// 部屋C（星の天球・夜明けの岸）で共有する道具。
// - Blender の glb を読み、extras（userData）を部屋の決まりに写す（clearance_exempt → clearanceExempt）
// - 焼き込んだ物にライトマップを付ける（blender/README.md「焼き込みとライトマップ」の手順どおり）
// - 同じ形の物（真鍮の輪の弧）を InstancedMesh にまとめる
// - 種を固定した乱数、見どころへの光の粒（誘導）、大きな殻や膜の形を半径 1 にそろえる
import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, mix, sin, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { RoomContext } from '../../contracts/room';

/** 種を固定した乱数（mulberry32）。0 以上 1 未満 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ライトマップの名前（glb の extras）。自サイトの rooms/ の下の PNG だけを許す */
const LIGHTMAP_NAME = /^[a-z0-9_.-]+\.png$/;

/**
 * glb を読んで写しを返す（アセットの読み込み口は同じパスに同じ物を返すので、材質の差し替えで元を汚さない）。
 * Blender のカスタムプロパティ clearance_exempt を、テストと統合担当が見る userData.clearanceExempt に写す。
 */
export async function loadRoomScene(ctx: RoomContext, path: string): Promise<THREE.Object3D> {
  const g = await ctx.assets.gltf(path);
  const scene = g.scene.clone(true);
  scene.traverse((o) => {
    if (o.userData.clearance_exempt === true) o.userData.clearanceExempt = true;
  });
  scene.updateMatrixWorld(true);
  return scene;
}

/** 物の名前（Blender の名前。GLTFLoader が userData.name に残す） */
export function nameOf(o: THREE.Object3D): string {
  return typeof o.userData.name === 'string' ? o.userData.name : o.name;
}

/** 物（材質が複数なら Group の下に並ぶ）のメッシュ */
export function meshesOf(o: THREE.Object3D): THREE.Mesh[] {
  if ((o as THREE.Mesh).isMesh) return [o as THREE.Mesh];
  return o.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && c.userData.name === undefined);
}

/** ライトマップを付けられる材質（MeshStandardMaterial・MeshStandardNodeMaterial など） */
export type LightMapped = THREE.Material & { lightMap: THREE.Texture | null; lightMapIntensity: number };

export interface BakedMesh {
  readonly object: THREE.Object3D;
  readonly mesh: THREE.Mesh;
  /** 付けたライトマップ */
  readonly lightMap: THREE.Texture;
  /** 線形の光 = 画像を線形に直した値 × scale */
  readonly scale: number;
}

/**
 * 焼き込んだ物（extras の lightmap・lightmap_scale）にライトマップを付ける。
 * 材質は物ごとに makeMaterial で新しく作る（GLTFLoader は同じ材質を共有する物に同じ実体を渡すので、
 * 共有のまま lightMap を書くと最後の物のライトマップで上書きされる）。
 * Blender で焼いた値は反射の明るさ（放射輝度）なので、three の lightMap（拡散反射に 1/π）に合わせて π を掛ける。
 */
export async function applyLightmaps(
  ctx: RoomContext,
  root: THREE.Object3D,
  makeMaterial: (object: THREE.Object3D, mesh: THREE.Mesh) => LightMapped,
  textures: THREE.Texture[],
): Promise<BakedMesh[]> {
  const targets: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (typeof o.userData.lightmap === 'string' && LIGHTMAP_NAME.test(o.userData.lightmap)) targets.push(o);
  });
  const cache = new Map<string, Promise<THREE.Texture>>();
  const load = (name: string) => {
    let p = cache.get(name);
    if (!p) {
      p = ctx.assets.texture(`rooms/${name}`).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace; // 8bit の sRGB（線形に直して使う）
        t.flipY = false; // glTF の UV に合わせる
        t.channel = 1; // 2つ目の UV（TEXCOORD_1）
        t.needsUpdate = true;
        textures.push(t);
        return t;
      });
      cache.set(name, p);
    }
    return p;
  };
  const out: BakedMesh[] = [];
  for (const o of targets) {
    const tex = await load(o.userData.lightmap as string);
    const raw = Number(o.userData.lightmap_scale);
    const scale = Number.isFinite(raw) && raw > 0 ? raw : 1;
    for (const mesh of meshesOf(o)) {
      const m = makeMaterial(o, mesh);
      m.lightMap = tex;
      m.lightMapIntensity = Math.PI * scale;
      mesh.material = m;
      out.push({ object: o, mesh, lightMap: tex, scale });
    }
  }
  return out;
}

/**
 * 同じ形を共有する物（extras の instance_group が同じ物）を InstancedMesh 1つにまとめる（描く回数を減らす）。
 * 弧ごとの箱が残るので、レールとの距離（RIDE-8）は弧ごとに測られる。元の物は外す。
 */
export function mergeInstanceGroups(root: THREE.Object3D, material: (group: string) => THREE.Material): THREE.InstancedMesh[] {
  const groups = new Map<string, THREE.Mesh[]>();
  root.traverse((o) => {
    const g = o.userData.instance_group;
    if (typeof g === 'string' && (o as THREE.Mesh).isMesh) {
      const list = groups.get(g) ?? [];
      list.push(o as THREE.Mesh);
      groups.set(g, list);
    }
  });
  const out: THREE.InstancedMesh[] = [];
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  for (const [group, meshes] of groups) {
    // 形が同じ物ごとに（弧の大きさが違う輪は別の形）
    const byGeo = new Map<THREE.BufferGeometry, THREE.Mesh[]>();
    for (const mesh of meshes) byGeo.set(mesh.geometry, [...(byGeo.get(mesh.geometry) ?? []), mesh]);
    for (const [geo, list] of byGeo) {
      const im = new THREE.InstancedMesh(geo, material(group), list.length);
      im.name = `${group}`;
      im.userData = { role: list[0].userData.role ?? group, instanceGroup: group };
      list.forEach((mesh, i) => {
        im.setMatrixAt(i, m.multiplyMatrices(inv, mesh.matrixWorld));
        mesh.removeFromParent();
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      root.add(im);
      out.push(im);
    }
  }
  return out;
}

/** Sprite の板（中心 0、一辺 1、uv 付き）。Sprite が共有する形を使わず、部屋ごとに作って解放する */
export function spriteQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  return g;
}

/**
 * 見どころへの光の粒（誘導の出来事で、見どころの方向へ流して視線を誘う）。
 * 時刻から決める: [t0, t1] のあいだ、from（ゴンドラの少し前）から to（見どころ）へ粒が流れる。
 */
export interface LureStream {
  readonly object: THREE.Sprite;
  update(t: number, from: THREE.Vector3, to: THREE.Vector3, reducedFlash: boolean): void;
  dispose(): void;
}

export function createLureStream(t0: number, t1: number, color: THREE.ColorRepresentation, count = 28): LureStream {
  const rand = seededRandom(0x1a2e);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = i / count; // 流れの位相
    seeds[i * 4 + 1] = rand() * 2 - 1; // 横のずれ
    seeds[i * 4 + 2] = rand() * 2 - 1; // 縦のずれ
    seeds[i * 4 + 3] = 0.6 + rand() * 0.8; // 大きさ
  }
  const aSeed = instancedBufferAttribute<'vec4'>(new THREE.InstancedBufferAttribute(seeds, 4), 'vec4');
  const uTime = uniform(0);
  const uFrom = uniform(new THREE.Vector3());
  const uTo = uniform(new THREE.Vector3());
  const uSide = uniform(new THREE.Vector3(1, 0, 0));
  const uAmount = uniform(0);
  const uColor = uniform(new THREE.Color(color));
  const span = t1 - t0;
  // 粒は 1.6 秒で from から to へ。途中は横と縦にふくらむ弧を描く
  const phase = aSeed.x.add(uTime.sub(t0).div(1.6)).fract();
  const bow = sin(phase.mul(Math.PI));
  const pos = mix(uFrom, uTo, phase.mul(phase).mul(0.35).add(phase.mul(0.65)))
    .add(uSide.mul(aSeed.y.mul(bow).mul(1.6)))
    .add(vec3(0, 1, 0).mul(aSeed.z.mul(bow).mul(0.9)));
  const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  material.positionNode = pos;
  material.scaleNode = aSeed.w.mul(0.16).mul(float(1).add(phase.mul(1.5)));
  const d = uv().sub(0.5).length().mul(2);
  const glow = smoothstep(1, 0, d).pow(2.2);
  material.colorNode = vec4(uColor.mul(glow).mul(bow).mul(uAmount), 1);
  const geometry = spriteQuad();
  const object = new THREE.Sprite(material);
  object.geometry = geometry;
  object.count = count;
  object.frustumCulled = false;
  object.renderOrder = 5;
  object.userData.clearanceExempt = true;
  object.visible = false;
  const tmp = new THREE.Vector3();
  return {
    object,
    update(t, from, to, reducedFlash) {
      // 出ている間だけ描く（前後 0.4 秒で現れて消える）
      const k = span > 0 ? Math.min(Math.max((t - t0) / 0.4, 0), 1) * Math.min(Math.max((t1 - t) / 0.4, 0), 1) : 0;
      object.visible = k > 0;
      if (!object.visible) return;
      uTime.value = t;
      (uFrom.value as THREE.Vector3).copy(from);
      (uTo.value as THREE.Vector3).copy(to);
      tmp.subVectors(to, from).cross(THREE.Object3D.DEFAULT_UP);
      if (tmp.lengthSq() > 1e-6) (uSide.value as THREE.Vector3).copy(tmp.normalize());
      uAmount.value = k * (reducedFlash ? 1.2 : 2.6);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * 形を、中心 0・半径 1 の写しに直して物の位置と大きさで戻す（core のガラスの虹色のむらは物の座標で決まるので、
 * 大きな殻や膜でもむらが細かくなりすぎない）。元の形はアセットの読み込み口が持つので書き換えない
 */
export function normalizeMesh(mesh: THREE.Mesh, owned: THREE.BufferGeometry[]): void {
  // GLTFLoader の境界球は箱の対角の半分（球なら半径の √3 倍）なので、写しで測り直して本当の半径にそろえる
  const g = mesh.geometry.clone();
  g.computeBoundingSphere();
  const bs = g.boundingSphere!.clone();
  if (bs.radius <= 1.0001) {
    g.dispose();
    return;
  }
  g.translate(-bs.center.x, -bs.center.y, -bs.center.z);
  g.scale(1 / bs.radius, 1 / bs.radius, 1 / bs.radius);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  owned.push(g);
  mesh.geometry = g;
  mesh.position.add(bs.center.clone().multiply(mesh.scale).applyQuaternion(mesh.quaternion));
  mesh.scale.multiplyScalar(bs.radius);
  mesh.updateMatrixWorld(true);
}
