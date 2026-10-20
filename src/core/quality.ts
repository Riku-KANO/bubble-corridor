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
 * Safari は「Apple GPU」とだけ名乗る。PC（isMobile でない）の Apple GPU は M シリーズなので high とみなす。
 */
const DISCRETE_GPU = [
  /nvidia|geforce|\brtx\b|\bgtx\b|quadro|tesla/i,
  /radeon\s*(rx|pro\s*w?|r9|r7|vii|hd)\s*\w*\d/i,
  /\barc\(?(tm)?\)?\s*a\d{3}/i, // Intel Arc の単体（A770 など）。内蔵の「Arc Graphics」は含めない
  /apple\s+m\d/i,
  /^apple gpu$/i,
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

/** 判断する窓の長さ（ms）。この間のフレーム時間の平均で決める */
const WINDOW_MS = 500;
/** 目標のフレーム時間のこの倍を超えたら下げる */
const SLOW_RATIO = 1.15;
/** 目標のフレーム時間のこの倍を下回ったら（余裕があれば）上げる候補 */
const FAST_RATIO = 0.8;
/** 1回に下げる量（大きく外したときは STEP_BIG）。1回の変化は 0.1 以下 */
const STEP_DOWN = 0.05;
const STEP_BIG = 0.1;
const BIG_RATIO = 1.6;
const STEP_UP = 0.05;
/** 戻すには、余裕のある窓がこの回数だけ続く必要がある（下げた直後に戻して行ったり来たりしない） */
const LIGHT_WINDOWS = 4;
const LIGHT_WINDOWS_MAX = 32;
/** 戻した直後（この窓の数以内）にまた下げたら、戻す条件を厳しくする */
const FLAP_WINDOWS = 10;
/** 1フレームの時間の上限（ms）。タブを離れた、シェーダのコンパイルなど一度きりの停止で判断を狂わせない */
const FRAME_CLAMP_MS = 100;

/**
 * 動的な解像度調整。フレームの時間を受け取り、目標の fps を保てるよう描画解像度の倍率を上下させる。
 * 約0.5秒の窓ごとの平均で判断する（毎フレームは変えない）。重いときは素早く、軽いときはゆっくり。
 */
export class DynamicResolution {
  private current: number;
  private sumMs = 0;
  private frames = 0;
  /** 余裕のある窓が連続した数 */
  private light = 0;
  private lightNeeded = LIGHT_WINDOWS;
  /** 最後に上げてから経った窓の数 */
  private sinceUp = Infinity;

  constructor(private readonly preset: QualityPreset) {
    this.current = preset.renderScale;
  }

  get scale(): number {
    return this.current;
  }

  /** 1フレームの時間（ms）を渡す。新しい倍率を返す */
  sample(frameMs: number): number {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return this.current;
    this.sumMs += Math.min(frameMs, FRAME_CLAMP_MS);
    this.frames++;
    if (this.sumMs < WINDOW_MS) return this.current;

    const avg = this.sumMs / this.frames;
    this.sumMs = 0;
    this.frames = 0;
    this.judge(avg);
    return this.current;
  }

  reset(): void {
    this.current = this.preset.renderScale;
    this.sumMs = 0;
    this.frames = 0;
    this.light = 0;
    this.lightNeeded = LIGHT_WINDOWS;
    this.sinceUp = Infinity;
  }

  private judge(avgMs: number): void {
    const target = 1000 / this.preset.targetFps;
    const ratio = avgMs / target;
    this.sinceUp++;

    if (ratio > SLOW_RATIO) {
      this.light = 0;
      // 上げた直後にまた重くなった = 境目にいる。次からは戻すのを慎重にする
      if (this.sinceUp <= FLAP_WINDOWS) this.lightNeeded = Math.min(this.lightNeeded * 2, LIGHT_WINDOWS_MAX);
      this.current = Math.max(this.preset.minRenderScale, this.current - (ratio > BIG_RATIO ? STEP_BIG : STEP_DOWN));
    } else if (ratio < FAST_RATIO && this.current < this.preset.renderScale) {
      if (++this.light >= this.lightNeeded) {
        this.light = 0;
        this.sinceUp = 0;
        this.current = Math.min(this.preset.renderScale, this.current + STEP_UP);
      }
    } else {
      // 目標付近。どちらにも動かさず、連続の数え直し
      this.light = 0;
    }
  }
}
