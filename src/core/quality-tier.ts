// 端末の自動判定と動的な解像度（案2「泡沫回廊」の部品）。品質の段 low/medium/high を端末の手がかりから決め、
// その段の描画設定（TierPreset）を返す。プリセットの表そのもの（案1の QUALITY_PRESETS）は ./quality.ts にある。
// ここの TierPreset は、案1の quality.ts の QualityPreset（renderScale・transmissionScale・dispersion など）とは別の型。
// 名前がぶつからないように 0.5.0 で QualityPreset から TierPreset に改めた。
// 判断の順序: 端末の種類（スマートフォン・VR）→ 明らかに遅い手がかり（ソフトウェア描画・少ないコア・少ないメモリ）→ GPU の種類。
// 動的な解像度調整は、重ければすぐ下げ、軽くなっても慌てて戻さない（ちらつかせない）。
// 案1の perf/dynamic-resolution（GPU 時間で動かす）・perf/governor とは別物で、こちらは requestAnimationFrame の間隔で動く（README 参照）。

export type QualityTier = 'low' | 'medium' | 'high';

export interface TierPreset {
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

export function presetFor(tier: QualityTier, hints: DeviceHints): TierPreset {
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
/** 目標のこの倍以下が続くなら、垂直同期の下限ではなく本当に余裕がある（高リフレッシュレートの画面、または場面が軽くなった） */
const EASY_RATIO = 0.8;
/** 1回に下げる量（大きく外したときは STEP_BIG）。1回の変化は 0.1 以下 */
const STEP_DOWN = 0.05;
const STEP_BIG = 0.1;
const BIG_RATIO = 1.6;
const STEP_UP = 0.05;
/** 試しに上げるには、守れている窓がこの回数だけ続く必要がある（下げた直後に戻して行ったり来たりしない） */
const LIGHT_WINDOWS = 4;
/** 試しに上げた直後は、この数のフレームだけで判定して、重ければすぐ戻す（0.5秒の窓を待たない） */
const PROBE_FRAMES = 8;
/**
 * 試しに上げて失敗した倍率の手前を「天井」として覚え、この時間は上げない（ms）。
 * 失敗が続くたびに倍にする（最大 8 倍）。重い部屋に居続けても、試しの上げと戻しが際限なく繰り返されない。
 * 天井は reset()、守れた試し、または本当に余裕のある窓（EASY_RATIO 以下）が続いたときにも外れる。
 */
const CEILING_HOLD_MS = 60_000;
const CEILING_HOLD_MAX = 8;
/** 1フレームの時間の上限（ms）。タブを離れた、シェーダのコンパイルなど一度きりの停止で窓の長さを狂わせない */
const FRAME_CLAMP_MS = 100;

/**
 * 動的な解像度調整。フレームの時間（requestAnimationFrame の間隔）を受け取り、目標の fps を保てるよう
 * 描画解像度の倍率を上下させる。約0.5秒の窓ごとのフレーム時間の中央値で判断する（毎フレームは変えない）。
 *  ・目標の 1.15 倍を超える窓: すぐ下げる（0.05。1.6 倍超なら 0.1）。
 *  ・目標の 1.05 倍以下の窓が 4 つ続き、倍率が初期値より下: 試しに 0.05 上げる。
 *  ・試しに上げた直後は 8 フレームだけで判定し、重ければすぐ戻して、その倍率を「天井」として 60 秒（失敗が続けば倍々）上げない。
 *  ・試しの判定を通っても、次の窓が重ければ同じく戻して天井にする（試しのときだけの分岐。普通の重さの変化とは区別する）。
 */
export class DynamicResolution {
  private current: number;
  private readonly frames = new Float32Array(WINDOW_FRAMES);
  private count = 0;
  private sumMs = 0;
  /** reset() からの時間（ms）。天井の期限の物差し */
  private elapsedMs = 0;
  /** 守れている窓が連続した数 */
  private light = 0;
  /** 余裕のある窓が連続した数 */
  private easy = 0;
  /** 試しに上げて、まだ結果が出ていない（次の窓まで） */
  private probing = false;
  /** 試しの判定に使うフレームの残り数と、その記録 */
  private probeLeft = 0;
  private readonly probeFrames = new Float32Array(PROBE_FRAMES);
  /** 試しに失敗した倍率の手前（これを超えて上げない）。null = 制限なし */
  private ceiling: number | null = null;
  private ceilingUntil = 0;
  private failStreak = 0;

  constructor(private readonly preset: TierPreset) {
    this.current = preset.renderScale;
  }

  get scale(): number {
    return this.current;
  }

  /** 1フレームの時間（ms）を渡す。新しい倍率を返す */
  sample(frameMs: number): number {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return this.current;
    const ms = Math.min(frameMs, FRAME_CLAMP_MS);
    this.elapsedMs += ms;

    // 試しに上げた直後: 短い窓で判定して、重ければすぐ戻す
    if (this.probeLeft > 0) {
      this.probeFrames[PROBE_FRAMES - this.probeLeft] = ms;
      if (--this.probeLeft === 0 && this.ratioOf(median(this.probeFrames, PROBE_FRAMES)) > SLOW_RATIO) this.failProbe();
      return this.current;
    }

    this.sumMs += ms;
    this.frames[this.count++] = ms;
    if (this.sumMs < WINDOW_MS && this.count < WINDOW_FRAMES) return this.current;

    const m = median(this.frames, this.count);
    this.sumMs = 0;
    this.count = 0;
    this.judge(this.ratioOf(m));
    return this.current;
  }

  reset(): void {
    this.current = this.preset.renderScale;
    this.sumMs = 0;
    this.count = 0;
    this.elapsedMs = 0;
    this.light = 0;
    this.easy = 0;
    this.probing = false;
    this.probeLeft = 0;
    this.ceiling = null;
    this.ceilingUntil = 0;
    this.failStreak = 0;
  }

  private ratioOf(ms: number): number {
    return ms / (1000 / this.preset.targetFps);
  }

  /** 試しに上げたのが重かった: 上げた分を戻し、その倍率を天井にする */
  private failProbe(): void {
    this.probing = false;
    this.probeLeft = 0;
    this.light = 0;
    this.sumMs = 0;
    this.count = 0;
    this.current = Math.max(this.preset.minRenderScale, this.current - STEP_UP);
    this.ceiling = this.current;
    this.failStreak = Math.min(this.failStreak + 1, Math.log2(CEILING_HOLD_MAX) + 1);
    this.ceilingUntil = this.elapsedMs + CEILING_HOLD_MS * 2 ** (this.failStreak - 1);
  }

  private judge(ratio: number): void {
    // 試しに上げて最初の窓: 重ければ戻して天井にする。重くなければ試しは成功（天井を外す）
    if (this.probing) {
      this.probing = false;
      if (ratio > SLOW_RATIO) {
        this.failProbe();
        return;
      }
      this.ceiling = null;
      this.failStreak = 0;
    }

    // 本当に余裕がある窓が続いたら、天井も外す
    if (ratio <= EASY_RATIO) {
      if (++this.easy >= LIGHT_WINDOWS) {
        this.ceiling = null;
        this.failStreak = 0;
      }
    } else {
      this.easy = 0;
    }
    if (this.ceiling !== null && this.elapsedMs >= this.ceilingUntil) this.ceiling = null;

    if (ratio > SLOW_RATIO) {
      this.light = 0;
      this.current = Math.max(this.preset.minRenderScale, this.current - (ratio > BIG_RATIO ? STEP_BIG : STEP_DOWN));
    } else if (ratio <= SETTLED_RATIO && this.current < this.preset.renderScale) {
      const next = Math.min(this.preset.renderScale, this.current + STEP_UP);
      if (this.ceiling !== null && next > this.ceiling + 1e-9) {
        this.light = 0; // 天井まで来ている。期限が来るまで上げない
      } else if (++this.light >= LIGHT_WINDOWS) {
        this.light = 0;
        this.current = next;
        this.probing = true;
        this.probeLeft = PROBE_FRAMES;
      }
    } else {
      // 目標付近（1.05〜1.15 倍）、または初期の倍率のまま。どちらにも動かさず、連続の数え直し
      this.light = 0;
    }
  }
}

/** フレーム時間の中央値（挿入ソート。窓は数十フレームなので十分速く、割り当てもしない。buf の並びは壊れる） */
function median(buf: Float32Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = v;
  }
  return n % 2 === 1 ? buf[(n - 1) / 2] : (buf[n / 2 - 1] + buf[n / 2]) / 2;
}
