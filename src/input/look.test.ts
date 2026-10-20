// @vitest-environment jsdom
// S-15 CAM-1 / CAM-2 見回し（親が作成。実装担当は変更しない）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventBus } from '../contracts/events';
import type { LookControl } from '../contracts/input';
import { CAMERA } from '../config';
import { createLookControl } from './index';

const DEG = Math.PI / 180;
const bus: EventBus = { on: () => () => {}, emit: () => {} };
let el: HTMLElement;
let look: LookControl;

function pointer(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  const Ctor = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
  const e = new Ctor(type, { clientX: x, clientY: y, bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  el.dispatchEvent(e);
}

function drag(dx: number, dy: number, steps = 10) {
  pointer('pointerdown', 400, 300);
  for (let i = 1; i <= steps; i++) pointer('pointermove', 400 + (dx * i) / steps, 300 + (dy * i) / steps);
  pointer('pointerup', 400 + dx, 300 + dy);
}

const settle = (sec = 3) => {
  for (let i = 0; i < sec * 60; i++) look.update(1 / 60);
};

beforeEach(() => {
  el = document.createElement('div');
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 600 });
  document.body.append(el);
  look = createLookControl({ element: el, events: bus, now: () => 0 }, { mode: 'drag', gyro: false });
  look.setEnabled(true);
});

afterEach(() => {
  look.dispose();
  el.remove();
});

describe('CAM-1 見回し（ドラッグ）', () => {
  it('最初は正面', () => {
    expect(look.look.yaw).toBe(0);
    expect(look.look.pitch).toBe(0);
  });

  it('左へドラッグすると右を向く（景色をつかんで動かす）、上へドラッグすると下を向く', () => {
    drag(-200, 0);
    settle();
    expect(look.look.yaw).toBeLessThan(-5 * DEG);
    drag(0, -150);
    settle();
    expect(look.look.pitch).toBeLessThan(-3 * DEG);
  });

  it('左右 ±120°、上下 ±60° に収める', () => {
    for (let i = 0; i < 20; i++) drag(3000, 3000);
    settle();
    expect(Math.abs(look.look.yaw)).toBeLessThanOrEqual(CAMERA.yawRangeDeg * DEG + 1e-6);
    expect(Math.abs(look.look.pitch)).toBeLessThanOrEqual(CAMERA.pitchRangeDeg * DEG + 1e-6);
    expect(Math.abs(look.look.yaw)).toBeGreaterThan(100 * DEG);
  });

  it('無効のあいだは動かない', () => {
    look.setEnabled(false);
    drag(-300, 0);
    settle();
    expect(look.look.yaw).toBe(0);
  });

  it('dispose の後は出来事を受けない', () => {
    look.dispose();
    drag(-300, 0);
    expect(look.look.yaw).toBe(0);
  });
});

describe('CAM-1 見回し（マウスの位置に追従）', () => {
  it('右端を指すと右、左端を指すと左、中央で正面', () => {
    look.setOptions({ mode: 'follow', gyro: false });
    pointer('pointermove', 790, 300, { buttons: 0 });
    settle();
    expect(look.look.yaw).toBeLessThan(-20 * DEG);
    pointer('pointermove', 10, 300, { buttons: 0 });
    settle();
    expect(look.look.yaw).toBeGreaterThan(20 * DEG);
    pointer('pointermove', 400, 300, { buttons: 0 });
    settle();
    expect(Math.abs(look.look.yaw)).toBeLessThan(2 * DEG);
  });
});

describe('INT-5 正面へやさしく戻す', () => {
  it('指定の秒をかけて正面へ戻る（途中は間の角度）', () => {
    drag(-400, 0);
    settle();
    const start = look.look.yaw;
    expect(Math.abs(start)).toBeGreaterThan(20 * DEG);
    look.recenter(undefined, 1.2);
    for (let i = 0; i < 18; i++) look.update(1 / 60);
    expect(Math.abs(look.look.yaw)).toBeLessThan(Math.abs(start));
    expect(Math.abs(look.look.yaw)).toBeGreaterThan(0.01 * DEG);
    settle(1.5);
    expect(Math.abs(look.look.yaw)).toBeLessThan(0.5 * DEG);
  });

  it('見どころの方向へ向けることもできる', () => {
    look.recenter({ yaw: 30 * DEG, pitch: 10 * DEG }, 1);
    settle(1.5);
    expect(look.look.yaw).toBeCloseTo(30 * DEG, 2);
    expect(look.look.pitch).toBeCloseTo(10 * DEG, 2);
  });
});

describe('CAM-2 端末の傾き', () => {
  function orient(alpha: number, beta: number, gamma: number) {
    const e = new Event('deviceorientation');
    Object.assign(e, { alpha, beta, gamma, absolute: false });
    window.dispatchEvent(e);
  }

  it('縦持ちで端末を左へ回すと左を向く（最初の向きが正面）', () => {
    look.setOptions({ mode: 'drag', gyro: true });
    orient(100, 90, 0);
    settle(0.5);
    orient(130, 90, 0);
    settle();
    expect(look.look.yaw).toBeGreaterThan(25 * DEG);
    expect(look.look.yaw).toBeLessThan(35 * DEG);
  });

  it('傾きを使わない設定では無視する', () => {
    orient(100, 90, 0);
    orient(160, 90, 0);
    settle();
    expect(look.look.yaw).toBe(0);
  });
});

describe('INT-5 追従モードで正面へ戻した後の引き継ぎ（2巡目のレビューで見つかった振れをテストにしたもの）', () => {
  const DEG2 = Math.PI / 180;
  const move = (x: number, y: number) => pointer('pointermove', x, y, { buttons: 0 });
  const recenteredAtRightEdge = () => {
    look.setOptions({ mode: 'follow', gyro: false });
    move(790, 300);
    settle();
    look.recenter(undefined, 1.2);
    settle(5);
    expect(Math.abs(look.look.yaw)).toBeLessThan(1 * DEG2);
  };

  it('縦だけに動かしても横に振れない（yaw の変化 2° 以内）', () => {
    recenteredAtRightEdge();
    const yaw0 = look.look.yaw;
    let worst = 0;
    for (let i = 1; i <= 15; i++) {
      move(790, 300 - i * 10);
      for (let f = 0; f < 6; f++) {
        look.update(1 / 60);
        worst = Math.max(worst, Math.abs(look.look.yaw - yaw0));
      }
    }
    expect(worst).toBeLessThanOrEqual(2 * DEG2);
  });

  it('左へ動かすと、景色は一度も右へ戻らず左へ進み、左端では左を向く', () => {
    recenteredAtRightEdge();
    let prev = look.look.yaw;
    for (let i = 1; i <= 40; i++) {
      move(790 - i * 19.5, 300);
      for (let f = 0; f < 6; f++) {
        look.update(1 / 60);
        expect(look.look.yaw, `step ${i}`).toBeGreaterThanOrEqual(prev - 0.5 * DEG2);
        prev = Math.max(prev, look.look.yaw);
      }
    }
    settle();
    expect(look.look.yaw).toBeGreaterThan(20 * DEG2);
  });

  it('戻している途中で大きく動かして打ち切っても、マウスと逆向きに振れない', () => {
    look.setOptions({ mode: 'follow', gyro: false });
    move(790, 300);
    settle();
    look.recenter(undefined, 1.2);
    for (let f = 0; f < 18; f++) look.update(1 / 60);
    let prev = look.look.yaw;
    for (let i = 1; i <= 20; i++) {
      move(790 - i * 15, 300);
      for (let f = 0; f < 6; f++) {
        look.update(1 / 60);
        expect(look.look.yaw, `step ${i}`).toBeGreaterThanOrEqual(prev - 0.5 * DEG2);
        prev = Math.max(prev, look.look.yaw);
      }
    }
  });
});
