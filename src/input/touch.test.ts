// @vitest-environment jsdom
// S-15 INT-1 / INT-2 / INT-4 触れる（親が作成。実装担当は変更しない）
import * as THREE from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus, RideEvents } from '../contracts/events';
import type { TouchInput } from '../contracts/input';
import type { Touchable } from '../contracts/room';
import { INTERACTION } from '../config';
import { createTouchInput } from './index';

let el: HTMLElement;
let input: TouchInput;
let emitted: { type: keyof RideEvents; payload: unknown }[];
let camera: THREE.PerspectiveCamera;
let now = 0;

const bus: EventBus = {
  on: () => () => {},
  emit(type, payload) {
    emitted.push({ type, payload });
  },
};

function makeTouchable(id: string, pos: [number, number, number], extra: Partial<Touchable> = {}) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicNodeMaterial());
  mesh.position.set(...pos);
  mesh.updateMatrixWorld(true);
  const t: Touchable & { highlight: number; touched: number } = {
    id,
    kind: 'leaf',
    section: 'greenhouse',
    object: mesh,
    radius: 0.5,
    enabled: true,
    idleChime: true,
    highlight: 0,
    touched: 0,
    setHighlight(v) {
      t.highlight = v;
    },
    onTouch() {
      t.touched++;
    },
    ...extra,
  };
  return t;
}

function click(x: number, y: number, moveBy = 0) {
  const Ctor = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
  const fire = (type: string, cx: number, cy: number) => {
    const e = new Ctor(type, { clientX: cx, clientY: cy, bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    el.dispatchEvent(e);
  };
  fire('pointerdown', x, y);
  if (moveBy) fire('pointermove', x + moveBy, y);
  fire('pointerup', x + moveBy, y);
}

beforeEach(() => {
  emitted = [];
  now = 12.5;
  el = document.createElement('div');
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 600 });
  document.body.append(el);
  camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.05, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  input = createTouchInput({ element: el, events: bus, now: () => now });
  input.setEnabled(true);
});

afterEach(() => {
  input.dispose();
  el.remove();
});

describe('INT-1 必ず応える', () => {
  it('クリックした物に、その出来事の中で応える（onTouch と touch イベント）', () => {
    const a = makeTouchable('greenhouse/leaf-1', [0, 0, -5]);
    input.setTouchables([a]);
    input.update(now, 1 / 60, camera, [0, 0, 0]);
    click(400, 300);
    expect(a.touched).toBe(1);
    const ev = emitted.find((e) => e.type === 'touch')?.payload as RideEvents['touch'];
    expect(ev).toMatchObject({ touchableId: 'greenhouse/leaf-1', kind: 'leaf', section: 'greenhouse', source: 'pointer', t: 12.5 });
    // 触れた点は物の表面（手前の面、z ≈ -4.5）
    expect(ev.position[2]).toBeGreaterThan(-4.7);
    expect(ev.position[2]).toBeLessThan(-4.3);
  });

  it('何もない所や、無効の物は反応しない', () => {
    const a = makeTouchable('a', [0, 0, -5]);
    const b = makeTouchable('b', [3, 0, -5], { enabled: false });
    input.setTouchables([a, b]);
    input.update(now, 1 / 60, camera, [0, 0, 0]);
    click(20, 20);
    expect(a.touched).toBe(0);
    // b の方向をクリック
    const p = new THREE.Vector3(3, 0, -5).project(camera);
    click(((p.x + 1) / 2) * 800, ((1 - p.y) / 2) * 600);
    expect(b.touched).toBe(0);
    expect(emitted.filter((e) => e.type === 'touch')).toEqual([]);
  });

  it('ドラッグ（見回し）は触れたことにしない', () => {
    const a = makeTouchable('a', [0, 0, -5]);
    input.setTouchables([a]);
    input.update(now, 1 / 60, camera, [0, 0, 0]);
    click(400, 300, 40);
    expect(a.touched).toBe(0);
  });

  it('手前の物を優先する', () => {
    const near = makeTouchable('near', [0, 0, -3]);
    const far = makeTouchable('far', [0, 0, -8]);
    input.setTouchables([far, near]);
    input.update(now, 1 / 60, camera, [0, 0, 0]);
    click(400, 300);
    expect(near.touched).toBe(1);
    expect(far.touched).toBe(0);
  });

  it('近づくと縁が光り、離れると消える', () => {
    const a = makeTouchable('a', [0, 0, -5]);
    input.setTouchables([a]);
    input.update(now, 1 / 60, camera, [0, 0, -5 + INTERACTION.highlightDistance - 1]);
    expect(a.highlight).toBeGreaterThan(0);
    input.update(now, 1 / 60, camera, [0, 0, -5 + INTERACTION.highlightDistance + 5]);
    expect(a.highlight).toBe(0);
  });

  it('無効のあいだは何もしない', () => {
    const a = makeTouchable('a', [0, 0, -5]);
    input.setTouchables([a]);
    input.setEnabled(false);
    input.update(now, 1 / 60, camera, [0, 0, 0]);
    click(400, 300);
    expect(a.touched).toBe(0);
  });
});

describe('INT-2 見つめて触れる', () => {
  const stare = (sec: number) => {
    const steps = Math.round(sec * 60);
    for (let i = 0; i < steps; i++) {
      now += 1 / 60;
      input.update(now, 1 / 60, camera, [0, 0, 0]);
    }
  };

  it('設定の秒数（1.2秒）見つめると一度だけ触れる', () => {
    const a = makeTouchable('a', [0, 0, -5]);
    input.setTouchables([a]);
    input.setGazeDwell(1.2);
    stare(1.1);
    expect(a.touched).toBe(0);
    stare(0.15);
    expect(a.touched).toBe(1);
    const ev = emitted.find((e) => e.type === 'touch')?.payload as RideEvents['touch'];
    expect(ev.source).toBe('gaze');
    stare(3);
    expect(a.touched).toBe(1);
  });

  it('視線が外れたら数え直す', () => {
    const a = makeTouchable('a', [0, 0, -5]);
    input.setTouchables([a]);
    input.setGazeDwell(0.8);
    stare(0.6);
    camera.lookAt(5, 0, -1);
    camera.updateMatrixWorld(true);
    stare(0.3);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld(true);
    stare(0.6);
    expect(a.touched).toBe(0);
    stare(0.3);
    expect(a.touched).toBe(1);
  });
});

describe('INT-4 何もしない人にも', () => {
  it('触れられないまま近づいた物は、一度だけ自分で鳴る合図を出す', () => {
    const a = makeTouchable('a', [0, 0, -5]);
    const quiet = makeTouchable('q', [2, 0, -5], { idleChime: false });
    input.setTouchables([a, quiet]);
    const chimed = vi.fn();
    input.onIdleChime(chimed);
    input.update(now, 1 / 60, camera, [0, 0, -5 + INTERACTION.idleChimeDistance + 3]);
    expect(chimed).not.toHaveBeenCalled();
    input.update(now, 1 / 60, camera, [0, 0, -5 + INTERACTION.idleChimeDistance - 0.5]);
    input.update(now, 1 / 60, camera, [0, 0, -5 + INTERACTION.idleChimeDistance - 1]);
    expect(chimed).toHaveBeenCalledTimes(1);
    expect(chimed.mock.calls[0][0]).toBe(a);
  });

  it('触れた物は自分で鳴らない', () => {
    const a = makeTouchable('a', [0, 0, -5]);
    input.setTouchables([a]);
    const chimed = vi.fn();
    input.onIdleChime(chimed);
    input.update(now, 1 / 60, camera, [0, 0, 0]);
    click(400, 300);
    input.update(now, 1 / 60, camera, [0, 0, -4.5]);
    expect(chimed).not.toHaveBeenCalled();
  });
});
