// @vitest-environment jsdom
// S-12 CORE-4 曇りと指の文字（親が作成。実装担当は変更しない）
// 見た目は dev/core.html と snap で確かめる。ここは時間の進み方と約束（Promise）の決まりだけ。
// jsdom には 2D の描画がない（getContext が null）。それでも例外を出さずに時間だけ進むこと。
import { describe, expect, it } from 'vitest';
import { createCondensation } from './condensation';

function setup(w = 400, h = 200, dpr = 1) {
  let now = 100;
  const c = createCondensation({ width: w, height: h, dpr, now: () => now, autoTick: false });
  const advance = (sec: number, steps = 10) => {
    for (let i = 0; i < steps; i++) {
      now += sec / steps;
      c.tick(now);
    }
  };
  return { c, advance };
}

const settled = async <T>(p: Promise<T>) => {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe('CORE-4 曇りと指の文字', () => {
  it('最初は澄んでいる', () => {
    expect(setup().c.density).toBe(0);
  });

  it('曇らせると時間をかけて濃くなり、指定の秒で終わる', async () => {
    const { c, advance } = setup();
    const p = c.fogIn(1);
    advance(0.5);
    expect(c.density).toBeGreaterThan(0);
    expect(c.density).toBeLessThan(1);
    expect(await settled(p)).toBe(false);
    advance(0.6);
    expect(c.density).toBeCloseTo(1, 6);
    expect(await settled(p)).toBe(true);
  });

  it('tick を呼ばなければ進まない（autoTick: false。3D のテクスチャにするとき）', async () => {
    const { c } = setup();
    const p = c.fogIn(0.2);
    expect(c.density).toBe(0);
    expect(await settled(p)).toBe(false);
  });

  it('晴らすと 0 に戻る', async () => {
    const { c, advance } = setup();
    void c.fogIn(0.2);
    advance(0.3);
    const p = c.clear(0.5);
    advance(0.6);
    expect(c.density).toBeCloseTo(0, 6);
    expect(await settled(p)).toBe(true);
  });

  it('指でなぞる文字は、指定の秒で書き終わってから resolve する', async () => {
    const { c, advance } = setup();
    void c.fogIn(0.1);
    advance(0.2);
    const p = c.write(['触れると、', '鳴ります'], { durationSec: 2 });
    advance(1.5);
    expect(await settled(p)).toBe(false);
    advance(0.6);
    expect(await settled(p)).toBe(true);
  });

  it('文字を消すと resolve する', async () => {
    const { c, advance } = setup();
    void c.write(['Touch to play'], { durationSec: 0.5 });
    advance(0.6);
    const p = c.erase(0.4);
    advance(0.5);
    expect(await settled(p)).toBe(true);
  });

  it('大きさを変えると canvas の画素数が変わる（dpr を掛ける）', () => {
    const { c } = setup(400, 200, 2);
    expect(c.canvas.width).toBe(800);
    expect(c.canvas.height).toBe(400);
    c.resize(300, 100, 1.5);
    expect(c.canvas.width).toBe(450);
    expect(c.canvas.height).toBe(150);
  });

  it('dispose の後に tick しても例外を出さない', () => {
    const { c } = setup();
    c.dispose();
    expect(() => c.tick(999)).not.toThrow();
  });
});
