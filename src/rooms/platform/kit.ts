// 部屋A（待ち列・乗り場・温室）の共通の道具。Blender で造形して焼いた glb を読み、その上に材質と動きを重ねる。
// （ほかの部屋の担当と共有する場所がないので、乗り場のディレクトリに置いて lobby と greenhouse からも使う）
//
// 判断の順序（glb の物ごと）:
//   1. role=proto（インスタンスの元の形）は場面から外し、形だけ取っておく（InstancedMesh で描く）。
//   2. glass（ガラスの種類）を持つ物は core のガラスに差し替える（触れられる物は個別、飾りは共有）。
//   3. brass を持つ物は core の真鍮。
//   4. lightmap（焼き込み）を持つ物は、glb の材質を複製して lightMap を付ける（sRGB、2つ目の UV、強さ π×scale）。
//   5. clearance_exempt（Blender のカスタムプロパティ）を userData.clearanceExempt に写す（テストと統合担当が見る名前）。
// extras は glb から来る外のデータなので、既知のキーだけを型と範囲を確かめて読む（src/core/storage.ts の道具）。
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  color as colorNode,
  float,
  normalWorld,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  vec4,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RoomContext } from '../../contracts/room';
import type { Ride, RidePose } from '../../contracts/ride';
import { createBrass, createGlass, sharedGlass, type GlassHandle, type GlassKind, type GlassParams } from '../../core/materials/glass';
import { bool, num, own } from '../../core/storage';

/** ガラスの種類（core の GlassKind と同じ並び。extras の値を検証するため） */
const GLASS_KINDS: readonly GlassKind[] = ['clear', 'frosted', 'tinted', 'iridescent', 'milky', 'mirror'];
/** ライトマップの画像の名前（rooms/ の中のファイルだけ。上の階層を指せない） */
const LIGHTMAP_NAME = /^[a-z0-9_.-]+\.(png|webp)$/;
const HEX = /^#[0-9a-f]{6}$/i;

type Tier = RoomContext['quality']['tier'];

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function hex(v: unknown): string | undefined {
  return typeof v === 'string' && HEX.test(v) ? v : undefined;
}

/** extras の真偽（Blender の bool は true/false か 1/0 で来る） */
export function flag(v: unknown): boolean {
  return v === true || v === 1;
}

/** extras の数の並び（長さを確かめる） */
export function numbers(v: unknown, multiple: number): number[] {
  if (!Array.isArray(v) || v.length % multiple !== 0) return [];
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return [];
    out.push(x);
  }
  return out;
}

export function vec3Of(v: unknown): THREE.Vector3 | null {
  const a = numbers(v, 3);
  return a.length === 3 ? new THREE.Vector3(a[0], a[1], a[2]) : null;
}

/** 種を固定した乱数（同じ部屋は毎回同じ） */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** 部屋の GPU の資源をまとめて解放する */
export class Resources {
  readonly geometries = new Set<THREE.BufferGeometry>();
  readonly materials = new Set<THREE.Material>();
  readonly textures = new Set<THREE.Texture>();
  readonly glass: GlassHandle[] = [];

  geo<G extends THREE.BufferGeometry>(g: G): G {
    this.geometries.add(g);
    return g;
  }
  mat<M extends THREE.Material>(m: M): M {
    this.materials.add(m);
    return m;
  }
  handle(h: GlassHandle): GlassHandle {
    this.glass.push(h);
    return h;
  }
  /** root の下の形をすべて登録する（glb から来た形も含めて、解放を漏らさない） */
  collect(root: THREE.Object3D): void {
    root.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (g) this.geometries.add(g);
    });
  }
  setTime(t: number): void {
    for (const h of this.glass) h.setTime(t);
  }
  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    for (const h of this.glass) h.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    this.glass.length = 0;
  }
}

/** 焼き込んだ物（ライトマップの差し替えに使う） */
export interface BakedMesh {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly scale: number;
  /** 別の光の状態（例: 朝）のライトマップと倍率 */
  readonly alt: Map<string, { texture: THREE.Texture; scale: number }>;
  readonly texture: THREE.Texture;
}

export interface Proto {
  readonly geometry: THREE.BufferGeometry;
  readonly userData: Record<string, unknown>;
  /** 材質ごとの部分（材質の extras にガラスの種類と色） */
  readonly parts: readonly { geometry: THREE.BufferGeometry; material: THREE.Material }[];
}

export interface GlbRoom {
  readonly scene: THREE.Group;
  /** glb の物の名前（userData.name）→ 物 */
  readonly byName: Map<string, THREE.Object3D>;
  /** インスタンスの元の形（名前の部品 proto_<種類> → 形と、物の extras と、材質ごとの部分） */
  readonly protos: Map<string, Proto>;
  readonly baked: BakedMesh[];
  /** extras の入れ物（<部屋>.instances）の userData */
  readonly instances: Record<string, unknown>;
}

export interface LoadOptions {
  readonly tier: Tier;
  /** ライトマップの強さに掛ける（演出の明るさ） */
  readonly lightmapGain?: number;
  /** 触れられる物（touch_kind を持つ物）のガラスは個別に作る（縁の光と波紋を物ごとに） */
  readonly ownGlass?: (o: THREE.Object3D) => boolean;
  /** ガラスの引数を部屋が上書きする */
  readonly glassOverride?: (o: THREE.Object3D, kind: GlassKind, params: GlassParams) => GlassParams;
}

/** 物のメッシュ（材質が複数の物は GLTFLoader が Group の下に並べる） */
export function meshesOf(o: THREE.Object3D): THREE.Mesh[] {
  if ((o as THREE.Mesh).isMesh) return [o as THREE.Mesh];
  return o.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && c.userData.name === undefined);
}

export function glassParamsOf(ud: Record<string, unknown>): GlassParams {
  const p: { -readonly [K in keyof GlassParams]: GlassParams[K] } = {};
  const color = hex(own(ud, 'glass_color'));
  if (color) p.color = color;
  if (own(ud, 'glass_opacity') !== undefined) p.opacity = num(own(ud, 'glass_opacity'), 0.1, 0, 1);
  const emissive = hex(own(ud, 'glass_emissive'));
  if (emissive) {
    p.emissive = emissive;
    p.emissiveIntensity = num(own(ud, 'glass_emissive_intensity'), 1, 0, 20);
  }
  if (own(ud, 'glass_iridescence') !== undefined) p.iridescence = num(own(ud, 'glass_iridescence'), 0.5, 0, 1);
  if (own(ud, 'glass_face') !== undefined) p.face = num(own(ud, 'glass_face'), 0.01, 0, 1);
  if (own(ud, 'glass_rim') !== undefined) p.rim = num(own(ud, 'glass_rim'), 0.7, 0, 1);
  if (own(ud, 'glass_roughness') !== undefined) p.roughness = num(own(ud, 'glass_roughness'), 0.05, 0, 1);
  if (bool(own(ud, 'glass_double'), false)) p.doubleSided = true;
  return p;
}

export function glassKindOf(ud: Record<string, unknown>): GlassKind | null {
  const v = own(ud, 'glass');
  return typeof v === 'string' && (GLASS_KINDS as readonly string[]).includes(v) ? (v as GlassKind) : null;
}

/**
 * 部屋の glb を読み、ライトマップ・ガラス・真鍮を付けて返す。
 * キャッシュされた glb の場面を壊さないよう、場面は複製し、材質はすべて新しく作る（形は共有する）。
 */
export async function loadGlbRoom(ctx: RoomContext, room: string, res: Resources, opts: LoadOptions): Promise<GlbRoom> {
  const g = await ctx.assets.gltf(`rooms/${room}.glb`);
  const scene = g.scene.clone(true);
  scene.name = `${room}.glb`;
  scene.updateMatrixWorld(true);
  const byName = new Map<string, THREE.Object3D>();
  scene.traverse((o) => {
    const n = str(o.userData.name);
    if (n) byName.set(n, o);
  });

  // 1. インスタンスの元の形（材質が複数の物は、材質ごとの部分に分かれている）
  const protos = new Map<string, Proto>();
  for (const [name, o] of byName) {
    if (own(o.userData, 'role') !== 'proto') continue;
    const ms = meshesOf(o);
    if (ms.length > 0) {
      protos.set(name.split('.')[1] ?? name, {
        geometry: ms[0].geometry,
        userData: o.userData,
        parts: ms.map((m) => ({ geometry: m.geometry, material: ([] as THREE.Material[]).concat(m.material)[0] })),
      });
    }
    for (const m of ms) res.geo(m.geometry);
    o.removeFromParent();
  }
  const holder = byName.get(`${room}.instances`);
  const instances = (holder?.userData ?? {}) as Record<string, unknown>;

  // 2〜4. 材質
  const textures = new Map<string, Promise<THREE.Texture>>();
  const loadMap = (name: string) => {
    let p = textures.get(name);
    if (!p) {
      p = ctx.assets.texture(`rooms/${name}`).then((t) => {
        // 8bit の sRGB（線形に直して使う）。glTF の UV に合わせて上下を返さない。2つ目の UV（TEXCOORD_1）
        t.colorSpace = THREE.SRGBColorSpace;
        t.flipY = false;
        t.channel = 1;
        t.needsUpdate = true;
        res.textures.add(t);
        return t;
      });
      textures.set(name, p);
    }
    return p;
  };
  const brass = res.mat(createBrass({ color: 0xbe9658, roughness: 0.32 }));
  const baked: BakedMesh[] = [];
  /** 同じ元の材質・同じライトマップ・同じ倍率の物は、複製した材質を共有する */
  const bakedMats = new Map<string, THREE.MeshStandardMaterial>();
  const gain = opts.lightmapGain ?? 1;
  const jobs: Promise<void>[] = [];
  for (const [, o] of byName) {
    const ud = o.userData as Record<string, unknown>;
    if (ud.clearance_exempt !== undefined) o.userData.clearanceExempt = flag(ud.clearance_exempt);
    // 元の形は場面から外した（材質は部屋がインスタンスごとに作る）
    if (own(ud, 'role') === 'proto') continue;
    const meshes = meshesOf(o);
    if (meshes.length === 0) continue;
    const kind = glassKindOf(ud);
    if (kind) {
      let params = glassParamsOf(ud);
      if (opts.glassOverride) params = opts.glassOverride(o, kind, params);
      const handle = res.handle(opts.ownGlass?.(o) ? createGlass(kind, params, { tier: opts.tier }) : sharedGlass(kind, params, { tier: opts.tier }));
      for (const m of meshes) m.material = handle.material;
      o.userData.glassHandle = handle;
      continue;
    }
    if (flag(own(ud, 'brass'))) {
      for (const m of meshes) m.material = brass;
      continue;
    }
    const lm = str(own(ud, 'lightmap'));
    if (lm && LIGHTMAP_NAME.test(lm)) {
      const scale = num(own(ud, 'lightmap_scale'), 1, 1e-6, 1e6);
      const alts: [string, string, number][] = [];
      for (const key of Object.keys(ud)) {
        const m = /^lightmap_([a-z]+)$/.exec(key);
        const alt = m ? str(own(ud, key)) : null;
        if (m && alt && LIGHTMAP_NAME.test(alt)) alts.push([m[1], alt, num(own(ud, `${key}_scale`), 1, 1e-6, 1e6)]);
      }
      jobs.push(
        (async () => {
          const tex = await loadMap(lm);
          const altMaps = new Map<string, { texture: THREE.Texture; scale: number }>();
          for (const [k, name, s] of alts) altMaps.set(k, { texture: await loadMap(name), scale: s });
          for (const mesh of meshes) {
            const src = mesh.material as THREE.MeshStandardMaterial;
            const key = `${src.uuid}|${lm}|${scale}`;
            let mat = bakedMats.get(key);
            if (!mat) {
              mat = res.mat(src.clone());
              // 焼いた値は放射輝度。three の lightMap は拡散反射に 1/π を掛けるので π を掛けて揃える（blender/README.md）
              mat.lightMap = tex;
              mat.lightMapIntensity = Math.PI * scale * gain;
              mat.envMapIntensity = 0;
              mat.roughness = 1;
              mat.metalness = 0;
              bakedMats.set(key, mat);
            }
            mesh.material = mat;
            baked.push({ mesh, material: mat, scale, alt: altMaps, texture: tex });
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  res.collect(scene);
  return { scene, byName, protos, baked, instances };
}

/** 焼き込んだ物のライトマップを切り替える（null で既定）。演出の明るさ gain も掛け直す */
export function setLightmapState(baked: readonly BakedMesh[], state: string | null, gain = 1): void {
  for (const b of baked) {
    const alt = state ? b.alt.get(state) : undefined;
    const tex = alt?.texture ?? b.texture;
    const scale = alt?.scale ?? b.scale;
    if (b.material.lightMap !== tex) {
      b.material.lightMap = tex;
      b.material.needsUpdate = true;
    }
    b.material.lightMapIntensity = Math.PI * scale * gain;
  }
}

/** extras の inst_<種類>（列優先の 4×4 の並び）を行列の配列に */
export function instanceMatrices(instances: Record<string, unknown>, kind: string): THREE.Matrix4[] {
  const a = numbers(own(instances, `inst_${kind}`), 16);
  const out: THREE.Matrix4[] = [];
  for (let i = 0; i < a.length; i += 16) out.push(new THREE.Matrix4().fromArray(a, i));
  return out;
}

/** インスタンスの数を品質で減らす（並びは Blender で混ぜてあるので、前から取れば偏らない） */
export function scaledCount(n: number, scale: number, min = 1): number {
  return Math.min(n, Math.max(min, Math.round(n * Math.min(1, Math.max(0, scale)))));
}

// ── 部屋の境目の膜（TRN-1） ───────────────────────────────────────────

export interface MembraneSpec {
  /** 膜を張るレールの距離（部屋の最後の区間の終わり） */
  readonly s: number;
  /** 膜の半径 */
  readonly radius: number;
  /** 床の高さ。渡すと下が床で切れた形（床のある部屋の出口）、省くと円 */
  readonly floorY?: number;
  readonly color?: THREE.ColorRepresentation;
  readonly tier: Tier;
}

export interface Membrane {
  readonly mesh: THREE.Mesh;
  /** ゴンドラの位置からたわみを計算する（時刻から決まる。積み上げない） */
  update(pose: RidePose, t: number): void;
  dispose(): void;
}

/**
 * 部屋の境目の膜。薄膜の虹色の板（core のガラス、面全体に色を出す）。ゴンドラが近づくと押されてたわみ、
 * 通り抜けた後は小さく揺れて元に戻る（設計書「部屋 → 部屋」）。通り抜ける瞬間の縞と歪みは画面効果の担当。
 * 近づく側から見える面だけを描く（通り抜けた後に裏から見る必要はない）。
 */
export function createMembrane(ride: Ride, spec: MembraneSpec): Membrane {
  const p = ride.pointAt(spec.s);
  const rings = 22;
  const segs = 72;
  // 局所の座標: x 右、y 上、z は進む向きの逆（膜の表は近づくゴンドラの方を向く）
  const outline = (a: number): number => {
    const r = spec.radius;
    if (spec.floorY === undefined) return r;
    // 下が平らな形: 中心から下へは床まで
    const down = p.y - spec.floorY;
    const s = Math.sin(a);
    if (s >= 0) return r;
    return Math.min(r, down / Math.max(1e-3, -s));
  };
  const pos: number[] = [0, 0, 0];
  const radial: number[] = [0];
  for (let i = 1; i <= rings; i++) {
    const f = i / rings;
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const r = outline(a) * f;
      pos.push(Math.cos(a) * r, Math.sin(a) * r, 0);
      radial.push(f);
    }
  }
  const idx: number[] = [];
  for (let k = 0; k < segs; k++) idx.push(0, 1 + k, 1 + ((k + 1) % segs));
  for (let i = 1; i < rings; i++) {
    const b0 = 1 + (i - 1) * segs;
    const b1 = 1 + i * segs;
    for (let k = 0; k < segs; k++) {
      const k2 = (k + 1) % segs;
      idx.push(b0 + k, b1 + k, b1 + k2, b0 + k, b1 + k2, b0 + k2);
    }
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.Float32BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const rest = Float32Array.from(pos);
  const glass = createGlass('iridescent', { color: spec.color ?? 0xf4f8ff, face: 0.07, opacity: 0.025, iridescence: 0.9, rim: 0.7 }, { tier: spec.tier });
  const mesh = new THREE.Mesh(geo, glass.material);
  mesh.name = 'membrane';
  mesh.userData.role = 'membrane';
  // 通り抜ける物（物との最短距離の検査から外す）
  mesh.userData.clearanceExempt = true;
  mesh.position.set(p.x, p.y, p.z);
  // 局所の -Z が進む向き（表は +Z = ゴンドラの来る側）
  mesh.rotation.set(0, p.yaw, 0);
  mesh.renderOrder = 2;
  const passT = (() => {
    // 膜を通る時刻（s から時刻表で）。見つからなければ遠い過去
    let lo = 0;
    let hi = ride.data.duration;
    const tmp: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      ride.poseAt(mid, 'standard', tmp);
      if (tmp.s < spec.s) lo = mid;
      else hi = mid;
    }
    return hi;
  })();
  let lastBulge = Number.NaN;
  return {
    mesh,
    update(pose, t) {
      // 膜までの距離（前が正）。近づくとゴンドラの前の面に押されてたわみ、通った後は揺れながら戻る
      const d = spec.s - pose.s;
      let bulge = 0;
      if (d > 0 && d < 2.4) bulge = Math.min(1.05, Math.max(0, 2.4 - d) * 0.75) * (d < 0.35 ? d / 0.35 : 1);
      else if (d <= 0) {
        const e = t - passT;
        if (e >= 0 && e < 6) bulge = -0.55 * Math.exp(-e * 1.3) * Math.cos(e * 5.2);
      }
      glass.setTime(t);
      if (Math.abs(bulge - lastBulge) < 1e-4) return;
      lastBulge = bulge;
      const arr = posAttr.array as Float32Array;
      for (let i = 0, v = 0; v < radial.length; v++, i += 3) {
        const f = radial[v];
        const w = (1 - f * f) * (1 - f * f);
        arr[i] = rest[i];
        arr[i + 1] = rest[i + 1];
        // 局所の -Z（進む向き）へ押される
        arr[i + 2] = -bulge * w;
      }
      posAttr.needsUpdate = true;
      geo.computeVertexNormals();
    },
    dispose() {
      geo.dispose();
      glass.dispose();
    },
  };
}

// ── 光の粒（誘導の lure と、見どころの光） ───────────────────────────────

/**
 * 加算で光る小さな玉の材質（光の粒、星の灯り）。glass ではなく光そのものなので、霧に溶けすぎないよう霧は使わない。
 * 不透明度は uniform で、品質や光の点滅を抑えるモードで下げられる。
 */
export function glowMaterial(colorHex: THREE.ColorRepresentation, strength = 1): { material: THREE.MeshBasicNodeMaterial; level: { value: number } } {
  const level = uniform(strength);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  m.colorNode = vec4(colorNode(new THREE.Color(colorHex)).mul(level), float(1));
  return { material: m, level: level as unknown as { value: number } };
}

/**
 * 柔らかい光の筋（斜めに差し込む朝日）。円柱の面に、視線と面の角度で縁ほど淡くなる加算の光を乗せる
 * （どの向きから見ても筋の中心が濃く、縁が溶ける）。
 */
export function shaftMaterial(colorHex: THREE.ColorRepresentation, strength: number, fadeNear = 4): { material: THREE.MeshBasicNodeMaterial; level: { value: number } } {
  const level = uniform(strength);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide, fog: false });
  const view = cameraPosition.sub(positionWorld).normalize();
  const facing = normalWorld.dot(view).abs();
  // 縁（facing → 0）で消え、中心で濃い
  const core = pow(facing, 2.2);
  // カメラのすぐ近くでは消す（筋の中に入ったときに視界が白くならない）
  const near = smoothstep(float(fadeNear * 0.4), float(fadeNear), cameraPosition.sub(positionWorld).length());
  m.colorNode = vec4(colorNode(new THREE.Color(colorHex)).mul(core.mul(level).mul(near)), float(1));
  return { material: m, level: level as unknown as { value: number } };
}

/** 正規化の道具 */
export const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * 灯りのまわりの柔らかい光の暈（かさ）。中心ほど濃く縁で消える加算の球を、灯りの数だけまとめて1つの物にする。
 * centers は [x, y, z, …]。
 */
export function haloMesh(res: Resources, centers: readonly number[], radius: number, colorHex: THREE.ColorRepresentation, strength: number): { mesh: THREE.Mesh; level: { value: number } } {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i + 2 < centers.length; i += 3) {
    const g = new THREE.SphereGeometry(radius, 20, 12);
    g.translate(centers[i], centers[i + 1], centers[i + 2]);
    parts.push(g);
  }
  const geo = res.geo(mergeGeometries(parts));
  for (const g of parts) g.dispose();
  const { material, level } = haloMaterial(colorHex, strength);
  res.mat(material);
  const mesh = new THREE.Mesh(geo, material);
  mesh.userData.clearanceExempt = true;
  mesh.renderOrder = 3;
  return { mesh, level };
}

/** 光の暈の材質（加算。視線と面の角度で縁ほど淡い） */
export function haloMaterial(colorHex: THREE.ColorRepresentation, strength: number): { material: THREE.MeshBasicNodeMaterial; level: { value: number } } {
  const level = uniform(strength);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const view = cameraPosition.sub(positionWorld).normalize();
  const facing = normalWorld.dot(view).abs();
  m.colorNode = vec4(colorNode(new THREE.Color(colorHex)).mul(pow(facing, 3).mul(level)), float(1));
  return { material: m, level: level as unknown as { value: number } };
}

/**
 * 反射用の環境画像（Blender で部屋の中から撮った正距円筒の PNG。extras の env などに名前）。
 * 真鍮とガラスが部屋そのものを映す。読めなければ null（擬似反射だけになる）。
 */
export async function loadEnvironment(ctx: RoomContext, res: Resources, holder: Record<string, unknown>, key = 'env'): Promise<THREE.Texture | null> {
  const name = str(own(holder, key));
  if (!name || !LIGHTMAP_NAME.test(name)) return null;
  try {
    const t = await ctx.assets.texture(`rooms/${name}`);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    // 画像の上が上（ライトマップと違い、glTF の UV ではない）
    t.flipY = true;
    t.needsUpdate = true;
    res.textures.add(t);
    return t;
  } catch {
    return null;
  }
}
