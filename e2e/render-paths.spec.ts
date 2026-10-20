// S-23 REN-1 画面の2つの描画経路（WebGPU と WebGL2）。親が作成。実装担当は変更しない。
// VR の経路は e2e/xr.spec.ts。ここは天球の時刻（9:50、最も重い場面）で、エラーなく描けることを確かめる。
import { expect, test, type Page } from '@playwright/test';

const read = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __utakata?: { backend: string; section: string; fps: number } }).__utakata ?? null);

for (const [name, query, backend] of [
  ['既定（WebGPU があれば WebGPU）', '', /WebGPU|WebGL2/],
  ['WebGL2 を強制', '&webgl', /WebGL2/],
] as const) {
  test(`${name}: 天球の見どころで描け、コンソールエラー 0`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`/?debug&t=588&rate=0.1${query}`);
    await expect.poll(async () => (await read(page))?.section, { timeout: 30_000 }).toBe('celestial');
    await page.waitForTimeout(1500);
    const s = await read(page);
    expect(s?.backend).toMatch(backend);
    expect(s?.fps ?? 0).toBeGreaterThan(5);
    const png = await page.screenshot({ clip: { x: 160, y: 120, width: 960, height: 480 } });
    expect(png.length).toBeGreaterThan(8000);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
