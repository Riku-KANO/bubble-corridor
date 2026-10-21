// 待ち列と入口（ホーム画面の背景）。乗り場のホールの南の入口から、レールの始点の真後ろへ一直線に伸びる。
// 形と光は Blender（blender/scripts/rooms/lobby.py）で造形して焼き、ここで灯り・扉・切符の動きを重ねる。
//
// 画面との約束（統合担当が画面とつなぐ）:
//   - setLoadProgress(0〜1): 待ち列の灯りが、待ち列の視点に近い方（手前）から灯る。全部灯ったら「乗り場へ」
//   - openDoors(): 突き当たりのガラスの扉が開いて光があふれる（待ち列 → 入口、1.5秒）
//   - setTicketNumber(n): 切符に「第n便」の番号を刻む（数字だけ。言葉は画面が出す）
//   - punchTicket(): 改札。切符に光の穴が開き、光の粒になって消える（入口 → 案内、1.5秒）
//   - lobbyViews(ride): 待ち列・入口・乗り場の視点（カメラの位置と見る点）
// 乗車の前の画面は乗車の時計が止まっている（frame.dt = 0）ので、ここの動きだけは実時間でも進める（dt があればそれを使う）。
import * as THREE from 'three/webgpu';
import type { Cue, Vec3Tuple } from '../../contracts/events';
import type { Ride } from '../../contracts/ride';
import type { Atmosphere, RoomContext, RoomFrame, RoomModule, Touchable } from '../../contracts/room';
import { TRANSITION_SEC } from '../../config';
import { createGlass, type GlassHandle } from '../../core/materials/glass';
import { easeGlass } from '../../core/easing';
import { own } from '../../core/storage';
import { PLATFORM_GLASS_LIGHTING } from '../platform';
import { Resources, glowMaterial, haloMaterial, loadEnvironment, loadGlbRoom, setLightmapState, smooth, type GlbRoom } from '../platform/kit';

/**
 * 待ち列の距離（レールの始点から真後ろへ、m）。blender/scripts/rooms/lobby.py と同じ値。
 * 前室の始まり・アーチ・扉・通路の突き当たりと、視点の位置。
 */
export const LOBBY = {
  origin: 7.6,
  arch: 9.2,
  doors: 19.6,
  end: 47,
  floorY: 0.32,
  archCenterY: 0.32 + 7.05 / 2,
  /** 視点 */
  queue: 44.4,
  home: 16.6,
  boarding: 3.6,
  eye: 1.55,
} as const;

export interface LobbyView {
  readonly position: Vec3Tuple;
  readonly target: Vec3Tuple;
}

export interface LobbyViews {
  /** 待ち列（読み込み）: 通路の中から突き当たりの扉を見る */
  readonly queue: LobbyView;
  /** 入口（ホーム）: 前室からアーチと切符を見る */
  readonly home: LobbyView;
  /** 乗り場: 桟橋から、水面に浮かぶゴンドラとホールを見る */
  readonly boarding: LobbyView;
}

/** 待ち列・入口・乗り場の視点（レールの始点と向きから決まる） */
export function lobbyViews(ride: Ride): LobbyViews {
  const s = ride.pointAt(0);
  // 始点の真後ろ（進む向きの逆）
  const bx = Math.sin(s.yaw);
  const bz = Math.cos(s.yaw);
  const at = (back: number, y: number): Vec3Tuple => [s.x + bx * back, y, s.z + bz * back];
  const eye = LOBBY.floorY + LOBBY.eye;
  return {
    queue: { position: at(LOBBY.queue, eye), target: at(LOBBY.doors, LOBBY.floorY + 1.7) },
    home: { position: at(LOBBY.home, eye), target: at(LOBBY.arch, LOBBY.archCenterY) },
    boarding: { position: at(LOBBY.boarding, eye), target: at(-12, 1.6) },
  };
}

export interface LobbyRoom extends RoomModule {
  readonly id: 'lobby';
  /** 読み込みの進み具合（0〜1）。灯りが手前から灯る */
  setLoadProgress(p: number): void;
  /** 何便目か（切符に刻む） */
  setTicketNumber(n: number): void;
  /** 改札（切符が光の粒になって消える） */
  punchTicket(): void;
  /** 突き当たりの扉を開ける（待ち列 → 入口） */
  openDoors(): void;
  /** 待ち列に戻す（扉を閉じ、切符を戻す。もう一度乗るときなど） */
  resetLobby(): void;
}

export function isLobbyRoom(room: RoomModule): room is LobbyRoom {
  return room.id === 'lobby' && typeof (room as Partial<LobbyRoom>).setLoadProgress === 'function';
}

/** 夜明け前の暗い空気（待ち列は薄暗い） */
const ATMOSPHERE: Atmosphere = {
  // 反射用の環境画像は読み込みで足す。ガラスの擬似照明は乗り場の夜明け前と同じ（入口から乗り場が続いて見える）
  glassLighting: PLATFORM_GLASS_LIGHTING.predawn,
  background: 0x101a2a,
  fog: { color: 0x121c2c, near: 18, far: 80 },
  exposure: 1.0,
};

/** 灯りが灯るのにかける秒 */
const LAMP_FADE = 0.45;
/** 切符の大きさ（m） */
const TICKET_W = 0.66;
const TICKET_H = 0.34;
const SPARKS = 72;

interface Lamp {
  readonly obj: THREE.Object3D;
  readonly glass: GlassHandle;
  readonly halo: { value: number };
  readonly dist: number;
  level: number;
}

export function createLobbyRoom(): LobbyRoom {
  const root = new THREE.Group();
  root.name = 'room:lobby';
  const res = new Resources();
  const touchables: Touchable[] = [];
  let glb: GlbRoom | null = null;
  const lamps: Lamp[] = [];
  const doors: { leaf: THREE.Object3D; side: number; base: number }[] = [];
  let progress = 0;
  let doorsOpenT = -1;
  let punchT = -1;
  let clock = 0;
  let lastReal = -1;
  let ticketNumber = 1;

  // 切符（コードで作る: 番号を刻み、改札で光の粒になる）
  const ticket = new THREE.Group();
  ticket.name = 'lobby.ticket';
  ticket.userData.role = 'ticket';
  let ticketGlass: GlassHandle | null = null;
  let numberMat: THREE.MeshBasicMaterial | null = null;
  let numberTex: THREE.CanvasTexture | null = null;
  let sparks: THREE.InstancedMesh | null = null;
  let sparkLevel: { value: number } | null = null;
  const sparkDir: THREE.Vector3[] = [];
  const ticketHome = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  let flood: { value: number } | null = null;
  let holeRef: { value: number } | null = null;
  let lightGain = 1;

  function drawNumber() {
    if (!numberTex) return;
    const c = numberTex.image as HTMLCanvasElement;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255, 236, 205, 0.95)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // 数字だけを刻む（「第n便」「Ride No.n」の言葉は画面が出す）。細い明朝で
    g.font = `300 ${Math.round(c.height * 0.52)}px "Zen Old Mincho", serif`;
    g.fillText(String(ticketNumber), c.width / 2, c.height * 0.54);
    g.strokeStyle = 'rgba(255, 228, 190, 0.7)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(c.width * 0.18, c.height * 0.86);
    g.lineTo(c.width * 0.82, c.height * 0.86);
    g.stroke();
    numberTex.needsUpdate = true;
  }

  function buildTicket(tier: RoomContext['quality']['tier'], home: THREE.Vector3, facing: number) {
    ticketHome.copy(home);
    ticket.position.copy(home);
    ticket.rotation.set(0, facing, 0);
    const shape = new THREE.Shape();
    const r = 0.05;
    const w = TICKET_W / 2;
    const h = TICKET_H / 2;
    shape.moveTo(-w + r, -h);
    shape.lineTo(w - r, -h);
    shape.quadraticCurveTo(w, -h, w, -h + r);
    shape.lineTo(w, h - r);
    shape.quadraticCurveTo(w, h, w - r, h);
    shape.lineTo(-w + r, h);
    shape.quadraticCurveTo(-w, h, -w, h - r);
    shape.lineTo(-w, -h + r);
    shape.quadraticCurveTo(-w, -h, -w + r, -h);
    const card = res.geo(new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 3, curveSegments: 10 }));
    card.translate(0, 0, -0.006);
    ticketGlass = res.handle(createGlass('frosted', { color: 0x9a948a, opacity: 0.38, roughness: 0.4, emissive: 0xffe2b8, emissiveIntensity: 0.05 }, { tier }));
    const cardMesh = new THREE.Mesh(card, ticketGlass.material);
    cardMesh.name = 'lobby.ticket.card';
    ticket.add(cardMesh);
    // 縁の真鍮の細い線
    const pts = shape.getSpacedPoints(80).map((p) => new THREE.Vector3(p.x, p.y, 0));
    const edge = res.geo(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 120, 0.004, 5, true));
    const brass = res.mat(new THREE.MeshBasicMaterial({ color: 0xd2ad6e }));
    const edgeMesh = new THREE.Mesh(edge, brass);
    edgeMesh.position.z = 0.012;
    ticket.add(edgeMesh);
    // 刻んだ番号（ブラウザでは文字を描いた画像。node のテストでは画像なしの板）
    numberMat = res.mat(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff, opacity: 0.9 }));
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      numberTex = new THREE.CanvasTexture(canvas);
      numberTex.colorSpace = THREE.SRGBColorSpace;
      res.textures.add(numberTex);
      numberMat.map = numberTex;
      drawNumber();
      // 書体の読み込みが後なら描き直す
      void document.fonts?.ready.then(drawNumber);
    } else {
      numberMat.opacity = 0;
    }
    const plate = new THREE.Mesh(res.geo(new THREE.PlaneGeometry(TICKET_W * 0.62, TICKET_H * 0.62)), numberMat);
    plate.position.set(0.05, 0, 0.0135);
    ticket.add(plate);
    // 改札の光の穴（右上）
    const hole = glowMaterial(0xfff2d8, 0);
    res.mat(hole.material);
    const holeMesh = new THREE.Mesh(res.geo(new THREE.CircleGeometry(0.028, 24)), hole.material);
    holeMesh.position.set(-w + 0.09, h - 0.08, 0.014);
    ticket.add(holeMesh);
    holeRef = hole.level;
    // 光の粒（改札で切符がほどける）
    const spark = glowMaterial(0xffe9c6, 0);
    res.mat(spark.material);
    sparkLevel = spark.level;
    sparks = new THREE.InstancedMesh(res.geo(new THREE.IcosahedronGeometry(0.012, 1)), spark.material, SPARKS);
    sparks.name = 'lobby.ticket.sparks';
    sparks.frustumCulled = false;
    const rand = mulberry(7);
    for (let i = 0; i < SPARKS; i++) {
      // 切符の面の上の点から、乗り場の方（局所の -Z）と上へ
      sparkDir.push(new THREE.Vector3((rand() - 0.5) * 0.9, 0.35 + rand() * 0.8, -0.6 - rand() * 1.4));
      tmpM.makeScale(0, 0, 0);
      sparks.setMatrixAt(i, tmpM);
    }
    ticket.add(sparks);
    root.add(ticket);
  }
  function applyLamps(step: number) {
    // 灯った灯りは LAMP_FADE 秒で明るくなる
    let litSum = 0;
    for (const l of lamps) {
      const want = l.obj.userData.lit ? 1 : 0;
      l.level = want > l.level ? Math.min(want, l.level + step / LAMP_FADE) : Math.max(want, l.level - step / LAMP_FADE);
      const mat = l.glass.material as THREE.MeshStandardNodeMaterial;
      mat.emissiveIntensity = 0.04 + 1.6 * easeGlass(l.level);
      l.halo.value = 0.6 * easeGlass(l.level);
      litSum += l.level;
    }
    // 通路の焼き込んだ光は、灯った数につれて明るくなる（すべて灯った状態で焼いてある）
    const f = lamps.length ? litSum / lamps.length : 1;
    const gain = 0.3 + 0.7 * f;
    if (glb && Math.abs(gain - lightGain) > 0.002) {
      lightGain = gain;
      setLightmapState(glb.baked, null, gain);
    }
  }

  let atmosphere: Atmosphere = ATMOSPHERE;
  const room: LobbyRoom = {
    id: 'lobby',
    root,
    touchables,
    get atmosphere() {
      return atmosphere;
    },
    async load(ctx: RoomContext) {
      const tier = ctx.quality.tier;
      const g = await loadGlbRoom(ctx, 'lobby', res, {
        tier,
        // 灯りは1つずつ灯すので個別のガラス
        ownGlass: (o) => own(o.userData, 'role') === 'lamp',
      });
      glb = g;
      root.add(g.scene);
      atmosphere = { ...ATMOSPHERE, environment: await loadEnvironment(ctx, res, g.instances) };
      const views = lobbyViews(ctx.ride);
      const queue = new THREE.Vector3(...views.queue.position);
      // 待ち列の灯り: 待ち列の視点に近い順（手前から灯る）
      const halo = res.geo(new THREE.SphereGeometry(0.42, 16, 10));
      for (const [, o] of g.byName) {
        if (own(o.userData, 'role') !== 'lamp') continue;
        const glass = o.userData.glassHandle as GlassHandle | undefined;
        if (!glass) continue;
        const hm = haloMaterial(0xffd29a, 0);
        res.mat(hm.material);
        const h = new THREE.Mesh(halo, hm.material);
        h.name = 'halo';
        o.add(h);
        o.userData.lit = false;
        const p = o.getWorldPosition(new THREE.Vector3());
        lamps.push({ obj: o, glass, halo: hm.level, dist: p.distanceTo(queue), level: 0 });
      }
      lamps.sort((a, b) => a.dist - b.dist);
      // 扉
      for (const [name, o] of g.byName) {
        if (own(o.userData, 'role') !== 'door_leaf') continue;
        const side = Number(own(o.userData, 'hinge_side')) < 0 ? -1 : 1;
        for (const [, f] of g.byName) if (own(f.userData, 'frame_of') === name) o.attach(f);
        doors.push({ leaf: o, side, base: o.rotation.y });
      }
      // 扉が開いたときにあふれる光（扉の開口に置いた柔らかい光の板）
      const s = ctx.ride.pointAt(0);
      const back = new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw));
      const fl = glowMaterial(0xffe2b8, 0);
      res.mat(fl.material);
      const floodMesh = new THREE.Mesh(res.geo(new THREE.CircleGeometry(1.6, 40)), fl.material);
      floodMesh.name = 'lobby.flood';
      floodMesh.position.set(s.x + back.x * (LOBBY.doors + 0.4), LOBBY.floorY + 1.7, s.z + back.z * (LOBBY.doors + 0.4));
      floodMesh.rotation.y = s.yaw;
      floodMesh.scale.set(1, 1.3, 1);
      root.add(floodMesh);
      flood = fl.level;
      // 切符: アーチの下、入口の視点の方を向いて浮かぶ
      // 入口の視点から約 3.4m 先、目の少し下（アーチの前に浮かぶ）
      const home = new THREE.Vector3(s.x + back.x * (LOBBY.home - 3.4), LOBBY.floorY + LOBBY.eye - 0.22, s.z + back.z * (LOBBY.home - 3.4));
      buildTicket(tier, home, s.yaw);
      applyLamps(0);
      res.collect(root);
      root.updateMatrixWorld(true);
    },
    update(frame: RoomFrame) {
      // 乗車の前の画面は乗車の時計が止まっているので、実時間でも進める
      const now = typeof performance !== 'undefined' ? performance.now() / 1000 : 0;
      const real = lastReal < 0 ? 0 : Math.min(0.1, Math.max(0, now - lastReal));
      lastReal = now;
      const step = frame.dt > 0 ? frame.dt : real;
      clock += step;
      res.setTime(clock);
      applyLamps(step);
      // 扉: 開ける合図から 1.2 秒で開く
      const open = doorsOpenT < 0 ? 0 : easeGlass(Math.min(1, (clock - doorsOpenT) / (TRANSITION_SEC.queueToHome * 0.8)));
      for (const d of doors) d.leaf.rotation.y = d.base - d.side * open * DOOR_OPEN;
      if (flood) flood.value = doorsOpenT < 0 ? 0 : 0.9 * smooth(0, 0.35, clock - doorsOpenT) * (1 - 0.6 * smooth(0.6, TRANSITION_SEC.queueToHome + 0.6, clock - doorsOpenT));
      // 切符: ゆっくり浮き沈みして、わずかに揺れる。改札でほどける
      if (punchT < 0) {
        ticket.visible = true;
        ticket.position.copy(ticketHome);
        ticket.position.y += Math.sin(clock * 0.9) * 0.025;
        ticket.rotation.z = Math.sin(clock * 0.6) * 0.02;
        ticket.scale.setScalar(1);
        if (holeRef) holeRef.value = 0;
        if (sparkLevel) sparkLevel.value = 0;
      } else {
        const e = clock - punchT;
        const dur = TRANSITION_SEC.homeToGuide;
        // 0〜0.25: 光の穴が開く。0.2〜dur: 切符が光の粒になって乗り場の方へ流れ、消える
        if (holeRef) holeRef.value = 2.2 * smooth(0, 0.18, e) * (1 - smooth(0.45, 0.8, e));
        const dissolve = smooth(0.2, dur * 0.75, e);
        const shrink = 1 - easeGlass(dissolve);
        ticket.scale.setScalar(Math.max(0, shrink));
        ticket.visible = e < dur;
        if (ticketGlass) ticketGlass.setHighlight(1 - dissolve);
        if (numberMat) numberMat.opacity = typeof document !== 'undefined' ? 0.9 * shrink : 0;
        if (sparks && sparkLevel) {
          // 粒は切符の縮み（scale）を打ち消して、元の大きさの空間を飛ぶ
          const inv = shrink > 1e-3 ? 1 / shrink : 0;
          sparkLevel.value = 1.4 * smooth(0.15, 0.3, e) * (1 - smooth(dur * 0.6, dur, e));
          const k = Math.max(0, e - 0.2);
          for (let i = 0; i < SPARKS; i++) {
            const d = sparkDir[i];
            const u = (i % 12) / 12 - 0.5;
            const v = Math.floor(i / 12) / 6 - 0.5;
            tmpV.set(u * TICKET_W + d.x * k * 0.6, v * TICKET_H + d.y * k * 0.5, d.z * k * 0.9).multiplyScalar(inv);
            tmpS.setScalar(inv * (1 - smooth(0.4, dur, e)) * 1.2);
            tmpM.compose(tmpV, tmpQ.identity(), tmpS);
            sparks.setMatrixAt(i, tmpM);
          }
          sparks.instanceMatrix.needsUpdate = true;
        }
      }
    },
    onCue(_cue: Cue) {},
    focusPoint(): Vec3Tuple | null {
      return null;
    },
    dispose() {
      res.collect(root);
      res.dispose();
      root.clear();
      glb = null;
    },
    setLoadProgress(p: number) {
      progress = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
      const n = Math.round(lamps.length * progress);
      lamps.forEach((l, i) => {
        l.obj.userData.lit = i < n;
      });
    },
    setTicketNumber(n: number) {
      ticketNumber = Number.isFinite(n) ? Math.max(1, Math.min(99999, Math.floor(n))) : 1;
      drawNumber();
    },
    punchTicket() {
      if (punchT < 0) punchT = clock;
    },
    openDoors() {
      if (doorsOpenT < 0) doorsOpenT = clock;
    },
    resetLobby() {
      punchT = -1;
      doorsOpenT = -1;
    },
  };
  return room;
}

/** 扉が開く角度（前室の側へ） */
const DOOR_OPEN = (95 * Math.PI) / 180;

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

