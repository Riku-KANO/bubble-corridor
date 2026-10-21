// S-29 部屋が初めて見える瞬間に画面が止まらない（親が作成。実装担当は変更しない）
// 次の部屋は膜の15秒前から描く。そのとき初めてシェーダを組むと、WebGL2（VR と同じ経路）で万華鏡が 0.35 秒止まった（S-21 の報告）。
// 前の部屋にいる間に先に組んでおく（renderer.compileAsync）。膜の20秒前から膜の後まで、フレームの間隔を測る。
import { expect, test } from '@playwright/test';

for (const [room, membrane] of [
  ['万華鏡', 360],
  ['星の天球', 480],
] as const) {
  test(`WebGL2（VR と同じ経路）: ${room}が見え始めるとき（膜 ${membrane} 秒の 15 秒前）に、フレームの間隔が 100ms を超えない`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/?debug&t=${membrane - 30}&rate=1&webgl`);
    const read = () => page.evaluate(() => (globalThis as unknown as { __utakata?: { t: number } }).__utakata?.t ?? 0);
    await expect.poll(read, { timeout: 30_000 }).toBeGreaterThan(membrane - 28);
    const worst = await page.evaluate(async (m) => {
      const g = globalThis as unknown as { __utakata: { t: number } };
      while (g.__utakata.t < m - 20) await new Promise((r) => requestAnimationFrame(r));
      let last = performance.now();
      let w = 0;
      while (g.__utakata.t < m + 2) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        w = Math.max(w, now - last);
        last = now;
      }
      return w;
    }, membrane);
    expect(worst, `最も長いフレームの間隔 ${worst.toFixed(0)}ms`).toBeLessThan(100);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
