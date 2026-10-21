// 第1室「朝露の温室」（1:00〜3:30）。白い鉄骨とガラスの巨大な温室。葉も花もつるもガラスで、葉先に露が光る。
// 形と光は Blender（blender/scripts/rooms/greenhouse.py）で造形して焼き、ここでガラス・植物のインスタンス・
// 露・光の模様・光の筋・大きな花の開花・触れられる葉と蕾を重ねる。
//
// 判断の順序（すべて乗車の時刻から計算する。?t= で途中から始めても同じ絵になる）:
//   1. 2:37（誘導）から光の粒が見どころへ流れ、2:40 の小節の頭で大きな花がほぼ開ききって花芯が最も明るい（撮影）。
//   2. 1 小節後（2:43.3）に、すべての露が少しずつずれて落ち、床に光の輪を残す。
//   3. 触れた葉は揺れて露を落とし、露はしばらくして戻る。触れた蕾は少し早く咲く（見どころでは一緒に咲く）。
//   4. 見どころの演出中に触れても演出は止めない（反応は重ねるだけ）。
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  color as colorNode,
  dot,
  float,
  max,
  mix,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { Cue, Vec3Tuple } from '../../contracts/events';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../../contracts/room';
import type { RidePose } from '../../contracts/ride';
import { DEWFALL_AFTER_BLOOM_BARS, LURE_LEAD_SEC, MOMENT_BARS, SEC_PER_BAR } from '../../config';
import { createGlass, sharedGlass, type GlassHandle, type GlassKind, type GlassLighting } from '../../core/materials/glass';
import { easeGlass } from '../../core/easing';
import { num, own } from '../../core/storage';
import {
  Resources,
  createMembrane,
  glassKindOf,
  glassParamsOf,
  glowMaterial,
  instanceMatrices,
  loadEnvironment,
  loadGlbRoom,
  meshesOf,
  numbers,
  rng,
  scaledCount,
  setLightmapState,
  shaftMaterial,
  smooth,
  str,
  vec3Of,
  type GlbRoom,
  type Membrane,
} from '../platform/kit';

const T_BLOOM = MOMENT_BARS.greenhouseBloom * SEC_PER_BAR;
const T_DEW = (MOMENT_BARS.greenhouseBloom + DEWFALL_AFTER_BLOOM_BARS) * SEC_PER_BAR;
const T_LURE = T_BLOOM - LURE_LEAD_SEC;
/** 大きな花が開き始めてから開ききるまで（2:40 にほぼ開ききる） */
const OPEN_FROM = T_BLOOM - 2.6;
const OPEN_TO = T_BLOOM + 0.6;
/** 朝日の進む向き（greenhouse.py の SUN_DIR と同じ） */
const SUN_DIR = new THREE.Vector3(-0.32, -0.4, 0.86).normalize();
/** 空の太陽の弱まり: 花の直前の暗さから、露が落ち終わるまで（花の向こうの白い霞で花が沈まないように） */
function skySunAt(t: number): number {
  return 1 - 0.8 * smooth(T_LURE - 5, T_LURE - 1, t) * (1 - smooth(T_DEW + 4, T_DEW + 10, t));
}
/** 出口の手前の殻と妻壁の乳白（次の部屋の大きな板が硬い縁のまま透けて見えないように。膜の口だけ澄む） */
const EXIT_MIST = { length: 18, max: 0.82, color: new THREE.Color(0xeef2ea) };
/** 植物の 11 種（greenhouse.py の PLANTS と同じ名前） */
const PLANTS = ['palm', 'treefern', 'banana', 'monstera', 'fern', 'calla', 'tulip', 'grass', 'succulent', 'vine', 'lilypad'] as const;
/** 露の数の上限（高品質。品質で減らす） */
const DEW_MAX = 1400;
const GRAVITY = 9.8;
/** 露が落ちきるまで（遅れ 0.9 秒 ＋ 最も高い葉から床まで）と、床の光の輪が消えるまでの秒 */
const DEW_FALL_SEC = 3.2;
const RING_SEC = 5;

/**
 * ガラスの擬似反射の照明（Atmosphere.glassLighting。アプリが空気の変わり目だけ当てる）:
 * 若葉の明るい空、暖かい石の床、正面の低い朝日（光の来る向き = SUN_DIR の逆）。
 */
export const GREENHOUSE_GLASS_LIGHTING: Partial<GlassLighting> = {
  sky: 0xf2f7ec,
  ground: 0xd6ccb4,
  keyDir: { x: 0.32, y: 0.4, z: -0.86 },
  keyColor: 0xfff0d8,
  keyIntensity: 1.3,
};

/** 朝の明るい空気（若葉の緑と白） */
const ATMOSPHERE: Atmosphere = {
  background: 0xe2ebd8,
  fog: { color: 0xe3e1cd, near: 90, far: 520 },
  exposure: 0.82,
  glassLighting: GREENHOUSE_GLASS_LIGHTING,
};

/**
 * 光の強い場面の直前は少し暗くする（設計書「見せ方のルール」）。誘導の 5 秒前から暗くなり始め、花が開く瞬間（2:40）に戻る。
 * 露出の下げ幅と、焼き込んだ光の下げ幅。空気は段で差し替える（アプリは空気の参照が変わったときだけ当てる。毎フレーム作らない）
 */
const DIM_EXPOSURE = 0.22;
const DIM_LIGHTMAP = 0.25;
const DIM_STEPS = 12;
function dimAt(t: number): number {
  return smooth(T_LURE - 5, T_LURE - 1, t) * (1 - smooth(T_BLOOM - 0.6, T_BLOOM + 0.4, t));
}

interface Leaf {
  readonly pivot: THREE.Object3D;
  readonly axis: THREE.Vector3;
  readonly tipLocal: THREE.Vector3;
  readonly ground: number;
  touchT: number;
}

interface Bud {
  readonly petals: THREE.InstancedMesh;
  readonly glass: GlassHandle;
  touchT: number;
}

export function createGreenhouseRoom(): RoomModule {
  const root = new THREE.Group();
  root.name = 'room:greenhouse';
  const res = new Resources();
  const touchables: Touchable[] = [];
  let glb: GlbRoom | null = null;
  let membrane: Membrane | null = null;
  const head = new THREE.Vector3();
  let hasFlower = false;
  const uT = uniform(0);
  const uSun = uniform(1);

  // 植物の露
  let dew: THREE.InstancedMesh | null = null;
  const dewPos: number[] = [];
  const dewGround: number[] = [];
  const dewDelay: number[] = [];
  let dewState = -1;
  let dewGlass: GlassHandle | null = null;
  let rings: THREE.InstancedMesh | null = null;
  // 触れられる葉の露
  const leaves: Leaf[] = [];
  let leafDew: THREE.InstancedMesh | null = null;
  const buds: Bud[] = [];
  // 大きな花
  let petals: THREE.InstancedMesh | null = null;
  let petalGlass: GlassHandle | null = null;
  const petalBase: { pos: THREE.Vector3; yaw: number; inner: boolean; scale: number }[] = [];
  let coreGlass: GlassHandle | null = null;
  let motes: THREE.InstancedMesh | null = null;
  let moteLevel: { value: number } | null = null;
  const moteFrom: THREE.Vector3[] = [];
  const moteDelay: number[] = [];
  let shaftLevel: { value: number } | null = null;
  let skyDome: THREE.Mesh | null = null;
  let bloomLevel: { value: number } | null = null;
  let skyFrom = 0;
  let skyTo = 0;

  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpQ2 = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const tmpC = new THREE.Color();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3(0, 0, 1);

  function flowerOpen(t: number): number {
    return easeGlass(smooth(OPEN_FROM, OPEN_TO, t));
  }

  function updateFlower(t: number, reduced: boolean) {
    if (!petals) return;
    const o = flowerOpen(t);
    for (let i = 0; i < petalBase.length; i++) {
      const b = petalBase[i];
      // 閉じた蕾では花弁の先が内へ寄り、開くと外へ倒れる（外の輪は深く、内の輪は浅く）
      const pitch = b.inner ? -0.2 + 1.15 * o : -0.12 + 1.42 * o;
      tmpQ.setFromAxisAngle(Y, b.yaw);
      tmpQ2.setFromAxisAngle(Z, -pitch);
      tmpQ.multiply(tmpQ2);
      tmpS.setScalar(b.scale);
      tmpM.compose(b.pos, tmpQ, tmpS);
      petals.setMatrixAt(i, tmpM);
    }
    petals.instanceMatrix.needsUpdate = true;
    if (coreGlass) {
      // 花芯: 光を集めて 2:40 に最も明るく、その後は穏やかに残る（光の点滅を抑えるモードでは控えめ）
      const peak = reduced ? 1.4 : 3.2;
      const gather = smooth(T_LURE, T_BLOOM, t);
      const after = smooth(T_BLOOM, T_BLOOM + 6, t);
      (coreGlass.material as THREE.MeshStandardNodeMaterial).emissiveIntensity = 0.35 + gather * (peak - 0.35) * (1 - 0.55 * after);
    }
    if (bloomLevel) {
      const gather = smooth(T_LURE + 0.5, T_BLOOM, t);
      const after = smooth(T_BLOOM + 0.3, T_BLOOM + 5, t);
      bloomLevel.value = (reduced ? 0.35 : 0.62) * gather * (1 - 0.65 * after);
    }
  }

  function updateMotes(t: number, reduced: boolean) {
    if (!motes || !moteLevel) return;
    const t0 = T_LURE - 0.6;
    const t1 = T_BLOOM + 0.8;
    const live = t >= t0 && t <= t1;
    motes.visible = live;
    if (!live) return;
    moteLevel.value = (reduced ? 0.6 : 1.1) * smooth(t0, t0 + 0.6, t) * (1 - smooth(T_BLOOM + 0.2, t1, t));
    for (let i = 0; i < moteFrom.length; i++) {
      const s = T_LURE - 0.5 + moteDelay[i];
      const u = Math.min(1, Math.max(0, (t - s) / (T_BLOOM + 0.15 - s)));
      if (t < s) {
        motes.setMatrixAt(i, ZERO);
        continue;
      }
      const e = u * u * (3 - 2 * u);
      const from = moteFrom[i];
      // 見どころへ吸い寄せられながら、横へ小さく渦を巻く
      const swirl = Math.sin(u * Math.PI) * 0.9;
      const a = i * 2.39996 + u * 4.0;
      tmpV.lerpVectors(from, head, e);
      tmpV.x += Math.cos(a) * swirl;
      tmpV.y += Math.sin(a * 0.7) * swirl * 0.6;
      tmpV.z += Math.sin(a) * swirl;
      const sc = (u >= 0.999 ? 0 : 1) * (0.6 + 0.4 * Math.sin(i * 1.7)) * (1 - 0.6 * e);
      tmpS.setScalar(sc);
      tmpM.compose(tmpV, tmpQ.identity(), tmpS);
      motes.setMatrixAt(i, tmpM);
    }
    motes.instanceMatrix.needsUpdate = true;
  }

  function updateDew(t: number) {
    if (!dew) return;
    // 葉の上の露: 0 は葉の上、1 は落ちている、2 は落ちきった。0 と 2 は形が変わらないので、変わったときだけ書く
    // （どの状態も時刻だけから決まる。途中から始めても同じ絵）
    const state = t < T_DEW ? 0 : t < T_DEW + DEW_FALL_SEC ? 1 : 2;
    if (state === 1 || state !== dewState) {
      dewState = state;
      const n = dew.count;
      for (let i = 0; i < n; i++) {
        const x = dewPos[i * 3];
        const y0 = dewPos[i * 3 + 1];
        const z = dewPos[i * 3 + 2];
        if (state === 0) {
          tmpV.set(x, y0, z);
          tmpS.set(1, 1.15, 1);
        } else {
          const e = t - T_DEW - dewDelay[i];
          const y = e <= 0 ? y0 : y0 - 0.5 * GRAVITY * e * e;
          if (state === 2 || y <= dewGround[i]) {
            dew.setMatrixAt(i, ZERO);
            continue;
          }
          tmpV.set(x, y, z);
          // 落ちるあいだは大きく、縦に伸びた光の筋に見える（数 px の点では落ちたのが分からない）
          const k = e > 0 ? Math.min(1, e * 4) : 0;
          tmpS.set(1 + 0.8 * k, 1.15 + 3.2 * k, 1 + 0.8 * k);
        }
        tmpM.compose(tmpV, tmpQ.identity(), tmpS);
        dew.setMatrixAt(i, tmpM);
      }
      dew.instanceMatrix.needsUpdate = true;
      if (dewGlass) (dewGlass.material as THREE.MeshStandardNodeMaterial).emissiveIntensity = state === 1 ? 1.4 : 0.4;
    }
    // 床の光の輪（落ちた所から広がって消える）。輪のある間は毎フレーム時刻から、それ以外は描かない
    if (!rings) return;
    const live = t >= T_DEW && t < T_DEW + RING_SEC;
    rings.visible = live;
    if (!live) return;
    for (let i = 0; i < rings.count; i++) {
      const fall = Math.sqrt((2 * Math.max(0, dewPos[i * 3 + 1] - dewGround[i])) / GRAVITY);
      const age = t - T_DEW - dewDelay[i] - fall;
      if (age < 0 || age > 1.4) {
        rings.setMatrixAt(i, ZERO);
        continue;
      }
      tmpV.set(dewPos[i * 3], dewGround[i] + 0.015, dewPos[i * 3 + 2]);
      tmpS.setScalar(0.05 + 0.42 * Math.sqrt(age));
      tmpM.compose(tmpV, tmpQ.identity(), tmpS);
      rings.setMatrixAt(i, tmpM);
      const f = (1 - age / 1.4) ** 2;
      rings.setColorAt(i, tmpC.setRGB(f, f * 0.96, f * 0.86));
    }
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  }

  function updateLeaves(t: number) {
    for (let i = 0; i < leaves.length; i++) {
      const l = leaves[i];
      const e = t - l.touchT;
      // 触れると、ばねのように揺れて戻る
      const a = e >= 0 && e < 3 ? 0.22 * Math.exp(-e * 2.4) * Math.sin(e * 10) : 0;
      l.pivot.quaternion.setFromAxisAngle(l.axis, a);
      if (!leafDew) continue;
      l.pivot.updateMatrixWorld(true);
      tmpV.copy(l.tipLocal).applyMatrix4(l.pivot.matrixWorld);
      // 露: 触れると落ち、2.5 秒後から戻る。見どころの露が落ちた後は戻らない
      let sc = t >= T_DEW + 0.4 ? 0 : 1;
      if (e >= 0 && e < 4.5) {
        const y = tmpV.y - 0.5 * GRAVITY * e * e;
        if (y > l.ground) {
          tmpV.y = y;
        } else sc = 0;
        if (e > 2.5) {
          tmpV.copy(l.tipLocal).applyMatrix4(l.pivot.matrixWorld);
          sc = t >= T_DEW + 0.4 ? 0 : smooth(2.5, 4.5, e);
        }
      }
      tmpS.set(sc, sc * 1.15, sc);
      tmpM.compose(tmpV, tmpQ.identity(), tmpS);
      leafDew.setMatrixAt(i, tmpM);
    }
    if (leafDew) leafDew.instanceMatrix.needsUpdate = true;
  }

  function updateBuds(t: number) {
    for (const b of buds) {
      // 見どころで大きな花と一緒に咲く。触れると少し早く咲く
      const sched = smooth(T_BLOOM - 1.2, T_BLOOM + 2.4, t);
      const touched = b.touchT >= 0 && t >= b.touchT ? smooth(b.touchT, b.touchT + 2.2, t) : 0;
      const o = easeGlass(Math.max(sched, touched));
      for (let j = 0; j < 5; j++) {
        tmpQ.setFromAxisAngle(Y, (j / 5) * Math.PI * 2);
        tmpQ2.setFromAxisAngle(Z, -(-0.25 + 1.25 * o));
        tmpQ.multiply(tmpQ2);
        tmpM.compose(tmpV.set(0, 0, 0), tmpQ, tmpS.set(1, 1, 1));
        b.petals.setMatrixAt(j, tmpM);
      }
      b.petals.instanceMatrix.needsUpdate = true;
    }
  }

  let atmosphere: Atmosphere = ATMOSPHERE;
  /** 暗さの段ごとの空気（0 = 部屋の明るさ） */
  const dimAir: Atmosphere[] = [];
  let dimLevel = -1;
  return {
    id: 'greenhouse',
    root,
    touchables,
    get atmosphere() {
      return atmosphere;
    },
    async load(ctx: RoomContext) {
      const tier = ctx.quality.tier;
      const g = await loadGlbRoom(ctx, 'greenhouse', res, {
        tier,
        ownGlass: (o) =>
          typeof own(o.userData, 'touch_kind') === 'string' ||
          own(o.userData, 'role') === 'flower_core' ||
          o.userData.name === 'greenhouse.shell' ||
          o.userData.name === 'greenhouse.end_glass',
        // 花芯ははっきりした金（光を集めて輝く）
        glassOverride: (o, _kind, params) =>
          own(o.userData, 'role') === 'flower_core' ? { ...params, color: '#ffc25a', opacity: 0.8, emissive: '#ffa526', emissiveIntensity: 0.4 } : params,
      });
      glb = g;
      root.add(g.scene);
      const env = await loadEnvironment(ctx, res, g.instances);
      for (let k = 0; k <= DIM_STEPS; k++) dimAir.push({ ...ATMOSPHERE, environment: env, exposure: ATMOSPHERE.exposure - (DIM_EXPOSURE * k) / DIM_STEPS });
      atmosphere = dimAir[0];
      const random = rng(160);

      // ── 白い鉄骨（細いので焼かず、朝日の向きと空の明るさで塗る） ──
      const iron = res.mat(ironMaterial());
      for (const [, o] of g.byName) if (own(o.userData, 'paint') === 'iron') for (const m of meshesOf(o)) m.material = iron;

      // ── 池（花の根元） ──
      const pond = g.byName.get('greenhouse.water');
      if (pond) {
        const wm = res.mat(pondMaterial(uT));
        for (const m of meshesOf(pond)) m.material = wm;
      }

      // ── 床の光の模様（焼き込んだ日だまりの所だけ揺れる）。低品質（スマートフォン・VR）では重ねる板ごと省く ──
      for (const name of tier === 'low' ? [] : ['greenhouse.floor', 'greenhouse.path']) {
        const o = g.byName.get(name);
        if (!o) continue;
        for (const m of meshesOf(o)) {
          const lm = (m.material as THREE.MeshBasicMaterial).lightMap;
          if (!lm) continue;
          const overlay = new THREE.Mesh(m.geometry, res.mat(causticMaterial(lm, uT, uSun, tier)));
          overlay.name = `${name}.caustics`;
          overlay.renderOrder = 1;
          overlay.userData.clearanceExempt = true;
          m.add(overlay);
        }
      }

      // ── 植物（11 種のインスタンス）と葉先の露 ──
      const dewAll: number[] = [];
      const groundAll: number[] = [];
      for (const kind of PLANTS) {
        const proto = g.protos.get(`proto_${kind}`);
        const all = instanceMatrices(g.instances, kind);
        if (!proto || all.length === 0) continue;
        const count = scaledCount(all.length, ctx.quality.particleScale);
        for (const part of proto.parts) {
          const ud = part.material.userData as Record<string, unknown>;
          const gk: GlassKind = glassKindOf(ud) ?? 'tinted';
          const base = glassParamsOf(ud);
          // 低品質では不透明寄りにして深さを書く（重なった透明な葉の描き重ねを減らす。VR のフレームを守る）
          const params = {
            ...base,
            iridescence: gk === 'tinted' && !/petal/.test(part.material.name) ? 0 : 0.3,
            ...(tier === 'low' ? { opacity: Math.min(0.92, (base.opacity ?? 0.6) + 0.22) } : {}),
          };
          const handle = res.handle(sharedGlass(gk, params, { tier }));
          if (tier === 'low') handle.material.depthWrite = true;
          const mesh = new THREE.InstancedMesh(part.geometry, handle.material, count);
          mesh.name = `greenhouse.plants.${kind}`;
          for (let i = 0; i < count; i++) mesh.setMatrixAt(i, all[i]);
          mesh.computeBoundingSphere();
          g.scene.add(mesh);
        }
        const tips = numbers(own(proto.userData, 'tips'), 3);
        for (let i = 0; i < count; i++) {
          const m = all[i];
          const ground = tmpV.setFromMatrixPosition(m).y;
          for (let k = 0; k < tips.length; k += 3) {
            tmpS.set(tips[k], tips[k + 1], tips[k + 2]).applyMatrix4(m);
            dewAll.push(tmpS.x, tmpS.y, tmpS.z);
            groundAll.push(kind === 'vine' ? 0.3 : ground);
          }
        }
      }
      // 露は数が多いので、品質に合わせて間引く（並びを混ぜてから前から取る）
      const nAll = dewAll.length / 3;
      const order = Array.from({ length: nAll }, (_, i) => i);
      for (let i = nAll - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const nDew = Math.min(nAll, scaledCount(DEW_MAX, ctx.quality.particleScale));
      for (let k = 0; k < nDew; k++) {
        const i = order[k];
        dewPos.push(dewAll[i * 3], dewAll[i * 3 + 1], dewAll[i * 3 + 2]);
        dewGround.push(groundAll[i]);
        dewDelay.push(random() * 0.9);
      }
      if (nDew > 0) {
        dewGlass = res.handle(createGlass('clear', { opacity: 0.25, rim: 1, iridescence: 0.3, emissive: 0xfffbea, emissiveIntensity: 0.4 }, { tier }));
        dew = new THREE.InstancedMesh(res.geo(new THREE.IcosahedronGeometry(0.03, tier === 'low' ? 0 : 1)), dewGlass.material, nDew);
        dew.name = 'greenhouse.dew';
        dew.frustumCulled = false;
        g.scene.add(dew);
        // 床の光の輪は加算（影の中でよく見え、日だまりではかすかに）
        const ring = glowMaterial(0xfff4dc, 1.0);
        res.mat(ring.material);
        const ringGeo = res.geo(new THREE.RingGeometry(0.82, 1, 36));
        ringGeo.rotateX(-Math.PI / 2);
        rings = new THREE.InstancedMesh(ringGeo, ring.material, nDew);
        rings.name = 'greenhouse.dew_rings';
        rings.frustumCulled = false;
        rings.visible = false;
        rings.userData.clearanceExempt = true;
        for (let i = 0; i < nDew; i++) {
          rings.setMatrixAt(i, ZERO);
          rings.setColorAt(i, tmpC.setRGB(0, 0, 0));
        }
        g.scene.add(rings);
      }

      // ── 触れられる葉・蕾・隠れた小さな泡 ──
      const leafDewGlass = res.handle(createGlass('clear', { opacity: 0.22, rim: 1, emissive: 0xfffbea, emissiveIntensity: 0.25 }, { tier }));
      for (const [name, o] of g.byName) {
        const kind = own(o.userData, 'touch_kind');
        const id = str(own(o.userData, 'touch_id'));
        const handle = o.userData.glassHandle as GlassHandle | undefined;
        if (!id || !id.startsWith('greenhouse/') || !handle) continue;
        if (kind === 'leaf') {
          const pivotAt = vec3Of(own(o.userData, 'pivot')) ?? o.getWorldPosition(new THREE.Vector3());
          const tip = vec3Of(own(o.userData, 'tip')) ?? o.getWorldPosition(new THREE.Vector3());
          const pivot = new THREE.Group();
          pivot.name = `${name}.pivot`;
          pivot.position.copy(pivotAt);
          g.scene.add(pivot);
          pivot.updateMatrixWorld(true);
          pivot.attach(o);
          const dir = o.getWorldPosition(new THREE.Vector3()).sub(pivotAt).setY(0);
          if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
          dir.normalize();
          const leaf: Leaf = { pivot, axis: new THREE.Vector3(dir.z, 0, -dir.x), tipLocal: pivot.worldToLocal(tip.clone()), ground: 0.32, touchT: -1e9 };
          leaves.push(leaf);
          touchables.push({
            id,
            kind: 'leaf',
            section: 'greenhouse',
            object: o,
            radius: Math.max(0.3, num(own(o.userData, 'radius'), 0.55, 0.1, 2)),
            enabled: true,
            idleChime: true,
            setHighlight: (v) => handle.setHighlight(v),
            onTouch: (e) => {
              handle.pulse(e.t, tmpV.set(e.point[0], e.point[1], e.point[2]));
              leaf.touchT = e.t;
            },
          });
        } else if (kind === 'bud') {
          // 蕾は5枚の花弁をコードで開く（glb の閉じた形は置き場所と向きに使い、隠す）
          const center = o.getWorldPosition(new THREE.Vector3());
          o.visible = false;
          const glass = res.handle(createGlass('tinted', { color: 0xf4b9c6, opacity: 0.42, iridescence: 0.35 }, { tier }));
          const mesh = new THREE.InstancedMesh(res.geo(petalGeometry(0.42, 0.26)), glass.material, 5);
          mesh.name = `${name}.petals`;
          mesh.position.copy(center).y -= 0.18;
          g.scene.add(mesh);
          const bud: Bud = { petals: mesh, glass, touchT: -1 };
          buds.push(bud);
          touchables.push({
            id,
            kind: 'bud',
            section: 'greenhouse',
            object: mesh,
            radius: 0.4,
            enabled: true,
            idleChime: true,
            setHighlight: (v) => glass.setHighlight(v),
            onTouch: (e) => {
              glass.pulse(e.t, tmpV.set(e.point[0], e.point[1], e.point[2]));
              if (bud.touchT < 0 || e.t < bud.touchT) bud.touchT = e.t;
            },
          });
        } else if (kind === 'hidden-bubble') {
          const ctxEvents = ctx.events;
          touchables.push({
            id,
            kind: 'hidden-bubble',
            section: 'greenhouse',
            object: o,
            radius: 0.14,
            enabled: true,
            setHighlight: (v) => handle.setHighlight(v),
            onTouch: (e) => {
              handle.pulse(e.t);
              ctxEvents.emit('hiddenFound', { section: 'greenhouse' });
            },
          });
        }
      }
      if (leaves.length > 0) {
        leafDew = new THREE.InstancedMesh(res.geo(new THREE.IcosahedronGeometry(0.032, 1)), leafDewGlass.material, leaves.length);
        leafDew.name = 'greenhouse.leaf_dew';
        leafDew.frustumCulled = false;
        g.scene.add(leafDew);
      }

      // ── 大きな花: 12 枚の花弁（外 6 と内 6）を花の頭のまわりに。花芯は光る ──
      const petalProto = g.protos.get('proto_petal');
      const headAt = vec3Of(own(petalProto?.userData ?? {}, 'flower_head'));
      if (petalProto && headAt) {
        head.copy(headAt);
        hasFlower = true;
        petalGlass = res.handle(createGlass('tinted', { color: 0xff5f7e, opacity: 0.46, iridescence: 0.55, rim: 1 }, { tier }));
        petals = new THREE.InstancedMesh(petalProto.geometry, petalGlass.material, 12);
        petals.name = 'greenhouse.flower_petals';
        petals.frustumCulled = false;
        for (let i = 0; i < 12; i++) {
          const inner = i >= 6;
          const yaw = ((i % 6) / 6) * Math.PI * 2 + (inner ? Math.PI / 6 : 0);
          const r0 = inner ? 0.42 : 0.7;
          petalBase.push({ pos: new THREE.Vector3(head.x + Math.cos(yaw) * r0, head.y - 0.42, head.z - Math.sin(yaw) * r0), yaw, inner, scale: inner ? 0.78 : 1 });
        }
        g.scene.add(petals);
        coreGlass = (g.byName.get('greenhouse.flower_core')?.userData.glassHandle as GlassHandle | undefined) ?? null;
        // 光の粒（誘導と、花が光を集める）
        const n = scaledCount(170, ctx.quality.particleScale, 40);
        const glow = sparkMaterial(0xffd27a, 0);
        res.mat(glow.material);
        moteLevel = glow.level;
        motes = new THREE.InstancedMesh(res.geo(new THREE.IcosahedronGeometry(0.05, 1)), glow.material, n);
        motes.name = 'greenhouse.motes';
        motes.frustumCulled = false;
        motes.visible = false;
        motes.userData.clearanceExempt = true;
        const lureAt: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'greenhouse', sectionProgress: 0 };
        ctx.ride.poseAt(T_LURE, 'standard', lureAt);
        for (let i = 0; i < n; i++) {
          // 半分はゴンドラのまわりから（誘導）、半分は温室のあちこちから（花が光を集める）
          const near = i % 2 === 0;
          const a = random() * Math.PI * 2;
          const r = near ? 2.5 + random() * 4 : 8 + random() * 18;
          const base = near ? new THREE.Vector3(lureAt.x, lureAt.y, lureAt.z) : head;
          moteFrom.push(new THREE.Vector3(base.x + Math.cos(a) * r, Math.max(0.6, base.y + (random() - 0.4) * (near ? 2.5 : 8)), base.z + Math.sin(a) * r));
          moteDelay.push(random() * 1.6);
          motes.setMatrixAt(i, ZERO);
        }
        g.scene.add(motes);
        // 花が光を集めて開くときの、頭のまわりの柔らかい金色の光（明るい空気でも見えるよう、ふつうの重ね方）
        const bg = bloomGlowMaterial();
        res.mat(bg.material);
        bloomLevel = bg.level;
        const glowMesh = new THREE.Mesh(res.geo(new THREE.SphereGeometry(4.2, 32, 16)), bg.material);
        glowMesh.name = 'greenhouse.bloom_glow';
        glowMesh.position.copy(head).y += 0.6;
        glowMesh.renderOrder = 5;
        glowMesh.userData.clearanceExempt = true;
        g.scene.add(glowMesh);
      }

      // ── 斜めに差し込む朝日の筋（低品質では省く: 画面いっぱいの加算の描き重ね） ──
      const shafts = tier === 'low' ? null : buildShafts(ctx, res);
      if (shafts) {
        g.scene.add(shafts.mesh);
        shaftLevel = shafts.level;
      }

      // ── 空: ガラスの屋根の向こうの朝の空（正面の低い朝日が逆光で光る）。温室にいるあいだだけ ──
      skyDome = makeSky(res);
      skyDome.position.set(head.x, 0, head.z - 40);
      g.scene.add(skyDome);
      skyFrom = ctx.ride.sectionTime('platform').t1 - 16;
      skyTo = ctx.ride.sectionTime('greenhouse').t1 + 0.4;

      // ── 雨の回廊への膜 ──
      const span = ctx.ride.sectionSpan('greenhouse');
      // 出口の手前の殻と妻壁を乳白に（出口の面からの距離で）
      {
        const e = ctx.ride.pointAt(span.s1 + 0.9);
        const b = ctx.ride.pointAt(span.s1 - 0.5);
        const n = new THREE.Vector3(e.x - b.x, 0, e.z - b.z).normalize();
        for (const name of ['greenhouse.shell', 'greenhouse.end_glass']) {
          const h = g.byName.get(name)?.userData.glassHandle as GlassHandle | undefined;
          if (h) misted(h.material as THREE.MeshStandardNodeMaterial, new THREE.Vector3(e.x, 0, e.z), n);
        }
      }
      membrane = createMembrane(ctx.ride, { s: span.s1, radius: 3.05, floorY: 0, tier });
      root.add(membrane.mesh);

      updateFlower(0, false);
      updateBuds(0);
      updateDew(0);
      res.collect(root);
      root.updateMatrixWorld(true);
    },
    update(frame: RoomFrame) {
      if (!glb) return;
      const t = frame.t;
      uT.value = t;
      res.setTime(t);
      // 空は温室が見えているあいだだけ（次の雨の回廊の空を上書きしない）
      if (skyDome) skyDome.visible = t >= skyFrom && t <= skyTo;
      // 光の筋はごくゆっくり息をする（明滅にならない速さと深さ）
      if (shaftLevel) shaftLevel.value = 0.13 * (0.85 + 0.15 * Math.sin(t * 0.21));
      uSun.value = frame.reducedFlash ? 0.6 : 1;
      uSkySun.value = skySunAt(t);
      // 花の直前の暗さ（空気の露出と焼き込んだ光）
      const dim = dimAt(t);
      const level = Math.round(dim * DIM_STEPS);
      if (level !== dimLevel && dimAir.length > level) {
        dimLevel = level;
        atmosphere = dimAir[level];
        setLightmapState(glb.baked, null, 1 - (DIM_LIGHTMAP * level) / DIM_STEPS);
      }
      updateFlower(t, frame.reducedFlash);
      updateMotes(t, frame.reducedFlash);
      updateDew(t);
      updateLeaves(t);
      updateBuds(t);
      membrane?.update(frame.pose, t);
    },
    onCue(cue: Cue) {
      // 見どころの瞬間、花弁に虹色の波紋を走らせる（演出は時刻から決まるので、出来事は光の強調だけ）
      if (cue.name === 'greenhouse.bloom' && petalGlass) petalGlass.pulse(cue.t);
    },
    focusPoint(name: Cue['name']): Vec3Tuple | null {
      if (!hasFlower) return null;
      if (name === 'greenhouse.bloom' || name === 'greenhouse.dewfall') return [head.x, head.y + 0.4, head.z];
      return null;
    },
    dispose() {
      membrane?.dispose();
      res.collect(root);
      res.dispose();
      root.clear();
      glb = null;
    },
  };
}

/** 花弁の形（根元が原点、+Y へ伸び、内側（-X）へ少し丸まる） */
function petalGeometry(length: number, width: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(width * 0.6, length * 0.15, width * 0.62, length * 0.75, 0, length);
  shape.bezierCurveTo(-width * 0.62, length * 0.75, -width * 0.6, length * 0.15, 0, 0);
  const g = new THREE.ShapeGeometry(shape, 12);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    // 平面 (x, y) を、横は Z、縦は Y にして、内側（-X）へ丸める
    const cup = -0.35 * (x / width) ** 2 * width - 0.08 * (y / length) ** 2 * length;
    p.setXYZ(i, -cup, y, x);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * 朝の空（大きな球の内側）。天頂は淡い青、地平は暖かい白、正面の低い朝日のまわりが明るく光る。
 * 霧は使わない（遠くの空そのもの）。物との距離の検査からは外す。
 */
/** 空の太陽の強さ（花の直前から露のあとまで弱める） */
const uSkySun = uniform(1);

/** 出口の手前を乳白に: 出口の面（点 e、向き n）からの距離で、ガラスの上に乳白の層を重ねる（premultiplied のまま） */
function misted(m: THREE.MeshStandardNodeMaterial, e: THREE.Vector3, n: THREE.Vector3): void {
  if (!m.opacityNode || !m.emissiveNode) return;
  const d = dot(positionWorld.sub(vec3(e.x, e.y, e.z)), vec3(n.x, 0, n.z));
  const k = smoothstep(float(-EXIT_MIST.length), float(-1), d).mul(EXIT_MIST.max);
  const a = m.opacityNode as THREE.Node<'float'>;
  const rgb = m.emissiveNode as THREE.Node<'vec3'>;
  const milk = vec3(EXIT_MIST.color.r, EXIT_MIST.color.g, EXIT_MIST.color.b).mul(mix(float(0.82), float(1), normalWorld.y.mul(0.5).add(0.5)));
  m.opacityNode = a.add(k.mul(float(1).sub(a)));
  m.emissiveNode = rgb.mul(float(1).sub(k)).add(milk.mul(k));
  m.needsUpdate = true;
}

function makeSky(res: Resources): THREE.Mesh {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const dir = positionLocal.normalize();
  const toSun = vec3(-SUN_DIR.x, -SUN_DIR.y, -SUN_DIR.z);
  const up = dir.y;
  const zenith = vec3(0.4, 0.6, 0.82);
  const horizon = vec3(0.94, 0.9, 0.8);
  const ground = vec3(0.82, 0.8, 0.72);
  const skyCol = mix(mix(horizon, ground, smoothstep(0.0, -0.25, up)), zenith, smoothstep(0.02, 0.75, up));
  const d = max(dot(dir, toSun), float(0));
  const sun = vec3(1.0, 0.9, 0.72).mul(pow(d, 900).mul(6).add(pow(d, 40).mul(0.7)).add(pow(d, 6).mul(0.25))).mul(uSkySun);
  m.colorNode = vec4(skyCol.add(sun), float(1));
  const mesh = new THREE.Mesh(res.geo(new THREE.SphereGeometry(520, 48, 24)), res.mat(m));
  mesh.name = 'greenhouse.sky';
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.userData.clearanceExempt = true;
  return mesh;
}

/**
 * 明るい空気の中でも見える光の粒（加算だと白い背景に消えるので、ふつうの重ね方で金色に光らせる）。
 */
function sparkMaterial(colorHex: THREE.ColorRepresentation, level: number): { material: THREE.MeshBasicNodeMaterial; level: { value: number } } {
  const u = uniform(level);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  const c = colorNode(new THREE.Color(colorHex));
  m.colorNode = vec4(c, (u as unknown as THREE.Node<'float'>).clamp(0, 1));
  return { material: m, level: u as unknown as { value: number } };
}

/** 花のまわりの金色の光: 球の正面ほど濃く縁で消える（視線と面の角度）、ふつうの重ね方 */
function bloomGlowMaterial(): { material: THREE.MeshBasicNodeMaterial; level: { value: number } } {
  const u = uniform(0);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  const view = cameraPosition.sub(positionWorld).normalize();
  const facing = normalWorld.dot(view).abs();
  m.colorNode = vec4(vec3(1.0, 0.66, 0.22), pow(facing, 2.0).mul(u as unknown as THREE.Node<'float'>));
  return { material: m, level: u as unknown as { value: number } };
}

/** 白い鉄の塗り: 朝日の当たる面は暖かく明るく、影の面は空の色 */
function ironMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const toSun = vec3(-SUN_DIR.x, -SUN_DIR.y, -SUN_DIR.z);
  const n = normalWorld;
  const sun = max(dot(n, toSun), float(0));
  const sky = mix(vec3(0.62, 0.6, 0.55), vec3(0.86, 0.9, 0.88), n.y.mul(0.5).add(0.5));
  const albedo = vec3(0.93, 0.92, 0.88);
  m.colorNode = vec4(albedo.mul(sky.mul(0.82).add(vec3(1.0, 0.92, 0.78).mul(sun).mul(0.55))), float(1));
  return m;
}

/** 池: 浅い緑の水。縁ほど空を映す */
function pondMaterial(uT: ReturnType<typeof uniform>): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const view = cameraPosition.sub(positionWorld).normalize();
  const p = positionWorld.xz;
  const n = mx_noise_float(vec3(p.x.mul(0.7), p.y.mul(0.7), (uT as unknown as THREE.Node<'float'>).mul(0.15))).mul(0.05);
  const cosT = view.y.add(n).clamp(0, 1);
  const fres = float(0.03).add(float(0.97).mul(float(1).sub(cosT).pow(5)));
  const deep = vec3(0.16, 0.3, 0.27);
  const sky = vec3(0.86, 0.92, 0.84);
  m.colorNode = vec4(mix(deep, sky, fres), float(1));
  return m;
}

/**
 * 床の光の模様: ガラスの屋根と葉を抜けた朝日が揺れる。焼き込んだライトマップの明るい所（日だまり）だけに出す。
 * 加算で床に重ねる（床と同じ形・同じ UV を使う）。
 */
function causticMaterial(lightMap: THREE.Texture, uT: ReturnType<typeof uniform>, uLevel: ReturnType<typeof uniform>, tier: RoomContext['quality']['tier']): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const lm = texture(lightMap, uv(1)).rgb;
  const lum = dot(lm, vec3(0.299, 0.587, 0.114));
  // ライトマップは最も明るい所で 1 に正規化してある。日だまりの床はその数割
  const sunlit = smoothstep(0.1, 0.35, lum);
  const p = positionWorld.xz;
  const t = uT as unknown as THREE.Node<'float'>;
  const w1 = mx_worley_noise_vec2(vec3(p.x.mul(0.62), p.y.mul(0.62), t.mul(0.32)));
  const l1 = pow(float(1).sub(smoothstep(0.0, 0.22, w1.y.sub(w1.x))), 2);
  let c = l1;
  if (tier !== 'low') {
    const w2 = mx_worley_noise_vec2(vec3(p.x.mul(1.3).add(5.3), p.y.mul(1.3), t.mul(0.45).add(11)));
    c = l1.mul(0.65).add(pow(float(1).sub(smoothstep(0.0, 0.2, w2.y.sub(w2.x))), 2).mul(0.45));
  }
  m.colorNode = vec4(colorNode(new THREE.Color(0xfff2d6)).mul(c.mul(sunlit).mul(0.3).mul(uLevel as unknown as THREE.Node<'float'>)), float(1));
  return m;
}

/**
 * 斜めに差し込む朝日の筋: 床の点から太陽の方へ伸びる柔らかい円柱（加算）。レールから十分離す（視界が白くならない）。
 * 1 つの形にまとめて 1 回で描く。
 */
function buildShafts(ctx: RoomContext, res: Resources): { mesh: THREE.Mesh; level: { value: number } } | null {
  const span = ctx.ride.sectionSpan('greenhouse');
  const toSun = SUN_DIR.clone().negate();
  const parts: THREE.BufferGeometry[] = [];
  const r = rng(77);
  const railPts: THREE.Vector3[] = [];
  for (let s = span.s0; s <= span.s1; s += 1) {
    const p = ctx.ride.pointAt(s);
    railPts.push(new THREE.Vector3(p.x, p.y, p.z));
  }
  const seg = new THREE.Line3();
  const closest = new THREE.Vector3();
  for (let k = 0; k < 9; k++) {
    const s = span.s0 + 18 + ((span.s1 - span.s0 - 30) * k) / 8;
    const p = ctx.ride.pointAt(s);
    const side = k % 2 === 0 ? 1 : -1;
    const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    const radius = 0.9 + r() * 1.3;
    let placed = false;
    for (let lateral = 5; lateral < 16 && !placed; lateral += 0.7) {
      const foot = new THREE.Vector3(p.x, 0, p.z).addScaledVector(right, side * lateral);
      const len = 30 / toSun.y;
      const top = foot.clone().addScaledVector(toSun, len);
      seg.set(foot, top);
      let ok = true;
      for (const q of railPts) {
        seg.closestPointToPoint(q, true, closest);
        if (closest.distanceTo(q) < radius + 2.6) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const g = new THREE.CylinderGeometry(radius, radius * 1.25, len, 20, 1, true);
      g.translate(0, len / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), toSun));
      g.translate(foot.x, foot.y, foot.z);
      parts.push(g);
      placed = true;
    }
  }
  if (parts.length === 0) return null;
  const geo = res.geo(mergeAll(parts));
  for (const g of parts) g.dispose();
  const { material, level } = shaftMaterial(0xfff1d8, 0.13, 6);
  res.mat(material);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'greenhouse.shafts';
  mesh.userData.clearanceExempt = true;
  mesh.renderOrder = 4;
  return { mesh, level };
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // 同じ属性（position・normal・uv）の円柱だけなので、そのまま連ねる
  let nv = 0;
  let ni = 0;
  for (const g of parts) {
    nv += g.attributes.position.count;
    ni += g.index ? g.index.count : 0;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const idx = new Uint32Array(ni);
  let ov = 0;
  let oi = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, ov * 3);
    nor.set(g.attributes.normal.array as Float32Array, ov * 3);
    const gi = g.index!.array;
    for (let i = 0; i < gi.length; i++) idx[oi + i] = gi[i] + ov;
    ov += g.attributes.position.count;
    oi += gi.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

