// 第2室「雨の回廊」（3:30〜6:00）と、琥珀と瑠璃の扉の分岐。
// 形と光は Blender（blender/scripts/rooms/rain.py）で造形して焼いた glb とライトマップ。ここでは、
// ガラスの材質（core）・水と雨・触れられる物（止まった雨粒、扉、隠れた泡）・見どころの動きを重ねる。
//
// 構図（入口の一枚絵）: 低いガラスの穹窿の回廊がゆるく右へ曲がって霧の奥へ続く。左右に雫形のガラスの柱、
// 雫の中に琥珀の灯り。濡れた石の床と中央の水路に灯りが映り、左の水の膜の壁の向こうに街の灯りがにじむ。
// 見どころ（5:10）: 屋根のない楕円の中庭で、降る雨が見どころの点から波のように一粒ずつガラス玉に変わって止まる。
// 止まった雨粒の中には、まわりの景色が逆さに映る（環境画像を球のレンズのように歪めて読む）。
// 分岐（5:50）: 突き当たりの円い膜の左右に、琥珀（左）と瑠璃（右）の扉が床から立ち上がる。
//
// すべて時刻から決める（雨の位置、止まる時刻、扉の開き具合）。触れた記録（弾けた雨粒、選んだ扉）だけは出来事の時刻で持ち、
// 時刻が戻ったら捨てる。
import * as THREE from 'three/webgpu';
import { BRANCH_DECIDE_AFTER_DOORS_BARS, MOMENT_BARS, SEC_PER_BAR } from '../../config';
import type { Cue, Vec3Tuple } from '../../contracts/events';
import { DEFAULT_DOOR, type DoorChoice } from '../../contracts/ids';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../../contracts/room';
import type { RidePose } from '../../contracts/ride';
import { createBrass, createGlass, setGlassLighting, sharedGlass, type GlassHandle, type GlassParams } from '../../core/materials/glass';
import { disposeTree, findAll, instancesFrom, loadBlenderRoom } from './blender-room';
import { DoorChoices } from './doors';
import {
  cityLightsMaterial,
  cityMaterial,
  createRainClock,
  decorateDropGlass,
  decorateMetal,
  decorateWetFloor,
  floatUniform,
  glowMaterial,
  haloMaterial,
  lightPoolMaterial,
  rainbowRingMaterial,
  rainStreakMaterial,
  waterFilmMaterial,
  waterMaterial,
  type FallSpec,
  type FloatUniform,
  type RainAttributes,
} from './look';
import { courtFromExtras, flowTime, planRain } from './rainfall';

const FREEZE_T = MOMENT_BARS.rainFreeze * SEC_PER_BAR;
const DOORS_T = MOMENT_BARS.rainDoors * SEC_PER_BAR;
const DECIDE_T = DOORS_T + BRANCH_DECIDE_AFTER_DOORS_BARS * SEC_PER_BAR;

/** 見どころの点（止まる波の中心）: レールの s と、レールの中心からの高さ */
const FOCUS_S_AHEAD = 7.4;
const FOCUS_RISE = 0.35;
/** 隠れた小さな泡: 中庭の手前の柱の間、左の高い所（前を見ていると気づかない） */
const HIDDEN = { s: 262, u: -2.0, y: 3.45, r: 0.075 };

/** 雨の昼の灰青の空気（HSL: 色相 180〜250、彩度 0.4 未満、明るさ 0.2〜0.6） */
const ATMOSPHERE: Atmosphere = {
  background: 0x5d6b78,
  fog: { color: 0x47515c, near: 12, far: 90 },
  exposure: 1.0,
};
/** ガラスの擬似反射の照明: 曇り空の柔らかい光、下は濡れた石と灯りの琥珀 */
const GLASS_LIGHTING = {
  sky: 0x93a6ba,
  ground: 0x3d342b,
  keyDir: { x: 0.25, y: 1, z: 0.35 },
  keyColor: 0xe2e9f1,
  keyIntensity: 0.45,
  envReflection: 0.4,
};

const FALL: FallSpec = { speed: 4.6, floorY: 0, topY: 13, ease: 0.35 };
const WALL_GLASS: GlassParams = { color: 0xc6d6e6, opacity: 0.05, rim: 0.55, iridescence: 0.06, roughness: 0.05 };
const ROOF_GLASS: GlassParams = { color: 0xd0dde9, opacity: 0.07, rim: 0.5, iridescence: 0.05, roughness: 0.08 };
const COLUMN_GLASS: GlassParams = { color: 0xd6e8f4, opacity: 0.12, rim: 0.95, iridescence: 0.18, roughness: 0.03 };
const BEAD_GLASS: GlassParams = { color: 0xe4f1ff, opacity: 0.3, rim: 0.85, iridescence: 0.25, roughness: 0.02 };
const DOOR_COLOR: Record<DoorChoice, number> = { amber: 0xffa23c, lapis: 0x3d6bff };
const DOOR_LIGHT: Record<DoorChoice, number> = { amber: 0xffb066, lapis: 0x6f9cff };
const MEMBRANE_TINT = new THREE.Color(0xeef4ff);
/** 弾けた雨粒の虹色の輪が残る秒 */
const RING_SEC = 1.8;

interface TouchDrop {
  readonly mesh: THREE.Mesh;
  readonly glass: GlassHandle;
  readonly tf: number;
  readonly r: number;
  touchAt: number;
  popAt: number;
  touchable: Touchable;
}

interface Ring {
  readonly mesh: THREE.Mesh;
  readonly fade: FloatUniform;
  start: number;
}

interface Door {
  readonly id: DoorChoice;
  readonly root: THREE.Group;
  readonly center: THREE.Group;
  readonly leaves: { readonly obj: THREE.Object3D; readonly base: THREE.Quaternion; readonly sign: number }[];
  readonly glass: GlassHandle;
  readonly glow: FloatUniform;
  readonly pool: FloatUniform;
  touchAt: number;
  touchable: Touchable;
}

export function createRainRoom(): RoomModule {
  const root = new THREE.Group();
  root.name = 'room:rain';
  const touchables: Touchable[] = [];
  const handles: GlassHandle[] = [];
  const owned: { dispose(): void }[] = [];
  const clock = createRainClock();
  const uLamp = floatUniform(3.0);
  const uLampHalo = floatUniform(0.5);
  const drops: TouchDrop[] = [];
  const rings: Ring[] = [];
  const doorList: Door[] = [];
  let doors: DoorChoices | null = null;
  let ctxRef: RoomContext | null = null;
  let membrane: GlassHandle | null = null;
  let hidden: { mesh: THREE.Mesh; glass: GlassHandle; base: THREE.Vector3; foundAt: number; touchAt: number } | null = null;
  let focus: Vec3Tuple | null = null;
  let portal: Vec3Tuple | null = null;
  let lastT = -Infinity;
  let lightingApplied = false;
  const doorPools = new Map<DoorChoice, THREE.Mesh>();
  const tmpQ = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const doorColorTmp = new THREE.Color();

  function spawnRing(at: THREE.Vector3, t: number, camera: THREE.Camera | null) {
    let ring = rings[0];
    for (const r of rings) if (r.start < ring.start) ring = r;
    ring.start = t;
    ring.mesh.position.copy(at);
    if (camera) camera.getWorldQuaternion(ring.mesh.quaternion);
  }
  let lastCamera: THREE.Camera | null = null;

  async function load(ctx: RoomContext) {
    ctxRef = ctx;
    const br = await loadBlenderRoom(ctx, 'rain', 1.0);
    for (const b of br.baked) owned.push(b.material);
    owned.push(...br.lightmaps);
    const env = await ctx.assets.texture('rooms/rain.env.png');
    env.colorSpace = THREE.SRGBColorSpace;
    env.flipY = false;
    env.wrapS = THREE.RepeatWrapping;
    env.needsUpdate = true;
    owned.push(env);
    const scene = br.scene;
    root.add(scene);

    // 焼き込んだ床: 濡れた石の目地と映り込み
    for (const b of br.baked) {
      if (b.mesh.userData.name === 'rain.floor') decorateWetFloor(b.material, env, { tile: 0.62, wet: 0.9 });
    }

    // ガラスと、ガラスを伝う水の膜（足し算の筋を同じ形に重ねる）
    const wallGlass = sharedGlass('clear', WALL_GLASS);
    const roofGlass = sharedGlass('clear', ROOF_GLASS);
    handles.push(wallGlass, roofGlass);
    const wallFilm = waterFilmMaterial(clock, 'wall', 0.42);
    const roofFilm = waterFilmMaterial(clock, 'roof', 0.7);
    owned.push(wallFilm, roofFilm);
    for (const o of findAll(scene, (ud) => ud.look === 'wallglass' || ud.look === 'roofglass')) {
      const mesh = o as THREE.Mesh;
      const wall = o.userData.look === 'wallglass';
      mesh.material = (wall ? wallGlass : roofGlass).material;
      const film = new THREE.Mesh(mesh.geometry, wall ? wallFilm : roofFilm);
      film.name = `${mesh.name}-film`;
      film.renderOrder = 2;
      film.userData = { role: 'film' };
      mesh.add(film);
    }

    // 柱（3種）・金具・灯りはインスタンス描画にまとめる
    const columnGlass = sharedGlass('clear', COLUMN_GLASS);
    handles.push(columnGlass);
    const brass = createBrass();
    decorateMetal(brass, env, { strength: 1.25 });
    owned.push(brass);
    const lampMat = glowMaterial(0xffa04c, uLamp);
    owned.push(lampMat);
    const columns: { x: number; z: number }[] = [];
    for (const key of ['column_a', 'column_b', 'column_c']) {
      const im = instancesFrom(scene, key, columnGlass.material);
      if (!im) continue;
      im.renderOrder = 1;
      scene.add(im);
      const m = new THREE.Matrix4();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        columns.push({ x: m.elements[12], z: m.elements[14] });
      }
    }
    const fits = instancesFrom(scene, 'column_fit', brass);
    if (fits) scene.add(fits);
    const lamps = instancesFrom(scene, 'lamp', lampMat);
    if (lamps) {
      scene.add(lamps);
      // 灯りのにじみ（雨の空気で灯りがにじむ）
      const centers = new Float32Array(lamps.count * 3);
      const m = new THREE.Matrix4();
      for (let i = 0; i < lamps.count; i++) {
        lamps.getMatrixAt(i, m);
        centers.set([m.elements[12], m.elements[13], m.elements[14]], i * 3);
      }
      const haloMat = haloMaterial(new THREE.InstancedBufferAttribute(centers, 3), 0.85, 0xffa452, uLampHalo);
      owned.push(haloMat);
      const halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), haloMat, lamps.count);
      for (let i = 0; i < lamps.count; i++) {
        lamps.getMatrixAt(i, m);
        halos.setMatrixAt(i, m.makeTranslation(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]).scale(new THREE.Vector3(0.01, 0.01, 0.01)));
      }
      halos.frustumCulled = false;
      halos.renderOrder = 8;
      halos.name = 'rain.lamp-halos';
      halos.userData = { clearanceExempt: true, role: 'light' };
      root.add(halos);
    }
    for (const o of findAll(scene, (ud) => ud.look === 'brass')) (o as THREE.Mesh).material = brass;

    // 遠景の街と灯り、水面
    const cityMat = cityMaterial();
    const cityLights = cityLightsMaterial(1.5);
    const channelMat = waterMaterial(env, clock, 'channel');
    const poolMat = waterMaterial(env, clock, 'pool');
    owned.push(cityMat, cityLights, channelMat, poolMat);
    for (const o of findAll(scene, (ud) => typeof ud.look === 'string')) {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) continue;
      switch (o.userData.look) {
        case 'city':
          mesh.material = cityMat;
          break;
        case 'citylight':
          mesh.material = cityLights;
          mesh.renderOrder = 3;
          break;
        case 'water':
          mesh.material = channelMat;
          break;
        case 'pool':
          mesh.material = poolMat;
          break;
        default:
          break;
      }
    }

    // 膜（萬華鏡へ）。選んだ扉の色をかすかに帯びる
    const mem = findAll(scene, (ud) => ud.role === 'membrane')[0] as THREE.Mesh | undefined;
    if (mem) {
      membrane = createGlass('iridescent', { color: MEMBRANE_TINT, opacity: 0.035, iridescence: 1, face: 0.12, rim: 0.7, doubleSided: true });
      handles.push(membrane);
      mem.material = membrane.material;
      mem.renderOrder = 4;
    }

    // 区間の点
    const span = ctx.ride.sectionSpan('rain');
    const fp = ctx.ride.pointAt(focusS(ctx));
    focus = [fp.x, fp.y + FOCUS_RISE, fp.z];
    const pe = ctx.ride.pointAt(span.s1);
    portal = [pe.x, pe.y, pe.z];

    // 雨（中庭と外）。止まる位置と時刻は種を固定して決める
    const poolObj = findAll(scene, (ud) => Array.isArray(ud.court))[0];
    const court = courtFromExtras(poolObj?.userData.court) ?? { cx: fp.x, cz: fp.z, fx: 1, fz: 0, a: 10, b: 6 };
    const vaultIn = Number(poolObj?.userData.vault_in ?? span.s0 + 92);
    const vaultOut = Number(poolObj?.userData.vault_out ?? span.s0 + 115);
    const plan = planRain(ctx.ride, {
      court,
      s0: span.s0,
      s1: span.s1,
      vaultIn,
      vaultOut,
      columns,
      freezeT: FREEZE_T,
      focus: { x: focus[0], y: focus[1], z: focus[2] },
      scale: ctx.quality.particleScale,
      seed: 0x5a1e,
    });
    const total = plan.count + plan.touch.length;
    const rest = new Float32Array(total * 4);
    const freeze = new Float32Array(total);
    const floorY = new Float32Array(total);
    rest.set(plan.rest);
    freeze.set(plan.freeze);
    floorY.set(plan.floor);
    plan.touch.forEach((d, i) => {
      rest.set([d.x, d.y, d.z, (i * 0.618) % 1], (plan.count + i) * 4);
      freeze[plan.count + i] = d.tf;
    });
    const attr: RainAttributes = {
      drop: new THREE.InstancedBufferAttribute(rest, 4),
      freeze: new THREE.InstancedBufferAttribute(freeze, 1),
      floor: new THREE.InstancedBufferAttribute(floorY, 1),
    };
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const one = new THREE.Quaternion();
    const scl = new THREE.Vector3();

    const streakGeo = new THREE.PlaneGeometry(1, 1);
    const streakMat = rainStreakMaterial(attr, clock, FALL, 0.42, 0.011);
    owned.push(streakMat);
    const streaks = new THREE.InstancedMesh(streakGeo, streakMat, total);
    for (let i = 0; i < total; i++) {
      pos.set(rest[i * 4], rest[i * 4 + 1], rest[i * 4 + 2]);
      streaks.setMatrixAt(i, m4.compose(pos, one, scl.set(0.02, 0.4, 0.02)));
    }
    streaks.frustumCulled = false;
    streaks.name = 'rain.streaks';
    streaks.renderOrder = 5;
    root.add(streaks);

    const beadGlass = createGlass('clear', BEAD_GLASS);
    handles.push(beadGlass);
    decorateDropGlass(beadGlass.material, env, { attr, clock, strength: 1.35 });
    // 雨粒は数千あるので、低い品質では面を減らす（2〜3cm の玉なので見た目はほぼ変わらない）
    const beadGeo = new THREE.IcosahedronGeometry(1, ctx.quality.tier === 'low' ? 0 : 1);
    const beads = new THREE.InstancedMesh(beadGeo, beadGlass.material, Math.max(1, plan.count));
    beads.count = plan.count;
    for (let i = 0; i < plan.count; i++) {
      pos.set(rest[i * 4], rest[i * 4 + 1], rest[i * 4 + 2]);
      const r = plan.radius[i];
      beads.setMatrixAt(i, m4.compose(pos, one, scl.set(r, r, r)));
    }
    beads.frustumCulled = false;
    beads.name = 'rain.beads';
    beads.renderOrder = 6;
    root.add(beads);

    // 触れられる雨粒（個別。近づくと縁が光り、触れると澄んだ音で弾けて虹色の輪を残す）
    const dropGeo = new THREE.IcosahedronGeometry(1, 2);
    plan.touch.forEach((d, i) => {
      const glass = createGlass('clear', BEAD_GLASS);
      decorateDropGlass(glass.material, env, { strength: 1.35 });
      handles.push(glass);
      const mesh = new THREE.Mesh(dropGeo, glass.material);
      mesh.name = `rain.drop-${i}`;
      mesh.position.set(d.x, d.y, d.z);
      mesh.scale.setScalar(0.0001);
      mesh.visible = false;
      mesh.renderOrder = 6;
      root.add(mesh);
      const drop: TouchDrop = {
        mesh,
        glass,
        tf: d.tf,
        r: d.r,
        touchAt: Infinity,
        popAt: Infinity,
        touchable: null as unknown as Touchable,
      };
      drop.touchable = {
        id: `rain/drop-${i}`,
        kind: 'raindrop',
        section: 'rain',
        object: mesh,
        radius: Math.max(0.06, d.r * 1.4),
        enabled: false,
        idleChime: false,
        setHighlight: (v) => glass.setHighlight(v),
        onTouch: (e) => {
          // 0.1 秒以内に光と動き: 波紋を出し、ひと回りふくらんでから弾ける
          glass.pulse(e.t, new THREE.Vector3(...e.point));
          if (drop.popAt !== Infinity) return;
          drop.touchAt = e.t;
          drop.popAt = e.t + 0.14;
          mesh.scale.setScalar(d.r * 1.3);
          spawnRing(mesh.position, drop.popAt, lastCamera);
        },
      };
      drops.push(drop);
      touchables.push(drop.touchable);
    });

    // 虹色の輪（弾けた雨粒が残す光。物ではないので距離の検査から外す）
    const ringGeo = new THREE.TorusGeometry(1, 0.05, 8, 72);
    for (let i = 0; i < 6; i++) {
      const fade = floatUniform(0);
      const mat = rainbowRingMaterial(fade);
      owned.push(mat);
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.name = `rain.ring-${i}`;
      mesh.visible = false;
      mesh.renderOrder = 7;
      mesh.userData = { clearanceExempt: true, role: 'light' };
      root.add(mesh);
      rings.push({ mesh, fade, start: -Infinity });
    }

    // 扉（琥珀・瑠璃）
    doors = new DoorChoices(DOORS_T, DECIDE_T, DEFAULT_DOOR, ctx.suggestedDoor);
    scene.updateMatrixWorld(true);
    for (const id of ['amber', 'lapis'] as const) {
      const leaves = findAll(scene, (ud) => ud.role === 'door' && ud.door === id);
      if (leaves.length === 0) continue;
      const c = new THREE.Vector3();
      for (const l of leaves) c.add(l.getWorldPosition(pos));
      c.divideScalar(leaves.length);
      const doorRoot = new THREE.Group();
      doorRoot.name = `rain.door-${id}`;
      doorRoot.position.set(c.x, 0, c.z);
      const center = new THREE.Group();
      center.name = `rain.door-${id}-center`;
      center.position.set(0, 1.6, 0);
      doorRoot.add(center);
      root.add(doorRoot);
      root.updateMatrixWorld(true);
      const glass = createGlass('tinted', { color: DOOR_COLOR[id], opacity: 0.5, rim: 0.85, iridescence: 0.1, emissive: DOOR_COLOR[id], emissiveIntensity: 0.2 });
      handles.push(glass);
      const list: Door['leaves'][number][] = [];
      for (const l of leaves) {
        center.attach(l);
        (l as THREE.Mesh).material = glass.material;
        (l as THREE.Mesh).renderOrder = 3;
        list.push({ obj: l, base: l.quaternion.clone(), sign: Number(l.userData.leaf) === 0 ? 1 : -1 });
      }
      const glow = floatUniform(0);
      const poolU = floatUniform(0);
      const lightPanel = findAll(scene, (ud) => ud.look === 'doorlight' && ud.door === id)[0] as THREE.Mesh | undefined;
      if (lightPanel) {
        const m = glowMaterial(DOOR_LIGHT[id], glow);
        owned.push(m);
        lightPanel.material = m;
      }
      // 床に落ちる光（扉の前、レールの側へ）
      const fwd = new THREE.Vector3(pe.x - c.x, 0, pe.z - c.z);
      const poolMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lightPoolMaterial(DOOR_LIGHT[id], poolU));
      poolMesh.scale.set(1.9, 2.6, 1);
      owned.push(poolMesh.material as THREE.Material);
      const back = new THREE.Vector3(-Math.sin(pe.yaw), 0, -Math.cos(pe.yaw)).multiplyScalar(-1.25);
      poolMesh.position.set(c.x + back.x + fwd.x * 0.1, 0.012, c.z + back.z + fwd.z * 0.1);
      poolMesh.rotation.set(-Math.PI / 2, pe.yaw, 0, 'YXZ');
      poolMesh.name = `rain.door-${id}-pool`;
      poolMesh.renderOrder = 2;
      poolMesh.visible = false;
      root.add(poolMesh);
      const door: Door = { id, root: doorRoot, center, leaves: list, glass, glow, pool: poolU, touchAt: -Infinity, touchable: null as unknown as Touchable };
      door.touchable = {
        id: `rain/door-${id}`,
        kind: 'door',
        section: 'rain',
        object: center,
        radius: 0.95,
        enabled: false,
        idleChime: true,
        setHighlight: (v) => glass.setHighlight(v),
        onTouch: (e) => {
          glass.pulse(e.t, new THREE.Vector3(...e.point));
          door.touchAt = e.t;
          if (doors?.pick(id, e.t)) ctx.events.emit('doorChosen', { door: id, by: e.source === 'gaze' ? 'gaze' : 'touch' });
        },
      };
      doorList.push(door);
      touchables.push(door.touchable);
      (poolMesh as THREE.Object3D).userData.door = id;
      doorPools.set(id, poolMesh);
    }

    // 隠れた小さな泡
    const hp = ctx.ride.pointAt(HIDDEN.s);
    const hpos = new THREE.Vector3(hp.x + Math.cos(hp.yaw) * HIDDEN.u, HIDDEN.y, hp.z - Math.sin(hp.yaw) * HIDDEN.u);
    const hglass = createGlass('iridescent', { color: 0xf4f8ff, opacity: 0.06, iridescence: 1, face: 0.12, rim: 0.9, emissive: 0xbfd8ff, emissiveIntensity: 0.06 });
    handles.push(hglass);
    const hmesh = new THREE.Mesh(new THREE.IcosahedronGeometry(HIDDEN.r, 3), hglass.material);
    hmesh.name = 'rain.hidden-bubble';
    hmesh.position.copy(hpos);
    hmesh.renderOrder = 6;
    root.add(hmesh);
    hidden = { mesh: hmesh, glass: hglass, base: hpos.clone(), foundAt: Infinity, touchAt: -Infinity };
    const hb = hidden;
    touchables.push({
      id: 'rain/hidden-bubble',
      kind: 'hidden-bubble',
      section: 'rain',
      object: hmesh,
      radius: HIDDEN.r,
      enabled: true,
      setHighlight: (v) => hglass.setHighlight(v * 0.6),
      onTouch: (e) => {
        hglass.pulse(e.t, new THREE.Vector3(...e.point));
        hb.touchAt = e.t;
        if (hb.foundAt === Infinity) {
          hb.foundAt = e.t;
          ctx.events.emit('hiddenFound', { section: 'rain' });
        }
      },
    });
  }

  function rewind(t: number) {
    for (const d of drops) {
      if (t < d.touchAt - 0.25) {
        d.touchAt = Infinity;
        d.popAt = Infinity;
      }
    }
    for (const r of rings) if (t < r.start) r.start = -Infinity;
    doors?.rewind(t);
    if (hidden && t < hidden.foundAt - 0.25) hidden.foundAt = Infinity;
  }

  function update(frame: RoomFrame) {
    const t = frame.t;
    lastCamera = frame.camera;
    if (t < lastT - 0.5) rewind(t);
    lastT = t;
    if (frame.pose.section === 'rain') {
      if (!lightingApplied) {
        setGlassLighting(GLASS_LIGHTING);
        lightingApplied = true;
      }
    } else lightingApplied = false;

    clock.uTime.value = t;
    clock.uFlow.value = flowTime(t, FREEZE_T);
    for (const h of handles) h.setTime(t);
    // 灯りはごくゆっくり息をする（明滅ではない。1 秒に 0.1 回）
    uLamp.value = 3.0 * (1 + 0.035 * Math.sin(t * 0.65));
    uLampHalo.value = 0.5 * (1 + 0.035 * Math.sin(t * 0.65));

    // 触れられる雨粒
    for (const d of drops) {
      const grown = smooth(d.tf - 0.06, d.tf + 0.28, t);
      let s = grown;
      let visible = grown > 0.002;
      if (t >= d.touchAt && t < d.popAt) s = 1.3;
      else if (t >= d.popAt) {
        const k = (t - d.popAt) / 0.16;
        s = k < 1 ? 1.3 + 0.7 * k : 0;
        visible = k < 1;
      }
      d.mesh.visible = visible;
      d.mesh.scale.setScalar(Math.max(0.0001, d.r * s));
      d.touchable.enabled = grown > 0.9 && t < d.popAt;
    }
    // 虹色の輪
    const flash = frame.reducedFlash ? 0.45 : 1;
    for (const r of rings) {
      // 弾けた所から広がって、ゆっくり薄れる（約 1.8 秒）
      const k = (t - r.start) / RING_SEC;
      const on = k >= 0 && k < 1;
      r.mesh.visible = on;
      if (!on) continue;
      const e = 1 - (1 - k) ** 3;
      r.mesh.scale.setScalar(0.06 + 0.36 * e);
      r.fade.value = (1 - k) ** 1.3 * flash;
    }

    // 扉
    if (doors) {
      const look = doors.look(t);
      for (const d of doorList) {
        const rise = look.rise;
        d.root.visible = rise > 0.002;
        d.root.scale.set(1, Math.max(0.002, rise), 1);
        const wob = t >= d.touchAt && t < d.touchAt + 0.6 ? Math.sin((t - d.touchAt) * 30) * 0.05 * (1 - (t - d.touchAt) / 0.6) : 0;
        // 開く角度は 62°（葉の先が壁の口の奥の光の板に届かない）
        const ang = look.open[d.id] * THREE.MathUtils.degToRad(62) + wob;
        for (const l of d.leaves) l.obj.quaternion.copy(l.base).multiply(tmpQ.setFromAxisAngle(yAxis, ang * l.sign));
        d.glow.value = 0.25 + look.glow[d.id] * 3.2;
        d.pool.value = look.glow[d.id] * 0.55 * flash;
        const pool = doorPools.get(d.id);
        if (pool) pool.visible = look.glow[d.id] > 0.01;
        (d.glass.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.12 + look.glow[d.id] * 0.9;
        d.touchable.enabled = doors.enabledAt(t);
      }
      if (membrane) {
        const sel = doors.selectedAt(t);
        const m = membrane.material as THREE.MeshStandardMaterial;
        if (sel) m.color.copy(MEMBRANE_TINT).lerp(doorColorTmp.set(DOOR_COLOR[sel.door]), look.open[sel.door] * 0.55);
        else m.color.copy(MEMBRANE_TINT);
      }
    }

    // 隠れた泡: ゆっくり上下に漂う。触れるとふるえる
    if (hidden) {
      const b = hidden.base;
      hidden.mesh.position.set(b.x, b.y + Math.sin(t * 0.9) * 0.03, b.z);
      const k = t - hidden.touchAt;
      hidden.mesh.scale.setScalar(k >= 0 && k < 0.5 ? 1 + 0.35 * Math.sin(k * 25) * (1 - k / 0.5) : 1);
    }
  }

  /** 見どころの点の s: 見どころの時刻のゴンドラの位置の少し先（止まった雨粒の群れ） */
  function focusS(ctx: RoomContext): number {
    const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'rain', sectionProgress: 0 };
    ctx.ride.poseAt(FREEZE_T, 'standard', pose);
    return pose.s + FOCUS_S_AHEAD;
  }

  return {
    id: 'rain',
    root,
    touchables,
    get atmosphere() {
      return ATMOSPHERE;
    },
    load,
    update,
    onCue(_cue: Cue) {
      // 雨が止まる・扉が現れる・扉が決まるは、すべて時刻から決める（?t= で途中から始めても同じ絵になる）
    },
    focusPoint(name) {
      if (!ctxRef) return null;
      if (name === 'rain.freeze') return focus;
      if (name === 'rain.doors' || name === 'branch.decide') return portal;
      return null;
    },
    setDoor(door) {
      doors?.setAppDoor(door);
    },
    dispose() {
      for (const h of handles) h.dispose();
      handles.length = 0;
      disposeTree(root, owned);
      owned.length = 0;
      touchables.length = 0;
      drops.length = 0;
      rings.length = 0;
      doorList.length = 0;
    },
  };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
