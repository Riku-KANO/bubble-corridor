// S-14 ライドフォト（親が作成。実装担当は変更しない）
// 撮影（WebGPU の描き出し）と合成の見た目は dev/photo.html と snap・e2e で確かめる。ここは決まりと保存。
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhotoRecord } from '../contracts/photo';
import { PHOTO } from '../config';
import { createPhotoStore, cropFor, doorTint, frameTierFor, photoFileName, sharePhoto, stampText } from './index';

const rec = (n: number, extra: Partial<PhotoRecord> = {}): PhotoRecord => ({
  id: `ride-${n}`,
  createdAt: 1_000 + n,
  meta: { rideNo: n, date: '2026-10-20', door: 'lapis', hiddenTotal: 0, constellations: 0, lang: 'ja' },
  shots: [{ shot: 'constellation', image: new Blob([`img-${n}`], { type: 'image/png' }) }],
  chosen: 'constellation',
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('PHO-2 額縁と刻印', () => {
  it('額縁は隠れた泡の数で変わる（0〜1 通常、2〜3 銀、4 金、5 虹色）', () => {
    expect([0, 1, 2, 3, 4, 5].map(frameTierFor)).toEqual(['plain', 'plain', 'silver', 'silver', 'gold', 'rainbow']);
    expect(frameTierFor(9)).toBe('rainbow');
    expect(frameTierFor(-1)).toBe('plain');
  });

  it('刻印は設計書の形（日本語・英語）', () => {
    expect(stampText({ rideNo: 3, date: '2026-10-20' }, 'ja')).toBe('泡沫回廊・第3便・2026.10.20');
    expect(stampText({ rideNo: 3, date: '2026-10-20' }, 'en')).toBe('Utakata · Ride No.3 · 2026.10.20');
  });

  it('扉の色: 琥珀と瑠璃で違う色（CSS の色）', () => {
    const a = doorTint('amber');
    const l = doorTint('lapis');
    expect(a).toMatch(/^#[0-9a-f]{6}$/i);
    expect(l).toMatch(/^#[0-9a-f]{6}$/i);
    expect(a).not.toBe(l);
  });

  it('保存の形の切り出し: 横長は 16:9 のまま、正方形は中央を切り出す', () => {
    const src = PHOTO.captureDesktop;
    expect(cropFor('wide', src.width, src.height)).toEqual({ sx: 0, sy: 0, sw: 2560, sh: 1440, width: 1920, height: 1080 });
    expect(cropFor('square', src.width, src.height)).toEqual({ sx: 560, sy: 0, sw: 1440, sh: 1440, width: 1080, height: 1080 });
    // 縦長の撮影（スマートフォンの縦持ち）でも中央を切り出す
    expect(cropFor('wide', 1080, 1920)).toEqual({ sx: 0, sy: 656.25, sw: 1080, sh: 607.5, width: 1920, height: 1080 });
  });

  it('ファイル名に日付・便・場面・形が入る', () => {
    expect(photoFileName({ rideNo: 3, date: '2026-10-20' }, 'bloom', 'square')).toBe('utakata-2026-10-20-ride3-bloom-square.png');
  });
});

describe('PHO-3 ブラウザ内の保存（IndexedDB）', () => {
  it('新しい順に並び、画像はそのまま戻る', async () => {
    const store = createPhotoStore(`t-${Math.random()}`);
    await store.put(rec(1));
    await store.put(rec(2));
    const list = await store.list();
    expect(list.map((r) => r.id)).toEqual(['ride-2', 'ride-1']);
    expect(await list[0].shots[0].image.text()).toBe('img-2');
    expect(list[0].meta).toEqual(rec(2).meta);
  });

  it('最新10回分まで。11回目で最も古いものを消す', async () => {
    const store = createPhotoStore(`t-${Math.random()}`);
    for (let n = 1; n <= 11; n++) await store.put(rec(n));
    const list = await store.list();
    expect(list).toHaveLength(PHOTO.keep);
    expect(list.map((r) => r.id)).not.toContain('ride-1');
    expect(list[0].id).toBe('ride-11');
  });

  it('同じ id で入れ直すと置き換える（選んだ写真の変更）', async () => {
    const store = createPhotoStore(`t-${Math.random()}`);
    await store.put(rec(1));
    await store.put(rec(1, { chosen: 'bloom' }));
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].chosen).toBe('bloom');
  });

  it('削除でき、別のインスタンスからも同じ内容が見える（永続）', async () => {
    const name = `t-${Math.random()}`;
    const a = createPhotoStore(name);
    await a.put(rec(1));
    await a.put(rec(2));
    await a.remove('ride-1');
    const b = createPhotoStore(name);
    expect((await b.list()).map((r) => r.id)).toEqual(['ride-2']);
  });

  it('IndexedDB が使えない環境では、例外を出さずにメモリだけで動く', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const store = createPhotoStore(`t-${Math.random()}`);
    await store.put(rec(1));
    expect((await store.list()).map((r) => r.id)).toEqual(['ride-1']);
  });
});

describe('PHO-3 共有', () => {
  it('端末の共有機能でファイルを送れるなら送って true', async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal('navigator', { share, canShare: () => true });
    const ok = await sharePhoto(new Blob(['x'], { type: 'image/png' }), 'a.png', '泡沫回廊・第3便');
    expect(ok).toBe(true);
    const arg = share.mock.calls[0][0] as unknown as { files: File[]; text: string };
    expect(arg.files[0].name).toBe('a.png');
    expect(arg.text).toBe('泡沫回廊・第3便');
  });

  it('共有機能がない・ファイルを送れない・途中でやめた → false（呼び出し側が保存に切り替える）', async () => {
    vi.stubGlobal('navigator', {});
    expect(await sharePhoto(new Blob(['x']), 'a.png', '')).toBe(false);
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: () => false });
    expect(await sharePhoto(new Blob(['x']), 'a.png', '')).toBe(false);
    vi.stubGlobal('navigator', {
      share: vi.fn(async () => {
        throw new DOMException('cancel', 'AbortError');
      }),
      canShare: () => true,
    });
    expect(await sharePhoto(new Blob(['x']), 'a.png', '')).toBe(false);
  });
});
