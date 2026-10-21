// S-24 INT-4「何もしない人にも」: 触れられないまま近づいた物が一度だけ自分で鳴る。
// 入力の種類に依らない（画面でも VR でも同じ）ので、統合担当が持つ（親が作成。実装担当は変更しない）。
import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { Touchable } from '../contracts/room';
import { INTERACTION } from '../config';
import { createIdleChimer } from './idle-chime';

function touchable(id: string, pos: [number, number, number], extra: Partial<Touchable> = {}): Touchable {
  const o = new THREE.Object3D();
  o.position.set(...pos);
  o.updateMatrixWorld(true);
  return { id, kind: 'leaf', section: 'greenhouse', object: o, radius: 0.2, enabled: true, idleChime: true, setHighlight() {}, onTouch() {}, ...extra };
}

describe('INT-4 自分で鳴る合図', () => {
  const D = INTERACTION.idleChimeDistance;

  it('近づいた物（表面までの距離）が一度だけ鳴る', () => {
    const fn = vi.fn();
    const c = createIdleChimer(fn);
    const a = touchable('a', [0, 0, -10]);
    c.update([0, 0, -10 + D + 3], [a]);
    expect(fn).not.toHaveBeenCalled();
    c.update([0, 0, -10 + D + 0.1], [a]); // 中心までは D+0.1、表面までは D-0.1
    c.update([0, 0, -10 + 1], [a]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe(a);
  });

  it('触れた物・idleChime でない物・無効の物・見えない物は鳴らない', () => {
    const fn = vi.fn();
    const c = createIdleChimer(fn);
    const touched = touchable('t', [0, 0, -1]);
    const quiet = touchable('q', [0.5, 0, -1], { idleChime: false });
    const off = touchable('o', [-0.5, 0, -1], { enabled: false });
    const hidden = touchable('h', [0, 0.5, -1]);
    hidden.object.visible = false;
    c.touched('t');
    c.update([0, 0, 0], [touched, quiet, off, hidden]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('新しい乗車では数え直す', () => {
    const fn = vi.fn();
    const c = createIdleChimer(fn);
    const a = touchable('a', [0, 0, -1]);
    c.update([0, 0, 0], [a]);
    c.reset();
    c.update([0, 0, 0], [a]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
