// 部屋の契約テストの道具（統合担当。部屋の担当は変更しない）。各部屋の room.test.ts から使う。
// 部屋を本物のレールと偽のイベントで読み込み、設計書の決まり（物との最短距離、見どころが前にある、
// 隠れた泡、描画の予算、部屋の空気）を部屋の実装に頼らずに確かめる。
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { expect } from 'vitest';
import type { Cue, EventBus, RideEvents, Vec3Tuple } from '../contracts/events';
import type { ComfortMode, DoorChoice, SectionId } from '../contracts/ids';
import type { RideData, RidePose } from '../contracts/ride';
import type { AssetLoader, RoomContext, RoomFactory, RoomFrame, RoomModule } from '../contracts/room';
import { GONDOLA_DIAMETER, MOTION, PERF } from '../config';
import { presetFor, type QualityTier } from '../core/quality-tier';
import { buildCueSheet, createRide, generateRideData } from '../ride';

const ASSETS = new URL('../../public/assets/', import.meta.url);

/** 出荷するレール（public/assets/rail.json。Blender から書き出したもの）。なければ生成器 */
function shippedRideData(): RideData {
  const file = new URL('rail.json', ASSETS);
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8')) as RideData;
    if (data?.version === 1) return data;
  }
  return generateRideData();
}

export const ride = createRide(shippedRideData());

/** node でアセットを読む（glb は画像を埋め込まない決まり。テクスチャは中身のない 1×1 を返す） */
export const nodeAssets: AssetLoader = {
  async gltf(path) {
    const buf = readFileSync(new URL(path, ASSETS));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const g = await new GLTFLoader().parseAsync(ab, '');
    return { scene: g.scene, animations: g.animations };
  },
  async texture(path) {
    if (!existsSync(new URL(path, ASSETS))) throw new Error(`テクスチャがない: ${path}`);
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  },
};
export const cues = buildCueSheet();

export interface RoomHarness {
  readonly room: RoomModule;
  readonly emitted: { type: keyof RideEvents; payload: unknown }[];
  readonly ctx: RoomContext;
  /** 時刻 t の姿勢で1フレーム進める */
  frame(t: number, dt?: number, mode?: ComfortMode): RoomFrame;
  /** t0〜t1 の出来事を順に流しながらフレームを進める */
  play(t0: number, t1: number, step?: number): void;
}

export async function loadRoom(
  factory: RoomFactory,
  opts: {
    tier?: QualityTier;
    comfort?: ComfortMode;
    reducedFlash?: boolean;
    suggestedDoor?: DoorChoice | null;
    assets?: AssetLoader;
  } = {},
): Promise<RoomHarness> {
  const emitted: { type: keyof RideEvents; payload: unknown }[] = [];
  const bus: EventBus = {
    on: () => () => {},
    emit(type, payload) {
      emitted.push({ type, payload });
    },
  };
  const ctx: RoomContext = {
    ride,
    assets: opts.assets ?? nodeAssets,
    events: bus,
    quality: presetFor(opts.tier ?? 'high', { isMobile: false, isXR: false }),
    comfort: () => opts.comfort ?? 'standard',
    reducedFlash: () => opts.reducedFlash ?? false,
    suggestedDoor: opts.suggestedDoor ?? null,
    hiddenAlreadyFound: false,
  };
  const room = factory();
  await room.load(ctx);
  room.root.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 2000);
  const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
  const frame = (t: number, dt = 1 / 60, mode: ComfortMode = 'standard'): RoomFrame => {
    ride.poseAt(t, mode, pose);
    camera.position.set(pose.x, pose.y, pose.z);
    camera.rotation.set(0, pose.yaw, 0);
    camera.updateMatrixWorld(true);
    const f: RoomFrame = { t, dt, pose, camera, comfort: mode, reducedFlash: opts.reducedFlash ?? false };
    room.update(f);
    return f;
  };
  const play = (t0: number, t1: number, step = 0.25) => {
    let i = cues.findIndex((c) => c.t >= t0);
    if (i < 0) i = cues.length;
    for (let t = t0; t <= t1; t += step) {
      while (i < cues.length && cues[i].t <= t) room.onCue(cues[i++]);
      frame(t, step);
    }
  };
  return { room, emitted, ctx, frame, play };
}

/** 区間の時刻の範囲 */
export function sectionTimes(id: SectionId) {
  return ride.sectionTime(id);
}

/** 描画される物（Mesh・InstancedMesh・Points・Line）と三角形の数 */
export function drawStats(root: THREE.Object3D): { drawables: number; triangles: number } {
  let drawables = 0;
  let triangles = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine) return;
    if (!o.visible) return;
    drawables++;
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (!g || !m.isMesh) return;
    const count = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1;
    triangles += count * inst;
  });
  return { drawables, triangles };
}

const tmpBox = new THREE.Box3();
const tmpMat = new THREE.Matrix4();
const tmpV = new THREE.Vector3();

/**
 * 物の世界座標の箱（InstancedMesh はインスタンスごと）。
 * userData.clearanceExempt が真の物（膜、水面、遠くの床や空）とその子は除く。
 */
export function obstacleBoxes(root: THREE.Object3D): THREE.Box3[] {
  const out: THREE.Box3[] = [];
  root.updateMatrixWorld(true);
  const visit = (o: THREE.Object3D) => {
    if (o.userData.clearanceExempt) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) {
      const g = m.geometry as THREE.BufferGeometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if ((o as THREE.InstancedMesh).isInstancedMesh) {
        const im = o as THREE.InstancedMesh;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, tmpMat);
          tmpMat.premultiply(im.matrixWorld);
          out.push(g.boundingBox!.clone().applyMatrix4(tmpMat));
        }
      } else {
        out.push(tmpBox.copy(g.boundingBox!).applyMatrix4(o.matrixWorld).clone());
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return out;
}

/**
 * RIDE-8 / MOTION.clearanceMin: ゴンドラ（半径 1.2m）の表面から物まで 0.5m 以上。
 * レールの中心から箱までの距離で測る（標準と穏やかの両方の高さ）。違反した [t, 距離] を返す。
 */
export function clearanceViolations(room: RoomModule, sections: readonly SectionId[], step = 1): [number, number][] {
  const boxes = obstacleBoxes(room.root);
  const need = GONDOLA_DIAMETER / 2 + MOTION.clearanceMin;
  const bad: [number, number][] = [];
  const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
  for (const id of sections) {
    const { t0, t1 } = ride.sectionTime(id);
    for (let t = t0; t <= t1; t += step) {
      for (const mode of ['standard', 'gentle'] as const) {
        ride.poseAt(t, mode, pose);
        tmpV.set(pose.x, pose.y, pose.z);
        for (const b of boxes) {
          const d = b.distanceToPoint(tmpV);
          if (d < need) bad.push([t, d]);
        }
      }
    }
  }
  return bad;
}

/** 見どころがゴンドラの前（左右 ±60° 以内）、3〜80m 先にあるか */
export function expectFocusAhead(room: RoomModule, name: Cue['name'], t: number): void {
  const f = room.focusPoint(name);
  expect(f, `${name} の focusPoint`).not.toBeNull();
  const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
  ride.poseAt(t, 'standard', pose);
  const [fx, fy, fz] = f as Vec3Tuple;
  const dx = fx - pose.x;
  const dz = fz - pose.z;
  const dist = Math.hypot(dx, fy - pose.y, dz);
  expect(dist, `${name} までの距離`).toBeGreaterThanOrEqual(3);
  expect(dist, `${name} までの距離`).toBeLessThanOrEqual(80);
  // 前方 (−sin yaw, −cos yaw) との角度
  const fwdX = -Math.sin(pose.yaw);
  const fwdZ = -Math.cos(pose.yaw);
  const cos = (dx * fwdX + dz * fwdZ) / Math.max(1e-6, Math.hypot(dx, dz));
  expect(Math.acos(Math.min(1, Math.max(-1, cos))) * (180 / Math.PI), `${name} の方向（正面からの角度）`).toBeLessThanOrEqual(60);
}

/** 部屋の空気の色の HSL（設計書のアートディレクションの粗い確認に使う） */
export function backgroundHsl(room: RoomModule): { h: number; s: number; l: number } {
  const c = new THREE.Color(room.atmosphere.background as THREE.ColorRepresentation);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  return { h: hsl.h * 360, s: hsl.s, l: hsl.l };
}

/** すべての部屋に共通の契約の確認 */
export async function expectRoomContract(factory: RoomFactory, sections: readonly SectionId[]): Promise<void> {
  const h = await loadRoom(factory);
  const { room } = h;
  // 触れられる物の id は一意で、部屋の名前で始まる
  const ids = room.touchables.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id.startsWith(`${room.id}/`), id).toBe(true);
  // すべての出来事とすべての時刻で例外を出さない
  for (const c of cues) expect(() => room.onCue(c), c.id).not.toThrow();
  for (const id of sections) {
    const { t0, t1 } = ride.sectionTime(id);
    expect(() => h.play(Math.max(0, t0 - 5), t1 + 5, 0.5)).not.toThrow();
  }
  // 触れても例外を出さない
  for (const t of room.touchables) expect(() => t.onTouch({ t: 100, source: 'pointer', point: [0, 0, 0] }), t.id).not.toThrow();
  // 解放
  const geos: THREE.BufferGeometry[] = [];
  room.root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (g && !geos.includes(g)) geos.push(g);
  });
  const spies = geos.map((g) => {
    let called = false;
    const orig = g.dispose.bind(g);
    g.dispose = () => {
      called = true;
      orig();
    };
    return () => called;
  });
  room.dispose();
  expect(spies.every((s) => s()), '形をすべて解放する').toBe(true);
}

/** userData.role で物を探す（部屋の担当は、テストが探す物に role を付ける: membrane / shell / stars / pattern / lamp / ticket / arch / rim） */
export function findByRole(root: THREE.Object3D, role: string): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData.role === role) out.push(o);
  });
  return out;
}

/** 世界座標の中心 */
export function worldCenter(o: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(o);
  return box.isEmpty() ? o.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
}

/**
 * TRN-1 部屋の境目はすべて膜。膜はその部屋を出る側の部屋が持つ（近づくあいだ見えるので）。
 * 部屋の最後の区間の終わりのレールの点から 3m 以内に role=membrane の物があり、clearanceExempt であること。
 */
export function expectExitMembrane(room: RoomModule, section: SectionId): void {
  const { s1 } = ride.sectionSpan(section);
  const p = ride.pointAt(s1);
  const at = new THREE.Vector3(p.x, p.y, p.z);
  const membranes = findByRole(room.root, 'membrane');
  expect(membranes.length, `${room.id} の出口の膜`).toBeGreaterThan(0);
  const nearest = Math.min(...membranes.map((m) => new THREE.Box3().setFromObject(m).distanceToPoint(at)));
  expect(nearest, `${room.id} の膜とレールの終わりの距離`).toBeLessThanOrEqual(3);
  for (const m of membranes) {
    let exempt = false;
    for (let o: THREE.Object3D | null = m; o; o = o.parent) if (o.userData.clearanceExempt) exempt = true;
    expect(exempt, '膜は通り抜けるので clearanceExempt').toBe(true);
  }
}

/** INT-6 隠れた小さな泡: ちょうど1つ、小さく（半径 0.25m 以下）、触れると hiddenFound を出す */
export async function expectHiddenBubble(factory: RoomFactory, section: SectionId): Promise<void> {
  const h = await loadRoom(factory);
  const hidden = h.room.touchables.filter((t) => t.kind === 'hidden-bubble');
  expect(hidden, '隠れた泡の数').toHaveLength(1);
  expect(hidden[0].radius).toBeLessThanOrEqual(0.25);
  expect(hidden[0].section).toBe(section);
  hidden[0].onTouch({ t: ride.sectionTime(section).t0 + 10, source: 'pointer', point: [0, 0, 0] });
  expect(h.emitted.filter((e) => e.type === 'hiddenFound').map((e) => e.payload)).toEqual([{ section }]);
}

/** 触れられる物のうち、区間のどこかでレールから dist 以内に来るものの割合（手が届く・縁が光る） */
export function reachableFraction(room: RoomModule, kind: string, sections: readonly SectionId[], dist: number): number {
  const list = room.touchables.filter((t) => t.kind === kind);
  if (list.length === 0) return 0;
  const samples: THREE.Vector3[] = [];
  for (const id of sections) {
    const { s0, s1 } = ride.sectionSpan(id);
    for (let s = s0; s <= s1; s += 1) {
      const p = ride.pointAt(s);
      samples.push(new THREE.Vector3(p.x, p.y, p.z));
    }
  }
  let ok = 0;
  for (const t of list) {
    const c = t.object.getWorldPosition(new THREE.Vector3());
    if (samples.some((p) => p.distanceTo(c) <= dist)) ok++;
  }
  return ok / list.length;
}

interface GltfNodeJson {
  name?: string;
  mesh?: number;
  extras?: Record<string, unknown>;
}

/** glb の JSON の部分（12 バイトの頭の後の最初のチャンク） */
function glbJson(buf: Buffer): { nodes?: GltfNodeJson[]; images?: unknown[]; extensionsUsed?: string[] } {
  expect(buf.toString('ascii', 0, 4), 'glb の頭').toBe('glTF');
  const len = buf.readUInt32LE(12);
  expect(buf.toString('ascii', 16, 20), 'glb の最初のチャンク').toBe('JSON');
  return JSON.parse(buf.toString('utf8', 20, 20 + len));
}

/**
 * BLD-4〜7 Blender で造形した部屋（blender/scripts/rooms/<name>.py → public/assets/rooms/<name>.glb）。
 * - glb は 15MB（10進）以下、画像を埋め込まない、圧縮の拡張（Draco など）を使わない
 * - 物の名前は `<name>.<部品>[.<番号>]`（小文字。BLD-6）
 * - 光を焼き込んだ物（extras の lightmap と lightmap_scale）が1つ以上あり、PNG があり、glb との合計が 15MB 以下
 * - 部屋は load で ctx.assets からこの glb とライトマップを読み、焼き込んだ物に lightMap を付ける
 *   （sRGB、2つ目の UV、強さ > 0、その物のライトマップ。材質を共有して上書きしない）
 */
export async function expectBlenderRoom(factory: RoomFactory, name: string): Promise<void> {
  const glbPath = `rooms/${name}.glb`;
  const file = new URL(glbPath, ASSETS);
  expect(existsSync(file), `${glbPath} がない（blender/scripts/rooms/${name}.py で書き出す）`).toBe(true);
  const buf = readFileSync(file);
  const limit = PERF.roomLoadMB * 1e6;
  expect(buf.length, 'glb の大きさ').toBeLessThanOrEqual(limit);
  const json = glbJson(buf);
  expect(json.images ?? [], 'glb に画像を入れない（ライトマップは外の PNG）').toEqual([]);
  expect(json.extensionsUsed ?? [], 'glb の拡張（node のテストと同じ GLTFLoader で読めること）').toEqual([]);
  const nodes = json.nodes ?? [];
  expect(nodes.filter((n) => n.mesh !== undefined).length, 'メッシュの物').toBeGreaterThan(0);
  const re = new RegExp(`^${name}\\.[a-z][a-z0-9_]*(\\.[0-9]+)?$`);
  expect(nodes.map((n) => n.name ?? '(名前なし)').filter((n) => !re.test(n)), '物の名前は <部屋>.<部品>[.<番号>]').toEqual([]);

  const baked = nodes.filter((n) => typeof n.extras?.lightmap === 'string');
  expect(baked.length, '光を焼き込んだ物（extras.lightmap）').toBeGreaterThan(0);
  let total = buf.length;
  for (const m of new Set(baked.map((n) => n.extras!.lightmap as string))) {
    const f = new URL(`rooms/${m}`, ASSETS);
    expect(existsSync(f), `ライトマップ rooms/${m}`).toBe(true);
    total += statSync(f).size;
  }
  for (const n of baked) expect(Number(n.extras!.lightmap_scale), `${n.name} の lightmap_scale`).toBeGreaterThan(0);
  expect(total, 'glb とライトマップの合計（部屋の読み込み）').toBeLessThanOrEqual(limit);

  const gltfAsked: string[] = [];
  const textures = new Map<string, THREE.Texture[]>();
  const spy: AssetLoader = {
    gltf(path) {
      gltfAsked.push(path);
      return nodeAssets.gltf(path);
    },
    async texture(path) {
      const t = await nodeAssets.texture(path);
      textures.set(path, [...(textures.get(path) ?? []), t]);
      return t;
    },
  };
  const { room } = await loadRoom(factory, { assets: spy });
  expect(gltfAsked, '部屋は glb を ctx.assets から読む').toContain(glbPath);
  const byName = new Map<string, THREE.Object3D>();
  room.root.traverse((o) => {
    if (typeof o.userData.name === 'string') byName.set(o.userData.name, o);
  });
  for (const n of baked) {
    const o = byName.get(n.name!);
    expect(o, `焼き込んだ ${n.name} が部屋にある`).toBeDefined();
    // 材質が複数の物は GLTFLoader が Group の下にメッシュを並べる
    const meshes = (o as THREE.Mesh).isMesh ? [o as THREE.Mesh] : o!.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && c.userData.name === undefined);
    const mats = meshes.flatMap((m) => ([] as THREE.Material[]).concat(m.material));
    expect(mats.length, `${n.name} の材質`).toBeGreaterThan(0);
    const own = textures.get(`rooms/${n.extras!.lightmap as string}`) ?? [];
    for (const m of mats as THREE.MeshStandardMaterial[]) {
      expect(m.lightMap, `${n.name} の lightMap`).toBeTruthy();
      expect(own, `${n.name} の lightMap はその物のライトマップ（材質を共有して上書きしない）`).toContain(m.lightMap);
      expect(m.lightMap!.colorSpace, `${n.name} の lightMap は sRGB`).toBe(THREE.SRGBColorSpace);
      expect(m.lightMap!.channel, `${n.name} の lightMap は2つ目の UV`).toBe(1);
      expect(m.lightMapIntensity, `${n.name} の lightMapIntensity`).toBeGreaterThan(0);
    }
  }
  room.dispose();
}

const PASS_THROUGH_ROLES = new Set(['membrane', 'shell', 'water']);

/** 通り抜ける物（膜・殻・水面、または userData.passThrough）か。自分か親のどれかがそうなら真 */
function passesThrough(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (p.userData.passThrough || PASS_THROUGH_ROLES.has(p.userData.role as string)) return true;
  }
  return false;
}

/** clearanceExempt が自分か親のどれかに付いているか */
function exempted(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.clearanceExempt) return true;
  return false;
}

/**
 * RIDE-8 の本当の形での確かめ。clearanceExempt を付けた物（レールを囲む連続した壁・穹窿・鏡の板など、軸に沿った箱では
 * レールを含んでしまう物）も、三角形との最短距離でゴンドラの表面から 0.5m 以上離れていること。
 * 通り抜ける物（role が membrane・shell・water、または userData.passThrough）だけは除く。
 * exempt を付けるだけで RIDE-8 を外れる抜け道を塞ぐ（S-21 レビュー1巡目 P2-1）。レールは区間の前後 margin m まで測る
 * （隣の区間から見える所、部屋の境目の物も）。レールは1本なので標準と穏やかで同じ（ADR-0008）。
 * 違反した [s, 距離, 物の名前] を、物ごとに最も近いものだけ返す。
 */
export function shapeClearanceViolations(
  room: RoomModule,
  sections: readonly SectionId[],
  opts: { margin?: number; step?: number } = {},
): [number, number, string][] {
  const margin = opts.margin ?? 3;
  const step = opts.step ?? 0.25;
  const need = GONDOLA_DIAMETER / 2 + MOTION.clearanceMin;
  room.root.updateMatrixWorld(true);
  // 三角形を世界座標で集める（物ごと）
  const objs: { name: string; tri: Float32Array; centers: Float32Array; radii: Float32Array }[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const m = new THREE.Matrix4();
  room.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !exempted(o) || passesThrough(o)) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.attributes.position;
    if (!pos) return;
    const idx = g.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1;
    const tri = new Float32Array(triCount * inst * 9);
    const centers = new Float32Array(triCount * inst * 3);
    const radii = new Float32Array(triCount * inst);
    let k = 0;
    for (let i = 0; i < inst; i++) {
      if (inst > 1 || (o as THREE.InstancedMesh).isInstancedMesh) {
        (o as THREE.InstancedMesh).getMatrixAt(i, m);
        m.premultiply(mesh.matrixWorld);
      } else m.copy(mesh.matrixWorld);
      for (let t = 0; t < triCount; t++) {
        const ia = idx ? idx.getX(t * 3) : t * 3;
        const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(m);
        b.fromBufferAttribute(pos, ib).applyMatrix4(m);
        c.fromBufferAttribute(pos, ic).applyMatrix4(m);
        tri.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], k * 9);
        const cx = (a.x + b.x + c.x) / 3;
        const cy = (a.y + b.y + c.y) / 3;
        const cz = (a.z + b.z + c.z) / 3;
        centers.set([cx, cy, cz], k * 3);
        radii[k] = Math.sqrt(
          Math.max((a.x - cx) ** 2 + (a.y - cy) ** 2 + (a.z - cz) ** 2, (b.x - cx) ** 2 + (b.y - cy) ** 2 + (b.z - cz) ** 2, (c.x - cx) ** 2 + (c.y - cy) ** 2 + (c.z - cz) ** 2),
        );
        k++;
      }
    }
    objs.push({ name: (o.userData.name as string) ?? o.name, tri, centers, radii });
  });
  const worst = new Map<string, [number, number, string]>();
  const triangle = new THREE.Triangle();
  const closest = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const id of sections) {
    const { s0, s1 } = ride.sectionSpan(id);
    for (let s = Math.max(0, s0 - margin); s <= s1 + margin; s += step) {
      const q = ride.pointAt(s);
      p.set(q.x, q.y, q.z);
      for (const ob of objs) {
        const n = ob.radii.length;
        for (let t = 0; t < n; t++) {
          const dx = ob.centers[t * 3]! - p.x;
          const dy = ob.centers[t * 3 + 1]! - p.y;
          const dz = ob.centers[t * 3 + 2]! - p.z;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) - ob.radii[t]! >= need) continue;
          const o9 = t * 9;
          a.set(ob.tri[o9]!, ob.tri[o9 + 1]!, ob.tri[o9 + 2]!);
          b.set(ob.tri[o9 + 3]!, ob.tri[o9 + 4]!, ob.tri[o9 + 5]!);
          c.set(ob.tri[o9 + 6]!, ob.tri[o9 + 7]!, ob.tri[o9 + 8]!);
          triangle.set(a, b, c).closestPointToPoint(p, closest);
          const d = closest.distanceTo(p);
          if (d < need) {
            const w = worst.get(ob.name);
            if (!w || d < w[1]) worst.set(ob.name, [Math.round(s * 100) / 100, Math.round(d * 1000) / 1000, ob.name]);
          }
        }
      }
    }
  }
  return [...worst.values()];
}
