// ライドフォトの決まり（額縁・刻印・扉の色・切り出し・ファイル名）。画面にも GPU にも触れない純粋な関数。
import { PHOTO } from '../config';
import type { DoorChoice, Lang, ShotId } from '../contracts/ids';
import type { FrameTier, PhotoFormat, PhotoMeta } from '../contracts/photo';

/** 隠れた泡の総数（0〜5）→ 額縁。0〜1: 通常、2〜3: 銀、4: 金、5: 虹色 */
export function frameTierFor(hiddenTotal: number): FrameTier {
  // NaN や負の数は「見つけていない」として通常の額縁にする
  if (!(hiddenTotal >= 2)) return 'plain';
  if (hiddenTotal < 4) return 'silver';
  if (hiddenTotal < 5) return 'gold';
  return 'rainbow';
}

/** 刻印の文字（例: 「泡沫回廊・第3便・2026.10.20」、"Utakata · Ride No.3 · 2026.10.20"） */
export function stampText(meta: Pick<PhotoMeta, 'rideNo' | 'date'>, lang: Lang): string {
  const date = meta.date.replaceAll('-', '.');
  return lang === 'en' ? `Utakata · Ride No.${meta.rideNo} · ${date}` : `泡沫回廊・第${meta.rideNo}便・${date}`;
}

/**
 * 扉の色のさし色（CSS の色）。琥珀は金の万華鏡、瑠璃は青の万華鏡の色に合わせる。
 * 写真の縁にだけ薄く足すので、明るすぎない中間の色にする。
 */
export function doorTint(door: DoorChoice): string {
  return door === 'amber' ? '#f3a73c' : '#3f73d9';
}

/** 撮影した画像のどこを、どの大きさの保存画像にするか */
export interface PhotoCrop {
  /** 元の画像から切り出す範囲（小数のことがある。縦長の撮影で 16:9 を中央から取るため） */
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  /** 保存する画像の大きさ */
  readonly width: number;
  readonly height: number;
}

/**
 * 保存の形に合わせた、中央からの切り出し。横長は 16:9、正方形は 1:1。
 * 元の画像より縦長・横長のどちらでも、はみ出さない最大の範囲を中央から取る。
 */
export function cropFor(format: PhotoFormat, srcW: number, srcH: number): PhotoCrop {
  const out = format === 'square' ? PHOTO.exportSquare : PHOTO.exportWide;
  const aspect = out.width / out.height;
  let sw = srcW;
  let sh = srcW / aspect;
  if (sh > srcH) {
    sh = srcH;
    sw = srcH * aspect;
  }
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh, width: out.width, height: out.height };
}

export function photoFileName(meta: Pick<PhotoMeta, 'rideNo' | 'date'>, shot: ShotId, format: PhotoFormat): string {
  return `utakata-${meta.date}-ride${meta.rideNo}-${shot}-${format}.png`;
}
