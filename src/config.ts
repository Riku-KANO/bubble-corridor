// 設計書（docs/spec.md、原本は Claude Docs「泡沫回廊 企画・設計書」）の数値をここに集める。
// 各担当はこの値を参照し、コードに直接書かない。値を変えるときは設計書と同時に直す（統合担当）。
import type { SectionId, ShotId } from './contracts/ids';

// ── 楽曲と時間（「楽曲の組み立て方」「楽曲の構成」） ──────────────────────
/** 基本のテンポ。72BPM 固定 */
export const BPM = 72;
export const BEATS_PER_BAR = 4;
export const SEC_PER_BEAT = 60 / BPM;
export const SEC_PER_BAR = SEC_PER_BEAT * BEATS_PER_BAR;
/** 触れた音を揃える拍の細かさ（8分音符 = 1拍の半分） */
export const TOUCH_GRID_BEATS = 0.5;

/**
 * 7つの区間。時刻は小節から計算する（キューシートの時刻は構成データの小節から自動で計算する）。
 * 72BPM・4/4 では 1小節 = 10/3 秒なので、設計書の時刻（1:00、3:30 …）はすべて小節の頭に乗る。
 */
export const SECTIONS: readonly { id: SectionId; startBar: number; bars: number }[] = [
  { id: 'platform', startBar: 0, bars: 18 }, // 0:00〜1:00 乗り場
  { id: 'greenhouse', startBar: 18, bars: 45 }, // 1:00〜3:30 第1室 朝露の温室
  { id: 'rain', startBar: 63, bars: 45 }, // 3:30〜6:00 第2室 雨の回廊
  { id: 'kaleidoscope', startBar: 108, bars: 36 }, // 6:00〜8:00 第3室 万華鏡の間
  { id: 'celestial', startBar: 144, bars: 54 }, // 8:00〜11:00 第4室 星の天球
  { id: 'dawn', startBar: 198, bars: 27 }, // 11:00〜12:30 第5室 夜明けの岸
  { id: 'departure', startBar: 225, bars: 9 }, // 12:30〜13:00 降車
];
export const RIDE_BARS = 234;
/** 乗車時間 13分 = 780秒。快適モードでも変えない */
export const RIDE_DURATION = RIDE_BARS * SEC_PER_BAR;

/** 見どころと出来事の小節（乗車の頭からの通しの小節番号）。すべて小節の頭に置く */
export const MOMENT_BARS = {
  /** 0:20 泡の内側に「触れると、鳴ります」 */
  hintTouch: 6,
  /** 2:40 ガラスの花が開く → 直後に露が一斉に落ちる。撮影 */
  greenhouseBloom: 48,
  /** 5:10 雨粒がガラス玉に変わり止まる。撮影 */
  rainFreeze: 93,
  /** 5:50 琥珀と瑠璃の扉が現れる */
  rainDoors: 105,
  /** 7:20 ガラス片が集まり巨大な花の模様を描く */
  kaleidoscopeFlower: 132,
  /** 9:50 星が線でつながりガラスの街を描く。撮影。楽曲の頂点 */
  celestialConstellation: 177,
  /** 11:50 朝日が昇り砂浜が金色に光る */
  dawnSunrise: 213,
} as const;

/** 露が落ちるのは花が開いた直後（1小節後） */
export const DEWFALL_AFTER_BLOOM_BARS = 1;
/** 天球に入ってからの暗闇（秒）。唯一の暗闇 */
export const CELESTIAL_BLACKOUT_SEC = 2.0;
/** 見どころの何秒前に、その方向から音と光の粒で誘うか */
export const LURE_LEAD_SEC = 3;
/** 自動撮影の3か所 */
export const SHOTS: readonly { shot: ShotId; bar: number }[] = [
  { shot: 'bloom', bar: MOMENT_BARS.greenhouseBloom },
  { shot: 'freeze', bar: MOMENT_BARS.rainFreeze },
  { shot: 'constellation', bar: MOMENT_BARS.celestialConstellation },
];

// ── 動きの上限（「ライドとカメラ」） ───────────────────────────────────
export const MOTION = {
  /** 普段の前進の速度（m/s） */
  cruiseMin: 1.0,
  cruiseMax: 2.0,
  /** 前進の最大速度（m/s） */
  speedMax: 3.0,
  /** 見どころの間の速度（m/s）。ほとんど止まっているように感じさせる */
  highlightSpeed: 0.5,
  /** 加速・減速の上限（m/s²） */
  accelMax: 0.5,
  /** 速度の変化にかける最短時間（秒） */
  speedChangeMinSec: 2,
  /** 上下の移動の上限（m/s） */
  verticalMax: 0.6,
  /** 向きの回転（左右）の上限（度/秒） */
  yawRateMaxDeg: 15,
  /** 物との最短距離（m） */
  clearanceMin: 0.5,
  /** 穏やかモードで上下の動きと向きの回転にかける倍率 */
  gentleFactor: 0.5,
} as const;

// ── カメラ（PCとスマートフォン、VR） ─────────────────────────────────
export const CAMERA = {
  /** 見回せる範囲（ゴンドラの正面から、度） */
  yawRangeDeg: 120,
  pitchRangeDeg: 60,
  fovDeg: 75,
  fovMinDeg: 60,
  fovMaxDeg: 90,
  /** 見どころの直前に正面へ戻すのは、正面からこれ以上外れているとき（度）。設計書に値がないので仮 */
  recenterThresholdDeg: 45,
  /** 正面へ戻す動きの長さ（秒） */
  recenterSec: 1.2,
  /** 正面へ戻すときの最大の角速度（度/秒）。大きく外れているときは長さを延ばす（酔わせない）。仮 */
  recenterMaxDegPerSec: 60,
  /** 座席の目の高さ（ゴンドラの中心からの高さ、m） */
  seatEyeHeight: 0.15,
} as const;

/** ゴンドラ（泡）の直径（m） */
export const GONDOLA_DIAMETER = 2.4;

// ── 触れる（「インタラクション設計」） ───────────────────────────────
export const INTERACTION = {
  /** 触れてから光と動きで応えるまでの上限（秒） */
  responseMaxSec: 0.1,
  /** 見つめて触れるまでの時間（秒）。0.8 / 1.2 / 2.0 から選べる */
  gazeDwellSec: 1.2,
  gazeDwellChoices: [0.8, 1.2, 2.0] as const,
  /** 同じ物は0.3秒以内に再び鳴らない */
  retriggerSec: 0.3,
  /** 触れた音が同時に鳴る数の上限。設計書に値がないので仮 */
  maxTouchVoices: 8,
  /** 触れられる物の縁が光り始める距離（m）。仮 */
  highlightDistance: 6,
  /** 触れられないままの物が自分で小さく鳴る距離（m）。仮 */
  idleChimeDistance: 4,
  /** 見つめて触れる物までの最大の距離（物の表面まで、m）。手を使わない人も遠くの扉や星に届くように、縁が光る距離より遠くまで。仮 */
  gazeMaxDistance: 25,
  /** VR で指先と物の距離がこれ以下なら触れたとみなす（m）。仮 */
  xrTouchDistance: 0.06,
} as const;

/** 隠れた小さな泡（各部屋に1つ、全5つ） */
export const HIDDEN_BUBBLE_SECTIONS: readonly SectionId[] = ['greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn'];

// ── 画面（「UI/UX設計」） ───────────────────────────────────────
export const UI = {
  /** 乗車前の案内は6秒で自動的に進む */
  preRideGuideSec: 6,
  /** マウスを動かしたときにポーズの雫が浮かぶ時間（秒） */
  pauseDropVisibleSec: 2,
  /** 画面の長押しでポーズ（秒）。仮 */
  longPressSec: 0.6,
  /** 最小の文字サイズ（1080p基準、px）。スマートフォンでは16px相当以上 */
  minFontPx: 18,
  minFontPxMobile: 16,
} as const;

/** 遷移の長さ（秒）。「遷移の一覧」 */
export const TRANSITION_SEC = {
  queueToHome: 1.5,
  homeToGuide: 1.5,
  boarding: 2.0,
  membrane: 0.6,
  pause: 0.4,
  resume: 0.3,
  alightToPhoto: 2.5,
  photoToRideAgain: 2.0,
  photoToHome: 1.5,
  screenToVR: 1.0,
} as const;

// ── ライドフォト ──────────────────────────────────────────────
export const PHOTO = {
  /** 撮影の解像度 */
  captureDesktop: { width: 2560, height: 1440 },
  captureMobile: { width: 1920, height: 1080 },
  /** 保存の形 */
  exportWide: { width: 1920, height: 1080 },
  exportSquare: { width: 1080, height: 1080 },
  /** ブラウザ内に残す枚数 */
  keep: 10,
} as const;

// ── 性能の目標（「性能の目標」） ──────────────────────────────────
export const PERF = {
  desktopFps: 60,
  mobileFps: 30,
  xrFpsMin: 72,
  xrFpsTarget: 90,
  roomGpuMemoryMB: 300,
  initialLoadMB: 10,
  roomLoadMB: 15,
} as const;

// ── VR ───────────────────────────────────────────────────────
export const XR = {
  /** メニューを出す距離（m） */
  menuDistance: 1.2,
  /** 文字は画面版の約2倍 */
  textScale: 2,
  /** 移動中に視界の外周を暗くする既定の強さ（0〜1） */
  vignetteDefault: 0.35,
} as const;

// ── 保存 ──────────────────────────────────────────────────────
/** localStorage・IndexedDB のキーの接頭辞 */
export const STORAGE_PREFIX = 'utakata';
