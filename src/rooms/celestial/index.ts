// 第4室「星の天球」（8:00〜11:00）。設計書「体験の流れ › 第4室」、ADR-0009。
// 形は Blender（blender/scripts/rooms/celestial.py → public/assets/rooms/celestial.glb）。ここでは
// 材質（core のガラスと真鍮、焼いた台座）、数千の星（光を宿したガラス玉。インスタンス）、9:50 の星座の街、
// 触れた星をつなぐ光の線、殻を抜けるときの光の輪、台座の金の目盛り、見どころへの光の粒を重ねる。
//
// 時刻から決める（フレームの積み上げで状態を作らない）:
//   - 星は 8:02（2秒の暗転の後）から一つずつ灯る（灯る時刻は星ごとに決めてある。光の点滅を抑えるモードでは時間割ごとゆっくり）
//   - 殻を抜ける時刻はレールから求め、その時刻からの経過で殻の上に光の輪を広げる（目の近くでは見せない）
//   - 星座の線は描き始めの時刻と長さを線ごとに持ち、9:50 の撮影の瞬間には描き上がっている
//   - 10:50 からは夜明けに向けて星が薄れ、出口の膜は 10:34 から現れる（遠くからは星を隠す濁った円に見えるので）
//   - 膜を抜ける瞬間（11:00.3。膜の画面効果が隠す）に、中の殻・星・芯の輪を消し、外殻と子午線・黄道だけを残す。
//     先読みの窓から外れた後は、夜明けの岸の部屋が同じ形の代役で「海に半ば沈んだ天球」を見せ続ける
// 触れた星の線だけは触れた時刻（乗車の時計）を覚えて、そこからの経過で描く。
//
// ガラスの擬似照明は部屋の空気（ATMOSPHERE.glassLighting）で渡す（共有の値には触れない。統合担当が膜で切り替える）。
import * as THREE from 'three/webgpu';
import {
  atan,
  attribute,
  cameraPosition,
  cross,
  exp,
  float,
  fwidth,
  hash,
  instancedBufferAttribute,
  instancedDynamicBufferAttribute,
  materialColor,
  max,
  mix,
  mx_noise_float,
  normalView,
  normalWorld,
  positionLocal,
  positionViewDirection,
  positionWorld,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { CAMERA, CELESTIAL_BLACKOUT_SEC, LURE_LEAD_SEC, MOMENT_BARS, SEC_PER_BAR } from '../../config';
import type { Cue, Vec3Tuple } from '../../contracts/events';
import type { RidePose } from '../../contracts/ride';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../../contracts/room';
import { createBrass, createGlass, sharedGlass, type GlassHandle } from '../../core/materials/glass';
import { CITY_FOCUS, cityPosition, layoutCity, type CityFrame } from './constellation';
import { applyLightmaps, createLureStream, loadRoomScene, mergeInstanceGroups, normalizeMesh, seededRandom, spriteQuad, type LureStream } from './kit';
import { generateStarField } from './stars';

const ROOM = 'celestial';
/** 9:50 星がつながりガラスの街を描く（撮影） */
const CONSTELLATION_T = MOMENT_BARS.celestialConstellation * SEC_PER_BAR;
/** 夜の藍（設計書「アートディレクション」: 藍、星の白金） */
const NIGHT = 0x070b22;
/**
 * 部屋の空気。光は「星のガラス玉の内側の光だけ」なので、ガラスの擬似反射は夜の藍の空とほぼ黒い下だけにし、
 * 光の向きのハイライト（殻の上の白いにじみになる）はほとんど乗せない。
 */
const ATMOSPHERE: Atmosphere = Object.freeze({
  background: NIGHT,
  exposure: 1.05,
  glassLighting: Object.freeze({
    sky: new THREE.Color().setRGB(0.08, 0.11, 0.26, THREE.LinearSRGBColorSpace),
    ground: new THREE.Color().setRGB(0.012, 0.016, 0.045, THREE.LinearSRGBColorSpace),
    keyColor: new THREE.Color().setRGB(0.78, 0.84, 1.0, THREE.LinearSRGBColorSpace),
    keyDir: Object.freeze({ x: 0.25, y: 0.8, z: -0.45 }),
    keyIntensity: 0.04,
  }),
});
/** 夜明けの岸の膜（区間の終わり）の何秒前から星を薄れさせるか */
const DAWN_FADE_SEC = 10;
/** 膜を抜けた後、中の殻・星・芯の輪を消す時刻（区間の終わりからの秒。膜の画面効果が隠す） */
const AFTER_MEMBRANE_SEC = 0.3;
/** 殻を抜けたときの光の輪が広がって消えるまでの秒 */
const SHELL_RIPPLE_SEC = 3.2;
/** 触れた星の線の数の上限（自分だけの星座） */
const MAX_LINKS = 64;
/** 触れた星がつながる相手を探す距離（m） */
const LINK_NEAR = 12;
/** 星を置かない値（光の粒の「街の線が届く時刻」「触れた時刻」）。float32 で 0.25 秒の差が表せる大きさ */
const NEVER = 1e6;

interface Shell {
  readonly mesh: THREE.Mesh;
  readonly crossings: { t: number; point: THREE.Vector3 }[];
  readonly center: THREE.Vector3;
  readonly radius: number;
  /** low の片面の殻: 外から見る形と、内から見る形（向きを裏返した形）。カメラの位置で毎フレーム選ぶ */
  readonly outward: THREE.BufferGeometry | null;
  readonly inward: THREE.BufferGeometry | null;
}

interface TouchStar {
  readonly touchable: Touchable;
  /** 星の光の粒の中の番号 */
  readonly glow: number;
  readonly index: number;
  readonly position: THREE.Vector3;
  touchedAt: number;
  readonly links: Set<number>;
}

export function createCelestialRoom(): RoomModule {
  const root = new THREE.Group();
  root.name = 'room:celestial';
  // 8:00 の暗転より前（万華鏡の膜の向こう）には見せない。暗転が明けて初めて星の海が現れる
  const content = new THREE.Group();
  content.name = 'celestial:content';
  root.add(content);
  const touchables: Touchable[] = [];
  const handles: GlassHandle[] = [];
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const textures: THREE.Texture[] = [];
  const shells: Shell[] = [];
  const touchStars: TouchStar[] = [];
  /** 膜を抜けた後に消す物（中の殻、星、芯の輪、膜とその縁、触れる星、線、遠い空、光の輪） */
  const insideOnly: THREE.Object3D[] = [];
  /** 出口の膜。遠くからは星を隠す濁った円に見えるので、近づくまで（膜の 26 秒前まで）は真鍮の縁だけを見せる */
  const membranes: THREE.Mesh[] = [];
  let lure: LureStream | null = null;
  let ripple: ReturnType<typeof shellRipple> | null = null;
  let focus: Vec3Tuple | null = null;
  let t0 = 0;
  let t1 = 0;
  let revealT = 0;
  let hiddenFound = false;
  let emit: RoomContext['events']['emit'] | null = null;
  /** 隠れた泡の動き（触れた時刻からの経過） */
  let hiddenAnim: ((t: number) => void) | null = null;

  // ── 共有のつまみ（uniform） ──
  const uTime = uniform(0);
  /** 星が灯るのにかける秒（光の点滅を抑えるモードではゆっくり） */
  const uFadeSec = uniform(0.6);
  /** 星の灯る時間割の伸び（光の点滅を抑えるモードでは 1.6 倍ゆっくり） */
  const uStretch = uniform(1);
  /** 星の明るさ全体（夜明けの前に薄れる） */
  const uMaster = uniform(1);
  /** 星座の街の明るさ（描き上がった後、ゆっくり息をする） */
  const uCity = uniform(1);
  /** 光の点滅を抑えるモードで、描いたばかりの線の閃きを弱める */
  const uFlash = uniform(1);
  /** 殻を抜ける光の輪の強さ（穏やかモードでは半分） */
  const uRippleGain = uniform(1);

  // 毎フレームの計算で使い回す
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const eye = new THREE.Vector3();

  // 触れた星の線（自分だけの星座）は、街の線と同じ帯の形の後ろに足していく
  let lines: RibbonGeometry | null = null;
  let linkBase = 0;
  let linkCount = 0;
  let glowDyn: THREE.InstancedBufferAttribute | null = null;

  function addLink(a: TouchStar, b: TouchStar, at: number): void {
    if (!lines || linkCount >= MAX_LINKS) return;
    const dist = a.position.distanceTo(b.position);
    const dur = 0.5 + dist * 0.05;
    lines.set(linkBase + linkCount++, a.position, b.position, at, dur, LINK_STYLE);
    a.links.add(b.index);
    b.links.add(a.index);
    // 線が届いた瞬間に相手の星が灯る
    b.touchedAt = at + dur;
    writeGlowDyn(b);
  }

  /** 触れる星の光の粒の「触れた時刻・縁の光」を書く（星の光の粒は一つの Sprite なので、その星の分だけ書き換える） */
  function writeGlowDyn(s: TouchStar, level?: number): void {
    if (!glowDyn) return;
    const arr = glowDyn.array as Float32Array;
    arr[s.glow * 2] = s.touchedAt;
    if (level !== undefined) arr[s.glow * 2 + 1] = level;
    glowDyn.needsUpdate = true;
  }

  return {
    id: 'celestial',
    root,
    touchables,
    atmosphere: ATMOSPHERE,

    async load(ctx: RoomContext) {
      emit = ctx.events.emit.bind(ctx.events);
      const tier = ctx.quality.tier;
      const low = tier === 'low';
      ({ t0, t1 } = ctx.ride.sectionTime(ROOM));
      revealT = t0 + CELESTIAL_BLACKOUT_SEC;
      const scene = await loadRoomScene(ctx, `rooms/${ROOM}.glb`);
      content.add(scene);

      // ── 焼いた台座: 藍の釉。光は星の光だけ（ライトマップ）。受け皿の上には金で天の目盛り（アストロラーベの盤）を刻む ──
      // 中心から真下を見ると、60m 下に金の目盛りの盤が見える（台座の位置は glb の形から求める）
      let dial: { x: number; z: number; top: number } | null = null;
      scene.traverse((o) => {
        if (o.userData.role === 'pedestal' && (o as THREE.Mesh).isMesh) {
          const b = new THREE.Box3().setFromObject(o);
          const c = b.getCenter(new THREE.Vector3());
          dial = { x: c.x, z: c.z, top: b.max.y };
        }
      });
      await applyLightmaps(
        ctx,
        scene,
        () => {
          const m = new THREE.MeshStandardNodeMaterial({ color: 0x1c2154, roughness: 0.4, metalness: 0 });
          if (dial) m.emissiveNode = astrolabeNode(dial);
          materials.push(m);
          return m;
        },
        textures,
      );

      // ── 物を役ごとに集める ──
      const byRole = new Map<string, THREE.Mesh[]>();
      scene.traverse((o) => {
        const role = o.userData.role;
        if (typeof role === 'string' && (o as THREE.Mesh).isMesh) byRole.set(role, [...(byRole.get(role) ?? []), o as THREE.Mesh]);
      });

      // ── 同心の殻: 透過は使わず、縁の反射と薄膜の虹色だけ（内側からは視界の外周だけにかすかに） ──
      // low（スマートフォン・VR）では片面で描く（透明の両面は2回に分けて描かれ、全画面を何枚も塗るため）。
      // 外から見る形と内から見る形（向きを裏返した形）を持ち、カメラの位置で選ぶ。材質は同じなので描き方（パイプライン）は増えない
      const shellMeshes = (byRole.get('shell') ?? []).sort((a, b) => Number(a.userData.radius) - Number(b.userData.radius));
      const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
      shellMeshes.forEach((mesh, i) => {
        const outer = i === shellMeshes.length - 1;
        // 半径 1 の形にして物の大きさで広げる（core のガラスの虹色のむらは物の座標で決まるので、
        // 60m の殻でもむらが細かすぎず、大きくゆっくり流れる薄膜に見える）。元の形はアセットの読み込み口が持つので写しを作る
        normalizeMesh(mesh, geometries);
        let outward: THREE.BufferGeometry | null = null;
        let inward: THREE.BufferGeometry | null = null;
        if (low) {
          outward = new THREE.SphereGeometry(1, 64, 32);
          inward = flipped(outward);
          geometries.push(outward, inward);
          mesh.geometry = outward;
        }
        const glass = createGlass(
          'iridescent',
          {
            color: outer ? 0xe2eaff : 0xe8f0ff,
            // 夜の暗さでは薄膜の虹色（照明に依らない）がよく目立つ。殻を5枚重ねても色が濁らないよう、縁の細い光を主に虹色はごく薄く
            opacity: outer ? 0.02 : 0.01,
            iridescence: outer ? 0.035 : 0.01 + 0.003 * i,
            rim: outer ? 0.7 : 0.28 + 0.04 * i,
            // 両面の殻として作る（core が「カメラが殻の内側」の見え方に切り替える）。low では片面にする
            doubleSided: true,
          },
          { tier },
        );
        if (low) glass.material.side = THREE.FrontSide;
        handles.push(glass);
        mesh.material = glass.material;
        mesh.renderOrder = 2 + (shellMeshes.length - i); // 外の殻から先に描く（同心なので距離で並べられない）
        mesh.userData.clearanceExempt = true;
        if (!outer) insideOnly.push(mesh);
        // 殻を抜ける時刻と場所（レールから求める）
        const box = new THREE.Box3().setFromObject(mesh);
        const center = box.getCenter(new THREE.Vector3());
        const radius = box.getSize(tmp).x / 2;
        const crossings: Shell['crossings'] = [];
        let prev = NaN;
        for (let t = t0 - 2; t <= t1 + 2; t += 0.05) {
          ctx.ride.poseAt(t, 'standard', pose);
          const d = Math.hypot(pose.x - center.x, pose.y - center.y, pose.z - center.z) - radius;
          if (Number.isFinite(prev) && Math.sign(d) !== Math.sign(prev)) crossings.push({ t, point: new THREE.Vector3(pose.x, pose.y, pose.z) });
          prev = d;
        }
        shells.push({ mesh, crossings, center, radius, outward, inward });
      });
      const center = shellMeshes.length ? new THREE.Box3().setFromObject(shellMeshes[0]).getCenter(new THREE.Vector3()) : new THREE.Vector3();

      // ── 出口の膜（夜明けの岸へ）: 面全体に虹色を出す膜 ──
      for (const mesh of byRole.get('membrane') ?? []) {
        // 膜の形も半径 1 ほどに直す（虹色のむらが窓の大きさに合う）
        normalizeMesh(mesh, geometries);
        // 膜の向こうには夜明けの岸の空がにじむ（夜明けの岸の部屋が、膜の 14 秒前から出口の方角だけ空を明るくする）
        const glass = createGlass('iridescent', { color: 0xffe6d8, opacity: 0.02, iridescence: 0.6, face: 0.04, rim: 1, doubleSided: true }, { tier });
        handles.push(glass);
        membranes.push(mesh);
        insideOnly.push(mesh);
        mesh.material = glass.material;
        mesh.renderOrder = 8;
        mesh.userData.clearanceExempt = true;
      }

      // ── 真鍮の細い輪（子午線・黄道・天の芯・膜の縁）: 弧をまとめて描く ──
      const brass = createBrass({ color: 0xc9a46a, roughness: 0.3 }) as THREE.MeshStandardNodeMaterial;
      // 動く光源がないので、真鍮は星明かりを受けた縁だけが細く光る（視線に対して寝た面ほど明るい）
      const nv = normalView.dot(positionViewDirection).abs().clamp(0, 1);
      brass.emissiveNode = materialColor.rgb.mul(float(0.16).add(float(1).sub(nv).pow(2).mul(0.7))).mul(uMaster.mul(0.7).add(0.3));
      materials.push(brass);
      for (const im of mergeInstanceGroups(scene, () => brass)) {
        // 外殻を抱く子午線と黄道は残す（夜明けの岸の代役が同じ輪で引き継ぐ）。芯と膜の縁は中の物
        if (im.userData.instanceGroup !== 'meridian') insideOnly.push(im);
      }

      // ── 星のガラス玉の型（Blender）→ インスタンス ──
      const templates = new Map<string, THREE.BufferGeometry>();
      for (const mesh of byRole.get('star_template') ?? []) {
        templates.set(String(mesh.userData.star_kind), mesh.geometry);
        geometries.push(mesh.geometry);
        mesh.removeFromParent();
      }
      const geoA = templates.get('a') ?? new THREE.IcosahedronGeometry(1, 1);
      const geoB = templates.get('b') ?? new THREE.IcosahedronGeometry(1, 2);
      const geoC = templates.get('c') ?? new THREE.SphereGeometry(1, 20, 10);
      // 明るい星がレールの近くに来たとき用の、輪郭のなめらかな型
      const geoFine = new THREE.SphereGeometry(1, 24, 16);
      for (const g of [geoA, geoB, geoC, geoFine]) if (!geometries.includes(g)) geometries.push(g);

      // 9:50 の目と正面（星座の街の向き）
      ctx.ride.poseAt(CONSTELLATION_T, 'standard', pose);
      const city: CityFrame = {
        eye: new THREE.Vector3(pose.x, pose.y + CAMERA.seatEyeHeight, pose.z),
        forward: new THREE.Vector3(-Math.sin(pose.yaw), 0, -Math.cos(pose.yaw)),
        right: new THREE.Vector3(Math.cos(pose.yaw), 0, -Math.sin(pose.yaw)),
      };
      const f = cityPosition(city, CITY_FOCUS);
      focus = [f.x, f.y, f.z];

      // 暗転が明けたときの目と正面（星が灯る順）
      ctx.ride.poseAt(revealT + 2, 'standard', pose);
      const revealEye = new THREE.Vector3(pose.x, pose.y + CAMERA.seatEyeHeight, pose.z);
      const revealForward = new THREE.Vector3(-Math.sin(pose.yaw), 0, -Math.cos(pose.yaw));

      // レールの点（この区間と、ほかの区間）
      const span = ctx.ride.sectionSpan(ROOM);
      const path: THREE.Vector3[] = [];
      for (let s = span.s0 - 40; s <= span.s1 + 40; s += 1) {
        const p = ctx.ride.pointAt(s);
        path.push(new THREE.Vector3(p.x, p.y, p.z));
      }
      const otherPath: THREE.Vector3[] = [];
      const total = ctx.ride.data.rail.points.length * ctx.ride.data.rail.spacing;
      for (let s = 0; s <= total; s += 3) {
        if (s > span.s0 - 40 && s < span.s1 + 40) continue;
        const p = ctx.ride.pointAt(s);
        otherPath.push(new THREE.Vector3(p.x, p.y, p.z));
      }
      const nearPath = (p: THREE.Vector3, d: number) => {
        for (const q of path) if (q.distanceToSquared(p) < d * d) return true;
        return false;
      };

      const field = generateStarField({
        center,
        shellRadii: shellMeshes.map((m) => Number(m.userData.radius) || 1),
        path,
        otherPath,
        cityEye: city.eye,
        cityForward: city.forward,
        revealEye,
        revealForward,
        revealT,
        scale: ctx.quality.particleScale,
      });

      // ガラス玉（インスタンス）。星の光は玉の中の光の粒（下の Sprite）で描き、玉そのものは縁の反射だけ
      const orbGlass = sharedGlass('clear', { color: 0xe6eeff, opacity: 0.015, rim: 0.4, iridescence: 0.08 }, { tier });
      const orbGlassB = sharedGlass('clear', { color: 0xf2f4ff, opacity: 0.02, rim: 0.6, iridescence: 0.14 }, { tier });
      handles.push(orbGlass, orbGlassB);
      const mtx = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const makeOrbs = (geo: THREE.BufferGeometry, glass: GlassHandle, idx: number[], name: string) => {
        const im = new THREE.InstancedMesh(geo, glass.material, Math.max(1, idx.length));
        im.count = idx.length;
        im.name = name;
        im.userData.role = 'stars';
        idx.forEach((i, k) => {
          const r = field.radius[i];
          im.setMatrixAt(k, mtx.compose(tmp.fromArray(field.position, i * 3), q, sc.set(r, r, r)));
        });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.renderOrder = 1;
        content.add(im);
        insideOnly.push(im);
        return im;
      };
      // レールの近く（12m 以内）の星は、輪郭が角ばって見えないよう細かい型で（小さな星は中くらい、明るい星はなめらか）
      const idxA: number[] = [];
      const idxNear: number[] = [];
      const idxB: number[] = [];
      const idxBNear: number[] = [];
      for (let i = 0; i < field.count; i++) {
        const near = nearPath(tmp.fromArray(field.position, i * 3), 12);
        if (field.kind[i] === 0) (near ? idxNear : idxA).push(i);
        else (near ? idxBNear : idxB).push(i);
      }
      makeOrbs(geoA, orbGlass, idxA, 'celestial:stars-a');
      makeOrbs(geoB, orbGlass, idxNear, 'celestial:stars-a-near');
      makeOrbs(geoB, orbGlassB, idxB, 'celestial:stars-b');
      makeOrbs(geoFine, orbGlassB, idxBNear, 'celestial:stars-b-near');

      // ── 9:50 の星座の街 ──
      const layout = layoutCity(city, CONSTELLATION_T);
      const cityIdx: number[] = [];
      layout.stars.forEach((p, i) => {
        // 玉の箱（半径 0.3 × √3）を引いても、レールから 1.75m 以上
        if (!nearPath(p, 2.6)) cityIdx.push(i);
      });
      const cityOrbs = new THREE.InstancedMesh(geoC, orbGlass.material, Math.max(1, cityIdx.length));
      cityOrbs.count = cityIdx.length;
      cityOrbs.name = 'celestial:stars-city';
      cityOrbs.userData.role = 'stars';
      cityIdx.forEach((i, k) => cityOrbs.setMatrixAt(k, mtx.compose(layout.stars[i], q, sc.set(0.3, 0.3, 0.3))));
      cityOrbs.instanceMatrix.needsUpdate = true;
      cityOrbs.computeBoundingSphere();
      cityOrbs.renderOrder = 1;
      content.add(cityOrbs);
      insideOnly.push(cityOrbs);

      // ── 触れられる星: 近くの星と光の線でつながる（自分だけの星座） ──
      // ガラスは暖・冷の2つを共有する（材質を増やさない）。縁の光と触れた反応は、星の光の粒（明るさと閃き）と大きさで出す
      const touchMeshes = (byRole.get('touch_star') ?? []).sort((a, b) => String(a.userData.touch_id).localeCompare(String(b.userData.touch_id)));
      const warmGlass = sharedGlass('clear', { color: 0xfff2dc, opacity: 0.05, rim: 0.85, iridescence: 0.3, emissive: 0xffd9a0, emissiveIntensity: 0.06 }, { tier });
      const coolGlass = sharedGlass('clear', { color: 0xe8f0ff, opacity: 0.05, rim: 0.85, iridescence: 0.3, emissive: 0xbfd4ff, emissiveIntensity: 0.06 }, { tier });
      handles.push(warmGlass, coolGlass);

      // ── 星の光の粒（玉の中の光）: 星の海・街の星・触れる星を一つの Sprite で ──
      const nField = field.count;
      const nCity = cityIdx.length;
      const nTouch = touchMeshes.length;
      const n = Math.max(1, nField + nCity + nTouch);
      const gPos = new Float32Array(n * 3);
      const gSize = new Float32Array(n);
      const gColor = new Float32Array(n * 3);
      const gLight = new Float32Array(n * 2);
      const gJoin = new Float32Array(n).fill(NEVER);
      const gDyn = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) gDyn[i * 2] = -NEVER;
      gPos.set(field.position.subarray(0, nField * 3));
      gColor.set(field.color.subarray(0, nField * 3));
      gLight.set(field.light.subarray(0, nField * 2));
      for (let i = 0; i < nField; i++) gSize[i] = field.radius[i] * (field.kind[i] === 0 ? 5.5 : 6.5);
      const rand = seededRandom(0xc17);
      cityIdx.forEach((i, k) => {
        const g = nField + k;
        gPos.set([layout.stars[i].x, layout.stars[i].y, layout.stars[i].z], g * 3);
        gSize[g] = 0.36 * 5.5;
        // 線が届くまでは目立たない星（街の形を先に見せない）
        gColor.set([0.6, 0.56, 0.48], g * 3);
        gLight.set([revealT + 7 + rand() * 9, rand()], g * 2);
        gJoin[g] = layout.joinAt[i];
      });

      touchMeshes.forEach((mesh, i) => {
        const p = mesh.getWorldPosition(new THREE.Vector3());
        const warm = i % 3 === 0;
        const g = nField + nCity + i;
        mesh.material = (warm ? warmGlass : coolGlass).material;
        mesh.renderOrder = 3;
        insideOnly.push(mesh);
        gPos.set([p.x, p.y, p.z], g * 3);
        gSize[g] = 0.42 * 4.6;
        gColor.set(warm ? [1.7, 1.45, 1.05] : [1.15, 1.35, 1.8], g * 3);
        gLight.set([revealT + 6 + i * 0.25, (i * 0.618) % 1], g * 2);
        const id = typeof mesh.userData.touch_id === 'string' && mesh.userData.touch_id.startsWith(`${ROOM}/`) ? mesh.userData.touch_id : `${ROOM}/star-${i}`;
        const star: TouchStar = {
          index: i,
          glow: g,
          position: p,
          touchedAt: -NEVER,
          links: new Set(),
          touchable: {
            id,
            kind: 'star',
            section: ROOM,
            object: mesh,
            radius: 0.45,
            enabled: true,
            idleChime: true,
            setHighlight: (level) => writeGlowDyn(star, level),
            onTouch: (e) => {
              star.touchedAt = e.t;
              writeGlowDyn(star);
              // まだつながっていない近くの星（なければ一番近い星）へ線を引く
              let best: TouchStar | null = null;
              let bestD = Infinity;
              for (const other of touchStars) {
                if (other === star || star.links.has(other.index)) continue;
                const d = other.position.distanceTo(star.position);
                if (d < bestD) {
                  bestD = d;
                  best = other;
                }
              }
              if (best && (bestD <= LINK_NEAR || star.links.size === 0)) {
                addLink(star, best, e.t + 0.04);
                emit?.('constellationLinked', { fromId: id, toId: best.touchable.id });
              }
            },
          },
        };
        touchStars.push(star);
        touchables.push(star.touchable);
      });
      glowDyn = new THREE.InstancedBufferAttribute(gDyn, 2);
      glowDyn.setUsage(THREE.DynamicDrawUsage);
      const glow = starGlow(nField + nCity + nTouch, gPos, gSize, gColor, gLight, gJoin, glowDyn);
      content.add(glow);
      insideOnly.push(glow);

      // ── 光の線: 街の線（描き始めの時刻と長さ）と、触れた星の線（後ろに足していく） ──
      linkBase = layout.segments.length;
      lines = new RibbonGeometry(linkBase + MAX_LINKS);
      layout.segments.forEach((s, i) => lines!.set(i, s.a, s.b, s.t0, s.duration, CITY_STYLE));
      geometries.push(lines.geometry);
      const lineMesh = new THREE.Mesh(lines.geometry, ribbonMaterial());
      lineMesh.name = 'celestial:constellation';
      lineMesh.userData = { role: 'constellation', clearanceExempt: true };
      lineMesh.frustumCulled = false;
      lineMesh.renderOrder = 6;
      content.add(lineMesh);
      insideOnly.push(lineMesh);

      // ── 隠れた小さな泡（淡い菫色） ──
      for (const mesh of byRole.get('hidden') ?? []) {
        const glass = createGlass('iridescent', { color: 0xe4d8ff, opacity: 0.05, iridescence: 1, rim: 1, emissive: 0x6c58c8, emissiveIntensity: 0.05 }, { tier });
        handles.push(glass);
        mesh.material = glass.material;
        insideOnly.push(mesh);
        let touchedAt = -NEVER;
        const id = typeof mesh.userData.touch_id === 'string' && mesh.userData.touch_id.startsWith(`${ROOM}/`) ? mesh.userData.touch_id : `${ROOM}/hidden`;
        const base = mesh.scale.clone();
        touchables.push({
          id,
          kind: 'hidden-bubble',
          section: ROOM,
          object: mesh,
          radius: 0.2,
          enabled: true,
          setHighlight: (level) => glass.setHighlight(level),
          onTouch: (e) => {
            glass.pulse(e.t);
            touchedAt = e.t;
            if (!hiddenFound) {
              hiddenFound = true;
              emit?.('hiddenFound', { section: ROOM });
            }
          },
        });
        hiddenAnim = (t) => {
          const k = t >= touchedAt ? Math.exp(-(t - touchedAt) * 3) : 0;
          mesh.scale.copy(base).multiplyScalar(1 + 0.6 * k + 0.05 * Math.sin(t * 0.9));
        };
      }

      // ── 遠くの星と天の川（球の外の、さらに遠い空）。背景の藍の上に足すだけ ──
      const dome = skyDome(low);
      dome.position.copy(center);
      content.add(dome);
      insideOnly.push(dome);

      // ── 殻を抜けたときの光の輪（殻と同じ球の上に、薄い輪だけを描く） ──
      ripple = shellRipple();
      content.add(ripple.mesh);
      insideOnly.push(ripple.mesh);

      // ── 見どころへの光の粒（誘導） ──
      lure = createLureStream(CONSTELLATION_T - LURE_LEAD_SEC, CONSTELLATION_T, 0xffe2b0);
      content.add(lure.object);

      scene.updateMatrixWorld(true);
      root.updateMatrixWorld(true);
    },

    update(frame: RoomFrame) {
      const t = frame.t;
      content.visible = t >= t0 - 0.02;
      uTime.value = t;
      uFadeSec.value = frame.reducedFlash ? 1.8 : 0.6;
      uStretch.value = frame.reducedFlash ? 1.6 : 1;
      uFlash.value = frame.reducedFlash ? 0.35 : 1;
      uRippleGain.value = frame.comfort === 'gentle' ? 0.5 : 1;
      uMaster.value = 1 - smooth(t1 - DAWN_FADE_SEC, t1 + 2, t);
      // 街は描き上がった後ゆっくり息をし、出口へ向かうにつれて薄れる
      uCity.value = (0.85 + 0.15 * Math.cos((t - CONSTELLATION_T) * 0.5)) * (1 - smooth(CONSTELLATION_T + 40, t1 - 2, t));
      for (const h of handles) h.setTime(t);
      // 膜を抜けたら中の物を消す（外殻と子午線・黄道だけが残り、夜明けの岸の代役へ引き継ぐ）
      const inside = t < t1 + AFTER_MEMBRANE_SEC;
      for (const o of insideOnly) o.visible = inside;
      for (const m of membranes) m.visible = inside && t >= t1 - 26;

      // low の片面の殻: カメラが殻の内なら裏返した形、外なら表の形
      frame.camera.getWorldPosition(eye);
      for (const s of shells) {
        if (s.outward && s.inward) s.mesh.geometry = eye.distanceTo(s.center) < s.radius ? s.inward : s.outward;
      }

      // 殻を抜けた瞬間、抜けた所から殻の上を光の輪が広がる（時刻から決める。殻を抜けるたびに一つ）
      if (ripple && inside) {
        let active: Shell | null = null;
        let at = -Infinity;
        let point: THREE.Vector3 | null = null;
        for (const s of shells) {
          for (const c of s.crossings) {
            if (c.t <= t && t - c.t < SHELL_RIPPLE_SEC && c.t > at) {
              active = s;
              at = c.t;
              point = c.point;
            }
          }
        }
        ripple.mesh.visible = active !== null;
        if (active && point) {
          ripple.mesh.position.copy(active.center);
          ripple.mesh.scale.setScalar(active.radius * 1.002);
          (ripple.origin.value as THREE.Vector3).subVectors(point, active.center).normalize();
          ripple.start.value = at;
          ripple.radius.value = active.radius;
        }
      }

      // 触れた星の動き（触れた時刻からの経過）
      for (const s of touchStars) {
        const k = t >= s.touchedAt ? Math.exp(-(t - s.touchedAt) * 4) : 0;
        s.touchable.object.scale.setScalar(1 + 0.35 * k);
      }
      hiddenAnim?.(t);

      // 誘導の光の粒: ゴンドラの少し前から街へ
      if (lure && focus) {
        const p = frame.pose;
        from.set(p.x - Math.sin(p.yaw) * 2.5, p.y + 0.1, p.z - Math.cos(p.yaw) * 2.5);
        to.set(focus[0], focus[1], focus[2]);
        lure.update(t, from, to, frame.reducedFlash);
      }
    },

    onCue(_cue: Cue) {
      // 演出はすべて時刻から決めるので、出来事では何もしない（誘導の光の粒も時刻で出す）
    },

    focusPoint(name: Cue['name']): Vec3Tuple | null {
      return name === 'celestial.constellation' ? focus : null;
    },

    dispose() {
      const geos = new Set<THREE.BufferGeometry>(geometries);
      root.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (g) geos.add(g);
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      for (const g of geos) g.dispose();
      for (const h of handles) h.dispose();
      for (const m of materials) m.dispose();
      for (const tex of textures) tex.dispose();
      lure?.dispose();
      root.clear();
      touchables.length = 0;
      touchStars.length = 0;
      shells.length = 0;
      insideOnly.length = 0;
    },
  };

  // ── 中で使う道具（uniform を共有するので部屋の中に置く） ──

  /**
   * 星の光の粒（玉の中の光）。一つの Sprite で数千を描く。灯る時刻（light.x）から明るくなり、ゆっくりまたたく。
   * 街の星は線が届く時刻（join）に明るくなり、触れる星は触れた時刻と縁の光（dyn）で閃く。
   */
  function starGlow(
    count: number,
    position: Float32Array,
    size: Float32Array,
    color: Float32Array,
    light: Float32Array,
    join: Float32Array,
    dyn: THREE.InstancedBufferAttribute,
  ): THREE.Sprite {
    const aPos = instancedBufferAttribute<'vec3'>(new THREE.InstancedBufferAttribute(position, 3), 'vec3');
    const aSize = instancedBufferAttribute<'float'>(new THREE.InstancedBufferAttribute(size, 1), 'float');
    const aColor = instancedBufferAttribute<'vec3'>(new THREE.InstancedBufferAttribute(color, 3), 'vec3');
    const aLight = instancedBufferAttribute<'vec2'>(new THREE.InstancedBufferAttribute(light, 2), 'vec2');
    const aJoin = instancedBufferAttribute<'float'>(new THREE.InstancedBufferAttribute(join, 1), 'float');
    const aDyn = instancedDynamicBufferAttribute<'vec2'>(dyn, 'vec2');
    const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    material.positionNode = aPos;
    // 灯る時刻は暗転が明けた時刻からの間を伸ばせる（光の点滅を抑えるモードでは時間割ごとゆっくり）
    const lightAt = aLight.x.sub(revealT).mul(uStretch).add(revealT);
    const lit = smoothstep(lightAt, lightAt.add(uFadeSec), uTime);
    // またたき: 1 周 8〜25 秒（光の明滅は 1 秒に 3 回未満）
    const twinkle = sin(uTime.mul(aLight.y.mul(0.5).add(0.25)).add(aLight.y.mul(40))).mul(0.14).add(0.86);
    // 星座の線が届いたら明るくなる（街の星だけ。ほかの星の join は NEVER）
    const joined = smoothstep(aJoin, aJoin.add(0.25), uTime).mul(uCity).mul(3.6);
    // 触れた・線が届いた瞬間の閃き（触れる星だけ）と、近づいたときの縁の光
    const since = uTime.sub(aDyn.x);
    const flare = step(0, since).mul(exp(since.max(0).mul(-2.2))).mul(2.5).mul(uFlash.mul(0.6).add(0.4));
    const boost = float(1).add(joined).add(flare).add(aDyn.y.mul(0.8));
    material.scaleNode = aSize.mul(float(1).add(boost.sub(1).mul(0.22)));
    const d = uv().sub(0.5).length().mul(2);
    const core = exp(d.mul(d).mul(-90)).mul(1.7);
    const halo = exp(d.mul(-5.5)).mul(0.24).mul(float(1).sub(d).max(0));
    material.colorNode = vec4(aColor.mul(core.add(halo)).mul(lit).mul(twinkle).mul(boost).mul(uMaster), 1);
    materials.push(material);
    const geo = spriteQuad();
    geometries.push(geo);
    const sprite = new THREE.Sprite(material);
    sprite.geometry = geo;
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 4;
    sprite.userData.clearanceExempt = true;
    return sprite;
  }

  /**
   * 光の線（街の星座と、触れた星の線）。線ごとに描き始めの時刻と長さを持ち、時刻から伸びる。カメラに向いた細い帯。
   * 線の色と太さ（aStyle）と種類（aKind: 0 街、1 触れた線）は線ごと。街の線は uCity、触れた線は uMaster で薄れる
   */
  function ribbonMaterial(): THREE.Material {
    const aA = attribute('aStart', 'vec3');
    const aB = attribute('aEnd', 'vec3');
    const aC = attribute('aCorner', 'vec2');
    const aT = attribute('aTime', 'vec2');
    const aS = attribute('aStyle', 'vec4');
    const aK = attribute('aKind', 'float');
    const prog = uTime.sub(aT.x).div(aT.y).clamp(0, 1);
    const head = mix(aA, aB, prog);
    const p = mix(aA, head, aC.x);
    const dir = aB.sub(aA).normalize();
    const view = cameraPosition.sub(p);
    const side = cross(dir, view);
    const sideN = side.div(max(side.length(), 1e-4));
    // 遠くでも 1 画素より細くならない
    const hw = max(aS.w, view.length().mul(0.0012));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    material.positionNode = p.add(sideN.mul(aC.y.mul(hw)));
    const across = aC.y;
    const profile = exp(across.mul(across).mul(-4.2));
    // 描き終えたばかりの線と、伸びている先はひときわ明るい
    const since = uTime.sub(aT.x.add(aT.y));
    const just = exp(since.max(0).mul(-2.0)).mul(step(0, since)).mul(1.4).mul(uFlash);
    const tip = smoothstep(0.7, 1, aC.x).mul(step(prog, 0.999)).mul(1.5);
    const shown = step(0.0001, prog);
    const master = mix(uCity, uMaster, aK);
    material.colorNode = vec4(aS.xyz.mul(profile).mul(float(1).add(just).add(tip)).mul(master).mul(shown), 1);
    materials.push(material);
    return material;
  }

  /**
   * 殻を抜けたときの光の輪。抜けた点から殻の上を、細い輪が外へ広がって消える（core の触れたときの波紋は
   * 殻の大きさに比べて太く、目の前で白く広がりすぎるので、殻を抜ける合図はこの細い輪で描く）。
   * 目の近く（抜けた点から 2.5m 以内）では見せず、数 m 先から現れる（VR で目のすぐ前を大きく動く光にしない）。
   */
  function shellRipple() {
    const geo = new THREE.SphereGeometry(1, 96, 48);
    geometries.push(geo);
    const origin = uniform(new THREE.Vector3(1, 0, 0));
    const start = uniform(-NEVER);
    const radius = uniform(10);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const n = positionLocal.normalize();
    const arc = n.dot(origin).clamp(-1, 1).acos().mul(radius); // 抜けた点からの殻の上の道のり（m）
    const age = uTime.sub(start).max(0);
    const front = age.mul(9).add(age.mul(age).mul(-0.6).max(-20)); // 最初は速く、だんだんゆっくり
    const w = float(0.5).add(age.mul(0.5));
    const q = arc.sub(front).div(w);
    const ring = exp(q.mul(q).negate());
    const fade = float(1).sub(age.div(SHELL_RIPPLE_SEC)).clamp(0, 1).pow(1.6);
    const awayFromEye = smoothstep(2.5, 6, arc);
    // 輪の色は薄膜の虹色（道のりで色が移る）
    const hue = vec3(0, 0.33, 0.67).add(arc.mul(0.03)).mul(6.28318).cos().mul(0.5).add(0.5);
    const tint = mix(vec3(0.85, 0.9, 1.0), hue, 0.45);
    material.colorNode = vec4(tint.mul(ring).mul(fade).mul(awayFromEye).mul(uRippleGain).mul(uFlash.mul(0.5).add(0.5)).mul(0.55), 1);
    materials.push(material);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'celestial:shell-ripple';
    mesh.userData = { role: 'ripple', clearanceExempt: true };
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 7;
    return { mesh, origin, start, radius };
  }

  /**
   * 台座の受け皿に刻んだ金の目盛り（同心の輪、15° ごとの放射線、黄道の星の点）。中心からの水平距離と角度で描く。
   * 線は画面の上で細くなりすぎないよう、距離の変化（fwidth）で太さを保つ。
   */
  function astrolabeNode(d: { x: number; z: number; top: number }): THREE.Node<'vec3'> {
    const rel = positionWorld.xz.sub(vec2(d.x, d.z));
    const r = rel.length();
    const ang = atan(rel.y, rel.x);
    const line = (v: THREE.Node<'float'>, period: number, width: number) => {
      const k = v.div(period);
      const f = k.sub(k.round()).abs().mul(period); // 一番近い線までの距離
      const w = max(float(width), fwidth(v).mul(0.8));
      return float(1).sub(smoothstep(w.mul(0.5), w, f));
    };
    const rings = line(r, 3.2, 0.07).mul(step(1.5, r)).mul(step(r, 19.5));
    const rays = line(ang.mul(180 / Math.PI), 15, 0.25).mul(smoothstep(4.5, 6.5, r)).mul(step(r, 17.5));
    const band = smoothstep(12.6, 12.8, r).mul(float(1).sub(smoothstep(15.6, 15.8, r)));
    // 黄道の帯の星の点（30° ごとに 1 つずつ大きな点）
    const k = ang.mul(6 / Math.PI).add(0.5);
    const seg = k.sub(k.floor()).sub(0.5).mul(Math.PI / 6).mul(r);
    const dotD = vec2(seg, r.sub(14.2)).length();
    const dots = float(1).sub(smoothstep(0.35, 0.5, dotD));
    const upper = smoothstep(d.top - 14, d.top - 0.5, positionWorld.y).mul(smoothstep(0.2, 0.6, normalWorld.y));
    const gold = vec3(0.95, 0.72, 0.38);
    return gold.mul(rings.add(rays.mul(0.7)).add(band.mul(0.06)).add(dots).clamp(0, 1)).mul(upper).mul(0.55).mul(uMaster.mul(0.6).add(0.4));
  }

  /** 遠い空: 細かな遠い星と、淡い天の川。背景の藍に足す（加算）。暗転が明けると星と一緒に現れる */
  function skyDome(low: boolean): THREE.Mesh {
    const geo = new THREE.SphereGeometry(1500, 48, 24);
    geometries.push(geo);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const dir = positionLocal.normalize();
    const bandN = vec3(0.32, 0.86, -0.4).normalize();
    const b = dir.dot(bandN);
    const band = exp(b.mul(b).mul(-26));
    const cloud = low ? float(0.7) : mx_noise_float(dir.mul(3.2)).mul(0.5).add(0.55).mul(mx_noise_float(dir.mul(11)).mul(0.3).add(0.75));
    const milky = vec3(0.05, 0.06, 0.13).mul(band).mul(cloud).mul(0.9);
    const layer = (scale: number, density: number, bright: number) => {
      const g = dir.mul(scale);
      const cell = g.floor();
      const fr = g.sub(cell).sub(0.5);
      const seed = cell.dot(vec3(1, 157, 113)).add(1e6); // hash は符号なし整数で計算するので正にする
      const h = hash(seed);
      const jitter = vec3(hash(seed.add(7)), hash(seed.add(19)), hash(seed.add(31))).sub(0.5).mul(0.5);
      const off = fr.sub(jitter);
      return step(1 - density, h).mul(exp(off.dot(off).mul(-26))).mul(hash(seed.add(3)).mul(0.8).add(0.2)).mul(bright);
    };
    const stars = low ? layer(150, 0.02, 0.9) : layer(150, 0.02, 0.9).add(layer(330, 0.03, 0.45).mul(band.mul(1.5).add(0.5)));
    const lit = smoothstep(t0 + CELESTIAL_BLACKOUT_SEC + 2, t0 + CELESTIAL_BLACKOUT_SEC + 14, uTime).mul(uMaster);
    material.colorNode = vec4(milky.add(vec3(0.85, 0.9, 1.0).mul(stars)).mul(lit), 1);
    materials.push(material);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'celestial:sky';
    mesh.userData = { role: 'sky', clearanceExempt: true };
    mesh.renderOrder = -2;
    mesh.frustumCulled = false;
    return mesh;
  }
}

/** 線の見た目: 色（線形）と半分の太さ（m）、種類（0 街、1 触れた線） */
interface LineStyle {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly halfWidth: number;
  readonly kind: number;
}
/** 街の線は白金の金、触れた線は星明かりの淡い水色 */
const CITY_STYLE: LineStyle = { r: 1.0, g: 0.86, b: 0.6, halfWidth: 0.085, kind: 0 };
const LINK_STYLE: LineStyle = { r: 0.78, g: 0.9, b: 1.0, halfWidth: 0.03, kind: 1 };

/** 光の線の形（帯ごとに4頂点。始点・終点・角・時刻・見た目） */
class RibbonGeometry {
  readonly geometry = new THREE.BufferGeometry();
  private readonly start: THREE.BufferAttribute;
  private readonly end: THREE.BufferAttribute;
  private readonly time: THREE.BufferAttribute;
  private readonly pos: THREE.BufferAttribute;
  private readonly style: THREE.BufferAttribute;
  private readonly kind: THREE.BufferAttribute;

  constructor(readonly capacity: number) {
    const n = Math.max(1, capacity);
    this.start = new THREE.BufferAttribute(new Float32Array(n * 12), 3);
    this.end = new THREE.BufferAttribute(new Float32Array(n * 12), 3);
    // 使っていない帯は描き始めが遠い先（長さ 0 の帯になる）
    this.time = new THREE.BufferAttribute(new Float32Array(n * 8).fill(NEVER), 2);
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 12), 3);
    this.style = new THREE.BufferAttribute(new Float32Array(n * 16), 4);
    this.kind = new THREE.BufferAttribute(new Float32Array(n * 4), 1);
    const corner = new Float32Array(n * 8);
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      corner.set([0, -1, 1, -1, 1, 1, 0, 1], i * 8);
      index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    }
    for (const a of [this.start, this.end, this.time, this.pos, this.style, this.kind]) a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.pos);
    this.geometry.setAttribute('aStart', this.start);
    this.geometry.setAttribute('aEnd', this.end);
    this.geometry.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    this.geometry.setAttribute('aTime', this.time);
    this.geometry.setAttribute('aStyle', this.style);
    this.geometry.setAttribute('aKind', this.kind);
    this.geometry.setIndex(index);
  }

  set(i: number, a: THREE.Vector3, b: THREE.Vector3, t0: number, duration: number, s: LineStyle): void {
    if (i < 0 || i >= this.capacity) return;
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      this.start.setXYZ(v, a.x, a.y, a.z);
      this.end.setXYZ(v, b.x, b.y, b.z);
      const along = k === 1 || k === 2 ? b : a;
      this.pos.setXYZ(v, along.x, along.y, along.z);
      this.time.setXY(v, t0, Math.max(0.02, duration));
      this.style.setXYZW(v, s.r, s.g, s.b, s.halfWidth);
      this.kind.setX(v, s.kind);
    }
    for (const attr of [this.start, this.end, this.pos, this.time, this.style, this.kind]) attr.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }
}

/** 向きを裏返した形の写し（三角形の巡りと法線を逆に）。片面の殻を内側から見るため */
function flipped(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.clone();
  const index = g.getIndex();
  if (index) {
    const a = index.array;
    for (let i = 0; i < a.length; i += 3) {
      const tmp = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = tmp;
    }
    index.needsUpdate = true;
  }
  const nrm = g.getAttribute('normal');
  if (nrm) {
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
    nrm.needsUpdate = true;
  }
  return g;
}

function smooth(e0: number, e1: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
}
