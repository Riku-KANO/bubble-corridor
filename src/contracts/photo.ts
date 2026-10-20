// ライドフォトの契約。撮影は自動で3か所。サーバーを持たず、ブラウザ内に最新10枚まで残す。
import type { DoorChoice, Lang, ShotId } from './ids';

/** 額縁の種類（隠れた泡の数で変わる。5つすべてで虹色の特別版） */
export type FrameTier = 'plain' | 'silver' | 'gold' | 'rainbow';

/** 保存の形 */
export type PhotoFormat = 'wide' | 'square';

export interface PhotoMeta {
  readonly rideNo: number;
  /** YYYY-MM-DD */
  readonly date: string;
  readonly door: DoorChoice;
  /** この乗車までに見つけた小さな泡の総数（0〜5）。額縁を決める */
  readonly hiddenTotal: number;
  readonly constellations: number;
  readonly lang: Lang;
}

/** 1回の乗車の写真（3枚）。写真の棚に並ぶ単位 */
export interface PhotoRecord {
  /** 例: "ride-12-1729500000000" */
  readonly id: string;
  readonly createdAt: number;
  readonly meta: PhotoMeta;
  /** 撮影したままの画像（額縁なし）。撮影の解像度 */
  readonly shots: readonly { readonly shot: ShotId; readonly image: Blob }[];
  /** 選んだ1枚（既定は constellation） */
  readonly chosen: ShotId;
}

export interface PhotoStore {
  /** 新しい順。最新10枚まで */
  list(): Promise<PhotoRecord[]>;
  /** 追加して、10枚を超えた古いものを消す */
  put(record: PhotoRecord): Promise<void>;
  remove(id: string): Promise<void>;
}
