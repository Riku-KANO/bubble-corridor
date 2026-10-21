// 第3室「万華鏡の間」（6:00〜8:00）。金の万華鏡（琥珀と金）と青の万華鏡（瑠璃と水色）は形が共通で、
// setDoor で材質の色・光・部屋の空気を替える。形と光は Blender（blender/scripts/rooms/kaleidoscope.py）で造形して焼いた glb。
//
// 構図（入口の一枚絵）: 雨の回廊の円い膜を抜けると、六角の長い筒がまっすぐ奥の光の点へ伸びる。6つの角に内側から光る
// プリズムの棒が列をなし、鏡の板がその列を何重にも映す。軸のまわりに色ガラスのロゼットが浮かび、互い違いにゆっくり回る。
// 鏡の多重反射は画面効果の折り返し（src/fx）が受け持ち、部屋は折り返しの元になる色と光を作る。
// 見どころ（7:20）: 散らばったガラス片が次々に集まり、前方に巨大な花の模様を描く。ゴンドラは花の中心を抜ける。
// 触れると: 触れたガラス片の色が変わり、その色が拍に合わせてロゼットへ次々に広がって残る（自分が触れた跡が模様になる）。
// 穏やかモードでは模様の回転を止める（ロゼットと花）。
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { MOMENT_BARS, SEC_PER_BAR, SEC_PER_BEAT } from '../../config';
import type { Cue, Vec3Tuple } from '../../contracts/events';
import { DEFAULT_DOOR, type ComfortMode, type DoorChoice } from '../../contracts/ids';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../../contracts/room';
import type { RidePose } from '../../contracts/ride';
import { createBrass, createGlass, type GlassHandle } from '../../core/materials/glass';
import { disposeTree, findAll, instancesFrom, loadBlenderRoom } from '../rain/blender-room';
import { decorateMetal, decorateMirror, floatUniform, glowMaterial } from '../rain/look';
import { echoAt, echoFlash, echoGrid, type Echo, type EchoState } from './echo';
import { FLOWER_R0, flowerSlot, gatherAt, lerpCyl, type Cyl, type FlowerTiming } from './flower';

const FLOWER_T = MOMENT_BARS.kaleidoscopeFlower * SEC_PER_BAR;
/** 花の面は見どころの時刻のゴンドラの位置の少し先 */
const FLOWER_AHEAD = 11;
const TIMING: FlowerTiming = { flowerT: FLOWER_T, gatherSec: 8, releaseT: FLOWER_T + 21, releaseSec: 12 };
/** ロゼットの回る速さ（ラジアン/秒）。輪ごとに互い違い */
const ROSETTE_SPEED = [0.16, -0.12, 0.2, -0.15, 0.13, -0.18, 0.14];
/** 隠れた小さな泡: 筒の中ほどの左下の角の近く（前を見ていると気づかない） */
const HIDDEN = { ds: 52, angDeg: 214, rad: 3.6, r: 0.07 };
/**
 * 色ガラス（ロゼット・散らばるガラス片・触れられるガラス片・プリズム）の共通の引数。縁の強さ・虹色の強さ・粗さは
 * シェーダの式に埋め込まれるので、そろえると 1 つのシェーダで済む（初めて見えたときの組み立てが短い）。色・発光・不透明度は材質ごと
 */
const COLOR_GLASS = { rim: 0.85, iridescence: 0.3 } as const;
/**
 * 扉が変わったとき、金と青の色を混ぜて替える秒（膜の 15 秒前から見えているので、一瞬で入れ替えない）。
 * 混ぜは「扉が変わった時刻」からの時刻で決める（フレームの積み上げにしない）。部屋の空気は半ばで替える
 */
const DOOR_BLEND_SEC = 0.8;
/** 出口の膜の向こう（天球の暗がり）が暗い緑の円に見えないよう、膜をかすかに部屋の光の色で光らせる強さ */
const EXIT_GLOW = 0.22;
/** 触れたガラス片がくるりと一回転する秒 */
const SPIN_SEC = 0.8;

interface Palette {
  /** 部屋の空気。ガラスの擬似照明（glassLighting）もここに書く（アプリが空気の変わり目に当てる。部屋は共有の値に触れない） */
  readonly atmosphere: Atmosphere;
  /** プリズムの光の色 */
  readonly light: number;
  /** 鏡の板の拡散の色（焼いた光に掛ける）と、映り込みの色 */
  readonly panel: number;
  readonly tint: THREE.Color;
  /** ロゼットとガラス片の色ガラス */
  readonly glass: readonly number[];
}

/** 金の万華鏡（琥珀と金の暖かい光）と青の万華鏡（瑠璃と水色の冷たい光）。空気の色相: 金 20〜60°、青 190〜250° */
const PALETTES: Record<DoorChoice, Palette> = {
  amber: {
    atmosphere: {
      background: 0x2c1c0d,
      fog: { color: 0x2c1c0d, near: 14, far: 90 },
      exposure: 1.05,
      glassLighting: { sky: 0xffd9a0, ground: 0x5a3415, keyColor: 0xfff0d0, keyIntensity: 0.7, keyDir: { x: 0.3, y: 1, z: 0.2 } },
    },
    light: 0xffb43c,
    // 金の鏡: 映り込みを明るい金に寄せる（暗い茶に沈ませない）
    panel: 0x9a6a1c,
    tint: new THREE.Color(1.45, 1.02, 0.42),
    glass: [0xff8c1a, 0xffc12e, 0xff5a1a, 0xe8952a, 0xd04a24, 0xffb020],
  },
  lapis: {
    atmosphere: {
      background: 0x0b1a36,
      fog: { color: 0x0b1a36, near: 14, far: 90 },
      exposure: 1.0,
      glassLighting: { sky: 0xa8d8ff, ground: 0x10204a, keyColor: 0xe0f4ff, keyIntensity: 0.7, keyDir: { x: 0.3, y: 1, z: 0.2 } },
    },
    light: 0x46c8ff,
    panel: 0x1a2f5e,
    tint: new THREE.Color(0.3, 0.58, 1.0),
    glass: [0x2f5bd8, 0x1fa2ff, 0x3fd6f0, 0x5a46d6, 0x18b0b8, 0x6f9cff],
  },
};

interface Rosette {
  readonly group: THREE.Group;
  readonly base: THREE.Quaternion;
  readonly speed: number;
  readonly s: number;
  readonly petals: GlassHandle;
  readonly jewels: GlassHandle;
  readonly index: number;
}

interface Shard {
  readonly mesh: THREE.InstancedMesh | THREE.Mesh;
  /** InstancedMesh のインスタンス番号（個別の物は -1） */
  readonly instance: number;
  readonly home: Cyl;
  readonly homeQ: THREE.Quaternion;
  readonly slot: { ang: number; rad: number; tilt: number };
  /** 花の面からの前後のずれ */
  readonly ds: number;
  readonly seed: number;
  /** 花の中の大きさの増し分（散らばるガラス片は花びらの面を埋めるよう大きく、触れられる物は控えめ） */
  readonly grow: number;
  /** 触れた時刻（くるりと回る。時刻から作り直す。触れていなければ -Infinity） */
  touchAt: number;
}

export function createKaleidoscopeRoom(): RoomModule {
  const root = new THREE.Group();
  root.name = 'room:kaleidoscope';
  const touchables: Touchable[] = [];
  const handles: GlassHandle[] = [];
  const owned: { dispose(): void }[] = [];
  const rosettes: Rosette[] = [];
  const shards: Shard[] = [];
  const touchShards: { shard: Shard; glass: GlassHandle; colorIdx: number; touchable: Touchable }[] = [];
  /** 位置を毎フレーム書く InstancedMesh（散らばるガラス片） */
  const shardMeshes: THREE.InstancedMesh[] = [];
  const echoState: EchoState = { arrival: -Infinity, color: -1 };
  const echoes: Echo[] = [];
  const uTint = uniform(new THREE.Color(PALETTES.lapis.tint));
  const uLight = uniform(new THREE.Color(PALETTES.lapis.light));
  const uGlow = floatUniform(2.2);
  let door: DoorChoice = DEFAULT_DOOR;
  /** 混ぜの元の扉と、扉が変わった時刻（混ぜ終わっていれば -Infinity）、最後に当てた混ぜ具合 */
  let fromDoor: DoorChoice = DEFAULT_DOOR;
  let doorAt = -Infinity;
  let appliedK = -1;
  let atmosphere: Atmosphere = PALETTES[door].atmosphere;
  let exitGlass: GlassHandle | null = null;
  const mixA = new THREE.Color();
  const mixB = new THREE.Color();
  let prismGlass: GlassHandle | null = null;
  let panelMats: THREE.MeshStandardNodeMaterial[] = [];
  let ctxRef: RoomContext | null = null;
  let flowerCenter: Vec3Tuple | null = null;
  let flowerS = 0;
  let sectionT0 = 0;
  let lastT = -Infinity;
  let hidden: { mesh: THREE.Mesh; glass: GlassHandle; base: THREE.Vector3; foundAt: number; touchAt: number } | null = null;
  // 軸の向き（筒はまっすぐ）
  const axisF = new THREE.Vector3();
  const axisR = new THREE.Vector3();
  const axisUp = new THREE.Vector3(0, 1, 0);
  const axisQ = new THREE.Quaternion();
  let axisS0 = 0;
  const axisC0 = new THREE.Vector3();
  // 作業用
  const tmpCyl: Cyl = { s: 0, ang: 0, rad: 0 };
  const homeCyl: Cyl = { s: 0, ang: 0, rad: 0 };
  const flowerCyl: Cyl = { s: 0, ang: 0, rad: 0 };
  const tmpP = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpQ2 = new THREE.Quaternion();
  const tmpM = new THREE.Matrix4();
  const tmpS = new THREE.Vector3(1, 1, 1);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const flowerQ = new THREE.Quaternion();
  /** 局所の y（ガラス片の厚み）を z（筒の軸）へ倒す */
  const LAY_FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const tmpColor = new THREE.Color();

  /** 円筒座標 → 世界の点 */
  function cylToWorld(c: Cyl, out: THREE.Vector3): THREE.Vector3 {
    const ca = Math.cos(c.ang);
    const sa = Math.sin(c.ang);
    return out
      .copy(axisC0)
      .addScaledVector(axisF, c.s - axisS0)
      .addScaledVector(axisR, ca * c.rad)
      .addScaledVector(axisUp, sa * c.rad);
  }

  /** 世界の点 → 円筒座標 */
  function worldToCyl(p: THREE.Vector3, out: Cyl): Cyl {
    tmpP.copy(p).sub(axisC0);
    const along = tmpP.dot(axisF);
    const x = tmpP.dot(axisR);
    const y = tmpP.dot(axisUp);
    out.s = axisS0 + along;
    out.ang = Math.atan2(y, x);
    out.rad = Math.hypot(x, y);
    return out;
  }

  /** 軸のまわりの角度 ang の向きの基底（局所 x = 放射、y = 接線、z = 後ろ）の回転 */
  function axisRotation(ang: number, out: THREE.Quaternion): THREE.Quaternion {
    return out.copy(axisQ).multiply(tmpQ2.setFromAxisAngle(zAxis, ang));
  }

  /** 元の扉の色 a と今の扉の色 b を k で混ぜた色（out に書く。線形で混ぜる） */
  function mixHex(a: number, b: number, k: number, out: THREE.Color): THREE.Color {
    return out.set(a).lerp(mixB.set(b), k);
  }

  /** 金と青の色を k（0: 元の扉、1: 今の扉）で混ぜて当てる。空気（背景・霧・ガラスの擬似照明）は半ばで替える */
  function applyPalette(k: number) {
    const a = PALETTES[fromDoor];
    const p = PALETTES[door];
    atmosphere = k < 0.5 ? a.atmosphere : p.atmosphere;
    (uTint.value as THREE.Color).copy(a.tint).lerp(p.tint, k);
    mixHex(a.light, p.light, k, uLight.value as THREE.Color);
    if (prismGlass) {
      const m = prismGlass.material as THREE.MeshStandardMaterial;
      mixHex(a.light, p.light, k, m.color);
      m.emissive.copy(m.color);
    }
    if (exitGlass) (exitGlass.material as THREE.MeshStandardMaterial).emissive.copy(uLight.value as THREE.Color);
    for (const m of panelMats) mixHex(a.panel, p.panel, k, m.color);
    for (const r of rosettes) {
      setShardColor(r.petals, mixHex(a.glass[r.index % a.glass.length], p.glass[r.index % p.glass.length], k, mixA));
      setShardColor(r.jewels, mixHex(a.glass[(r.index + 3) % a.glass.length], p.glass[(r.index + 3) % p.glass.length], k, mixA));
    }
    for (let j = 0; j < shardColorHandles.length; j++) setShardColor(shardColorHandles[j], mixHex(a.glass[(j * 2) % a.glass.length], p.glass[(j * 2) % p.glass.length], k, mixA));
    for (const ts of touchShards) setShardColor(ts.glass, mixHex(a.glass[ts.colorIdx % a.glass.length], p.glass[ts.colorIdx % p.glass.length], k, mixA));
    appliedK = k;
  }

  /** 時刻 t の混ぜ具合（扉が変わった時刻からの時刻だけで決まる） */
  function blendAt(t: number): number {
    return doorAt === -Infinity ? 1 : smooth(doorAt, doorAt + DOOR_BLEND_SEC, t);
  }

  function setShardColor(g: GlassHandle, color: THREE.Color) {
    const m = g.material as THREE.MeshStandardMaterial;
    m.color.copy(color);
    m.emissive.copy(color);
  }

  async function load(ctx: RoomContext) {
    ctxRef = ctx;
    door = DEFAULT_DOOR;
    const span = ctx.ride.sectionSpan('kaleidoscope');
    sectionT0 = ctx.ride.sectionTime('kaleidoscope').t0;
    const p0 = ctx.ride.pointAt(span.s0);
    axisS0 = span.s0;
    axisC0.set(p0.x, p0.y, p0.z);
    axisF.set(-Math.sin(p0.yaw), 0, -Math.cos(p0.yaw));
    axisR.set(Math.cos(p0.yaw), 0, -Math.sin(p0.yaw));
    tmpM.makeBasis(axisR, axisUp, axisF.clone().negate());
    axisQ.setFromRotationMatrix(tmpM);

    const br = await loadBlenderRoom(ctx, 'kaleidoscope', 1.0);
    for (const b of br.baked) owned.push(b.material);
    owned.push(...br.lightmaps);
    const env = await ctx.assets.texture('rooms/kaleidoscope.env.png');
    env.colorSpace = THREE.SRGBColorSpace;
    env.flipY = false;
    env.wrapS = THREE.RepeatWrapping;
    env.needsUpdate = true;
    owned.push(env);
    const scene = br.scene;
    root.add(scene);

    // 鏡の板と端の壁: 焼いた光（拡散）＋ 環境画像の映り込み（Blender で撮った多重の鏡）
    panelMats = br.baked.map((b) => b.material);
    for (const b of br.baked) {
      const mirror = b.mesh.userData.look === 'mirror';
      decorateMirror(b.material, env, { strength: mirror ? 0.75 : 0.3, f0: mirror ? 0.45 : 0.08, tint: uTint });
      b.material.roughness = mirror ? 0.12 : 0.35;
    }
    // 真鍮と光の輪
    const brass = createBrass();
    decorateMetal(brass, env, { strength: 1.1, tint: uTint });
    owned.push(brass);
    for (const o of findAll(scene, (ud) => ud.look === 'brass')) (o as THREE.Mesh).material = brass;
    for (const o of findAll(scene, (ud) => ud.look === 'glowring')) {
      const m = glowMaterial(0xffffff, 1);
      (m as THREE.MeshBasicNodeMaterial).colorNode = uLight.mul(uGlow);
      owned.push(m);
      (o as THREE.Mesh).material = m;
    }
    // 角のプリズムの棒（内側から光るガラス）
    prismGlass = createGlass('tinted', { ...COLOR_GLASS, color: PALETTES.lapis.light, opacity: 0.6, emissive: PALETTES.lapis.light, emissiveIntensity: 1.3 });
    handles.push(prismGlass);
    const prisms = instancesFrom(scene, 'prism', prismGlass.material);
    if (prisms) {
      prisms.renderOrder = 2;
      scene.add(prisms);
    }

    // ロゼット（回る模様）。輪ごとに軸の上の点を中心にした組にまとめ、軸のまわりに回す
    const rosetteIds = new Set<number>();
    for (const o of findAll(scene, (ud) => typeof ud.rosette === 'number')) rosetteIds.add(o.userData.rosette as number);
    for (const k of [...rosetteIds].sort((a, b) => a - b)) {
      const s = Number(findAll(scene, (ud) => ud.rosette === k)[0].userData.rosette_s);
      // glb の extras は外のデータ。数でなければその輪は作らない（インスタンスにまとめず、元の物のまま残る）
      if (!Number.isFinite(s)) continue;
      const group = new THREE.Group();
      group.name = `kaleidoscope.rosette-${k}`;
      cylToWorld({ s, ang: 0, rad: 0 }, group.position);
      group.quaternion.copy(axisQ);
      group.userData = { role: 'pattern', rosette: k };
      root.add(group);
      group.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
      const pal = PALETTES.lapis.glass;
      const petals = createGlass('tinted', { ...COLOR_GLASS, color: pal[k % pal.length], opacity: 0.55, emissive: pal[k % pal.length], emissiveIntensity: 0.55 });
      const jewels = createGlass('tinted', { ...COLOR_GLASS, color: pal[(k + 3) % pal.length], opacity: 0.6, emissive: pal[(k + 3) % pal.length], emissiveIntensity: 0.8 });
      handles.push(petals, jewels);
      for (const [key, h] of [
        [`rosette_${k}_petal`, petals],
        [`rosette_${k}_jewel`, jewels],
      ] as const) {
        const im = instancesFrom(scene, key, h.material);
        if (!im) continue;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, tmpM);
          tmpM.premultiply(inv);
          im.setMatrixAt(i, tmpM);
        }
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.renderOrder = 3;
        group.add(im);
      }
      rosettes.push({ group, base: group.quaternion.clone(), speed: ROSETTE_SPEED[k % ROSETTE_SPEED.length], s, petals, jewels, index: k });
    }

    // 花の面
    const pose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'kaleidoscope', sectionProgress: 0 };
    ctx.ride.poseAt(FLOWER_T, 'standard', pose);
    flowerS = pose.s + FLOWER_AHEAD;
    const fc = cylToWorld({ s: flowerS, ang: 0, rad: 0 }, new THREE.Vector3());
    flowerCenter = [fc.x, fc.y, fc.z];

    // 散らばるガラス片（3つの形、色は形ごと）。家の位置は Blender の配置
    const shardHandles: GlassHandle[] = [];
    let n = 0;
    const keys = ['shard_a', 'shard_b', 'shard_c'];
    const all: { im: THREE.InstancedMesh; i: number }[] = [];
    keys.forEach((key, j) => {
      const pal = PALETTES.lapis.glass;
      const h = createGlass('tinted', { ...COLOR_GLASS, color: pal[(j * 2) % pal.length], opacity: 0.55, emissive: pal[(j * 2) % pal.length], emissiveIntensity: 0.6 });
      handles.push(h);
      shardHandles.push(h);
      const im = instancesFrom(scene, key, h.material);
      if (!im) return;
      im.frustumCulled = false;
      im.renderOrder = 3;
      im.userData.shardColor = j;
      scene.add(im);
      shardMeshes.push(im);
      const keep = Math.max(1, Math.round(im.count * ctx.quality.particleScale));
      for (let i = 0; i < im.count; i++) all.push({ im, i });
      im.count = keep;
    });
    for (const { im, i } of all) {
      im.getMatrixAt(i, tmpM);
      const pos = new THREE.Vector3();
      const q = new THREE.Quaternion();
      tmpM.decompose(pos, q, tmpP);
      shards.push({ mesh: im, instance: i, home: worldToCyl(pos, { s: 0, ang: 0, rad: 0 }), homeQ: q, slot: flowerSlot(n, all.length), ds: ((n * 0.7548) % 1) * 0.5 - 0.25, seed: (n * 0.618034) % 1, grow: 1.1, touchAt: -Infinity });
      n++;
    }
    shardColorHandles = shardHandles;

    // 触れられるガラス片（Blender の touch_kind = shard、touch_id）
    const touchObjs = findAll(scene, (ud) => ud.touch_kind === 'shard') as THREE.Mesh[];
    touchObjs.forEach((o, i) => {
      const pal = PALETTES.lapis.glass;
      const colorIdx = i % pal.length;
      const glass = createGlass('tinted', { ...COLOR_GLASS, color: pal[colorIdx], opacity: 0.5, emissive: pal[colorIdx], emissiveIntensity: 0.75 });
      handles.push(glass);
      o.material = glass.material;
      o.renderOrder = 4;
      o.updateMatrixWorld(true);
      const pos = o.getWorldPosition(new THREE.Vector3());
      const q = o.getWorldQuaternion(new THREE.Quaternion());
      // 触れられるガラス片も花に集まり、いちばん内側の輪に並ぶ（花の面の少し手前）
      const shard: Shard = {
        mesh: o,
        instance: -1,
        home: worldToCyl(pos, { s: 0, ang: 0, rad: 0 }),
        homeQ: q,
        slot: { ang: (2 * Math.PI * i) / touchObjs.length, rad: FLOWER_R0 + 0.05, tilt: 0 },
        ds: -0.35,
        seed: (i * 0.618034) % 1,
        grow: 0.6,
        touchAt: -Infinity,
      };
      shards.push(shard);
      const entry = { shard, glass, colorIdx, touchable: null as unknown as Touchable };
      entry.touchable = {
        id: `kaleidoscope/${String(o.userData.touch_id ?? `shard-${i}`)}`,
        kind: 'shard',
        section: 'kaleidoscope',
        object: o,
        radius: 0.3,
        enabled: true,
        idleChime: true,
        setHighlight: (v) => glass.setHighlight(v),
        onTouch: (e) => {
          // 0.1 秒以内に光と動き: 波紋、色が次の色へ、くるりと回る。色は拍に合わせて模様へ広がる
          glass.pulse(e.t, new THREE.Vector3(...e.point));
          shard.touchAt = e.t;
          entry.colorIdx++;
          const color = PALETTES[door].glass[entry.colorIdx % PALETTES[door].glass.length];
          setShardColor(glass, mixA.set(color));
          const c = worldToCyl(o.getWorldPosition(tmpP), { s: 0, ang: 0, rad: 0 });
          echoes.push({ t: e.t, s: c.s, color });
        },
      };
      touchShards.push(entry);
      touchables.push(entry.touchable);
    });

    // 膜（天球へ）
    const mem = findAll(scene, (ud) => ud.role === 'membrane')[0] as THREE.Mesh | undefined;
    if (mem) {
      // 正面の虹色は控えめに、部屋の光の色でかすかに光らせる（向こうの暗がりが暗い緑の円に見えない）
      const h = createGlass('iridescent', { color: 0xf0f4ff, opacity: 0.04, iridescence: 1, face: 0.05, rim: 0.7, doubleSided: true, emissive: PALETTES.lapis.light, emissiveIntensity: EXIT_GLOW });
      handles.push(h);
      exitGlass = h;
      mem.material = h.material;
      mem.renderOrder = 5;
    }

    // 隠れた小さな泡
    const hp = cylToWorld({ s: span.s0 + HIDDEN.ds, ang: THREE.MathUtils.degToRad(HIDDEN.angDeg), rad: HIDDEN.rad }, new THREE.Vector3());
    const hglass = createGlass('iridescent', { color: 0xffffff, opacity: 0.06, iridescence: 1, face: 0.12, rim: 0.9, emissive: 0xffffff, emissiveIntensity: 0.08 });
    handles.push(hglass);
    const hmesh = new THREE.Mesh(new THREE.IcosahedronGeometry(HIDDEN.r, 3), hglass.material);
    hmesh.name = 'kaleidoscope.hidden-bubble';
    hmesh.position.copy(hp);
    hmesh.renderOrder = 5;
    root.add(hmesh);
    hidden = { mesh: hmesh, glass: hglass, base: hp.clone(), foundAt: Infinity, touchAt: -Infinity };
    const hb = hidden;
    touchables.push({
      id: 'kaleidoscope/hidden-bubble',
      kind: 'hidden-bubble',
      section: 'kaleidoscope',
      object: hmesh,
      radius: HIDDEN.r,
      enabled: true,
      setHighlight: (v) => hglass.setHighlight(v * 0.6),
      onTouch: (e) => {
        hglass.pulse(e.t, new THREE.Vector3(...e.point));
        hb.touchAt = e.t;
        if (hb.foundAt === Infinity) {
          hb.foundAt = e.t;
          ctx.events.emit('hiddenFound', { section: 'kaleidoscope' });
        }
      },
    });

    applyPalette(1);
    // 最初の配置（時刻 0 の姿。テストと最初の描画で同じ）
    placeShards(0, 'standard');
  }

  let shardColorHandles: GlassHandle[] = [];

  /**
   * 扉が変わった。乗車の途中なら、いまの時刻（最後のフレームの時刻）から DOOR_BLEND_SEC かけて混ぜる。
   * まだフレームがない（読み込み直後、?t= の頭）なら、すぐに今の扉の色にする（途中から始めても同じ絵）。
   */
  function setDoorChoice(d: DoorChoice) {
    if (d === door) return;
    fromDoor = door;
    door = d;
    doorAt = Number.isFinite(lastT) ? lastT : -Infinity;
    applyPalette(blendAt(lastT));
  }

  function placeShards(t: number, comfort: ComfortMode) {
    const spin = comfort === 'standard' ? (t - FLOWER_T) * 0.06 : 0;
    // ゴンドラが近づくと花が開く（内側の半径が広がる）
    const open = 1 + 0.16 * smooth(FLOWER_T + 8, FLOWER_T + 18, t);
    for (const sh of shards) {
      const g = gatherAt(t, TIMING, Math.round(sh.seed * 997));
      // 家: 壁ぎわをゆっくり漂い、自分の軸のまわりにゆっくり回る
      homeCyl.s = sh.home.s + Math.sin(t * 0.11 + sh.seed * 40) * 0.25;
      homeCyl.ang = sh.home.ang + Math.sin(t * 0.07 + sh.seed * 17) * 0.05;
      homeCyl.rad = sh.home.rad;
      flowerCyl.s = flowerS + sh.ds;
      flowerCyl.ang = sh.slot.ang + spin;
      flowerCyl.rad = sh.slot.rad * open;
      lerpCyl(homeCyl, flowerCyl, g, tmpCyl);
      cylToWorld(tmpCyl, tmpP);
      // 向き: 家の向き（ゆっくり回る）→ 花の面の上で放射に沿う向き
      tmpQ.copy(sh.homeQ).multiply(tmpQ2.setFromAxisAngle(zAxis, t * 0.25 * (sh.seed - 0.5)));
      // glb の形は Y 上に直してあるので、ガラス片の厚み（Blender の z）は局所の y。花の面に寝かせるには y を軸へ向ける
      const fq = axisRotation(flowerCyl.ang, flowerQ).multiply(tmpQ2.setFromAxisAngle(zAxis, sh.slot.tilt)).multiply(LAY_FLAT);
      tmpQ.slerp(fq, g);
      // 触れたガラス片は、くるりと一回転する（触れた時刻からの経過で毎フレーム作り直す。積み上げない）
      const sk = (t - sh.touchAt) / SPIN_SEC;
      if (sk >= 0 && sk < 1) tmpQ.multiply(tmpQ2.setFromAxisAngle(zAxis, Math.PI * 2 * smooth(0, 1, sk)));
      // 花の中では大きく（花びらの面を埋める）
      const k = 1 + sh.grow * g;
      if (sh.instance >= 0) {
        const im = sh.mesh as THREE.InstancedMesh;
        if (sh.instance >= im.count) continue;
        tmpM.compose(tmpP, tmpQ, tmpS.set(k, k, k));
        im.setMatrixAt(sh.instance, tmpM);
      } else {
        sh.mesh.position.copy(tmpP);
        sh.mesh.quaternion.copy(tmpQ);
        sh.mesh.scale.setScalar(k);
      }
    }
    for (const im of shardMeshes) im.instanceMatrix.needsUpdate = true;
  }

  function rewind(t: number) {
    // 時刻が戻ったら、扉の色の混ぜは済んだことにする（戻った先では、今の扉の色）
    if (t < doorAt) doorAt = -Infinity;
    while (echoes.length > 0 && echoes[echoes.length - 1].t > t + 0.25) echoes.pop();
    for (const sh of shards) if (t < sh.touchAt - 0.25) sh.touchAt = -Infinity;
    if (hidden && t < hidden.foundAt - 0.25) hidden.foundAt = Infinity;
  }

  function update(frame: RoomFrame) {
    const t = frame.t;
    if (t < lastT - 0.5) rewind(t);
    lastT = t;
    for (const h of handles) h.setTime(t);
    // 扉が変わった後の金と青の混ぜ（時刻から）
    const k = blendAt(t);
    if (k !== appliedK) applyPalette(k);
    // プリズムはごくゆっくり息をする（明滅ではない）
    uGlow.value = 2.2 * (1 + 0.04 * Math.sin(t * 0.5));
    if (prismGlass) (prismGlass.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.25 + 0.1 * Math.sin(t * 0.37);

    // ロゼット: 軸のまわりに互い違いに回る（穏やかモードでは止める。角度は時刻から）
    const palA = PALETTES[fromDoor].glass;
    const pal = PALETTES[door].glass;
    for (const r of rosettes) {
      const ang = frame.comfort === 'standard' ? (t - sectionT0) * r.speed : 0;
      r.group.quaternion.copy(r.base).multiply(tmpQ.setFromAxisAngle(zAxis, ang));
      // 触れた色のこだま: 拍の頭に、近い輪から順に届き、届いた色は残る。光は 1 拍に 1 回まで
      // （光の点滅を抑えるモードでは 2 拍に 1 回まで、弱く。折り返しで画面中に広がるため）
      echoAt(echoes, r.s, t, echoGrid(SEC_PER_BEAT, frame.reducedFlash), echoState);
      const pm = r.petals.material as THREE.MeshStandardMaterial;
      mixHex(palA[r.index % palA.length], pal[r.index % pal.length], k, pm.emissive);
      if (echoState.color >= 0) pm.emissive.lerp(tmpColor.set(echoState.color), 0.65);
      pm.color.copy(pm.emissive);
      const flash = echoFlash(t, echoState.arrival) * (frame.reducedFlash ? 0.3 : 1);
      pm.emissiveIntensity = 0.55 + 1.0 * flash;
      (r.jewels.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.8 + 0.7 * flash;
    }

    // ガラス片（見どころの花。触れたガラス片の回転も、ここで時刻から作る）
    placeShards(t, frame.comfort);

    if (hidden) {
      const b = hidden.base;
      hidden.mesh.position.set(b.x, b.y + Math.sin(t * 0.8) * 0.03, b.z);
      const k = t - hidden.touchAt;
      hidden.mesh.scale.setScalar(k >= 0 && k < 0.5 ? 1 + 0.35 * Math.sin(k * 25) * (1 - k / 0.5) : 1);
    }
  }

  return {
    id: 'kaleidoscope',
    root,
    touchables,
    get atmosphere() {
      return atmosphere;
    },
    load,
    update,
    onCue(_cue: Cue) {
      // 花が咲く時刻・模様の回転は時刻から決める（?t= で途中から始めても同じ絵になる）
    },
    focusPoint(name) {
      if (!ctxRef) return null;
      return name === 'kaleidoscope.flower' ? flowerCenter : null;
    },
    setDoor(d) {
      setDoorChoice(d);
    },
    dispose() {
      for (const h of handles) h.dispose();
      handles.length = 0;
      disposeTree(root, owned);
      owned.length = 0;
      touchables.length = 0;
      rosettes.length = 0;
      shards.length = 0;
      touchShards.length = 0;
      echoes.length = 0;
    },
  };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
