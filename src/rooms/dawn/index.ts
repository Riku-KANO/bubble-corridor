// 第5室「夜明けの岸」（11:00〜12:30）。設計書「体験の流れ › 第5室」。
// 形は Blender（blender/scripts/rooms/dawn.py → public/assets/rooms/dawn.glb）。ここでは
// 空（夜明けの時間割で色が移る）、水面（平面反射を1回）、ガラスの砂（焼いた空の光と朝日、シェーダのきらめき）、
// 遠景の丘の板、真鍮の標柱と灯、海のガラスの小石、乗り場への膜、触れると広がる波紋を重ねる。
//
// 時刻から決める: 空・水・砂・灯・部屋の空気はすべて dawnAt(t) から。11:50 に朝日の縁が水平線に現れ、
// 砂浜が一斉に金色に光る。触れた波紋だけは触れた時刻を覚えて、そこからの経過で描く。
import * as THREE from 'three/webgpu';
import { cameraPosition, exp, float, hash, max, mix, normalView, positionViewDirection, positionWorld, pow, smoothstep, texture, uniform, uv, vec3 } from 'three/tsl';
import { LURE_LEAD_SEC, MOMENT_BARS, SEC_PER_BAR } from '../../config';
import type { Cue, Vec3Tuple } from '../../contracts/events';
import type { RidePose } from '../../contracts/ride';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../../contracts/room';
import { createBrass, createGlass, setGlassLighting, sharedGlass, type GlassHandle } from '../../core/materials/glass';
import { applyLightmaps, createLureStream, loadRoomScene, mergeInstanceGroups, normalizeMesh, type LureStream, type MutableGlassLighting } from '../celestial/kit';
import { createDawnState, createSkyUniforms, dawnAt, skyColorNode, sunDirection, sunHorizontal, viewDirectionNode } from './sky';
import { createRipples, createWater, rippleLightNode, type Water } from './water';

const ROOM = 'dawn';
/** 11:50 朝日が昇り砂浜が金色に光る */
const SUNRISE_T = MOMENT_BARS.dawnSunrise * SEC_PER_BAR;
/** 星の天球の外殻（水面を切る）。水面はここを空ける */
const GLOBE_RADIUS = 61.5;
/** 水面を下げる量（m）。乗り場の水と重なってちらつかないように */
const WATER_DROP = 0.02;
/** 部屋の空気を差し替える細かさ（秒）。毎フレーム新しい物を作らない */
const ATMOSPHERE_STEP = 0.25;

/** 光るガラスの砂: 焼いた空の光（lightMap）と朝日（sunmap）、きらめき、波紋の光 */
interface SandUniforms {
  readonly skyTint: THREE.UniformNode<'color', THREE.Color>;
  readonly sun: THREE.UniformNode<'color', THREE.Color>;
  readonly sunDir: THREE.UniformNode<'vec3', THREE.Vector3>;
  readonly sparkle: THREE.UniformNode<'float', number>;
  readonly warm: THREE.UniformNode<'float', number>;
}

export function createDawnRoom(): RoomModule {
  const root = new THREE.Group();
  root.name = 'room:dawn';
  const touchables: Touchable[] = [];
  const handles: GlassHandle[] = [];
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const textures: THREE.Texture[] = [];
  const state = createDawnState();
  const sky = createSkyUniforms();
  const ripples = createRipples();
  const uTime = uniform(0);
  const sand: SandUniforms = {
    skyTint: uniform(new THREE.Color(0.3, 0.3, 0.4)),
    sun: uniform(new THREE.Color(1, 0.7, 0.4)),
    sunDir: uniform(new THREE.Vector3(-0.86, 0.05, -0.5)),
    sparkle: uniform(0),
    warm: uniform(0),
  };
  /** 空の板の不透明さ: 膜の手前では出口の方角だけ（天球の中から膜の向こうに夜明けがにじむ）、膜を抜けたら全天 */
  const uSkyAll = uniform(1);
  /** 標柱の灯の明るさ（0〜1） */
  const uLamp = uniform(1);
  /** 遠景の丘の色 */
  const uHill = uniform(new THREE.Color(0x2c284a));
  const uSkyAhead = uniform(1);
  let atmosphere: Atmosphere = { background: 0x5a5a8a, exposure: 1 };
  let atmosphereKey = '';
  let water: Water | null = null;
  let proxy: THREE.Mesh | null = null;
  let lure: LureStream | null = null;
  let lampGlass: THREE.MeshStandardNodeMaterial | null = null;
  let sunMapScale = 1;
  let skyMaps: { material: THREE.MeshStandardNodeMaterial; scale: number }[] = [];
  let focus: Vec3Tuple | null = null;
  let hiddenFound = false;
  let hiddenAnim: ((t: number) => void) | null = null;
  let emit: RoomContext['events']['emit'] | null = null;
  const sunDir = new THREE.Vector3();
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();

  const lighting: MutableGlassLighting = {
    sky: new THREE.Color(),
    ground: new THREE.Color(),
    keyColor: new THREE.Color(),
    keyIntensity: 0.5,
    envReflection: 0.4,
  };
  const keyDir = new THREE.Vector3();

  return {
    id: 'dawn',
    root,
    touchables,
    get atmosphere() {
      return atmosphere;
    },

    async load(ctx: RoomContext) {
      emit = ctx.events.emit.bind(ctx.events);
      const tier = ctx.quality.tier;
      const scene = await loadRoomScene(ctx, `rooms/${ROOM}.glb`);
      root.add(scene);
      dawnAt(ctx.ride.sectionTime(ROOM).t0, SUNRISE_T, false, state);
      applyState();

      const byRole = new Map<string, THREE.Object3D[]>();
      scene.traverse((o) => {
        const role = o.userData.role;
        if (typeof role === 'string') byRole.set(role, [...(byRole.get(role) ?? []), o]);
      });

      // ── ガラスの砂浜: 焼いた空の光（lightMap）に朝日のライトマップを時刻で足す ──
      let sunTex: THREE.Texture | null = null;
      const beach = byRole.get('beach')?.[0];
      if (beach && typeof beach.userData.sunmap === 'string' && /^[a-z0-9_.-]+\.png$/.test(beach.userData.sunmap)) {
        sunTex = await ctx.assets.texture(`rooms/${beach.userData.sunmap}`);
        sunTex.colorSpace = THREE.SRGBColorSpace;
        sunTex.flipY = false;
        sunTex.channel = 1;
        sunTex.needsUpdate = true;
        textures.push(sunTex);
        const s = Number(beach.userData.sunmap_scale);
        sunMapScale = Number.isFinite(s) && s > 0 ? s : 1;
      }
      const baked = await applyLightmaps(ctx, scene, () => sandMaterial(sunTex, tier !== 'low'), textures);
      skyMaps = baked.map((b) => ({ material: b.mesh.material as THREE.MeshStandardNodeMaterial, scale: b.scale }));

      // ── 水面（平面反射。低品質は空の色を計算で映す） ──
      const gpose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
      ctx.ride.poseAt(MOMENT_BARS.celestialConstellation * SEC_PER_BAR, 'standard', gpose); // 星の天球の中心
      const globeR = Math.sqrt(Math.max(0, GLOBE_RADIUS * GLOBE_RADIUS - gpose.y * gpose.y));
      water = createWater({
        reflect: tier !== 'low',
        sky,
        ripples,
        // 天球の中には水を張らない。乗り場のホールの下は乗り場の担当の床や水が覆うので、こちらの水面は 2cm 下げておく
        holes: [{ x: gpose.x, z: gpose.z, r: globeR - 0.2 }],
      });
      materials.push(water.material);
      for (const o of byRole.get('water') ?? []) {
        const mesh = o as THREE.Mesh;
        mesh.material = water.material;
        mesh.userData.clearanceExempt = true;
        mesh.position.y -= WATER_DROP;
        mesh.renderOrder = -1;
      }
      if (water.reflectorTarget) root.add(water.reflectorTarget);

      // ── 遠景の丘の板: 霞の色（地平の空の色）へ、遠い板ほど溶ける ──
      for (const o of byRole.get('hills') ?? []) {
        const mesh = o as THREE.Mesh;
        const layer = Number(o.userData.layer) || 0;
        const haze = [0.35, 0.55, 0.74, 0.62][layer] ?? 0.6;
        const m = new THREE.MeshBasicNodeMaterial({ fog: false, side: THREE.DoubleSide });
        const dir = viewDirectionNode();
        const horizon = skyColorNode(vec3(dir.x, 0.02, dir.z).normalize(), sky, { clouds: false });
        // 下ほど霞む（地平の空気）。頂の縁だけ、太陽の側がかすかに明るい
        const h = positionWorld.y.div(60).clamp(0, 1);
        const toward = dir.xz.normalize().dot(sky.sunDir.xz.normalize()).mul(0.5).add(0.5);
        const base = mix(uHill, horizon, float(haze).add(float(1 - haze).mul(float(1).sub(h).pow(3)).mul(0.5)));
        // 膜を抜けるまでは、夜明けがにじむ出口の方角のほかは夜の空の中の暗い影（天球の中から見えるので）
        const lit = max(uSkyAll, smoothstep(0.2, 0.85, dir.x.negate()).mul(uSkyAhead));
        m.colorNode = mix(vec3(0.012, 0.014, 0.04), base.add(sky.sunColor.mul(pow(toward, 6)).mul(sky.glow).mul(0.06)), lit);
        materials.push(m);
        mesh.material = m;
        mesh.userData.clearanceExempt = true;
      }

      // ── 真鍮の標柱と灯 ──
      const brass = createBrass({ color: 0xc9a46a, roughness: 0.28 }) as THREE.MeshStandardNodeMaterial;
      const nv = normalView.dot(positionViewDirection).abs().clamp(0, 1);
      // 動く光源がないので、縁だけが空と朝日を受けて細く光る
      // 標柱の上の灯が、柱の上のほうを暖かく照らす（夜明けとともに消える）
      const lampOnBrass = vec3(1.0, 0.72, 0.42).mul(uLamp.mul(0.5)).mul(smoothstep(0.4, 2.3, positionWorld.y));
      brass.emissiveNode = sand.skyTint.mul(0.9).add(sand.sun.mul(0.7)).mul(float(0.25).add(float(1).sub(nv).pow(2).mul(1.1))).mul(vec3(0.85, 0.66, 0.4)).add(lampOnBrass.mul(float(0.3).add(float(1).sub(nv).mul(0.7))));
      materials.push(brass);
      for (const o of byRole.get('post') ?? []) (o as THREE.Mesh).material = brass;
      mergeInstanceGroups(scene, () => brass);
      const lamp = createGlass('milky', { color: 0xffe2b8, opacity: 0.7, emissive: 0xffb866, emissiveIntensity: 1.4 }, { tier });
      handles.push(lamp);
      lampGlass = lamp.material as THREE.MeshStandardNodeMaterial;
      for (const o of byRole.get('lamp') ?? []) (o as THREE.Mesh).material = lamp.material;

      // ── 乗り場への膜 ──
      for (const o of byRole.get('membrane') ?? []) {
        const mesh = o as THREE.Mesh;
        normalizeMesh(mesh, geometries);
        const glass = createGlass('iridescent', { color: 0xfff4ea, opacity: 0.03, iridescence: 0.7, face: 0.1, rim: 0.9, doubleSided: true }, { tier });
        handles.push(glass);
        mesh.material = glass.material;
        mesh.renderOrder = 8;
        mesh.userData.clearanceExempt = true;
      }

      // ── 海のガラスの小石（型と置き場所は Blender） ──
      const templates = new Map<string, THREE.BufferGeometry>();
      for (const o of byRole.get('pebble_template') ?? []) {
        const mesh = o as THREE.Mesh;
        templates.set(String(o.userData.pebble_kind), mesh.geometry);
        geometries.push(mesh.geometry);
        mesh.removeFromParent();
      }
      const marker = byRole.get('pebbles')?.[0];
      const raw = marker?.userData.points;
      const pts = Array.isArray(raw) ? raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [];
      const counts = [0, 0, 0];
      for (let i = 0; i + 5 < pts.length; i += 6) counts[Math.min(2, Math.max(0, Math.round(pts[i + 5])))]++;
      const colors = [0xa8e4da, 0xf0d2a0, 0xf2c8d4];
      const kinds = ['a', 'b', 'c'];
      const mtx = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const pos = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      kinds.forEach((k, ki) => {
        const geo = templates.get(k);
        if (!geo || counts[ki] === 0) return;
        const glass = sharedGlass('frosted', { color: colors[ki], opacity: 0.32, rim: 0.6 }, { tier });
        handles.push(glass);
        const im = new THREE.InstancedMesh(geo, glass.material, counts[ki]);
        im.name = `dawn:pebbles-${k}`;
        im.userData.role = 'pebbles';
        let n = 0;
        for (let i = 0; i + 5 < pts.length; i += 6) {
          if (Math.min(2, Math.max(0, Math.round(pts[i + 5]))) !== ki) continue;
          const s = pts[i + 3];
          // 型は Blender の Z を平たくしてあるので、three では Y が平たい
          im.setMatrixAt(n++, mtx.compose(pos.set(pts[i], pts[i + 1], pts[i + 2]), q.setFromAxisAngle(up, pts[i + 4]), sc.set(s, s, s)));
        }
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        root.add(im);
      });

      // ── 隠れた小さな泡（ばら色の金） ──
      for (const o of byRole.get('hidden') ?? []) {
        const mesh = o as THREE.Mesh;
        const glass = createGlass('iridescent', { color: 0xffe0d0, opacity: 0.06, iridescence: 1, rim: 1, emissive: 0xffa080, emissiveIntensity: 0.05 }, { tier });
        handles.push(glass);
        mesh.material = glass.material;
        const base = mesh.position.clone();
        let touchedAt = -1e4;
        const id = typeof o.userData.touch_id === 'string' && o.userData.touch_id.startsWith(`${ROOM}/`) ? o.userData.touch_id : `${ROOM}/hidden`;
        touchables.push({
          id,
          kind: 'hidden-bubble',
          section: ROOM,
          object: mesh,
          radius: 0.18,
          enabled: true,
          setHighlight: (level) => glass.setHighlight(level),
          onTouch: (e) => {
            glass.pulse(e.t);
            touchedAt = e.t;
            ripples.add(base.x, base.z, e.t);
            if (!hiddenFound) {
              hiddenFound = true;
              emit?.('hiddenFound', { section: ROOM });
            }
          },
        });
        // 水に浮いて、かすかに上下する（時刻から）。触れると跳ねる
        hiddenAnim = (t) => {
          const k = t >= touchedAt ? Math.exp(-(t - touchedAt) * 3) : 0;
          mesh.position.set(base.x, base.y + 0.03 * Math.sin(t * 1.3) + 0.25 * k * Math.sin(Math.min(Math.PI, (t - touchedAt) * 5)), base.z);
          mesh.scale.setScalar(1 + 0.4 * k);
        };
      }

      // ── 空（夜明けの時間割で色が移る大きな板）。地平の下は水面が隠す ──
      const skyGeo = new THREE.SphereGeometry(1800, 64, 32);
      geometries.push(skyGeo);
      const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, fog: false });
      const vdir = viewDirectionNode();
      const skyCol = skyColorNode(vdir, sky, { clouds: tier !== 'low' });
      const ahead = smoothstep(0.2, 0.85, vdir.x.negate()).mul(smoothstep(0.55, 0.0, vdir.y.abs()));
      skyMat.colorNode = skyCol;
      skyMat.opacityNode = max(uSkyAll, ahead.mul(uSkyAhead)).clamp(0, 1);
      materials.push(skyMat);
      const skyMesh = new THREE.Mesh(skyGeo, skyMat);
      skyMesh.name = 'dawn:sky';
      skyMesh.position.set(55, 0, 0);
      skyMesh.userData = { role: 'sky', clearanceExempt: true };
      skyMesh.renderOrder = -10;
      skyMesh.frustumCulled = false;
      root.add(skyMesh);

      // ── 水面に触れる: 見えない板（ゴンドラの下の水の高さ）。光線はどこに当たっても、その点から波紋 ──
      const proxyGeo = new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2);
      geometries.push(proxyGeo);
      const proxyMat = new THREE.MeshBasicNodeMaterial({ visible: false });
      materials.push(proxyMat);
      proxy = new THREE.Mesh(proxyGeo, proxyMat);
      proxy.name = 'dawn:water-touch';
      proxy.userData = { role: 'water_touch', clearanceExempt: true };
      root.add(proxy);
      const proxyRef = proxy;
      touchables.push({
        id: `${ROOM}/water`,
        kind: 'water',
        section: ROOM,
        object: proxyRef,
        // 指先（VR）はゴンドラの床より下へ手を伸ばしたときだけ水に届く
        radius: 0.55,
        enabled: true,
        idleChime: false,
        setHighlight: (level) => {
          if (water) water.highlight.value = level;
        },
        onTouch: (e) => {
          const [x, , z] = e.point;
          // 当たった点が水の上でなければ（原点のままなど）、ゴンドラの少し前に
          const px = Number.isFinite(x) && (x !== 0 || z !== 0) ? x : proxyRef.position.x - 2;
          const pz = Number.isFinite(z) && (x !== 0 || z !== 0) ? z : proxyRef.position.z;
          ripples.add(px, pz, e.t);
        },
      });

      // ── 見どころ（朝日）と誘導の光の粒 ──
      const fpose: RidePose = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, s: 0, section: 'platform', sectionProgress: 0 };
      ctx.ride.poseAt(SUNRISE_T, 'standard', fpose);
      sunHorizontal(sunDir);
      focus = [fpose.x + sunDir.x * 70, fpose.y + 1.4, fpose.z + sunDir.z * 70];
      lure = createLureStream(SUNRISE_T - LURE_LEAD_SEC, SUNRISE_T, 0xffd7a0);
      root.add(lure.object);
      root.updateMatrixWorld(true);
    },

    update(frame: RoomFrame) {
      const t = frame.t;
      dawnAt(t, SUNRISE_T, frame.reducedFlash, state);
      applyState();
      uTime.value = t;
      sky.time.value = t;
      const t0 = SUNRISE_T - 50; // = 区間の頭（11:00）
      // 天球の中（膜の手前 14 秒）からは、出口の方角だけ夜明けがにじむ。膜を抜けたら全天
      uSkyAhead.value = smooth(t0 - 14, t0 - 1, t);
      uSkyAll.value = smooth(t0 - 0.4, t0 + 0.8, t);
      for (const h of handles) h.setTime(t);
      if (lampGlass) lampGlass.emissiveIntensity = 1.4 * state.lamps + 0.05;
      uLamp.value = state.lamps;
      for (const m of skyMaps) m.material.lightMapIntensity = Math.PI * m.scale * state.skyOnSand;
      const p = frame.pose;
      if (water) {
        water.time.value = t;
        water.body.value.copy(state.water);
        (water.boat.value as THREE.Vector3).set(p.x, p.z, p.speed);
        (water.boatDir.value as THREE.Vector2).set(-Math.sin(p.yaw), -Math.cos(p.yaw));
      }
      if (proxy) proxy.position.set(p.x, 0, p.z);
      hiddenAnim?.(t);
      if (lure && focus) {
        from.set(p.x - Math.sin(p.yaw) * 2.5, p.y + 0.1, p.z - Math.cos(p.yaw) * 2.5);
        to.set(focus[0], focus[1], focus[2]);
        lure.update(t, from, to, frame.reducedFlash);
      }

      // 部屋の空気（夜明け前の藍と桃 → 金と桃色の朝）。細かく刻んで、変わったときだけ新しい物に差し替える
      const step = Math.round(t / ATMOSPHERE_STEP) * ATMOSPHERE_STEP;
      dawnAt(step, SUNRISE_T, frame.reducedFlash, atmoState);
      const key = `${atmoState.background.getHexString()}|${atmoState.exposure.toFixed(2)}`;
      if (key !== atmosphereKey) {
        atmosphereKey = key;
        atmosphere = { background: atmoState.background.getHex(), exposure: atmoState.exposure };
      }

      // この区間にいる間は、ガラスの擬似反射を夜明けの空と朝日に合わせる
      if (frame.pose.section === ROOM) {
        lighting.sky.copy(state.zenith).lerp(state.horizonSun, 0.35);
        lighting.ground.copy(state.water).lerp(state.horizonAway, 0.5);
        lighting.keyColor.copy(state.sunColor);
        lighting.keyIntensity = 0.35 + 0.9 * state.sunOnSand;
        sunDirection(Math.max(2, state.sunElevationDeg), keyDir);
        lighting.keyDir = keyDir; // 太陽が昇るので毎回渡す（使い回しのベクトル）
        setGlassLighting(lighting);
      }
    },

    onCue(_cue: Cue) {
      // 演出はすべて時刻から決める
    },

    focusPoint(name: Cue['name']): Vec3Tuple | null {
      return name === 'dawn.sunrise' ? focus : null;
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
      water?.dispose();
      lure?.dispose();
      root.clear();
      touchables.length = 0;
    },
  };

  /** 時刻の光を uniform に移す */
  function applyState(): void {
    sky.zenith.value.copy(state.zenith);
    sky.horizonSun.value.copy(state.horizonSun);
    sky.horizonAway.value.copy(state.horizonAway);
    sky.sunColor.value.copy(state.sunColor);
    sunDirection(state.sunElevationDeg, sky.sunDir.value as THREE.Vector3);
    sky.sunDisc.value = state.sunDisc;
    sky.glow.value = state.glow;
    sky.stars.value = state.stars;
    uHill.value.copy(state.hill);
    sand.skyTint.value.copy(state.zenith).lerp(state.horizonSun, 0.55).multiplyScalar(1.15);
    sand.sun.value.copy(state.sunColor).multiplyScalar(state.sunOnSand * 1.0);
    sunDirection(Math.max(1.5, state.sunElevationDeg), sand.sunDir.value as THREE.Vector3);
    sand.sparkle.value = state.sparkle;
    sand.warm.value = state.sunOnSand;
  }

  /**
   * ガラスの砂の材質。色は空の光（焼いた lightMap × 空の色）＋朝日（焼いた sunmap × 朝日の色）。
   * 砂粒ごとに向きの違う小さな面を想像し、朝日をちょうど目へ返す粒だけが光る（きらめき）。波紋の光の模様も届く。
   */
  function sandMaterial(sunTex: THREE.Texture | null, fine: boolean): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0xece6f0, roughness: 0.85, metalness: 0 });
    // 濡れた砂（波打ち際）は少し暗く、ガラスの粒が透ける
    const wet = smoothstep(0.35, 0.02, positionWorld.y);
    const albedo = mix(vec3(0.93, 0.9, 0.95), vec3(0.62, 0.66, 0.74), wet);
    m.colorNode = albedo.mul(sand.skyTint);
    const sunLight = sunTex ? texture(sunTex, uv(1)).rgb.mul(sunMapScale) : float(0.6);
    let emissive: THREE.Node<'vec3'> = albedo.mul(sunLight).mul(sand.sun);
    // きらめき: 砂粒（約 6cm）ごとの向き。近くは細かく、遠くは粗い粒で（画面の 1 画素より小さくしない）
    const toEye = positionWorld.sub(cameraPosition);
    const dist = toEye.length();
    const view = toEye.negate().normalize();
    const half = sand.sunDir.add(view).normalize();
    /** 砂粒の層: 1m あたり scale 粒。距離 [in0, in1] で現れ、[out0, out1] で消える */
    const layer = (scale: number, in0: number, in1: number, out0: number, out1: number, power: number) => {
      const g = positionWorld.xz.mul(scale);
      const cell = g.floor();
      const f = g.sub(cell).sub(0.5);
      const seed = cell.x.add(cell.y.mul(317.3)).add(4e6); // hash は符号なし整数で計算するので正にする
      const h1 = hash(seed);
      const h2 = hash(seed.add(19.1));
      const h3 = hash(seed.add(47.7));
      // 粒の面の向きはばらばら（立った面もある）。低い朝日を、低い目へ返す粒だけが光る
      const facet = vec3(h1.mul(2).sub(1), hash(seed.add(83.3)).mul(1.2).sub(0.2), h2.mul(2).sub(1)).normalize();
      const spec = pow(max(facet.dot(half), 0), power);
      const dot = exp(f.dot(f).mul(-14));
      const present = smoothstep(0.25, 0.4, h3);
      const fade = (in1 > 0 ? smoothstep(in0, in1, dist) : float(1)).mul(smoothstep(out1, out0, dist));
      return spec.mul(dot).mul(present).mul(fade);
    };
    const glints = fine ? layer(16, 0, 0, 22, 34, 260).add(layer(5, 16, 26, 70, 95, 180).mul(0.7)) : layer(6, 0, 0, 40, 60, 180);
    // 朝日の前は空の光だけのかすかな銀色、朝日が昇ると金色に一斉に
    emissive = emissive.add(vec3(0.038, 0.034, 0.032).add(vec3(1, 0.82, 0.5).mul(sand.sun)).mul(glints).mul(sand.sparkle.mul(48).add(1.2)));
    // 一斉に金色に: きらめきの瞬間、砂浜全体が朝日の金色を帯びる
    emissive = emissive.add(albedo.mul(vec3(1, 0.78, 0.42).mul(sand.sun)).mul(sand.sparkle.mul(0.55)));
    // ガラスの砂の真珠のような照り（浅い角度で空を映す）
    const nvS = normalView.dot(positionViewDirection).abs().clamp(0, 1);
    emissive = emissive.add(sand.skyTint.mul(float(1).sub(nvS).pow(4).mul(0.18)));
    // 波紋の光の模様（水際から砂の上へ）
    const rip = rippleLightNode(uTime, ripples);
    emissive = emissive.add(mix(vec3(0.5, 0.8, 1.0), vec3(1.0, 0.8, 0.5), sand.warm).mul(rip).mul(smoothstep(1.6, 0.0, positionWorld.y)).mul(0.45));
    m.emissiveNode = emissive;
    materials.push(m);
    return m;
  }
}

/** 部屋の空気を刻んで求めるための作業用 */
const atmoState = createDawnState();

function smooth(e0: number, e1: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
}
