// Blender で造形して焼いた部屋（public/assets/rooms/<部屋>.glb とライトマップ）を読む道具。雨の回廊と万華鏡の間で使う。
// 手順は blender/README.md「焼き込みとライトマップ（three.js 側の使い方）」のとおり:
//   ・焼いた値は「反射の明るさ」。three の lightMap は拡散反射に 1/π を掛けて足すので、強さは π × lightmap_scale
//   ・ライトマップは 8bit の sRGB、2つ目の UV（channel 1）、glTF の UV に合わせて flipY = false（読み込み口が設定する）
//   ・材質は物ごとに作り直す（GLTFLoader は同じ材質を共有する物に同じ実体を渡すので、上書きし合わないように）
// 焼き込んだ物は焼いた光だけで照らす（動く光源は持たない。アプリが仮の部屋のために置いた環境光は受けない）。
import * as THREE from 'three/webgpu';
import { lights } from 'three/tsl';
import type { RoomContext } from '../../contracts/room';

export interface BlenderRoom {
  /** glb の場面の写し（部屋の root に足す）。読み込み口の写しを汚さないよう clone してある */
  readonly scene: THREE.Group;
  /** Blender の物の名前（userData.name）→ 物 */
  readonly byName: Map<string, THREE.Object3D>;
  /** 読んだライトマップ */
  readonly lightmaps: THREE.Texture[];
  /** 焼き込んだ物の材質（色を変える部屋がある）。解放は部屋が受け持つ */
  readonly baked: { readonly mesh: THREE.Mesh; readonly material: THREE.MeshStandardNodeMaterial }[];
}

/**
 * 部屋の glb とライトマップを読む。gain はライトマップの明るさの演出の倍率（README: 演出の明るさとして調整してよい）。
 * Blender の clearance_exempt（スネーク）を、テストと統合担当が読む userData.clearanceExempt（キャメル）にも写す。
 */
export async function loadBlenderRoom(ctx: RoomContext, name: string, gain = 1): Promise<BlenderRoom> {
  const gltf = await ctx.assets.gltf(`rooms/${name}.glb`);
  const scene = gltf.scene.clone(true);
  scene.name = `${name}.glb`;
  const byName = new Map<string, THREE.Object3D>();
  const lightmapPaths = new Set<string>();
  scene.traverse((o) => {
    const ud = o.userData;
    if (typeof ud.name === 'string') byName.set(ud.name, o);
    if (ud.clearance_exempt) ud.clearanceExempt = true;
    if (typeof ud.lightmap === 'string') lightmapPaths.add(ud.lightmap);
  });
  const textures = new Map<string, THREE.Texture>();
  await Promise.all(
    [...lightmapPaths].map(async (p) => {
      const tex = await ctx.assets.texture(`rooms/${p}`);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.channel = 1;
      tex.needsUpdate = true;
      textures.set(p, tex);
    }),
  );
  const baked: { mesh: THREE.Mesh; material: THREE.MeshStandardNodeMaterial }[] = [];
  scene.traverse((o) => {
    const ud = o.userData;
    if (typeof ud.lightmap !== 'string') return;
    const tex = textures.get(ud.lightmap);
    const scale = Number(ud.lightmap_scale);
    if (!tex || !(scale > 0)) return;
    const meshes = (o as THREE.Mesh).isMesh ? [o as THREE.Mesh] : o.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
    for (const mesh of meshes) {
      const src = mesh.material as THREE.MeshStandardMaterial;
      const m = new THREE.MeshStandardNodeMaterial({
        color: src.color,
        roughness: src.roughness,
        metalness: src.metalness,
        side: src.side,
      });
      m.name = `${ud.name ?? mesh.name}.baked`;
      m.lightMap = tex;
      m.lightMapIntensity = Math.PI * scale * gain;
      // 焼いた光だけで照らす（シーンの光源を受けない。環境画像の反射は部屋が自分で足す）
      m.lightsNode = lights([]);
      mesh.material = m;
      baked.push({ mesh, material: m });
    }
  });
  return { scene, byName, lightmaps: [...textures.values()], baked };
}

/** userData の条件に合う物の一覧 */
export function findAll(root: THREE.Object3D, pred: (ud: Record<string, unknown>, o: THREE.Object3D) => boolean): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (pred(o.userData, o)) out.push(o);
  });
  return out;
}

/**
 * Blender でリンク複製した物（userData.instance が key）を1つのインスタンス描画にまとめる。
 * 元の物は外す。インスタンスの行列は root から見た行列（テストの物との距離はインスタンスごとの箱で測られる）。
 */
export function instancesFrom(root: THREE.Object3D, key: string, material: THREE.Material): THREE.InstancedMesh | null {
  const found = findAll(root, (ud, o) => ud.instance === key && (o as THREE.Mesh).isMesh) as THREE.Mesh[];
  if (found.length === 0) return null;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const im = new THREE.InstancedMesh(found[0].geometry, material, found.length);
  const m = new THREE.Matrix4();
  found.forEach((o, i) => {
    m.multiplyMatrices(inv, o.matrixWorld);
    im.setMatrixAt(i, m);
    o.removeFromParent();
  });
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.name = key;
  im.userData = { ...found[0].userData, name: undefined, instances: found.length };
  return im;
}

/**
 * 部屋の物を解放する。形は root の下をすべて、材質・ガラスのハンドル・画像は渡した物だけ
 * （共有のガラス（sharedGlass）はハンドルの dispose で数を減らす。材質を直接 dispose すると、ほかの部屋の物まで壊す）。
 */
export function disposeTree(root: THREE.Object3D, owned: readonly { dispose(): void }[] = []): void {
  const geos = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) geos.add(mesh.geometry as THREE.BufferGeometry);
  });
  for (const g of geos) g.dispose();
  for (const e of owned) e.dispose();
  root.clear();
}

/** 種を固定した乱数（mulberry32）。部屋の配置は毎回同じになる */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
