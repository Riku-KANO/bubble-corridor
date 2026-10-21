// 第2室「雨の回廊」（3:30〜6:00）と、琥珀と瑠璃の扉の分岐。
// 形と光は Blender（blender/scripts/rooms/rain.py）で造形して焼いた glb とライトマップ。ここでは、
// ガラスの材質（core）・水と雨・触れられる物（止まった雨粒、扉、隠れた泡）・見どころの動きを重ねる。
//
// 構図（入口の一枚絵）: 低いガラスの穹窿の回廊がゆるく右へ曲がって霧の奥へ続く。左右に雫形の曇りガラスの柱、
// 雫の中に琥珀の灯り。濡れた石の床と中央の水路に灯りが映り、左の水の膜の壁の向こうに雨に霞む街の灯りがにじむ。
// 見どころ（5:10）: 屋根のない楕円の中庭で、降る雨が見どころの点から波のように一粒ずつガラス玉に変わって止まる。
// 止まった雨粒の中には、まわりの景色が逆さに映る（環境画像を球のレンズのように歪めて読む）。
// 分岐（5:50）: 突き当たりの円い膜の左右に、琥珀（左）と瑠璃（右）の扉が床から立ち上がる。選んだ扉が開き、その光と色で
// 膜が満たされ、その中を進む。選ばなかった扉は閉じて暗くなる（ADR-0013。レールは 1 本）。
//
// すべて時刻から決める（雨の位置、止まる時刻、扉の開き具合）。触れた記録（弾けた雨粒、選んだ扉）だけは出来事の時刻で持ち、
// 時刻が戻ったら捨てる。読み込み時に隠す物は作らない（最初に見えたフレームでシェーダを組んで止まらないよう、
// 触れられる雨粒・虹色の輪・扉・床の光は、読み込みの時から描く物として置き、大きさや光の強さを 0 にしておく）。
import * as THREE from 'three/webgpu';
import { BRANCH_DECIDE_AFTER_DOORS_BARS, MOMENT_BARS, SEC_PER_BAR } from '../../config';
import type { Cue, Vec3Tuple } from '../../contracts/events';
import { DEFAULT_DOOR, type DoorChoice } from '../../contracts/ids';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../../contracts/room';
import type { RidePose } from '../../contracts/ride';
import { createBrass, createGlass, sharedGlass, type GlassHandle, type GlassParams } from '../../core/materials/glass';
import { disposeTree, findAll, instancesFrom, loadBlenderRoom } from './blender-room';
import { createDoorLook, DoorChoices, type DoorSelection } from './doors';
import {
  cityLightsMaterial,
  cityMaterial,
  createEnvBlend,
  createRainClock,
  decorateDropGlass,
  decorateMetal,
  decorateWetFloor,
  envPair,
  floatUniform,
  glowMaterial,
  haloMaterial,
  lightPoolMaterial,
  NOT_TOUCHED,
  rainbowRingMaterial,
  rainStreakMaterial,
  waterFilmMaterial,
  waterMaterial,
  type EnvBlend,
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

/**
 * 雨の昼の灰青の空気（HSL: 色相 180〜250、彩度 0.4 未満、明るさ 0.2〜0.6）。
 * ガラスの擬似照明は曇り空の柔らかい光（上）と、濡れた石に映る街灯りの琥珀（下）。アプリが空気の変わり目に当てる。
 */
const ATMOSPHERE: Atmosphere = {
  background: 0x5d6b78,
  fog: { color: 0x47515c, near: 12, far: 90 },
  exposure: 1.0,
  glassLighting: {
    sky: 0x93a6ba,
    ground: 0x4a3a2a,
    keyDir: { x: 0.25, y: 1, z: 0.35 },
    keyColor: 0xe2e9f1,
    keyIntensity: 0.45,
  },
};
/** 街を霞ませる色（雨の空気。背景に近い灰青） */
const CITY_HAZE = 0x55626e;

const FALL: FallSpec = { speed: 4.6, floorY: 0, topY: 13, ease: 0.35 };
// 壁と屋根のガラスは、式に埋め込まれる引数（縁・虹色・粗さ）をそろえて 1 つのシェーダにする（色と不透明度だけ違う）
const WALL_GLASS: GlassParams = { color: 0xc6d6e6, opacity: 0.05, rim: 0.55, iridescence: 0.06, roughness: 0.05 };
const ROOF_GLASS: GlassParams = { color: 0xd0dde9, opacity: 0.07, rim: 0.55, iridescence: 0.06, roughness: 0.05 };
/** 雫形の柱（Blender の extras の glass に合わせて曇りガラス。中の灯りがやわらかく透ける程度に薄く） */
const COLUMN_GLASS: GlassParams = { color: 0x9fb3c5, opacity: 0.06, rim: 0.8, iridescence: 0.12, roughness: 0.28 };
const BEAD_GLASS: GlassParams = { color: 0xe4f1ff, opacity: 0.3, rim: 0.85, iridescence: 0.25, roughness: 0.02 };
const DOOR_COLOR: Record<DoorChoice, number> = { amber: 0xffa23c, lapis: 0x3d6bff };
const DOOR_LIGHT: Record<DoorChoice, number> = { amber: 0xffb066, lapis: 0x6f9cff };
const MEMBRANE_TINT = new THREE.Color(0xeef4ff);
/** 選んだ扉の色で膜を満たす割合と、膜の光の強さ */
const MEMBRANE_FILL = 0.9;
const MEMBRANE_GLOW = 0.6;
/** 弾けた雨粒の虹色の輪が残る秒と、同時に出せる数 */
const RING_SEC = 1.8;
const RINGS = 6;
/** 触れられる雨粒の当たりの半径の倍率（小さな玉なので、見た目より少し大きく当てる） */
const DROP_HIT = 1.6;

interface TouchDrop {
  /** インスタンスの番号（雨粒の InstancedMesh の中） */
  readonly index: number;
  readonly proxy: THREE.Object3D;
  readonly tf: number;
  touchAt: number;
  popAt: number;
  touchable: Touchable;
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

/** 当たりの球だけを持つ物（触れられる雨粒の光線の判定。描く物ではないので描画の数に入らない） */
function hitSphere(center: THREE.Vector3, radius: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.position.copy(center);
  const sphere = new THREE.Sphere(new THREE.Vector3(), radius);
  const hit = new THREE.Vector3();
  o.raycast = (raycaster, intersects) => {
    o.getWorldPosition(sphere.center);
    if (raycaster.ray.intersectSphere(sphere, hit) === null) return;
    const distance = raycaster.ray.origin.distanceTo(hit);
    if (distance < raycaster.near || distance > raycaster.far) return;
    intersects.push({ distance, point: hit.clone(), object: o });
  };
  return o;
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
  const doorList: Door[] = [];
  let doors: DoorChoices | null = null;
  let ctxRef: RoomContext | null = null;
  let membrane: GlassHandle | null = null;
  let hidden: { mesh: THREE.Mesh; glass: GlassHandle; base: THREE.Vector3; foundAt: number; touchAt: number } | null = null;
  let focus: Vec3Tuple | null = null;
  let portal: Vec3Tuple | null = null;
  let lastT = -Infinity;
  let lastCamera: THREE.Camera | null = null;
  // 触れられる雨粒（雨粒の InstancedMesh の後ろの方）の記録と、虹色の輪
  let touchAttr: THREE.InstancedBufferAttribute | null = null;
  let touchStart = 0;
  let ringMesh: THREE.InstancedMesh | null = null;
  let ringFade: THREE.InstancedBufferAttribute | null = null;
  const ringStart: number[] = new Array<number>(RINGS).fill(-Infinity);
  const ringPos: THREE.Vector3[] = Array.from({ length: RINGS }, () => new THREE.Vector3());
  const ringQuat: THREE.Quaternion[] = Array.from({ length: RINGS }, () => new THREE.Quaternion());
  // 環境画像（回廊・中庭・突き当たりの 3 か所）。ゴンドラの位置の前後の 2 枚を混ぜる
  let envBlend: EnvBlend | null = null;
  let envTextures: THREE.Texture[] = [];
  let envStations: number[] = [];
  const pair = { i: 0, j: 0, w: 0 };
  // 毎フレームの作業用
  const doorLook = createDoorLook();
  const selection: DoorSelection = { door: null, since: 0 };
  const tmpQ = new THREE.Quaternion();
  const tmpM = new THREE.Matrix4();
  const tmpS = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const doorColorTmp = new THREE.Color();

  /** 触れた記録の属性は、触れられる雨粒の所（並びの後ろ）だけを送り直す（数千の雨粒の全体を毎回送らない） */
  function markTouchDirty() {
    if (!touchAttr) return;
    touchAttr.clearUpdateRanges();
    touchAttr.addUpdateRange(touchStart * 4, Math.max(1, drops.length) * 4);
    touchAttr.needsUpdate = true;
  }

  function writeTouch(d: TouchDrop) {
    if (!touchAttr) return;
    const a = touchAttr.array as Float32Array;
    const k = (touchStart + d.index) * 4;
    a[k] = d.touchAt;
    a[k + 1] = d.popAt;
    markTouchDirty();
  }

  function spawnRing(at: THREE.Vector3, t: number) {
    let best = 0;
    for (let i = 1; i < RINGS; i++) if (ringStart[i] < ringStart[best]) best = i;
    ringStart[best] = t;
    ringPos[best].copy(at);
    if (lastCamera) lastCamera.getWorldQuaternion(ringQuat[best]);
  }

  /** 環境画像を読む（extras の一覧。外のデータなので名前と数を確かめる）。なければ中庭の 1 枚 */
  async function loadEnv(ctx: RoomContext, ud: Record<string, unknown> | undefined): Promise<void> {
    const names = Array.isArray(ud?.env) ? (ud.env as unknown[]) : [];
    const stations = Array.isArray(ud?.env_s) ? (ud.env_s as unknown[]) : [];
    const ok =
      names.length > 0 &&
      names.length === stations.length &&
      names.every((n) => typeof n === 'string' && /^rain\.env[a-z0-9_]*\.png$/.test(n)) &&
      stations.every((s) => typeof s === 'number' && Number.isFinite(s));
    const list = ok ? (names as string[]) : ['rain.env.png'];
    envStations = ok ? (stations as number[]) : [0];
    envTextures = await Promise.all(
      list.map(async (n) => {
        const tex = await ctx.assets.texture(`rooms/${n}`);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        tex.wrapS = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        owned.push(tex);
        return tex;
      }),
    );
    envBlend = createEnvBlend(envTextures[0], envTextures[Math.min(1, envTextures.length - 1)]);
  }

  async function load(ctx: RoomContext) {
    ctxRef = ctx;
    const br = await loadBlenderRoom(ctx, 'rain', 1.0);
    for (const b of br.baked) owned.push(b.material);
    owned.push(...br.lightmaps);
    const scene = br.scene;
    root.add(scene);
    const poolObj = findAll(scene, (ud) => Array.isArray(ud.court))[0];
    await loadEnv(ctx, poolObj?.userData);
    const env = envBlend as EnvBlend;
    // 雨粒の屈折は中庭の 1 枚（雨粒はほとんど中庭にある）
    const courtEnv = envTextures[Math.max(0, envStations.length >= 3 ? 1 : 0)];

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
    const columnGlass = sharedGlass('frosted', COLUMN_GLASS);
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
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, tmpM);
        columns.push({ x: tmpM.elements[12], z: tmpM.elements[14] });
      }
    }
    const fits = instancesFrom(scene, 'column_fit', brass);
    if (fits) scene.add(fits);
    const lamps = instancesFrom(scene, 'lamp', lampMat);
    if (lamps) {
      scene.add(lamps);
      // 灯りのにじみ（雨の空気で灯りがにじむ）。光なので通り抜ける
      const centers = new Float32Array(lamps.count * 3);
      for (let i = 0; i < lamps.count; i++) {
        lamps.getMatrixAt(i, tmpM);
        centers.set([tmpM.elements[12], tmpM.elements[13], tmpM.elements[14]], i * 3);
      }
      const haloMat = haloMaterial(new THREE.InstancedBufferAttribute(centers, 3), 0.85, 0xffa452, uLampHalo);
      owned.push(haloMat);
      const halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), haloMat, lamps.count);
      for (let i = 0; i < lamps.count; i++) halos.setMatrixAt(i, tmpM.makeTranslation(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]).scale(tmpS.setScalar(0.01)));
      halos.frustumCulled = false;
      halos.renderOrder = 8;
      halos.name = 'rain.lamp-halos';
      halos.userData = { clearanceExempt: true, passThrough: true, role: 'light' };
      root.add(halos);
    }
    for (const o of findAll(scene, (ud) => ud.look === 'brass')) (o as THREE.Mesh).material = brass;

    // 遠景の街と灯り、水面
    const cityMat = cityMaterial(CITY_HAZE);
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

    // 膜（万華鏡へ）。選んだ扉の光と色で満たされる
    const mem = findAll(scene, (ud) => ud.role === 'membrane')[0] as THREE.Mesh | undefined;
    if (mem) {
      membrane = createGlass('iridescent', { color: MEMBRANE_TINT, opacity: 0.035, iridescence: 1, face: 0.12, rim: 0.7, doubleSided: true, emissive: 0xffffff, emissiveIntensity: 0 });
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

    // 雨（中庭と外）。止まる位置と時刻は種を固定して決める（extras は外のデータなので数を確かめる）
    const court = courtFromExtras(poolObj?.userData.court) ?? { cx: fp.x, cz: fp.z, fx: 1, fz: 0, a: 10, b: 6 };
    const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const vaultIn = finite(poolObj?.userData.vault_in, span.s0 + 92);
    const vaultOut = finite(poolObj?.userData.vault_out, span.s0 + 115);
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
    // 触れられる雨粒は、雨粒の並びの後ろに入れる（材質も描画も 1 つ。縁の光と弾ける動きはインスタンスの属性で）
    const total = plan.count + plan.touch.length;
    touchStart = plan.count;
    const rest = new Float32Array(total * 4);
    const freeze = new Float32Array(total);
    const floorY = new Float32Array(total);
    const radius = new Float32Array(total);
    rest.set(plan.rest);
    freeze.set(plan.freeze);
    floorY.set(plan.floor);
    radius.set(plan.radius);
    plan.touch.forEach((d, i) => {
      rest.set([d.x, d.y, d.z, (i * 0.618) % 1], (plan.count + i) * 4);
      freeze[plan.count + i] = d.tf;
      radius[plan.count + i] = d.r;
    });
    const attr: RainAttributes = {
      drop: new THREE.InstancedBufferAttribute(rest, 4),
      freeze: new THREE.InstancedBufferAttribute(freeze, 1),
      floor: new THREE.InstancedBufferAttribute(floorY, 1),
    };
    const touchArr = new Float32Array(total * 4);
    for (let i = 0; i < total; i++) touchArr.set([NOT_TOUCHED, NOT_TOUCHED, 0, 0], i * 4);
    touchAttr = new THREE.InstancedBufferAttribute(touchArr, 4);
    touchAttr.setUsage(THREE.DynamicDrawUsage);
    const pos = new THREE.Vector3();
    const one = new THREE.Quaternion();

    const streakMat = rainStreakMaterial(attr, clock, FALL, 0.42, 0.011);
    owned.push(streakMat);
    const streaks = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), streakMat, total);
    for (let i = 0; i < total; i++) {
      pos.set(rest[i * 4], rest[i * 4 + 1], rest[i * 4 + 2]);
      streaks.setMatrixAt(i, tmpM.compose(pos, one, tmpS.set(0.02, 0.4, 0.02)));
    }
    streaks.frustumCulled = false;
    streaks.name = 'rain.streaks';
    streaks.renderOrder = 5;
    root.add(streaks);

    const beadGlass = createGlass('clear', BEAD_GLASS);
    handles.push(beadGlass);
    decorateDropGlass(beadGlass.material, courtEnv, { attr, clock, touch: touchAttr, strength: 1.35 });
    // 雨粒は数千あるので、低い品質では面を減らす（2〜3cm の玉なので見た目はほぼ変わらない）
    const beadGeo = new THREE.IcosahedronGeometry(1, ctx.quality.tier === 'low' ? 0 : 1);
    const beads = new THREE.InstancedMesh(beadGeo, beadGlass.material, Math.max(1, total));
    beads.count = total;
    for (let i = 0; i < total; i++) {
      pos.set(rest[i * 4], rest[i * 4 + 1], rest[i * 4 + 2]);
      const r = radius[i];
      beads.setMatrixAt(i, tmpM.compose(pos, one, tmpS.set(r, r, r)));
    }
    beads.frustumCulled = false;
    beads.name = 'rain.beads';
    beads.renderOrder = 6;
    root.add(beads);

    // 触れられる雨粒（近づくと縁が光り、触れると澄んだ音で弾けて虹色の輪を残す）。当たりは球だけの物
    plan.touch.forEach((d, i) => {
      const proxy = hitSphere(new THREE.Vector3(d.x, d.y, d.z), Math.max(0.06, d.r * DROP_HIT));
      proxy.name = `rain.drop-${i}`;
      root.add(proxy);
      const drop: TouchDrop = { index: i, proxy, tf: d.tf, touchAt: NOT_TOUCHED, popAt: NOT_TOUCHED, touchable: null as unknown as Touchable };
      drop.touchable = {
        id: `rain/drop-${i}`,
        kind: 'raindrop',
        section: 'rain',
        object: proxy,
        radius: Math.max(0.06, d.r * DROP_HIT),
        enabled: false,
        idleChime: false,
        setHighlight: (v) => {
          if (!touchAttr) return;
          (touchAttr.array as Float32Array)[(touchStart + i) * 4 + 2] = Math.min(1, Math.max(0, v));
          markTouchDirty();
        },
        onTouch: (e) => {
          // 0.1 秒以内に光と動き: 次のフレームで光り、ひと回りふくらんでから弾ける
          if (drop.popAt !== NOT_TOUCHED) return;
          drop.touchAt = e.t;
          drop.popAt = e.t + 0.14;
          writeTouch(drop);
          spawnRing(proxy.position, drop.popAt);
        },
      };
      drops.push(drop);
      touchables.push(drop.touchable);
    });

    // 虹色の輪（弾けた雨粒が残す光。物ではないので通り抜ける）。1 つのインスタンス描画で、使わない輪は大きさ 0
    ringFade = new THREE.InstancedBufferAttribute(new Float32Array(RINGS), 1);
    ringFade.setUsage(THREE.DynamicDrawUsage);
    const ringMat = rainbowRingMaterial(ringFade);
    owned.push(ringMat);
    ringMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.05, 8, 72), ringMat, RINGS);
    for (let i = 0; i < RINGS; i++) ringMesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
    ringMesh.frustumCulled = false;
    ringMesh.name = 'rain.rings';
    ringMesh.renderOrder = 7;
    ringMesh.userData = { clearanceExempt: true, passThrough: true, role: 'light' };
    root.add(ringMesh);

    // 扉（琥珀・瑠璃）。読み込みの時から描く（立ち上がる前は高さ 0.2%）
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
      doorRoot.scale.set(1, 0.002, 1);
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
      // 床に落ちる光（扉の前、レールの側へ）。強さ 0 の間も描く（足し算なので見えない）
      const inward = new THREE.Vector3(pe.x - c.x, 0, pe.z - c.z);
      const poolMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lightPoolMaterial(DOOR_LIGHT[id], poolU));
      poolMesh.scale.set(1.9, 2.6, 1);
      owned.push(poolMesh.material as THREE.Material);
      const back = new THREE.Vector3(-Math.sin(pe.yaw), 0, -Math.cos(pe.yaw)).multiplyScalar(-1.25);
      poolMesh.position.set(c.x + back.x + inward.x * 0.1, 0.012, c.z + back.z + inward.z * 0.1);
      poolMesh.rotation.set(-Math.PI / 2, pe.yaw, 0, 'YXZ');
      poolMesh.name = `rain.door-${id}-pool`;
      poolMesh.renderOrder = 2;
      poolMesh.userData = { passThrough: true, role: 'light' };
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
      if (d.touchAt !== NOT_TOUCHED && t < d.touchAt - 0.25) {
        d.touchAt = NOT_TOUCHED;
        d.popAt = NOT_TOUCHED;
        writeTouch(d);
      }
    }
    for (let i = 0; i < RINGS; i++) if (t < ringStart[i]) ringStart[i] = -Infinity;
    doors?.rewind(t);
    if (hidden && t < hidden.foundAt - 0.25) hidden.foundAt = Infinity;
  }

  function update(frame: RoomFrame) {
    const t = frame.t;
    lastCamera = frame.camera;
    if (t < lastT - 0.5) rewind(t);
    lastT = t;

    clock.uTime.value = t;
    clock.uFlow.value = flowTime(t, FREEZE_T);
    const flash = frame.reducedFlash ? 0.4 : 1;
    clock.uFlash.value = flash;
    for (const h of handles) h.setTime(t);
    // 灯りはごくゆっくり息をする（明滅ではない。1 秒に 0.1 回）
    uLamp.value = 3.0 * (1 + 0.035 * Math.sin(t * 0.65));
    uLampHalo.value = 0.5 * (1 + 0.035 * Math.sin(t * 0.65));

    // 環境画像: ゴンドラの位置の前後の 2 枚を混ぜる
    if (envBlend && envTextures.length > 0) {
      envPair(envStations, frame.pose.s, pair);
      envBlend.a.value = envTextures[Math.min(pair.i, envTextures.length - 1)];
      envBlend.b.value = envTextures[Math.min(pair.j, envTextures.length - 1)];
      envBlend.mix.value = pair.w;
    }

    // 触れられる雨粒: 止まってから弾けるまで触れられる（大きさと光はシェーダが時刻と記録から作る）
    for (const d of drops) d.touchable.enabled = t >= d.tf + 0.22 && t < d.popAt;
    // 虹色の輪: 弾けた所から広がって、ゆっくり薄れる（約 1.8 秒）
    if (ringMesh && ringFade) {
      const fade = ringFade.array as Float32Array;
      for (let i = 0; i < RINGS; i++) {
        const k = (t - ringStart[i]) / RING_SEC;
        if (k >= 0 && k < 1) {
          const e = 1 - (1 - k) ** 3;
          ringMesh.setMatrixAt(i, tmpM.compose(ringPos[i], ringQuat[i], tmpS.setScalar(0.06 + 0.36 * e)));
          fade[i] = (1 - k) ** 1.3 * flash;
        } else {
          ringMesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
          fade[i] = 0;
        }
      }
      ringMesh.instanceMatrix.needsUpdate = true;
      ringFade.needsUpdate = true;
    }

    // 扉
    if (doors) {
      const look = doors.look(t, doorLook);
      for (const d of doorList) {
        d.root.scale.set(1, Math.max(0.002, look.rise), 1);
        const wob = t >= d.touchAt && t < d.touchAt + 0.6 ? Math.sin((t - d.touchAt) * 30) * 0.05 * (1 - (t - d.touchAt) / 0.6) : 0;
        // 開く角度は 62°（葉の先が壁の口の奥の光の板に届かない）
        const ang = look.open[d.id] * THREE.MathUtils.degToRad(62) + wob;
        for (const l of d.leaves) l.obj.quaternion.copy(l.base).multiply(tmpQ.setFromAxisAngle(yAxis, ang * l.sign));
        d.glow.value = 0.12 + look.glow[d.id] * 3.2;
        d.pool.value = look.glow[d.id] * 0.55 * flash;
        (d.glass.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.06 + look.glow[d.id] * 0.9;
        d.touchable.enabled = doors.enabledAt(t);
      }
      if (membrane) {
        // 選んだ扉の光と色で膜が満たされる（開くにつれて）
        const sel = doors.selectedAt(t, selection);
        const m = membrane.material as THREE.MeshStandardMaterial;
        if (sel.door) {
          const k = look.open[sel.door];
          doorColorTmp.set(DOOR_LIGHT[sel.door]);
          m.color.copy(MEMBRANE_TINT).lerp(doorColorTmp, k * MEMBRANE_FILL);
          m.emissive.copy(doorColorTmp);
          m.emissiveIntensity = k * MEMBRANE_GLOW;
        } else {
          m.color.copy(MEMBRANE_TINT);
          m.emissiveIntensity = 0;
        }
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
      doorList.length = 0;
      envTextures = [];
      ringMesh = null;
      ringFade = null;
      touchAttr = null;
    },
  };
}
