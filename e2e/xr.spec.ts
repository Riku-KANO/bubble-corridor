// S-23 VR（IWER で Meta Quest 3 をエミュレーションする）。親が作成。実装担当は変更しない。
// M0 の関門: WebGPURenderer の WebGL2 経路で immersive-vr のセッションを始め、毎フレーム描けるか。
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const IWER = fileURLToPath(new URL('../node_modules/iwer/build/iwer.min.js', import.meta.url));

type Shared = { screen: string; backend: string; xr: boolean; xrFrames: number; xrSupported: boolean; commands: { ride(m: string): void }; xrExit: () => Promise<void> };
const read = <K extends keyof Shared>(page: Page, key: K) =>
  page.evaluate((k) => (globalThis as unknown as { __utakata?: Shared }).__utakata?.[k as keyof Shared], key as string) as Promise<Shared[K] | undefined>;

async function installQuest3(page: Page) {
  await page.addInitScript({ path: IWER });
  await page.addInitScript(() => {
    const W = globalThis as unknown as { IWER: { XRDevice: new (c: unknown) => { installRuntime(): void }; metaQuest3: unknown }; __iwerDevice?: unknown };
    const device = new W.IWER.XRDevice(W.IWER.metaQuest3);
    device.installRuntime();
    W.__iwerDevice = device;
  });
}

test.describe('REN-1 / CAM-3 VR の描画経路', () => {
  test('VR が使える端末では WebGL2 の経路で始め、入口に「VR で乗る」の条件がそろう', async ({ page }) => {
    await installQuest3(page);
    await page.goto('/?debug&screen=home');
    await expect.poll(() => read(page, 'screen'), { timeout: 30_000 }).toBe('home');
    expect(await read(page, 'xrSupported')).toBe(true);
    expect(await read(page, 'backend')).toBe('WebGL2');
  });

  test('immersive-vr のセッションで乗車が始まり、毎フレーム描ける（コンソールエラー 0）', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await installQuest3(page);
    await page.goto('/?debug&screen=home');
    await expect.poll(() => read(page, 'screen'), { timeout: 30_000 }).toBe('home');
    await page.evaluate(() => (globalThis as unknown as { __utakata: Shared }).__utakata.commands.ride('vr'));
    await expect.poll(() => read(page, 'xr'), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => read(page, 'screen'), { timeout: 15_000 }).toMatch(/guide|riding/);
    // フレームが進み続けること。固定の窓（1.5 秒で 20）は負荷の高い端末で揺れるので、10 秒のうちに 20 を超えればよい
    const f0 = (await read(page, 'xrFrames')) ?? 0;
    await expect.poll(async () => ((await read(page, 'xrFrames')) ?? 0) - f0, { timeout: 10_000, intervals: [250] }).toBeGreaterThan(20);
    // 両眼の描画が真っ黒・一色ではない（PNG の大きさで粗く見る）
    const png = await page.screenshot({ clip: { x: 160, y: 120, width: 960, height: 480 } });
    expect(png.length).toBeGreaterThan(8000);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('セッションが終わったら、乗車中ならポーズにして画面で続けられる', async ({ page }) => {
    await installQuest3(page);
    await page.goto('/?debug&screen=home');
    await expect.poll(() => read(page, 'screen'), { timeout: 30_000 }).toBe('home');
    await page.evaluate(() => (globalThis as unknown as { __utakata: Shared }).__utakata.commands.ride('vr'));
    await expect.poll(() => read(page, 'xr'), { timeout: 15_000 }).toBe(true);
    // アプリの外からセッションを終える（ヘッドセットを外したのと同じく sessionend が来る）
    await page.evaluate(() => (globalThis as unknown as { __utakata: { xrExit: () => Promise<void> } }).__utakata.xrExit());
    await expect.poll(() => read(page, 'xr'), { timeout: 15_000 }).toBe(false);
    expect(await read(page, 'screen')).toMatch(/pause|home/);
  });
});
