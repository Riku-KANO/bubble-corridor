// 乗り場「泡の発着場」（0:00〜1:00）と降車（12:30〜13:00）。同じホールを光だけ変えて使う。
// 形と光は Blender（blender/scripts/rooms/platform.py）で造形して焼き、ここでガラス・水面・膜・吊られた泡の動きを重ねる。
//
// 判断の順序:
//   1. 光の状態は時刻から決める: 夜明けの岸に入った後（降車を含む）は朝、それより前は夜明け前。
//      ライトマップ（夜明け前 / 朝）・灯りの強さ・部屋の空気を同時に切り替える（膜の縞が切り替えを隠す）。
//   2. 吊られた泡の回転・揺れ、水面の波紋、膜のたわみも時刻（と触れた時刻）から計算する。積み上げない。
//   3. 触れられる泡は個別のガラス（縁の光と波紋が物ごと）。飾りの泡は共有のガラスのインスタンス。
//   4. 夜明けの岸から遠くに見えるあいだ（岸の区間から降車の手前まで）は、水面の本物の映り込み（場面をもう一度描く）を
//      環境画像の映り込みに替える。外側（外壁・ドーム・水門の館）は Blender が別のアトラスに焼いてある。
import * as THREE from 'three/webgpu';
import { cameraPosition, equirectUV, exp, float, length, max, mix, mx_noise_float, positionWorld, reflector, sin, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { Cue, Vec3Tuple } from '../../contracts/events';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../../contracts/room';
import { createBrass, sharedGlass, type GlassHandle, type GlassLighting } from '../../core/materials/glass';
import { GONDOLA_DIAMETER, MOMENT_BARS, SEC_PER_BAR } from '../../config';
import { own } from '../../core/storage';
import {
  Resources,
  createMembrane,
  haloMesh,
  instanceMatrices,
  loadEnvironment,
  loadGlbRoom,
  meshesOf,
  numbers,
  rng,
  scaledCount,
  setLightmapState,
  smooth,
  str,
  vec3Of,
  type GlbRoom,
  type Membrane,
} from './kit';

/** 吊られた泡の8種（platform.py の BUBBLE_KINDS と同じ） */
const BUBBLE_KINDS = ['round', 'twin', 'trio', 'drop', 'ringed', 'nested', 'lantern', 'pearl'] as const;
const WATER_Y = 0.06;
/** 夜明けの岸の朝日の時刻（src/rooms/dawn と同じ）。岸から見る外側は、朝日とともに明るくなる */
const SUNRISE_T = MOMENT_BARS.dawnSunrise * SEC_PER_BAR;
/** 外側の明るさの段（ライトマップの強さを変える回数を抑える） */
const SHORE_STEPS = 16;
/** 南の入口の扉が開いたときの角度（外へ） */
const DOOR_OPEN = (100 * Math.PI) / 180;

/**
 * ガラスと真鍮の擬似反射の照明（Atmosphere.glassLighting。アプリが空気の変わり目だけ当てる）。
 * 夜明け前は天井の乳白の灯りが頭上から（真鍮が黒く沈まないよう空と床の色は明るめ）。
 * 朝は夜明けの岸と同じ朝日の向き（src/rooms/dawn/sky.ts の方位 30°、高さ約 15°。光の来る向き）。
 */
export const PLATFORM_GLASS_LIGHTING: { readonly predawn: Partial<GlassLighting>; readonly morning: Partial<GlassLighting> } = {
  predawn: { sky: 0xb4bccb, ground: 0x4a5466, keyDir: { x: -0.15, y: 0.8, z: 0.25 }, keyColor: 0xffdcb0, keyIntensity: 0.9 },
  morning: { sky: 0xe6eef6, ground: 0xc9a77c, keyDir: { x: -0.837, y: 0.259, z: -0.483 }, keyColor: 0xfff0d8, keyIntensity: 1.2 },
};

/** 夜明け前の青灰（設計書「乗り場: 夜明け前、青灰と真鍮、天井の乳白の灯り」）。反射用の環境画像は読み込みで足す */
const PREDAWN: Atmosphere = {
  background: 0x223047,
  fog: { color: 0x223047, near: 22, far: 120 },
  exposure: 1.0,
  glassLighting: PLATFORM_GLASS_LIGHTING.predawn,
};

/** 降車: ホールは朝の光 */
const MORNING: Atmosphere = {
  background: 0xa9c0d6,
  fog: { color: 0xb4c7d8, near: 30, far: 160 },
  exposure: 1.0,
  glassLighting: PLATFORM_GLASS_LIGHTING.morning,
};

/** 触れた泡の揺れ（振り子）。触れた時刻から計算する */
interface Swing {
  t0: number;
  axis: THREE.Vector3;
  /** 振れの角度の振幅（泡の位置で SWING_REACH m になる角度） */
  amp: number;
}

/** 触れた泡が押されて振れる距離（泡の位置で、m）。ゴンドラとの距離の余裕（配置で 0.15m 余分に離してある）より小さく */
const SWING_REACH = 0.25;

export function createPlatformRoom(): RoomModule {
  const root = new THREE.Group();
  root.name = 'room:platform';
  const touchables: Touchable[] = [];
  const res = new Resources();
  let predawn: Atmosphere = PREDAWN;
  let morningAir: Atmosphere = MORNING;
  let atmosphere: Atmosphere = predawn;
  let morning = false;
  let morningFrom = Infinity;
  let endRipple: [number, number] = [Infinity, Infinity];
  let glb: GlbRoom | null = null;
  let membrane: Membrane | null = null;
  const pivots: { pivot: THREE.Object3D; spin: number; phase: number; swing: Swing | null }[] = [];
  const doors: { leaf: THREE.Object3D; side: number; base: number }[] = [];
  const decor: { mesh: THREE.InstancedMesh; base: THREE.Matrix4[]; spin: number[]; ring?: THREE.InstancedMesh }[] = [];
  let lampGlass: GlassHandle | null = null;
  /** 灯りの暈（朝は弱める） */
  const halos: { level: { value: number }; on: number }[] = [];
  let oculusGlass: GlassHandle | null = null;
  let sconceGlass: GlassHandle | null = null;
  /** 高窓（内と外）とドームの外のガラスの帯。朝は外から見て暖かく灯る（岸から見る逆光のホール） */
  const glows: { glass: GlassHandle; predawn: [number, number]; morning: [number, number] }[] = [];
  let water: ReturnType<typeof waterMaterial> | null = null;
  let waterMeshes: THREE.Mesh[] = [];
  /** 遠くから見る時間（夜明けの岸の始まり〜降車の 12 秒前） */
  let far: [number, number] = [Infinity, -Infinity];
  let farNow = false;
  /** 外側（外壁・ドーム・水門の館）の焼いた物。朝は岸の空とともに明るさを変える */
  let exteriorBaked: GlbRoom['baked'] = [];
  let shoreLevel = -1;
  let envMaps: { predawn: THREE.Texture | null; morning: THREE.Texture | null } = { predawn: null, morning: null };
  const tmpM = new THREE.Matrix4();
  const tmpR = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpQ2 = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();

  function applyState(m: boolean) {
    if (!glb || m === morning) return;
    morning = m;
    setLightmapState(glb.baked, m ? 'morning' : null);
    shoreLevel = -1;
    atmosphere = m ? morningAir : predawn;
    water?.setEnvironment(m ? envMaps.morning : envMaps.predawn);
    if (lampGlass) (lampGlass.material as THREE.MeshStandardNodeMaterial).emissiveIntensity = m ? 0.25 : 1.3;
    for (const h of halos) h.level.value = m ? h.on * 0.12 : h.on;
    if (sconceGlass) (sconceGlass.material as THREE.MeshStandardNodeMaterial).emissiveIntensity = m ? 0.2 : 1.6;
    if (oculusGlass) {
      const mat = oculusGlass.material as THREE.MeshStandardNodeMaterial;
      mat.emissive.set(m ? 0xfff2dc : 0x8ea6cc);
      mat.emissiveIntensity = m ? 1.2 : 0.3;
    }
    for (const g of glows) {
      const mat = g.glass.material as THREE.MeshStandardNodeMaterial;
      const [color, level] = m ? g.morning : g.predawn;
      mat.emissive.set(color);
      mat.emissiveIntensity = level;
    }
  }

  /** 遠くから見るあいだは、水面を安い映り込みに替える（時刻から決める） */
  function applyFar(f: boolean) {
    if (!water || f === farNow) return;
    farNow = f;
    const mat = f && water.far ? water.far : water.material;
    for (const m of waterMeshes) m.material = mat;
  }

  return {
    id: 'platform',
    root,
    touchables,
    get atmosphere() {
      return atmosphere;
    },
    async load(ctx: RoomContext) {
      const tier = ctx.quality.tier;
      morningFrom = ctx.ride.sectionTime('dawn').t0;
      const dep = ctx.ride.sectionTime('departure');
      far = [morningFrom, dep.t0 - 12];
      endRipple = [dep.t0 + 15, dep.t1 - 2];
      const g = await loadGlbRoom(ctx, 'platform', res, {
        tier,
        // 触れられる泡（縁の光と波紋が物ごと）と、朝に強さを変える灯り・丸窓は個別のガラス
        ownGlass: (o) =>
          typeof own(o.userData, 'touch_kind') === 'string' ||
          ['ceiling_lamp', 'sconce', 'window', 'dome_band'].includes(String(own(o.userData, 'role'))) ||
          o.userData.name === 'platform.oculus',
        // 吊られた泡は澄んだ泡に（虹色は縁にだけ。面全体が色付いて見えないよう弱める）
        // 南の入口の扉は琥珀の乳白（向こうの明るい待ち列が白く飛んで見えないよう、濃く暖かく）
        glassOverride: (o, kind, params) =>
          kind === 'iridescent'
            ? { ...params, iridescence: 0.4, opacity: 0.03 }
            : own(o.userData, 'role') === 'door_leaf'
              ? { ...params, color: '#a8784a', opacity: 0.74, emissive: '#ffa85c', emissiveIntensity: 0.3 }
              : params,
      });
      glb = g;
      root.add(g.scene);
      exteriorBaked = g.baked.filter((b) => {
        for (let o: THREE.Object3D | null = b.mesh; o; o = o.parent) if (own(o.userData, 'exterior') === true) return true;
        return false;
      });
      const env = await loadEnvironment(ctx, res, g.instances, 'env');
      const envMorning = (await loadEnvironment(ctx, res, g.instances, 'env_morning')) ?? env;
      predawn = { ...PREDAWN, environment: env };
      morningAir = { ...MORNING, environment: envMorning };
      atmosphere = morning ? morningAir : predawn;
      envMaps = { predawn: env, morning: envMorning };
      water = waterMaterial(tier, env);
      if (water.mirror) root.add(water.mirror.target);
      lampGlass = (g.byName.get('platform.lamps')?.userData.glassHandle as GlassHandle | undefined) ?? null;
      oculusGlass = (g.byName.get('platform.oculus')?.userData.glassHandle as GlassHandle | undefined) ?? null;
      sconceGlass = (g.byName.get('platform.sconces')?.userData.glassHandle as GlassHandle | undefined) ?? null;
      for (const [, o] of g.byName) {
        const role = own(o.userData, 'role');
        const handle = o.userData.glassHandle as GlassHandle | undefined;
        if (!handle || (role !== 'window' && role !== 'dome_band')) continue;
        const mat = handle.material as THREE.MeshStandardNodeMaterial;
        const outside = own(o.userData, 'exterior') === true;
        glows.push({
          glass: handle,
          predawn: [mat.emissive.getHex(), mat.emissiveIntensity],
          // 朝: 内の高窓は日の差す明るい乳白。外は逆光のホールの窓とドームの帯が暖かく灯る
          morning: outside ? [0xffc98c, role === 'window' ? 0.75 : 0.5] : [0xfff0dc, 0.85],
        });
      }

      // ── 水面: 鏡のような暗い水（縁ほど映り込みが強い）。下に灯りの鏡像を置いて、水を透かして見せる ──
      const waterObj = g.byName.get('platform.water');
      if (waterObj && water) {
        const mat = res.mat(water.material);
        if (water.far) res.mat(water.far);
        waterMeshes = meshesOf(waterObj);
        for (const m of waterMeshes) {
          m.material = mat;
          m.renderOrder = -1;
        }
        farNow = false;
      }

      // ── 天井の灯りと壁の燭台の暈 ──
      for (const [name, scale, strength] of [
        ['platform.lamps', 2.8, 0.55],
        ['platform.sconces', 3.4, 0.7],
      ] as const) {
        const lampsObj = g.byName.get(name);
        const centers = numbers(own(lampsObj?.userData ?? {}, 'lamp_centers'), 3);
        if (centers.length === 0) continue;
        const lr = Number(own(lampsObj!.userData, 'lamp_radius')) || 0.4;
        const halo = haloMesh(res, centers, lr * scale, 0xffd5a0, strength);
        halo.mesh.name = `${name}.halos`;
        g.scene.add(halo.mesh);
        halos.push({ level: halo.level, on: strength });
      }

      // ── 膜の門（温室への出口） ──
      const span = ctx.ride.sectionSpan('platform');
      membrane = createMembrane(ctx.ride, { s: span.s1, radius: 2.98, tier });
      root.add(membrane.mesh);

      // ── 触れられる吊られた泡 ──
      let n = 0;
      for (const [name, o] of g.byName) {
        const kind = own(o.userData, 'touch_kind');
        const id = str(own(o.userData, 'touch_id'));
        if (kind !== 'hanging-bubble' || !id || !id.startsWith('platform/')) continue;
        const mesh = meshesOf(o)[0];
        const handle = o.userData.glassHandle as GlassHandle | undefined;
        if (!mesh || !handle) continue;
        const hang = vec3Of(own(o.userData, 'hang'));
        mesh.geometry.computeBoundingSphere();
        const center = mesh.geometry.boundingSphere!.center.clone().applyMatrix4(o.matrixWorld);
        const top = hang ?? new THREE.Vector3(center.x, center.y + 8, center.z);
        // 吊る点を回転の中心にする（泡は糸の下で揺れる）
        const pivot = new THREE.Group();
        pivot.name = `${name}.pivot`;
        pivot.position.copy(top);
        g.scene.add(pivot);
        pivot.updateMatrixWorld(true);
        pivot.attach(o);
        // 飾りの真鍮の輪（ringed・lantern）も一緒に揺れる
        for (const [, r] of g.byName) if (own(r.userData, 'ring_of') === name) pivot.attach(r);
        // 糸
        const thread = threadLine(res, [0, 0, 0], [center.x - top.x, center.y - top.y + radiusOf(o), center.z - top.z]);
        pivot.add(thread);
        const p = { pivot, spin: 0.05 + 0.03 * ((n * 37) % 7) / 7, phase: n * 1.37, swing: null as Swing | null };
        pivots.push(p);
        const radius = Math.min(1, Math.max(0.1, Number(own(o.userData, 'radius')) || 0.4));
        touchables.push({
          id,
          kind: 'hanging-bubble',
          section: 'platform',
          object: o,
          radius,
          enabled: true,
          idleChime: true,
          setHighlight: (v) => handle.setHighlight(v),
          onTouch: (e) => {
            tmpV.set(e.point[0], e.point[1], e.point[2]);
            handle.pulse(e.t, tmpV);
            // 触れた点から泡の中心への向き（ゴンドラから離れる向き）へ押されて振れる。
            // 軸 (-push.z, 0, push.x) のまわりの正の角度で、吊る点の下の泡は push の向きへ動く
            const c = o.getWorldPosition(new THREE.Vector3());
            const length = Math.max(0.5, c.distanceTo(p.pivot.getWorldPosition(new THREE.Vector3())));
            const push = c.sub(tmpV).setY(0);
            if (push.lengthSq() < 1e-6) push.set(1, 0, 0);
            push.normalize();
            p.swing = { t0: e.t, axis: new THREE.Vector3(-push.z, 0, push.x), amp: SWING_REACH / length };
          },
        });
        n++;
      }

      // ── 南の入口の扉（乗車の頭は開いていて、走り出すと閉まる。降車では閉じたまま、向こうの暖かい光がにじむ） ──
      for (const [name, o] of g.byName) {
        if (own(o.userData, 'role') !== 'door_leaf') continue;
        const side = Number(own(o.userData, 'hinge_side')) < 0 ? -1 : 1;
        for (const [, f] of g.byName) if (own(f.userData, 'frame_of') === name) o.attach(f);
        doors.push({ leaf: o, side, base: o.rotation.y });
      }

      // ── 飾りの吊られた泡（8種のインスタンス）と糸 ──
      const decorGlass = res.handle(sharedGlass('iridescent', { opacity: 0.025, iridescence: 0.28, rim: 0.85 }, { tier }));
      const threadPos: number[] = [];
      const ringBrass = res.mat(createBrass({ color: 0xc19a5c, roughness: 0.35 }));
      for (const kind of BUBBLE_KINDS) {
        const proto = g.protos.get(`proto_${kind}`);
        const all = instanceMatrices(g.instances, kind);
        if (!proto || all.length === 0) continue;
        const count = scaledCount(all.length, ctx.quality.particleScale);
        const mesh = new THREE.InstancedMesh(proto.geometry, decorGlass.material, count);
        mesh.name = `platform.bubbles.${kind}`;
        const base = all.slice(0, count);
        const spin: number[] = [];
        const r = rng(seedOf(kind));
        for (let i = 0; i < count; i++) {
          mesh.setMatrixAt(i, base[i]);
          spin.push((r() - 0.5) * 0.16);
        }
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.computeBoundingSphere();
        g.scene.add(mesh);
        const entry: (typeof decor)[number] = { mesh, base, spin };
        const ringProto = g.protos.get(`proto_${kind}_ring`);
        if (ringProto) {
          const ring = new THREE.InstancedMesh(ringProto.geometry, ringBrass, count);
          ring.name = `platform.bubble_rings.${kind}`;
          for (let i = 0; i < count; i++) ring.setMatrixAt(i, base[i]);
          ring.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          ring.computeBoundingSphere();
          g.scene.add(ring);
          entry.ring = ring;
        }
        decor.push(entry);
        const hangs = numbers(own(g.instances, `hang_${kind}`), 4);
        for (let i = 0; i < count && i * 4 + 3 < hangs.length; i++) {
          threadPos.push(hangs[i * 4], hangs[i * 4 + 1], hangs[i * 4 + 2], hangs[i * 4], hangs[i * 4 + 3], hangs[i * 4 + 2]);
        }
      }
      if (threadPos.length > 0) {
        const geo = res.geo(new THREE.BufferGeometry());
        geo.setAttribute('position', new THREE.Float32BufferAttribute(threadPos, 3));
        const lines = new THREE.LineSegments(geo, res.mat(new THREE.LineBasicMaterial({ color: 0xb79a6a, transparent: true, opacity: 0.32, depthWrite: false })));
        lines.name = 'platform.threads';
        g.scene.add(lines);
      }
      res.collect(root);
      root.updateMatrixWorld(true);
    },
    update(frame: RoomFrame) {
      if (!glb) return;
      const t = frame.t;
      applyState(t >= morningFrom);
      applyFar(t >= far[0] && t < far[1]);
      // 岸から見る外側: 朝日の前は暗い逆光、昇るにつれて岸の空とともに明るく（時刻から決める。段にして変える回数を抑える）
      if (morning) {
        const level = Math.round(smooth(SUNRISE_T - 4, SUNRISE_T + 40, t) * SHORE_STEPS);
        if (level !== shoreLevel) {
          shoreLevel = level;
          setLightmapState(exteriorBaked, 'morning', 0.6 + (0.4 * level) / SHORE_STEPS);
        }
      }
      res.setTime(t);
      // 水面の波紋: ゴンドラが水に触れているあいだ、その足もとから輪が広がる
      if (water) water.uT.value = t;
      const touching = Math.max(0, 1 - Math.max(0, frame.pose.y - GONDOLA_DIAMETER / 2 - WATER_Y) / 0.25);
      // 降車の終わり: 殻が水面へ溶けていくあいだ、波紋を強く
      const end = smooth(endRipple[0], endRipple[1], t);
      water?.uRipple.value.set(frame.pose.x, frame.pose.z, touching, Math.max(touching, end));
      // 吊られた泡: ゆっくり回り、触れられた泡は振り子のように揺れて戻る
      for (const p of pivots) {
        tmpQ.setFromAxisAngle(Y_AXIS, p.phase + t * p.spin);
        p.pivot.quaternion.copy(tmpQ);
        if (p.swing) {
          const e = t - p.swing.t0;
          if (e >= 0 && e < 8) {
            // 最初に押された向きへ大きく、戻りの振れは減衰でずっと小さい（ゴンドラの方へはほとんど来ない）
            const a = p.swing.amp * Math.exp(-e * 0.9) * Math.sin(e * 2.6);
            p.pivot.quaternion.premultiply(tmpQ2.setFromAxisAngle(p.swing.axis, a));
          } else if (e >= 8 || e < 0) p.swing = null;
        }
      }
      for (const d of decor) {
        for (let i = 0; i < d.base.length; i++) {
          tmpR.makeRotationY(t * d.spin[i]);
          tmpM.multiplyMatrices(d.base[i], tmpR);
          d.mesh.setMatrixAt(i, tmpM);
          d.ring?.setMatrixAt(i, tmpM);
        }
        d.mesh.instanceMatrix.needsUpdate = true;
        if (d.ring) d.ring.instanceMatrix.needsUpdate = true;
      }
      // 扉: 乗車の 4〜10 秒で閉まる（ゴンドラの後ろ。乗る前の入口・待ち列の画面では開いている）
      const open = 1 - smooth(4, 10, t);
      for (const d of doors) d.leaf.rotation.y = d.base + d.side * open * DOOR_OPEN;
      membrane?.update(frame.pose, t);
    },
    onCue(_cue: Cue) {
      // 乗り場の演出は時刻から決める（出来事を待たない）。?t= で途中から始めても同じ絵になる
    },
    focusPoint(_name: Cue['name']): Vec3Tuple | null {
      return null;
    },
    dispose() {
      membrane?.dispose();
      water?.mirror?.dispose();
      res.collect(root);
      res.dispose();
      root.clear();
      glb = null;
    },
  };
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

function radiusOf(o: THREE.Object3D): number {
  const m = meshesOf(o)[0];
  if (!m) return 0.3;
  m.geometry.computeBoundingSphere();
  return m.geometry.boundingSphere!.radius;
}

function threadLine(res: Resources, a: Vec3Tuple, b: Vec3Tuple): THREE.Line {
  const geo = res.geo(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b], 3));
  const line = new THREE.Line(geo, res.mat(new THREE.LineBasicMaterial({ color: 0xc4a574, transparent: true, opacity: 0.45, depthWrite: false })));
  line.name = 'thread';
  line.userData.clearanceExempt = true;
  return line;
}

/** 名前から乱数の種（泡の種類ごとに回る速さを変える。毎回同じ） */
function seedOf(kind: string): number {
  let s = 7;
  for (const c of kind) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return s;
}

/**
 * 水面: 暗い水と、縁ほど強い映り込み（フレネル）。
 *   高品質: 本物の平面の映り込み（半分強の解像度）。
 *   中・低品質: 部屋の中から撮った環境画像を、水面で返した向きで読む（安い。灯りの映り込みも出る）。
 * 波紋はゴンドラが水に触れているあいだだけ、その足もとから広がる（時刻から計算）。
 */
function waterMaterial(tier: RoomContext['quality']['tier'], env: THREE.Texture | null) {
  const uT = uniform(0);
  const uRipple = uniform(new THREE.Vector4(0, 0, 0, 0));
  const view = cameraPosition.sub(positionWorld).normalize();
  const p = positionWorld.xz;
  // さざ波（ごく弱い。光の明滅を作らない）
  const n = mx_noise_float(vec3(p.x.mul(0.32), p.y.mul(0.32), uT.mul(0.08))).mul(0.035);
  // ゴンドラの足もとの輪
  const d = length(p.sub(vec2(uRipple.x, uRipple.y)));
  const rings = sin(d.mul(5.5).sub(uT.mul(3.2))).mul(exp(d.mul(-0.35))).mul(uRipple.w).mul(0.06);
  const cosT = max(view.y.add(n).add(rings), float(0.0)).clamp(0, 1);
  const grazing = float(1).sub(cosT);
  const fres = float(0.02).add(float(0.98).mul(grazing.pow(5)));
  // 深い水の色。遠く（浅い角度）ほどわずかに空の色を帯びる
  const deep = vec3(0.004, 0.009, 0.016);
  const sheen = vec3(0.012, 0.022, 0.04).mul(smoothstep(float(0), float(0.6), grazing));
  // 水面で返した向き（視線の逆を、上向きの面で返す）。さざ波で少し揺らす
  const r = vec3(view.x.negate().add(n.mul(0.6)), view.y, view.z.negate().add(rings.mul(2))).normalize();
  const fallback = new THREE.DataTexture(new Uint8Array([40, 52, 70, 255]), 1, 1);
  fallback.needsUpdate = true;
  const envNode = texture(env ?? fallback, equirectUV(r));
  const cheap = new THREE.MeshBasicNodeMaterial({ fog: false });
  cheap.colorNode = vec4(mix(deep.add(sheen), envNode.rgb.mul(1.15), fres), float(1));
  const setEnvironment = (t: THREE.Texture | null) => {
    if (t && envNode.value !== t) envNode.value = t;
  };
  if (tier === 'high') {
    const m = new THREE.MeshBasicNodeMaterial({ fog: false });
    const refl = reflector({ resolutionScale: 0.7, samples: 4 });
    refl.target.rotateX(-Math.PI / 2);
    refl.target.position.y = WATER_Y;
    refl.uvNode = refl.uvNode!.add(vec2(n.mul(0.25), rings.mul(0.6)));
    m.colorNode = vec4(mix(deep.add(sheen), refl.rgb.mul(0.92), fres), float(1));
    return { material: m as THREE.Material, far: cheap as THREE.Material, uT, uRipple, mirror: refl, setEnvironment };
  }
  return { material: cheap as THREE.Material, far: null, uT, uRipple, mirror: null, setEnvironment };
}
