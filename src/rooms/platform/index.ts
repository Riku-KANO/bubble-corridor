// 乗り場「泡の発着場」（0:00〜1:00）と降車（12:30〜13:00）。同じホールを光だけ変えて使う。
// 形と光は Blender（blender/scripts/rooms/platform.py）で造形して焼き、ここでガラス・水面・膜・吊られた泡の動きを重ねる。
//
// 判断の順序:
//   1. 光の状態は時刻から決める: 夜明けの岸に入った後（降車を含む）は朝、それより前は夜明け前。
//      ライトマップ（夜明け前 / 朝）・灯りの強さ・部屋の空気を同時に切り替える（膜の縞が切り替えを隠す）。
//   2. 吊られた泡の回転・揺れ、水面の波紋、膜のたわみも時刻（と触れた時刻）から計算する。積み上げない。
//   3. 触れられる泡は個別のガラス（縁の光と波紋が物ごと）。飾りの泡は共有のガラスのインスタンス。
import * as THREE from 'three/webgpu';
import { cameraPosition, exp, float, length, max, mix, mx_noise_float, positionWorld, reflector, sin, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { Cue, Vec3Tuple } from '../../contracts/events';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../../contracts/room';
import { createBrass, sharedGlass, type GlassHandle, type GlassLighting } from '../../core/materials/glass';
import { own } from '../../core/storage';
import {
  Resources,
  createMembrane,
  haloMaterial,
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
/** 南の入口の扉が開いたときの角度（外へ） */
const DOOR_OPEN = (100 * Math.PI) / 180;

/** 夜明け前の青灰（設計書「乗り場: 夜明け前、青灰と真鍮、天井の乳白の灯り」）。反射用の環境画像は読み込みで足す */
const PREDAWN: Atmosphere = {
  background: 0x223047,
  fog: { color: 0x223047, near: 22, far: 120 },
  exposure: 1.0,
};
/**
 * ガラスと真鍮の擬似反射の照明（共有の値。部屋からは書かない）。統合で Atmosphere.glassLighting（S-25）へ入れる値:
 * 夜明け前は天井の乳白の灯りが頭上から（真鍮が黒く沈まないよう空と床の色は明るめ）、朝は東の高窓からの朝日。
 */
export const PLATFORM_GLASS_LIGHTING: { readonly predawn: Partial<GlassLighting>; readonly morning: Partial<GlassLighting> } = {
  predawn: { sky: 0xb4bccb, ground: 0x4a5466, keyDir: { x: -0.15, y: 0.8, z: 0.25 }, keyColor: 0xffdcb0, keyIntensity: 0.9 },
  morning: { sky: 0xe6eef6, ground: 0xc9a77c, keyDir: { x: 0.78, y: 0.42, z: -0.46 }, keyColor: 0xfff0d8, keyIntensity: 1.2 },
};

/** 降車: ホールは朝の光 */
const MORNING: Atmosphere = {
  background: 0xa9c0d6,
  fog: { color: 0xb4c7d8, near: 30, far: 160 },
  exposure: 1.0,
};

/** 触れた泡の揺れ（振り子）。時刻から計算する */
interface Swing {
  t0: number;
  axis: THREE.Vector3;
}

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
  let water: ReturnType<typeof waterMaterial> | null = null;
  const tmpM = new THREE.Matrix4();
  const tmpR = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpQ2 = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();

  function applyState(m: boolean) {
    if (!glb || m === morning) return;
    morning = m;
    setLightmapState(glb.baked, m ? 'morning' : null);
    atmosphere = m ? morningAir : predawn;
    if (lampGlass) (lampGlass.material as THREE.MeshStandardNodeMaterial).emissiveIntensity = m ? 0.25 : 1.3;
    for (const h of halos) h.level.value = m ? h.on * 0.12 : h.on;
    if (sconceGlass) (sconceGlass.material as THREE.MeshStandardNodeMaterial).emissiveIntensity = m ? 0.2 : 1.6;
    if (oculusGlass) {
      const mat = oculusGlass.material as THREE.MeshStandardNodeMaterial;
      mat.emissive.set(m ? 0xfff2dc : 0x8ea6cc);
      mat.emissiveIntensity = m ? 1.2 : 0.3;
    }
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
      water = waterMaterial(tier);
      if (water.mirror) root.add(water.mirror.target);
      morningFrom = ctx.ride.sectionTime('dawn').t0;
      const g = await loadGlbRoom(ctx, 'platform', res, {
        tier,
        // 触れられる泡（縁の光と波紋が物ごと）と、朝に強さを変える灯り・丸窓は個別のガラス
        ownGlass: (o) => typeof own(o.userData, 'touch_kind') === 'string' || ['ceiling_lamp', 'sconce'].includes(String(own(o.userData, 'role'))) || o.userData.name === 'platform.oculus',
        // 吊られた泡は澄んだ泡に（虹色は縁にだけ。面全体が色付いて見えないよう弱める）
        glassOverride: (_o, kind, params) => (kind === 'iridescent' ? { ...params, iridescence: 0.4, opacity: 0.03 } : params),
      });
      glb = g;
      root.add(g.scene);
      const env = await loadEnvironment(ctx, res, g.instances, 'env');
      const envMorning = (await loadEnvironment(ctx, res, g.instances, 'env_morning')) ?? env;
      predawn = { ...PREDAWN, environment: env };
      morningAir = { ...MORNING, environment: envMorning };
      atmosphere = morning ? morningAir : predawn;
      lampGlass = (g.byName.get('platform.lamps')?.userData.glassHandle as GlassHandle | undefined) ?? null;
      oculusGlass = (g.byName.get('platform.oculus')?.userData.glassHandle as GlassHandle | undefined) ?? null;
      sconceGlass = (g.byName.get('platform.sconces')?.userData.glassHandle as GlassHandle | undefined) ?? null;

      // ── 水面: 鏡のような暗い水（縁ほど映り込みが強い）。下に灯りの鏡像を置いて、水を透かして見せる ──
      const waterObj = g.byName.get('platform.water');
      if (waterObj && water) {
        const mat = res.mat(water.material);
        for (const m of meshesOf(waterObj)) {
          m.material = mat;
          m.renderOrder = -1;
        }
        // 中・低品質の鏡像: 灯りの暈と丸窓・高窓を水面で上下に返して置き、水を透かして見せる（縁ほど強い映り込みになる）。
        // 灯りそのものではなく柔らかい暈を、少し縦に伸ばして映す（水面の映り込みの揺らぎ）
        for (const name of water.cheap ? ['platform.oculus', 'platform.windows'] : []) {
          const src = g.byName.get(name);
          if (!src) continue;
          for (const m of meshesOf(src)) {
            const mirror = new THREE.Mesh(m.geometry, m.material);
            mirror.name = `${name}.mirror`;
            mirror.scale.set(1, -1, 1);
            mirror.position.y = 2 * WATER_Y;
            mirror.renderOrder = -2;
            mirror.userData.clearanceExempt = true;
            g.scene.add(mirror);
          }
        }
      }

      // ── 天井の灯りと壁の燭台の暈（とその映り込み） ──
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
        if (!water?.cheap) continue;
        const mirrorMat = haloMaterial(0xffd09a, strength * 0.9);
        const mirror = new THREE.Mesh(halo.mesh.geometry, res.mat(mirrorMat.material));
        mirror.name = `${name}.halos.mirror`;
        // 水面で返し、縦に伸ばす（水の映り込みの揺らぎ）。伸ばした分も水面で返るよう原点を水面に置く
        mirror.scale.set(1, -1.6, 1);
        mirror.position.y = WATER_Y * (1 + 1.6);
        mirror.renderOrder = -2;
        mirror.userData.clearanceExempt = true;
        g.scene.add(mirror);
        halos.push({ level: mirrorMat.level, on: strength * 0.9 });
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
            // 触れた点から泡の中心への向きに押されて揺れる（水平の向きのまわりに回る）
            const c = o.getWorldPosition(new THREE.Vector3());
            const push = c.sub(tmpV).setY(0);
            if (push.lengthSq() < 1e-6) push.set(1, 0, 0);
            push.normalize();
            p.swing = { t0: e.t, axis: new THREE.Vector3(push.z, 0, -push.x) };
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
      res.setTime(t);
      // 水面の波紋: ゴンドラが水に触れているあいだ、その足もとから輪が広がる
      if (water) water.uT.value = t;
      const touching = Math.max(0, 1 - Math.max(0, frame.pose.y - 1.2 - WATER_Y) / 0.25);
      const end = smooth(765, 778, t);
      water?.uRipple.value.set(frame.pose.x, frame.pose.z, touching, Math.max(touching, end));
      // 吊られた泡: ゆっくり回り、触れられた泡は振り子のように揺れて戻る
      for (const p of pivots) {
        tmpQ.setFromAxisAngle(Y_AXIS, p.phase + t * p.spin);
        p.pivot.quaternion.copy(tmpQ);
        if (p.swing) {
          const e = t - p.swing.t0;
          if (e >= 0 && e < 8) {
            const a = 0.22 * Math.exp(-e * 0.55) * Math.sin(e * 2.6);
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
 * 水面: 暗い水と、縁ほど強い映り込み（フレネル）。premultiplied で「奥（鏡像と背景）× F ＋ 水の色 × (1 - F)」。
 * 波紋はゴンドラが水に触れているあいだだけ、その足もとから広がる（時刻から計算）。
 */
function waterMaterial(tier: RoomContext['quality']['tier']) {
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
  if (tier === 'high') {
    // 高品質: 本物の平面の映り込み（半分の解像度）。波紋とさざ波で少し揺らす
    const refl = reflector({ resolutionScale: 0.7, samples: 4 });
    refl.target.rotateX(-Math.PI / 2);
    refl.target.position.y = WATER_Y;
    refl.uvNode = refl.uvNode!.add(vec2(n.mul(0.25), rings.mul(0.6)));
    const m = new THREE.MeshBasicNodeMaterial({ fog: false });
    m.colorNode = vec4(mix(deep.add(sheen), refl.rgb.mul(0.92), fres), float(1));
    return { material: m as THREE.Material, uT, uRipple, mirror: refl, cheap: false };
  }
  // 中・低品質: premultiplied で「奥（鏡像の暈と背景）× F ＋ 水の色 × (1 - F)」
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  // 映り込みは「奥（背景）」なので、背景が明るい朝に水が床のように白く見えないよう、映す割合を控えめにする
  const a = float(1).sub(fres.mul(0.6));
  m.colorNode = vec4(deep.add(sheen).mul(a), a);
  return { material: m as THREE.Material, uT, uRipple, mirror: null, cheap: true };
}
