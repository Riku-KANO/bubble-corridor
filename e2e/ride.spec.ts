// S-25 関門2: 13分を通して乗れる（?rate=60 で早送り。780秒 ≈ 13秒）。親が作成。実装担当は変更しない。
import { expect, test, type Page } from '@playwright/test';

type Shared = { t: number; section: string; screen: string; fps: number; photos?: number; frameAt?: number };
const read = (page: Page) => page.evaluate(() => (globalThis as unknown as { __utakata?: Shared }).__utakata ?? null);

for (const vp of [
  { name: 'PC 幅', viewport: { width: 1280, height: 720 }, isMobile: false },
  { name: 'スマートフォン幅', viewport: { width: 390, height: 844 }, isMobile: true },
]) {
  test(`${vp.name}: 乗車の頭から終わりまで通り、ライドフォトの画面へ（写真3枚、コンソールエラー 0）`, async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.isMobile, locale: 'ja-JP' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/?debug&t=0&rate=60');
    const seen = new Set<string>();
    await expect
      .poll(
        async () => {
          const s = await read(page);
          if (s?.section) seen.add(s.section);
          return s?.screen;
        },
        { timeout: 60_000, intervals: [200] },
      )
      .toBe('photo');
    expect([...seen]).toEqual(expect.arrayContaining(['platform', 'greenhouse', 'rain', 'kaleidoscope', 'celestial', 'dawn', 'departure']));
    await expect.poll(async () => (await read(page))?.photos, { timeout: 15_000 }).toBe(3);
    expect(errors, errors.join('\n')).toEqual([]);
    await ctx.close();
  });
}

test('音の時計で進む: 待ち列から普通に乗ると、乗車の時計は実時間とほぼ同じ速さで滑らかに進む（止まらない・飛ばない・戻らない）', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // ?t も ?rate も付けない（音の時計を使う経路）。?debug は __utakata を出すだけ
  await page.goto('/?debug');
  await page.getByRole('button', { name: /乗り場へ|To the platform/ }).click({ timeout: 30_000 });
  await page.getByRole('button', { name: /^(乗る|Ride)$/ }).click({ timeout: 15_000 });
  const skip = page.getByRole('button', { name: /^(飛ばす|Skip)$/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect.poll(async () => (await read(page))?.screen, { timeout: 20_000 }).toBe('riding');
  await expect.poll(async () => (await read(page))?.t ?? 0, { timeout: 10_000 }).toBeGreaterThan(1);
  // 4秒のあいだ、フレームごとに書かれる乗車の時計（t）と、そのフレームの時刻（frameAt = performance.now() のミリ秒）を読む。
  // ページの読み取りの間隔ではなく、フレームの時刻と比べる（負荷でフレームが遅れても、時計が飛んだことにはしない）
  const samples = await page.evaluate(async () => {
    const out: [number, number][] = [];
    const g = globalThis as unknown as { __utakata: { t: number; frameAt: number } };
    const t0 = performance.now();
    let last = -1;
    while (performance.now() - t0 < 4000) {
      if (g.__utakata.frameAt !== last) {
        last = g.__utakata.frameAt;
        out.push([g.__utakata.frameAt / 1000, g.__utakata.t]);
      }
      await new Promise((r) => setTimeout(r, 16));
    }
    return out;
  });
  expect(samples.length, 'フレームの数').toBeGreaterThan(20);
  const [w0, r0] = samples[0]!;
  const [w1, r1] = samples[samples.length - 1]!;
  const rate = (r1 - r0) / (w1 - w0);
  expect(rate, '乗車の時計の速さ（フレームの時刻に対して）').toBeGreaterThan(0.9);
  expect(rate).toBeLessThan(1.1);
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i]![1] - samples[i - 1]![1];
    const dw = samples[i]![0] - samples[i - 1]![0];
    expect(dt, `戻らない（${i}）`).toBeGreaterThanOrEqual(0);
    expect(Math.abs(dt - dw), `飛ばない（${i}: 時計 ${dt.toFixed(3)} 秒 / フレーム ${dw.toFixed(3)} 秒）`).toBeLessThan(0.05);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
