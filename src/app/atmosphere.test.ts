// S-29 霧は null にせず、霧のない部屋では距離だけを遠くへ（実装担当が追加。ADR-0014: 霧と null の行き来で見えている材質がすべて作り直される）
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { FOG_OFF_FAR, FOG_OFF_NEAR, applyFog } from './atmosphere';

describe('部屋の霧', () => {
  it('霧のある部屋は、霧の物の色と距離を書き換える（物は作り直さない）', () => {
    const fog = new THREE.Fog(0xffffff, 1, 10);
    applyFog(fog, { background: 0, exposure: 1, fog: { color: 0x223047, near: 22, far: 120 } });
    expect(fog.color.getHex()).toBe(0x223047);
    expect(fog.near).toBe(22);
    expect(fog.far).toBe(120);
  });

  it('霧のない部屋は、霧の物を残したまま距離を描く範囲の外まで遠ざける（色はそのまま）', () => {
    const fog = new THREE.Fog(0x223047, 22, 120);
    applyFog(fog, { background: 0, exposure: 1 });
    expect(fog.color.getHex()).toBe(0x223047);
    expect(fog.near).toBe(FOG_OFF_NEAR);
    expect(fog.far).toBe(FOG_OFF_FAR);
    // 霧が掛かり始める距離は、カメラの描く範囲（far 2000 m）よりずっと遠い。係数は 0 のまま
    expect(FOG_OFF_NEAR).toBeGreaterThan(2000 * 10);
    expect(FOG_OFF_FAR).toBeGreaterThan(FOG_OFF_NEAR);
  });

  it('霧のある部屋 → ない部屋 → ある部屋でも、同じ霧の物が使える', () => {
    const fog = new THREE.Fog(0xffffff, 1, 10);
    applyFog(fog, { background: 0, exposure: 1, fog: { color: 0xb4c7d8, near: 30, far: 160 } });
    applyFog(fog, { background: 0, exposure: 1 });
    applyFog(fog, { background: 0, exposure: 1, fog: { color: 0x47515c, near: 12, far: 90 } });
    expect([fog.near, fog.far, fog.color.getHex()]).toEqual([12, 90, 0x47515c]);
  });
});
