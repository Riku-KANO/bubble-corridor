// ライドフォト（撮影、額縁と刻印の合成、ブラウザ内の保存、保存と共有）。
// 撮影は capture.ts、合成は compose.ts、IndexedDB は store.ts、決まりは rules.ts。
// ここは受け取り（ダウンロード・共有）を持ち、外から使う名前をまとめて出す。

export { capturePhoto, prepareCapture, warmUpCapture } from './capture';
export type { CaptureOptions, CaptureSize, PrepareOptions } from './capture';
export { composePhoto } from './compose';
export { createPhotoStore } from './store';
export { CAPTURE_PREPARE_LEAD_SEC, captureToPrepare, cropFor, doorTint, frameTierFor, photoFileName, stampText } from './rules';
export type { PhotoCrop, ShotCue } from './rules';

/** 解放を遅らせる時間。すぐに解放すると、保存が始まる前に URL が無効になる環境（Safari など）がある */
const REVOKE_DELAY_MS = 10_000;

/** 画像として保存する（ダウンロード）。使い終わった object URL は解放する */
export function downloadPhoto(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** 端末の共有機能で送る。使えない・送れない・途中でやめた場合は false（呼び出し側が保存に切り替える） */
export async function sharePhoto(blob: Blob, fileName: string, text: string): Promise<boolean> {
  const nav = globalThis.navigator as Navigator | undefined;
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  try {
    const file = new File([blob], fileName, { type: blob.type || 'image/png' });
    const data: ShareData = { files: [file], text };
    if (!nav.canShare(data)) return false;
    await nav.share(data);
    return true;
  } catch {
    // AbortError（共有シートを閉じた）、NotAllowedError（操作の直後でない）など。どれも「送れなかった」
    return false;
  }
}
