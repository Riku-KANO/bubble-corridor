// ゴンドラ（泡）。直径約2.4mの透明な球。下半分に真鍮の細い枠と手すり、曇りガラスの座席（設計書「ゴンドラ(泡)」）。
// 乗車のあいだずっと画面に映るので、形は細かく、材質は core のガラスと真鍮だけで作る。
//
// 判断の順序:
//   1. 殻は core の虹色のガラス（両面）。内側から見ると視界の中央は澄み、外周だけに虹色が残る（core が自動で切り替える）。
//      閉じ具合は材質の maskNode で「この高さより下だけ描く」と切る（下から上へ閉じ、上から下へ開く）。
//   2. 閉じる・開く途中だけ、切り口に虹色の細い帯を走らせる（「表面に虹色が走る」）。
//   3. 真鍮の枠・手すり・座席は深さを書く（契約: 画面効果の万華鏡がゴンドラを折り返さないため）。
//   4. 縁（role=rim）は目より下、正面の見下ろし 35° 以内に置く（視界の下側に動かない基準が常に見える）。
import * as THREE from 'three/webgpu';
import { positionLocal, uniform } from 'three/tsl';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Gondola } from '../contracts/gondola';
import { CAMERA, GONDOLA_DIAMETER } from '../config';
import { createBrass, createGlass } from '../core/materials/glass';

const R = GONDOLA_DIAMETER / 2;
/** 枠の上端（縁）の高さ。目（+0.15）から正面の見下ろし約 17° に見える */
const RIM_Y = -0.22;
/** 手すりの高さと半径（殻の内側に少し離す） */
const RAIL_Y = -0.3;
const RAIL_R = 0.97;
/** 床の高さ */
const FLOOR_Y = -0.98;
/** 真鍮の管の太さ（細い枠） */
const TUBE = 0.011;
/** 閉じる途中の虹色の帯の幅（m） */
const SEAM_WIDTH = 0.09;

const UP = new THREE.Vector3(0, 1, 0);

/** 形をまとめる（属性をそろえる。索引のない形が混じれば、すべて索引なしにする）。元の形は解放する */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const anyNonIndexed = parts.some((g) => !g.index);
  const ready = parts.map((g) => {
    const n = anyNonIndexed && g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k);
    return n;
  });
  const out = mergeGeometries(ready, false);
  for (const g of parts) g.dispose();
  for (const g of ready) g.dispose();
  if (!out) throw new Error('ゴンドラの形をまとめられない');
  return out;
}

/** 殻の上の高さ y の水平な輪の半径 */
const ringRadius = (y: number) => Math.sqrt(Math.max(0, R * R - y * y));

export function createGondola(): Gondola {
  const root = new THREE.Group();
  root.name = 'gondola';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const keep = <G extends THREE.BufferGeometry>(g: G): G => {
    geometries.push(g);
    return g;
  };

  const brass = createBrass({ color: 0xc09a5b, roughness: 0.3 });
  const darkBrass = createBrass({ color: 0x8f6f3e, roughness: 0.42 });
  materials.push(brass, darkBrass);

  // ── 泡の殻 ──
  // 虹色は控えめに（内側から見て視界の隅に緑と紫が強く出すぎない）
  const shellGlass = createGlass('iridescent', { doubleSided: true, opacity: 0.032, iridescence: 0.45 });
  const shellMat = shellGlass.material as THREE.MeshStandardNodeMaterial;
  /** この高さ（殻の中心から、m）より下だけを描く */
  const uCut = uniform(-R - 0.01);
  shellMat.maskNode = positionLocal.y.lessThan(uCut);
  const shell = new THREE.Mesh(keep(new THREE.SphereGeometry(R, 112, 72)), shellMat);
  shell.name = 'gondola.shell';
  shell.userData.role = 'shell';
  // 殻は視点を包むので、ほかの透明な物より後に描く（中から見た虹色が部屋の物に隠れない）
  shell.renderOrder = 10;
  shell.visible = false;
  root.add(shell);

  // 閉じる途中の切り口に走る虹色の帯: 殻と同じ球の、切り口のすぐ下の細い帯だけを、面全体に色を出すガラスで描く
  const seamGlass = createGlass('iridescent', { face: 0.12, opacity: 0.015, iridescence: 0.7, rim: 0.4, doubleSided: true });
  const seamMat = seamGlass.material as THREE.MeshStandardNodeMaterial;
  seamMat.maskNode = positionLocal.y.lessThan(uCut).and(positionLocal.y.greaterThan(uCut.sub(SEAM_WIDTH)));
  const seam = new THREE.Mesh(shell.geometry, seamMat);
  seam.name = 'gondola.seam';
  seam.scale.setScalar(1.002);
  seam.renderOrder = 11;
  seam.visible = false;
  root.add(seam);

  // ── 真鍮の枠（下半分）: 動かない真鍮は色ごとに1つの形にまとめる（乗車中ずっと描くので描く回数を減らす。VR では目ごとに倍） ──
  const brassParts: THREE.BufferGeometry[] = [];
  const darkParts: THREE.BufferGeometry[] = [];
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();
  /** 形に変換を焼き込んで、まとめる一覧へ */
  const put = (list: THREE.BufferGeometry[], g: THREE.BufferGeometry, pos: THREE.Vector3Like, rot: THREE.Quaternion, scale: THREE.Vector3Like = { x: 1, y: 1, z: 1 }) => {
    tmpM.compose(new THREE.Vector3(pos.x, pos.y, pos.z), rot, new THREE.Vector3(scale.x, scale.y, scale.z));
    list.push(g.applyMatrix4(tmpM));
  };
  /** 水平な輪（TorusGeometry の弧は、寝かせた後 +X から +Z の向きへ回る。角度 a の点は (cos a, 0, sin a)） */
  const ring = (list: THREE.BufferGeometry[], y: number, r: number, tube: number, arc = Math.PI * 2, startAngle = 0) => {
    tmpE.set(Math.PI / 2, 0, startAngle);
    put(list, new THREE.TorusGeometry(r, tube, 10, 192, arc), { x: 0, y, z: 0 }, tmpQ.setFromEuler(tmpE));
  };
  // 縁: 殻の内側に沿う輪（最も目に入る、動かない基準）と、すぐ下の細い2本目（枠に厚みを見せる）
  ring(brassParts, RIM_Y, ringRadius(RIM_Y) - 0.012, TUBE * 1.35);
  ring(darkParts, RIM_Y - 0.035, ringRadius(RIM_Y - 0.035) - 0.014, TUBE * 0.7);
  // 手すり: 前と左右（後ろは座席なので開ける）。135° から 270° 回すと、後ろ（+Z、90°）の ±45° が開く
  ring(brassParts, RAIL_Y, RAIL_R, TUBE * 1.6, Math.PI * 1.5, Math.PI * 0.75);
  // 下の輪
  ring(darkParts, -0.62, ringRadius(-0.62) - 0.01, TUBE);
  ring(darkParts, FLOOR_Y - 0.03, ringRadius(FLOOR_Y - 0.03) - 0.008, TUBE * 1.2);
  // 経線のリブ: 縁から底へ、殻の内側に沿う細い弧（明るい真鍮と暗い真鍮を交互に）
  const ribCount = 16;
  for (let i = 0; i < ribCount; i++) {
    // 半分ずらす: 真正面（-Z）にリブを置かない（縦持ちの画面の真ん中に縦線が立って見えるため）
    put(i % 2 === 0 ? brassParts : darkParts, ribGeometry(RIM_Y, FLOOR_Y - 0.03), { x: 0, y: 0, z: 0 }, tmpQ.setFromAxisAngle(UP, ((i + 0.5) / ribCount) * Math.PI * 2));
  }
  // 手すりの支柱（手すりから下の輪へ）。正面のまん中は空ける（前を見る視界に縦の線を入れない）
  const postTop = RAIL_Y;
  const postBottom = -0.62;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * 0.75 + ((i + 0.5) / 6) * Math.PI * 1.5;
    const rBottom = ringRadius(postBottom) - 0.01;
    const x0 = Math.cos(a) * RAIL_R;
    const z0 = Math.sin(a) * RAIL_R;
    const x1 = Math.cos(a) * rBottom;
    const z1 = Math.sin(a) * rBottom;
    const len = Math.hypot(x1 - x0, postBottom - postTop, z1 - z0);
    tmpQ.setFromUnitVectors(UP, new THREE.Vector3(x0 - x1, postTop - postBottom, z0 - z1).normalize());
    put(darkParts, new THREE.CylinderGeometry(TUBE * 0.9, TUBE * 0.9, 1, 8, 1), { x: (x0 + x1) / 2, y: (postTop + postBottom) / 2, z: (z0 + z1) / 2 }, tmpQ, { x: 1, y: len, z: 1 });
  }
  // 座席の真鍮の脚と、背もたれの縁
  const cushionY = CAMERA.seatEyeHeight - 0.72;
  for (const [x, z] of [
    [-0.4, 0.0],
    [0.4, 0.0],
    [-0.4, 0.4],
    [0.4, 0.4],
  ] as const) {
    const top = cushionY - 0.05;
    put(darkParts, new THREE.CylinderGeometry(TUBE, TUBE, 1, 8, 1), { x, y: (top + FLOOR_Y) / 2, z }, tmpQ.identity(), { x: 1, y: top - FLOOR_Y, z: 1 });
  }
  tmpE.set(Math.PI / 2, 0, Math.PI / 2 - Math.PI * 0.31);
  put(brassParts, new THREE.TorusGeometry(0.62, TUBE * 1.2, 8, 96, Math.PI * 0.62), { x: 0, y: -0.12, z: 0 }, tmpQ.setFromEuler(tmpE));
  const brassFrame = new THREE.Mesh(keep(merge(brassParts)), brass);
  brassFrame.name = 'gondola.brass';
  // 縁と手すり（明るい真鍮）。目より下にあり、視界の下側に動かない基準として常に見える
  brassFrame.userData.role = 'rim';
  root.add(brassFrame);
  const darkFrame = new THREE.Mesh(keep(merge(darkParts)), darkBrass);
  darkFrame.name = 'gondola.dark_brass';
  root.add(darkFrame);

  // ── 床と座席（曇りガラス。深さを書く） ──
  // 床は暗めの曇り（下を向いたときに白く光る円盤にしない）
  const frosted = createGlass('frosted', { color: 0x3a4250, opacity: 0.32, roughness: 0.55 });
  const frostedMat = frosted.material;
  frostedMat.depthWrite = true;
  const floor = new THREE.Mesh(keep(floorGeometry()), frostedMat);
  floor.name = 'gondola.floor';
  floor.position.y = FLOOR_Y;
  root.add(floor);

  // 座面と背もたれは同じ曇りガラスなので1つの形に（目の高さ +0.15 の約 0.72m 下、少し後ろ）
  const seatGlass = createGlass('frosted', { color: 0x6c7684, opacity: 0.45, roughness: 0.5 });
  seatGlass.material.depthWrite = true;
  const cushionGeo = new RoundedBoxGeometry(0.92, 0.1, 0.5, 4, 0.045).translate(0, cushionY, 0.2);
  const seatMesh = new THREE.Mesh(keep(merge([cushionGeo, backrestGeometry()])), seatGlass.material);
  seatMesh.name = 'gondola.seat_glass';
  root.add(seatMesh);

  // 座席の目
  const seat = new THREE.Object3D();
  seat.name = 'seat';
  seat.position.y = CAMERA.seatEyeHeight;
  root.add(seat);

  let closedNow = 0;
  return {
    root,
    seat,
    setShell(closed) {
      const c = Number.isFinite(closed) ? Math.min(1, Math.max(0, closed)) : 0;
      closedNow = c;
      // 下から上へ: 切る高さを底（-R）から頂（+R）へ。端の 1cm は余らせて、閉じきったら穴を残さない
      const cut = -R - 0.01 + (2 * R + 0.03) * c;
      uCut.value = cut;
      shell.visible = c > 0.001;
      seam.visible = c > 0.001 && c < 0.999;
    },
    update(t) {
      shellGlass.setTime(t);
      // 切り口の帯は、閉じる途中だけ少し明るく流れる
      seamGlass.setTime(t * 1.6 + closedNow * 3);
      frosted.setTime(t);
      seatGlass.setTime(t);
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      shellGlass.dispose();
      seamGlass.dispose();
      frosted.dispose();
      seatGlass.dispose();
    },
  };
}

/** 経線のリブ: 殻の内側（半径 R - 1.4cm）に沿って、高さ y0 から y1 へ下る弧（x>0 側の1本） */
function ribGeometry(y0: number, y1: number): THREE.TubeGeometry {
  const rr = R - 0.014;
  const a0 = Math.asin(Math.max(-1, Math.min(1, y0 / rr)));
  const a1 = Math.asin(Math.max(-1, Math.min(1, y1 / rr)));
  const pts: THREE.Vector3[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push(new THREE.Vector3(Math.cos(a) * rr, Math.sin(a) * rr, 0));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, TUBE * 0.85, 8, false);
}

/** 床: 縁が少し上がった浅い皿（曇りガラス）。厚み 2cm */
function floorGeometry(): THREE.LatheGeometry {
  const rMax = ringRadius(FLOOR_Y) - 0.02;
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -0.02)];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const r = (rMax * i) / n;
    // 外へ行くほど殻に沿って少し上がる
    pts.push(new THREE.Vector2(r, Math.pow(i / n, 3) * 0.04));
  }
  pts.push(new THREE.Vector2(rMax, 0.02));
  pts.push(new THREE.Vector2(rMax * 0.98, -0.02));
  pts.reverse();
  return new THREE.LatheGeometry(pts, 72);
}

/** 背もたれ: 座席の後ろを囲む、曇りガラスの湾曲した板（目より下） */
function backrestGeometry(): THREE.BufferGeometry {
  // 中心は後ろ。角度 ±56°、半径 0.62、高さは座面から目の 0.27m 下まで
  const radius = 0.62;
  const y0 = CAMERA.seatEyeHeight - 0.68;
  const y1 = -0.12;
  // CylinderGeometry の角度 θ の点は (sin θ, cos θ)。θ=0 が後ろ（+Z）
  const g = new THREE.CylinderGeometry(radius, radius * 0.97, y1 - y0, 64, 6, true, -Math.PI * 0.31, Math.PI * 0.62);
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}
