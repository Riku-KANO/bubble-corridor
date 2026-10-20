// ライドフォト（撮影、額縁と刻印の合成、ブラウザ内の保存、保存と共有）。
// STUB: 署名は確定。中身は photo 担当が本実装に置き換える。
import type * as THREE from 'three/webgpu';
import type { Lang, ShotId } from '../contracts/ids';
import type { FrameTier, PhotoFormat, PhotoMeta, PhotoRecord, PhotoStore } from '../contracts/photo';

/** 隠れた泡の総数（0〜5）→ 額縁。0〜1: 通常、2〜3: 銀、4: 金、5: 虹色 */
export function frameTierFor(_hiddenTotal: number): FrameTier {
  return 'plain'; // STUB
}

/** 刻印の文字（例: 「泡沫回廊・第3便・2026.10.20」、"Utakata · Ride No.3 · 2026.10.20"） */
export function stampText(_meta: Pick<PhotoMeta, 'rideNo' | 'date'>, _lang: Lang): string {
  return ''; // STUB
}

/**
 * 画面とは別に高い解像度で描き出す。画面の演出は止めない（裏で別の画像として描く）。
 * size は config の PHOTO.captureDesktop / captureMobile。
 */
export async function capturePhoto(
  _renderer: THREE.WebGPURenderer,
  _scene: THREE.Scene,
  _camera: THREE.Camera,
  _size: { readonly width: number; readonly height: number },
): Promise<Blob> {
  return new Blob([], { type: 'image/png' }); // STUB
}

/** 額縁・刻印・扉の色を合成して、保存の形（横長 1920×1080 / 正方形 1080×1080）の画像にする */
export async function composePhoto(_image: Blob, _meta: PhotoMeta, _format: PhotoFormat): Promise<Blob> {
  return new Blob([], { type: 'image/png' }); // STUB
}

/** ブラウザ内のデータベース（IndexedDB）。最新10枚まで */
export function createPhotoStore(_dbName?: string): PhotoStore {
  const records: PhotoRecord[] = [];
  return {
    async list() {
      return [...records];
    },
    async put(r) {
      records.unshift(r);
    },
    async remove(id) {
      const i = records.findIndex((r) => r.id === id);
      if (i >= 0) records.splice(i, 1);
    },
  };
}

/** 画像として保存する（ダウンロード） */
export function downloadPhoto(_blob: Blob, _fileName: string): void {
  // STUB
}

/** 端末の共有機能で送る。使えなければ false */
export async function sharePhoto(_blob: Blob, _fileName: string, _text: string): Promise<boolean> {
  return false; // STUB
}

export function photoFileName(meta: Pick<PhotoMeta, 'rideNo' | 'date'>, shot: ShotId, format: PhotoFormat): string {
  return `utakata-${meta.date}-ride${meta.rideNo}-${shot}-${format}.png`;
}
