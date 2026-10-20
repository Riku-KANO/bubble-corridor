// 本番ビルドで起動し、エラーなく描けることを確かめる（中の輪の最後、check.sh の e2e）。
import { expect, test } from '@playwright/test';

test('起動して待ち列から入口へ進める（コンソールエラー 0）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?debug');
  await expect(page.locator('canvas.stage')).toBeVisible();
  await page.getByRole('button', { name: /乗り場へ|To the platform/ }).click({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __utakata?: { screen: string } }).__utakata?.screen)).toBe('home');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('途中の時刻から乗車でき、時計が進む', async ({ page }) => {
  await page.goto('/?debug&t=150&rate=4');
  const read = () => page.evaluate(() => (globalThis as unknown as { __utakata?: { t: number; section: string } }).__utakata ?? null);
  await expect.poll(async () => (await read())?.section, { timeout: 30_000 }).toBe('greenhouse');
  const t0 = (await read())!.t;
  await page.waitForTimeout(1000);
  expect((await read())!.t).toBeGreaterThan(t0 + 2);
});
