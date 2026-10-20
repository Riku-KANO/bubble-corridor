// 品質プリセットと自動判定。案1と共有する。
// 判断の順序: 端末の種類（スマートフォン・VR）→ 明らかに遅い手がかり（ソフトウェア描画・少ないコア・少ないメモリ）→ GPU の種類。
// 動的な解像度調整は、重ければすぐ下げ、軽くなっても慌てて戻さない（ちらつかせない）。

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityPreset {
  readonly tier: QualityTier;
  /** devicePixelRatio の上限 */
  readonly maxPixelRatio: number;
  /** 描画解像度の倍率の初期値（動的な解像度調整はこの範囲で動かす） */
  readonly renderScale: number;
  readonly minRenderScale: number;
  /** 1秒あたりの描画回数の目標 */
  readonly targetFps: number;
  /** 後処理（膜の縞、ブルーム、泡の縁）を使うか */
  readonly postFx: boolean;
  /** 粒子・インスタンスの数にかける倍率（0〜1） */
  readonly particleScale: number;
  /** 反射用の環境画像の一辺（px） */
  readonly envMapSize: number;
  readonly antialias: boolean;
}

/** 起動時に分かる端末の手がかり */
export interface DeviceHints {
  readonly isMobile: boolean;
  /** VR で描くか（速さを最優先にする） */
  readonly isXR: boolean;
  /** WebGL の UNMASKED_RENDERER など（分からなければ undefined） */
  readonly gpu?: string;
  readonly hardwareConcurrency?: number;
  readonly deviceMemoryGB?: number;
  /** 画面の画素数（width × height × dpr²） */
  readonly screenPixels?: number;
}

/** ソフトウェア描画（CPU で GPU のふりをするもの）。実用の速さが出ない */
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|microsoft basic/i;

/**
 * 単体 GPU と Apple の M シリーズ。
 * AMD の「Radeon Graphics」「Radeon 780M」「Vega」は CPU 内蔵なので含めない（RX・Pro・R9 など単体の型番だけ）。
 * Intel Arc は単体の A・B シリーズ（A770、B580 など）だけ。内蔵の「Arc Graphics」は含めない。
 * Safari は「Apple GPU」とだけ名乗り、Intel の Mac でも同じ名前になる（M シリーズとは区別できない）ので、
 * 名前に M の型番がないものは medium（不明）として扱う。実際に速ければ動的な解像度が上限まで戻す。
 */
const DISCRETE_GPU = [
  /nvidia|geforce|\brtx\b|\bgtx\b|quadro|tesla/i,
  /radeon\s*(rx|pro\s*w?|r9|r7|vii|hd)\s*\w*\d/i,
  /\barc\(?(tm)?\)?\s*(pro\s*)?[ab]\d{3}/i,
  /apple\s+m\d/i,
];

/** 画素数がこれを超える画面では、内蔵 GPU に重すぎるので初期の倍率を少し下げる（約 4.5K 相当） */
const HUGE_SCREEN_PIXELS = 6_000_000;

export function detectTier(hints: DeviceHints): QualityTier {
  if (hints.isMobile || hints.isXR) return 'low';
  const gpu = hints.gpu ?? '';
  if (SOFTWARE_GPU.test(gpu)) return 'low';
  if (hints.hardwareConcurrency !== undefined && hints.hardwareConcurrency <= 2) return 'low';
  if (hints.deviceMemoryGB !== undefined && hints.deviceMemoryGB <= 2) return 'low';
  if (DISCRETE_GPU.some((re) => re.test(gpu.trim()))) return 'high';
  // 内蔵 GPU と、手がかりのないもの
  return 'medium';
}

/** 品質ごとの基本。端末（スマートフォン・VR）と画面の大きさで少し調整する */
const BASE: Record<QualityTier, { pixelRatio: number; scale: number; minScale: number; particles: number; env: number }> = {
  high: { pixelRatio: 2, scale: 1, minScale: 0.6, particles: 1, env: 512 },
  medium: { pixelRatio: 1.5, scale: 1, minScale: 0.6, particles: 0.7, env: 256 },
  low: { pixelRatio: 1, scale: 0.9, minScale: 0.5, particles: 0.4, env: 128 },
};

export function presetFor(tier: QualityTier, hints: DeviceHints): QualityPreset {
  const b = BASE[tier];
  // スマートフォンは画素比を 2 以下にして発熱を抑える。low でも細部が潰れすぎないよう 1.5 まで許す
  const maxPixelRatio = hints.isMobile ? Math.min(Math.max(b.pixelRatio, 1.5), 2) : b.pixelRatio;
  // 大きな画面で高くない品質のときは、最初から少し下げておく（動的調整が追いつくまでの息継ぎを防ぐ）
  const huge = (hints.screenPixels ?? 0) > HUGE_SCREEN_PIXELS && tier !== 'high';
  const renderScale = Math.max(b.minScale, huge ? b.scale - 0.15 : b.scale);
  return {
    tier,
    maxPixelRatio,
    renderScale,
    minRenderScale: b.minScale,
    targetFps: hints.isXR ? 72 : hints.isMobile ? 30 : 60,
    // VR と low では後処理を使わない（フレームの速さを最優先）
    postFx: tier !== 'low' && !hints.isXR,
    particleScale: b.particles,
    envMapSize: b.env,
    // 低品質でも VR は MSAA を残す（タイル型 GPU では安く、VR は縁のギザギザが目立つ）
    antialias: tier !== 'low' || hints.isXR,
  };
}

/** 判断する窓の長さ（ms）。この間のフレーム時間の中央値で決める（一度きりの停止に引きずられない） */
const WINDOW_MS = 500;
/** 窓に貯められるフレームの上限（2ms 未満のフレームが続いても溢れないように、溢れたらそこで判断する） */
const WINDOW_FRAMES = 256;
/** 目標のフレーム時間のこの倍を超えたら下げる */
const SLOW_RATIO = 1.15;
/**
 * 目標のフレーム時間のこの倍以下なら「目標を守れている」。
 * 垂直同期で 60/72Hz に固定された画面では、余裕があっても間隔は目標どおり（比 ≈ 1.0）で、それより速くはならない。
 * そのため「余裕がある」の基準を 1 未満にせず、守れている状態が続けば試しに倍率を上げる。
 */
const SETTLED_RATIO = 1.05;
/** 1回に下げる量（大きく外したときは STEP_BIG）。1回の変化は 0.1 以下 */
const STEP_DOWN = 0.05;
const STEP_BIG = 0.1;
const BIG_RATIO = 1.6;
const STEP_UP = 0.05;
/** 戻す（試しに上げる）には、守れている窓がこの回数だけ続く必要がある（下げた直後に戻して行ったり来たりしない） */
const LIGHT_WINDOWS = 4;
const LIGHT_WINDOWS_MAX = 32;
/** 上げた直後（この窓の数以内）にまた重くなったら、上げた分だけ戻し、次に上げるまでの待ちを倍にする */
const FLAP_WINDOWS = 10;
/** 1フレームの時間の上限（ms）。タブを離れた、シェーダのコンパイルなど一度きりの停止で窓の長さを狂わせない */
const FRAME_CLAMP_MS = 100;

/**
 * 動的な解像度調整。フレームの時間（requestAnimationFrame の間隔）を受け取り、目標の fps を保てるよう
 * 描画解像度の倍率を上下させる。約0.5秒の窓ごとのフレーム時間の中央値で判断する（毎フレームは変えない）。
 *  ・目標の 1.15 倍を超える窓: すぐ下げる（0.05。1.6 倍超なら 0.1）。
 *  ・目標の 1.05 倍以下の窓が 4 つ続き、倍率が初期値より下: 試しに 0.05 上げる。
 *  ・上げた直後に重くなったら、上げた分だけ戻し、次に上げるまでの待ちを倍にする（最大 32 窓）。
 */
export class DynamicResolution {
  private current: number;
  private readonly frames = new Float32Array(WINDOW_FRAMES);
  private count = 0;
  private sumMs = 0;
  /** 守れている窓が連続した数 */
  private light = 0;
  private lightNeeded = LIGHT_WINDOWS;
  /** 最後に上げてから経った窓の数 */
  private sinceUp = Infinity;
  /** 試しに上げて、まだ結果が出ていない */
  private probing = false;

  constructor(private readonly preset: QualityPreset) {
    this.current = preset.renderScale;
  }

  get scale(): number {
    return this.current;
  }

  /** 1フレームの時間（ms）を渡す。新しい倍率を返す */
  sample(frameMs: number): number {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return this.current;
    const ms = Math.min(frameMs, FRAME_CLAMP_MS);
    this.sumMs += ms;
    this.frames[this.count++] = ms;
    if (this.sumMs < WINDOW_MS && this.count < WINDOW_FRAMES) return this.current;

    const median = this.median();
    this.sumMs = 0;
    this.count = 0;
    this.judge(median);
    return this.current;
  }

  reset(): void {
    this.current = this.preset.renderScale;
    this.sumMs = 0;
    this.count = 0;
    this.light = 0;
    this.lightNeeded = LIGHT_WINDOWS;
    this.sinceUp = Infinity;
    this.probing = false;
  }

  /** 窓の中のフレーム時間の中央値（挿入ソート。窓は数十フレームなので十分速く、割り当てもしない） */
  private median(): number {
    const f = this.frames;
    const n = this.count;
    for (let i = 1; i < n; i++) {
      const v = f[i];
      let j = i - 1;
      while (j >= 0 && f[j] > v) {
        f[j + 1] = f[j];
        j--;
      }
      f[j + 1] = v;
    }
    return n % 2 === 1 ? f[(n - 1) / 2] : (f[n / 2 - 1] + f[n / 2]) / 2;
  }

  private judge(medianMs: number): void {
    const target = 1000 / this.preset.targetFps;
    const ratio = medianMs / target;
    this.sinceUp++;
    // 試しに上げて、しばらく重くならずに済んだ = 余裕がある。上げるまでの待ちを半分に戻す（重い場面が終わったら、早く回復する）
    if (this.probing && this.sinceUp > FLAP_WINDOWS && ratio <= SETTLED_RATIO) {
      this.probing = false;
      this.lightNeeded = Math.max(LIGHT_WINDOWS, Math.floor(this.lightNeeded / 2));
    }

    if (ratio > SLOW_RATIO) {
      this.light = 0;
      if (this.sinceUp <= FLAP_WINDOWS) {
        // 上げた直後にまた重くなった = 境目にいる。試しに上げた分だけ戻し、次からは上げるのを慎重にする
        this.probing = false;
        this.lightNeeded = Math.min(this.lightNeeded * 2, LIGHT_WINDOWS_MAX);
        this.current = Math.max(this.preset.minRenderScale, this.current - STEP_UP);
      } else {
        this.current = Math.max(this.preset.minRenderScale, this.current - (ratio > BIG_RATIO ? STEP_BIG : STEP_DOWN));
      }
    } else if (ratio <= SETTLED_RATIO && this.current < this.preset.renderScale) {
      if (++this.light >= this.lightNeeded) {
        this.light = 0;
        this.sinceUp = 0;
        this.probing = true;
        this.current = Math.min(this.preset.renderScale, this.current + STEP_UP);
      }
    } else {
      // 目標付近（1.05〜1.15 倍）、または初期の倍率のまま。どちらにも動かさず、連続の数え直し
      this.light = 0;
    }
  }
}
