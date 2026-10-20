// レールとゴンドラの動き。物理エンジンは使わず、レール上の位置を時刻から決める。
import type { ComfortMode, SectionId } from './ids';
import type { Vec3Tuple } from './events';

/**
 * rail.json の形。Blender から書き出す場合も同じ形にする（設計書「書き出すもの」）。
 * 今はコードで生成する（scripts/build-ride-data.ts、ADR-0002）。
 */
export interface RideData {
  readonly version: 1;
  /** 乗車時間（秒） */
  readonly duration: number;
  /** レールの点列。一定間隔（spacing m）に並べた中心線 */
  readonly rail: { readonly spacing: number; readonly points: readonly Vec3Tuple[] };
  /**
   * 時刻 → レール上の距離（m）の対応表。t は単調増加、s は単調非減少。
   * s は3Dの弧長（点は3Dで spacing の等間隔に並べ、s = 点の番号 × spacing）。
   * 点の間は createRide が単調な3次エルミートで補う（速度が階段にならない。ADR-0008）。
   */
  readonly timeline: readonly { readonly t: number; readonly s: number }[];
  /**
   * 穏やかモードで使う高さの点列（rail.points と同じ数）。なければ standard と同じ。
   * いまは持たない（レールは1本。標準の動きを穏やかの上限以内に設計する。ADR-0008）
   */
  readonly gentleY?: readonly number[];
  /** 区間ごとのレール上の範囲（m） */
  readonly sections: readonly { readonly id: SectionId; readonly s0: number; readonly s1: number }[];
}

/** ある時刻のゴンドラの姿勢。ゴンドラは常に水平で、向きは左右（yaw）だけ持つ */
export interface RidePose {
  /** ゴンドラの中心（ワールド座標、m） */
  x: number;
  y: number;
  z: number;
  /** 進行方向の向き（ラジアン、-Z 方向が 0、左回りが正。three.js の rotation.y と同じ） */
  yaw: number;
  /** 前進の速度（m/s） */
  speed: number;
  /** レール上の距離（m） */
  s: number;
  section: SectionId;
  /** 区間の中での進み具合（0〜1、時刻で計る） */
  sectionProgress: number;
}

export interface Ride {
  readonly data: RideData;
  /** 時刻 t（秒）の姿勢を out に書いて返す（毎フレーム呼ぶので確保しない） */
  poseAt(t: number, mode: ComfortMode, out: RidePose): RidePose;
  /** レール上の距離 s の点（部屋の担当が物を置くときに使う） */
  pointAt(s: number, mode?: ComfortMode): { x: number; y: number; z: number; yaw: number };
  sectionAt(t: number): SectionId;
  /** 区間の時刻の範囲（秒） */
  sectionTime(id: SectionId): { t0: number; t1: number };
  /** 区間のレール上の範囲（m） */
  sectionSpan(id: SectionId): { s0: number; s1: number };
}

/** 動きの上限の検査結果（scripts/comfort.ts と単体テストで使う） */
export interface ComfortViolation {
  readonly kind: 'speed' | 'accel' | 'vertical' | 'yawRate' | 'speedChange';
  readonly t0: number;
  readonly t1: number;
  /** 上限に対する実測の最大値 */
  readonly peak: number;
  readonly limit: number;
}
