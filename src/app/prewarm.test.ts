// S-29 部屋のシェーダーの先読み（純粋な部分。実装担当が追加）。three の描画そのものは e2e/prewarm.spec.ts が確かめる
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { isDoublePass, scanReflectorMaterials, scanReflectors } from './prewarm';

/** TSL の水面の映り込み（ReflectorNode）の代わり。節点の木をたどる口と型の名前だけ持つ */
class FakeReflectorNode {
  static readonly type = 'ReflectorNode';
  readonly isNode = true;
  constructor(readonly reflector: { samples: number }) {}
  traverse(cb: (n: unknown) => void): void {
    cb(this);
  }
}

/** 子の節点を持つ節点（mix や vec4 の代わり） */
class FakeNode {
  static readonly type = 'MathNode';
  readonly isNode = true;
  constructor(readonly children: { traverse(cb: (n: unknown) => void): void }[]) {}
  traverse(cb: (n: unknown) => void): void {
    cb(this);
    for (const c of this.children) c.traverse(cb);
  }
}

function meshWith(material: unknown): THREE.Object3D {
  const o = new THREE.Object3D();
  (o as unknown as { material: unknown }).material = material;
  return o;
}

describe('水面の映り込み（reflector）を材質から見つける', () => {
  it('材質の節点の奥にある reflector の、描画先の多重標本の数と、その材質を返す', () => {
    const water = { colorNode: new FakeNode([new FakeNode([new FakeReflectorNode({ samples: 4 })])]) };
    const plain = { colorNode: new FakeNode([]) };
    const root = new THREE.Group();
    root.add(meshWith(water), meshWith(plain));
    const scan = scanReflectors(root);
    expect(scan.samples).toEqual([4]);
    expect(scan.materials.has(water)).toBe(true);
    expect(scan.materials.has(plain)).toBe(false);
  });

  it('多重標本の数が違う reflector は別々に返し、同じ数は1つにまとめる。多重標本の指定がなければ 0', () => {
    const root = new THREE.Group();
    root.add(
      meshWith({ colorNode: new FakeReflectorNode({ samples: 4 }) }),
      meshWith({ colorNode: new FakeReflectorNode({ samples: 4 }) }),
      meshWith({ colorNode: new FakeReflectorNode({ samples: 0 }) }),
      meshWith({ emissiveNode: new FakeReflectorNode({} as { samples: number }) }),
    );
    expect(scanReflectors(root).samples.sort()).toEqual([0, 4]);
  });

  it('材質の配列と、節点でない値（数・null・色）を持つ材質でも壊れない。reflector がなければ空', () => {
    const root = new THREE.Group();
    root.add(meshWith([{ color: new THREE.Color(1, 0, 0), opacity: 1, colorNode: null }, { colorNode: new FakeNode([]) }]), new THREE.Object3D());
    const scan = scanReflectors(root);
    expect(scan.samples).toEqual([]);
    expect(scan.materials.size).toBe(0);
  });
});

describe('材質の一覧から reflector を見つける', () => {
  it('どの物にも付いていない材質（差し替える前の水面の材質）でも見つかる', () => {
    const waterBeforeSwap = { colorNode: new FakeNode([new FakeReflectorNode({ samples: 4 })]) };
    const cheap = { colorNode: new FakeNode([]) };
    const scan = scanReflectorMaterials([cheap, waterBeforeSwap, waterBeforeSwap]);
    expect(scan.samples).toEqual([4]);
    expect([...scan.materials]).toEqual([waterBeforeSwap]);
  });
});

describe('2回に分けて描く材質（透明で両面）', () => {
  it('透明で両面（forceSinglePass でない）だけが当たる。ゴンドラの殻の白いヴェールの原因（compileAsync が両面用のシェーダーを作る）', () => {
    const mesh = (m: Partial<THREE.Material>) => meshWith(m);
    expect(isDoublePass(mesh({ transparent: true, side: THREE.DoubleSide }))).toBe(true);
    expect(isDoublePass(mesh({ transparent: true, side: THREE.DoubleSide, forceSinglePass: true } as Partial<THREE.Material>))).toBe(false);
    expect(isDoublePass(mesh({ transparent: false, side: THREE.DoubleSide }))).toBe(false);
    expect(isDoublePass(mesh({ transparent: true, side: THREE.FrontSide }))).toBe(false);
    expect(isDoublePass(mesh({ transparent: true, side: THREE.BackSide }))).toBe(false);
    expect(isDoublePass(new THREE.Object3D())).toBe(false);
  });

  it('材質の配列は、1つでも当たれば当たる', () => {
    const o = meshWith([{ transparent: false, side: THREE.FrontSide }, { transparent: true, side: THREE.DoubleSide }]);
    expect(isDoublePass(o)).toBe(true);
  });
});
