// S-23 VR（親が作成。実装担当は変更しない）
// セッション・描画は e2e/xr.spec.ts（IWER）で確かめる。ここは純粋な計算と、VR がない環境での振る舞い。
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Touchable } from '../contracts/room';
import { CAMERA, INTERACTION, XR } from '../config';
import { createXRSystem, fingertipHits, menuPose, recenterYaw, referenceSpaceFor, rigHeightOffset, vignetteFor } from './index';

const DEG = Math.PI / 180;

function touchable(id: string, pos: [number, number, number], radius = 0.3, enabled = true): Touchable {
  const o = new THREE.Object3D();
  o.position.set(...pos);
  o.updateMatrixWorld(true);
  return { id, kind: 'star', section: 'celestial', object: o, radius, enabled, setHighlight() {}, onTouch() {} };
}

describe('CAM-3 座る / 立つ', () => {
  it('座って乗るなら local、立って乗るなら local-floor', () => {
    expect(referenceSpaceFor('seated')).toBe('local');
    expect(referenceSpaceFor('standing')).toBe('local-floor');
  });

  it('頭の高さに関わらず、目が座席の目の高さに来るように台の高さを合わせる', () => {
    expect(rigHeightOffset('seated', 0)).toBeCloseTo(CAMERA.seatEyeHeight, 6);
    expect(rigHeightOffset('standing', 1.62)).toBeCloseTo(CAMERA.seatEyeHeight - 1.62, 6);
    expect(rigHeightOffset('seated', 0.1)).toBeCloseTo(CAMERA.seatEyeHeight - 0.1, 6);
  });

  it('頭の高さが分からないときは、座るなら 0、立つなら 1.6m とみなす', () => {
    expect(rigHeightOffset('seated', null)).toBeCloseTo(CAMERA.seatEyeHeight, 6);
    expect(rigHeightOffset('standing', null)).toBeCloseTo(CAMERA.seatEyeHeight - 1.6, 6);
  });

  it('正面の合わせ直し: 頭の向きを打ち消す向き（-π〜π）', () => {
    expect(recenterYaw(30 * DEG)).toBeCloseTo(-30 * DEG, 6);
    expect(recenterYaw(350 * DEG)).toBeCloseTo(10 * DEG, 6);
  });
});

describe('INT-1（VR）指先で触れる', () => {
  it('指先と物の表面の距離が xrTouchDistance 以内なら触れる', () => {
    const a = touchable('a', [0, 1, -0.5], 0.2);
    const tip: [number, number, number] = [0, 1, -0.5 + 0.2 + INTERACTION.xrTouchDistance * 0.9];
    const hits = fingertipHits([tip], [a]);
    expect(hits).toHaveLength(1);
    expect(hits[0].touchable).toBe(a);
    expect(hits[0].tip).toBe(0);
  });

  it('離れている物・無効の物には触れない', () => {
    const far = touchable('far', [0, 1, -2], 0.2);
    const off = touchable('off', [0, 1, -0.5], 0.2, false);
    expect(fingertipHits([[0, 1, -0.5]], [far, off])).toEqual([]);
  });

  it('指先ごとに最も近い物を1つ', () => {
    const a = touchable('a', [0, 1, -0.5], 0.1);
    const b = touchable('b', [0, 1, -0.62], 0.1);
    const hits = fingertipHits(
      [
        [0, 1, -0.45],
        [5, 5, 5],
      ],
      [b, a],
    );
    expect(hits.map((h) => h.touchable.id)).toEqual(['a']);
  });
});

describe('CAM-3 移動中の外周の暗さ', () => {
  it('止まっていれば 0、動くと強まり、設定の強さを超えない', () => {
    expect(vignetteFor(0, 0, 0.5)).toBe(0);
    const slow = vignetteFor(0.5, 0, 0.5);
    const fast = vignetteFor(2, 0, 0.5);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow);
    expect(vignetteFor(3, 15, 0.5)).toBeLessThanOrEqual(0.5);
    expect(vignetteFor(1, 10, 0.5)).toBeGreaterThan(vignetteFor(1, 0, 0.5));
    expect(vignetteFor(3, 15, 0)).toBe(0);
  });
});

describe('VR のメニュー', () => {
  it('手を伸ばした先（1.2m）の、目より少し下に、頭の方を向いて出す', () => {
    const p = menuPose({ x: 1, y: 1.5, z: 2, yaw: 90 * DEG });
    // yaw 90° は左（-X）を向いている
    expect(Math.hypot(p.x - 1, p.z - 2)).toBeCloseTo(XR.menuDistance, 6);
    expect(p.x).toBeCloseTo(1 - XR.menuDistance, 6);
    expect(p.y).toBeLessThan(1.5);
    expect(p.y).toBeGreaterThan(1.5 - 0.5);
    expect(p.yaw).toBeCloseTo(90 * DEG, 6);
  });
});

describe('VR がない環境', () => {
  it('isSupported は false、enter は失敗し、台は名前つきの Object3D', async () => {
    const renderer = { xr: { enabled: false } } as unknown as THREE.WebGPURenderer;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const xr = createXRSystem(renderer, { scene, camera, events: { on: () => () => {}, emit() {} }, now: () => 0 });
    expect(await xr.isSupported()).toBe(false);
    expect(xr.active).toBe(false);
    await expect(xr.enter('seated')).rejects.toThrow();
    expect(xr.rig.isObject3D).toBe(true);
    expect(() => xr.setVignette(2)).not.toThrow();
  });
});

describe('TRN-2 画面から VR への白い霧は、動きの曲線（glassEase）で晴れる（ADR-0011。S-28）', () => {
  it('始まりは真っ白、TRANSITION_SEC.screenToVR で晴れきり、途中は 1 − glassEase', async () => {
    const { whiteoutOpacity } = await import('./index');
    const { glassEase } = await import('../core/transition/curve');
    const { TRANSITION_SEC } = await import('../config');
    const T = TRANSITION_SEC.screenToVR;
    expect(whiteoutOpacity(0)).toBeCloseTo(1, 9);
    expect(whiteoutOpacity(T)).toBeCloseTo(0, 9);
    expect(whiteoutOpacity(T * 2)).toBe(0);
    expect(whiteoutOpacity(-1)).toBe(1);
    for (const k of [0.1, 0.25, 0.5, 0.75, 0.9]) expect(whiteoutOpacity(T * k), `k=${k}`).toBeCloseTo(1 - glassEase(k), 9);
  });
});
