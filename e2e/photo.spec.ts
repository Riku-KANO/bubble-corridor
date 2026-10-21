// S-30 ライドフォトの撮影で、見どころの最中に画面が止まらない（親が作成。実装担当は変更しない）
// 5:10.5（photo.capture@93、雨粒が止まる見どころの最中）の撮影の描き出しで約 0.47 秒止まっていた（S-21 レビュー2巡目）。
// VR の 72fps（1フレーム約 14ms）では、止まりはそのまま視界の止まりになる。撮影の前後のフレームの間隔を測る。
import { expect, test } from '@playwright/test';

// 同じ時刻の撮影を同時に走らせると、2560×1440 の描き出しで GPU を取り合い、撮影の直後のフレームが遅れて誤って落ちる（S-30 レビュー2巡目）
test.describe.configure({ mode: 'serial' });

for (const [name, q] of [
  ['WebGPU（あれば）', ''],
  ['WebGL2（VR と同じ経路）', '&webgl'],
] as const) {
test(`${name}: 雨の見どころの撮影（5:10.5）の前後で、フレームの間隔が 50ms を超えない（VR の 72fps で約3フレーム）（写真は撮れている）`, async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/?debug&t=300&rate=1${q}`);
  const read = () => page.evaluate(() => (globalThis as unknown as { __utakata?: { t: number; photos?: number } }).__utakata ?? null);
  await expect.poll(async () => (await read())?.t ?? 0, { timeout: 30_000 }).toBeGreaterThan(303);
  // 撮影の 4 秒前から 3 秒後まで、フレームの時刻を集める（ページの中の rAF で）
  const gaps = await page.evaluate(async () => {
    const g = globalThis as unknown as { __utakata: { t: number } };
    while (g.__utakata.t < 306.5) await new Promise((r) => requestAnimationFrame(r));
    const times: number[] = [];
    while (g.__utakata.t < 313.5) {
      await new Promise((r) => requestAnimationFrame(r));
      times.push(performance.now());
    }
    const out: number[] = [];
    for (let i = 1; i < times.length; i++) out.push(times[i]! - times[i - 1]!);
    return out;
  });
  expect(gaps.length, 'フレームの数').toBeGreaterThan(100);
  const worst = Math.max(...gaps);
  expect(worst, `最も長いフレームの間隔 ${worst.toFixed(0)}ms`).toBeLessThan(50);
  await expect.poll(async () => (await read())?.photos ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  expect(errors, errors.join('\n')).toEqual([]);
});
}

for (const [name, q] of [
  ['WebGPU（あれば）', ''],
  ['WebGL2（VR と同じ経路）', '&webgl'],
] as const) {
  test(`${name}: 温室の 2:40 の撮影と、その前の暗さの段の切り替え（150〜163.5 秒）で、フレームの間隔が 50ms を超えない（S-30 レビュー1巡目 P1）`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/?debug&t=145&rate=1${q}`);
    const t = () => page.evaluate(() => (globalThis as unknown as { __utakata?: { t: number } }).__utakata?.t ?? 0);
    await expect.poll(t, { timeout: 30_000 }).toBeGreaterThan(147);
    const worst = await page.evaluate(async () => {
      const g = globalThis as unknown as { __utakata: { t: number } };
      while (g.__utakata.t < 150) await new Promise((r) => requestAnimationFrame(r));
      let last = performance.now();
      let w = 0;
      while (g.__utakata.t < 163.5) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        w = Math.max(w, now - last);
        last = now;
      }
      return w;
    });
    expect(worst, `最も長いフレームの間隔 ${worst.toFixed(0)}ms`).toBeLessThan(50);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('撮影はキューの時刻どおりに描く（下ごしらえを待って遅れない。時刻から決める。S-30 レビュー1巡目 P2）', async ({ page }) => {
  test.setTimeout(120_000);
  // 早送り（20倍）で直前から乗る: 下ごしらえが間に合わない遅い端末と同じ状況。1フレームは乗車の約 0.33 秒
  await page.goto('/?debug&t=140&rate=20');
  const read = () => page.evaluate(() => (globalThis as unknown as { __utakata?: { screen: string; captures?: number[] } }).__utakata ?? null);
  await expect.poll(async () => (await read())?.screen, { timeout: 90_000, intervals: [250] }).toBe('photo');
  const captures = (await read())?.captures ?? [];
  expect(captures.length, `撮影の時刻 ${JSON.stringify(captures)}`).toBe(3);
  const cues = [160, 310, 590];
  captures.forEach((c, i) => {
    expect(c, `${i + 1}枚目の撮影の時刻`).toBeGreaterThanOrEqual(cues[i]! - 0.05);
    expect(c, `${i + 1}枚目の撮影の時刻`).toBeLessThan(cues[i]! + 1);
  });
});
