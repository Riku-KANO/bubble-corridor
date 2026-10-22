// S-29 環境画像のノードは 1 つで、部屋が変わるときは中の画像だけを替える（実装担当が追加。ADR-0014）。
// PMREM の作成は描画器が要るので、three の生成器の口を差し替えて、ノードと scene の状態の動きだけを確かめる
import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvironmentSlot } from './environment';

function fakePmrem(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(4, 4);
  target.texture.name = 'fake.pmrem';
  return target;
}

function equirect(name: string): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  t.name = name;
  return t;
}

afterEach(() => vi.restoreAllMocks());

describe('環境画像の入れ物', () => {
  it('最初から環境画像のノードを場面に置く（scene.environment は使わない）。画像が来るまでは反射の強さ 0', () => {
    vi.spyOn(THREE.PMREMGenerator.prototype, 'fromEquirectangular').mockImplementation(() => fakePmrem());
    const scene = new THREE.Scene();
    createEnvironmentSlot(scene, {} as THREE.WebGPURenderer);
    expect((scene as THREE.Scene & { environmentNode?: { isNode?: boolean } }).environmentNode?.isNode).toBe(true);
    expect(scene.environment).toBeNull();
    expect(scene.environmentIntensity).toBe(0);
  });

  it('部屋の画像は、ノードの値を替えるだけ（ノードは同じ）。画像の PMREM は一度だけ作り、同じ画像なら何もしない', () => {
    const spy = vi.spyOn(THREE.PMREMGenerator.prototype, 'fromEquirectangular').mockImplementation(() => fakePmrem());
    const scene = new THREE.Scene();
    const slot = createEnvironmentSlot(scene, {} as THREE.WebGPURenderer);
    const node = (scene as THREE.Scene & { environmentNode: { value: THREE.Texture } }).environmentNode;
    const afterInit = spy.mock.calls.length; // 入れ物の黒い画像ぶん

    const a = equirect('a');
    slot.prepare(a); // 先に作る
    expect(spy.mock.calls.length).toBe(afterInit + 1);
    slot.apply(a);
    expect(spy.mock.calls.length).toBe(afterInit + 1); // 作り済み
    expect(node.value.name).toBe('fake.pmrem');
    expect(scene.environmentIntensity).toBe(1);
    expect((scene as THREE.Scene & { environmentNode: unknown }).environmentNode).toBe(node);

    const b = equirect('b');
    slot.apply(b);
    expect(spy.mock.calls.length).toBe(afterInit + 2);
    slot.apply(b);
    slot.apply(a); // 戻しても作り直さない
    expect(spy.mock.calls.length).toBe(afterInit + 2);
    expect((scene as THREE.Scene & { environmentNode: unknown }).environmentNode).toBe(node);
  });

  it('環境画像のない部屋は、反射の強さを 0 にする（ノードは外さない。外すと見えている材質がすべて作り直される）', () => {
    vi.spyOn(THREE.PMREMGenerator.prototype, 'fromEquirectangular').mockImplementation(() => fakePmrem());
    const scene = new THREE.Scene();
    const slot = createEnvironmentSlot(scene, {} as THREE.WebGPURenderer);
    const node = (scene as THREE.Scene & { environmentNode: unknown }).environmentNode;
    slot.apply(equirect('a'));
    slot.apply(null);
    expect(scene.environmentIntensity).toBe(0);
    expect((scene as THREE.Scene & { environmentNode: unknown }).environmentNode).toBe(node);
    slot.apply(equirect('b'));
    expect(scene.environmentIntensity).toBe(1);
  });

  it('PMREM を作れなかったら、その部屋は環境画像なしとして扱い、前の部屋の反射を残さない', () => {
    const spy = vi.spyOn(THREE.PMREMGenerator.prototype, 'fromEquirectangular').mockImplementation(() => fakePmrem());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new THREE.Scene();
    const slot = createEnvironmentSlot(scene, {} as THREE.WebGPURenderer);
    slot.apply(equirect('a'));
    expect(scene.environmentIntensity).toBe(1);
    spy.mockImplementation(() => {
      throw new Error('backend not initialized');
    });
    slot.apply(equirect('b'));
    expect(scene.environmentIntensity).toBe(0);
  });

  it('元の画像が解放されたら、反射用の画像も解放する', () => {
    const targets: THREE.RenderTarget[] = [];
    vi.spyOn(THREE.PMREMGenerator.prototype, 'fromEquirectangular').mockImplementation(() => {
      const t = fakePmrem();
      targets.push(t);
      return t;
    });
    const scene = new THREE.Scene();
    const slot = createEnvironmentSlot(scene, {} as THREE.WebGPURenderer);
    const a = equirect('a');
    slot.apply(a);
    const made = targets.at(-1)!;
    const disposed = vi.fn();
    made.addEventListener('dispose', disposed);
    a.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('使っている画像が解放されたら、ノードは入れ物の画像へ戻り、反射の強さは 0（解放済みの画像を指したままにならない）', () => {
    vi.spyOn(THREE.PMREMGenerator.prototype, 'fromEquirectangular').mockImplementation(() => fakePmrem());
    const scene = new THREE.Scene();
    const slot = createEnvironmentSlot(scene, {} as THREE.WebGPURenderer);
    const node = (scene as THREE.Scene & { environmentNode: { value: THREE.Texture } }).environmentNode;
    const placeholderPmrem = node.value;
    const a = equirect('a');
    slot.apply(a);
    expect(node.value).not.toBe(placeholderPmrem);
    a.dispose();
    expect(node.value).toBe(placeholderPmrem);
    expect(scene.environmentIntensity).toBe(0);
    // 同じ画像をもう一度渡すと、作り直して使える
    const b = equirect('b');
    slot.apply(b);
    expect(scene.environmentIntensity).toBe(1);
  });
});
