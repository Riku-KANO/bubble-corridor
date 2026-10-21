// 夜明けの岸の水面: 平面反射を1回だけ描く（設計書「描画の工夫」）。低品質（スマートフォン・VR）では反射の描画を省き、
// 空の色を映り込みの向きから計算する。凪いだうねり、ゴンドラの航跡、触れた所から広がる波紋を法線の揺れで描く。
// 波紋は砂浜まで届き、砂の上では光の模様になる（rippleLightNode を砂の材質でも使う）。
import * as THREE from 'three/webgpu';
import { cameraPosition, cos, exp, float, hash, max, mix, positionWorld, pow, reflector, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { skyColorNode, type SkyUniforms } from './sky';

/** 波紋の数（同時に広がる）。古いものから入れ替える */
export const RIPPLE_SLOTS = 6;
/** 波紋が広がる速さ（m/s）と消えるまでの秒 */
export const RIPPLE_SPEED = 2.6;
export const RIPPLE_LIFE = 9;

export interface Ripples {
  /** xy = 触れた点（世界の xz）、z = 触れた時刻、w = 強さ */
  readonly slots: readonly THREE.UniformNode<'vec4', THREE.Vector4>[];
  add(x: number, z: number, t: number): void;
}

export function createRipples(): Ripples {
  const slots = Array.from({ length: RIPPLE_SLOTS }, () => uniform(new THREE.Vector4(0, 0, -1e4, 0)));
  let next = 0;
  return {
    slots,
    add(x, z, t) {
      // 空いている（消えた）枠を先に使い、なければ一番古いもの
      let k = -1;
      for (let i = 0; i < slots.length; i++) if (t - (slots[i].value as THREE.Vector4).z > RIPPLE_LIFE || (slots[i].value as THREE.Vector4).z > t) k = i;
      if (k < 0) k = next++ % slots.length;
      (slots[k].value as THREE.Vector4).set(x, z, t, 1);
    },
  };
}

/** 波紋の輪の位置での波（高さの傾きの大きさ）と光（輪の明るさ）。p は世界の xz */
function rippleTerms(p: THREE.Node<'vec2'>, time: THREE.Node<'float'>, ripples: Ripples): { grad: THREE.Node<'vec2'>; light: THREE.Node<'float'> } {
  let grad: THREE.Node<'vec2'> = vec2(0, 0);
  let light: THREE.Node<'float'> = float(0);
  for (const s of ripples.slots) {
    const d = p.sub(s.xy);
    const dist = d.length().max(1e-3);
    const age = time.sub(s.z);
    const live = smoothstep(0, 0.05, age).mul(float(1).sub(smoothstep(RIPPLE_LIFE * 0.5, RIPPLE_LIFE, age)));
    const front = age.max(0).mul(RIPPLE_SPEED);
    const w = float(0.35).add(age.max(0).mul(0.12));
    const q = dist.sub(front).div(w);
    const env = exp(q.mul(q).negate()).mul(live).mul(s.w);
    // 輪の前後に 2〜3 本の細い波が続く
    const x = dist.sub(front).div(w.mul(2.5));
    const train = exp(x.mul(x).negate());
    const wave = cos(dist.sub(front).mul(7)).mul(train).mul(live).mul(s.w).mul(float(1).div(age.max(0).mul(0.25).add(1)));
    grad = grad.add(d.div(dist).mul(wave.mul(0.12)));
    light = light.add(env.mul(float(1).div(age.max(0).mul(0.2).add(1))));
  }
  return { grad, light };
}

/** 砂浜でも使う、波紋の光の模様（世界の位置の xz） */
export function rippleLightNode(time: THREE.Node<'float'>, ripples: Ripples): THREE.Node<'float'> {
  return rippleTerms(positionWorld.xz, time, ripples).light;
}

export interface WaterOptions {
  readonly reflect: boolean;
  readonly sky: SkyUniforms;
  readonly ripples: Ripples;
  /** 水を描かない円（天球の外殻が水面を切る円、乗り場のホール）。xz 中心と半径 */
  readonly holes: readonly { x: number; z: number; r: number }[];
}

export interface Water {
  readonly material: THREE.MeshBasicNodeMaterial;
  /** 平面反射の基準（部屋に足す）。反射しないときは null */
  readonly reflectorTarget: THREE.Object3D | null;
  readonly time: THREE.UniformNode<'float', number>;
  readonly body: THREE.UniformNode<'color', THREE.Color>;
  /** ゴンドラの位置（xz）と速さ（航跡） */
  readonly boat: THREE.UniformNode<'vec3', THREE.Vector3>;
  readonly boatDir: THREE.UniformNode<'vec2', THREE.Vector2>;
  readonly highlight: THREE.UniformNode<'float', number>;
  /** 穴を空けるか（1 で空ける、0 で水を張る）。天球の中を抜けた後は水を張る */
  readonly holeOpen: THREE.UniformNode<'float', number>;
  dispose(): void;
}

export function createWater(opts: WaterOptions): Water {
  const time = uniform(0);
  const body = uniform(new THREE.Color(0x182042));
  const boat = uniform(new THREE.Vector3(0, 0, 0)); // x, z, 速さ
  const boatDir = uniform(new THREE.Vector2(-1, 0));
  const highlight = uniform(0);
  const holeOpen = uniform(1);
  const p = positionWorld.xz;

  // 凪いだうねり（3 つの向きの細い波。時刻で流れる）
  let grad: THREE.Node<'vec2'> = vec2(0, 0);
  const swells: [number, number, number, number, number][] = [
    // 向き x, z, 波長, 高さ, 速さ
    [0.86, 0.5, 9.0, 0.03, 0.9],
    [0.3, -0.95, 4.7, 0.016, 0.7],
    [-0.6, 0.8, 2.3, 0.008, 0.5],
    [0.95, -0.3, 1.1, 0.003, 0.35],
  ];
  for (const [dx, dz, len, amp, sp] of swells) {
    const k = (Math.PI * 2) / len;
    const ph = p.dot(vec2(dx, dz)).mul(k).sub(time.mul(sp * k));
    grad = grad.add(vec2(dx, dz).mul(cos(ph).mul(amp * k)));
  }

  // 航跡: ゴンドラの後ろに開く V 字（ケルビンの角 19.5°）と、泡の殻が水に触れる輪
  const rel = p.sub(boat.xy);
  const back = rel.dot(boatDir).negate(); // 後ろ向きの距離
  const right = vec2(boatDir.y, boatDir.x.negate());
  const side = rel.dot(right);
  const lat = side.abs();
  const arm = lat.sub(back.mul(0.354)).div(back.mul(0.05).add(0.35));
  const wakeAmp = exp(arm.mul(arm).negate()).mul(exp(back.max(0).mul(-1 / 24))).mul(smoothstep(0, 1.5, back)).mul(boat.z.clamp(0, 1.5));
  const wakeWave = sin(back.mul(3.1).sub(lat.mul(1.2)));
  grad = grad.add(right.mul(side.sign()).mul(wakeWave.mul(wakeAmp).mul(0.09)));
  const hullR = rel.length();
  const hull = exp(hullR.sub(1.18).div(0.16).pow(2).negate());

  // 波紋
  const rip = rippleTerms(p, time, opts.ripples);
  grad = grad.add(rip.grad);

  const n = vec3(grad.x.negate(), 1, grad.y.negate()).normalize();
  const toEye = cameraPosition.sub(positionWorld);
  const dist = toEye.length();
  const view = toEye.div(dist.max(1e-3));
  const ndv = max(n.dot(view), 0);
  const fresnel = float(0.05).add(pow(float(1).sub(ndv), 5).mul(0.95)); // 水の 0.02 より少し強く（足もとも空を映す）

  const material = new THREE.MeshBasicNodeMaterial({ fog: false });
  let reflectorTarget: THREE.Object3D | null = null;
  let reflNode: ReturnType<typeof reflector> | null = null;
  let refl: THREE.Node<'vec3'>;
  if (opts.reflect) {
    const r = reflector({ resolutionScale: 0.5 });
    reflNode = r;
    // 揺れた法線で映り込みをずらす（遠いほど小さく）
    r.uvNode = r.uvNode!.add(n.xz.mul(float(0.8).div(dist.max(3))));
    reflectorTarget = r.target;
    reflectorTarget.rotation.x = -Math.PI / 2;
    refl = r.rgb;
  } else {
    // 映り込む向きの空の色（太陽の円盤も入る）
    const rd = view.negate().reflect(n);
    refl = skyColorNode(vec3(rd.x, rd.y.abs().max(0.002), rd.z), opts.sky, { clouds: false });
  }
  // 朝日のきらめきの道: 細かな波の面（約 0.4m）ごとに向きを揺らし、太陽を目へ返す面だけが光る
  const g = p.mul(7);
  const cell = g.floor();
  const seed = cell.x.add(cell.y.mul(271.7)).add(4e6); // hash は符号なし整数で計算するので正にする
  const tw = opts.sky.time.mul(0.9).add(hash(seed.add(5.1)).mul(6.283));
  const fine = vec3(hash(seed).sub(0.5).add(sin(tw).mul(0.25)), 4.2, hash(seed.add(13.7)).sub(0.5).add(cos(tw.mul(1.3)).mul(0.25))).normalize();
  const nf = n.add(fine).normalize();
  const sunRefl = view.negate().reflect(nf).dot(opts.sky.sunDir).max(0);
  // 近くは面が大きく見えて粒にならないので、少し離れた所から（画面の上で細かな光の粒の道になる）
  const glitter = pow(sunRefl, 1400).mul(opts.sky.sunDisc).mul(0.6).mul(smoothstep(10, 30, dist));
  // 水の体の色: 足もとは深い色、太陽の側は少し明るい
  const deep = body.mul(mix(float(0.7), float(1.15), smoothstep(-0.2, 1, view.negate().xz.normalize().dot(opts.sky.sunDir.xz.normalize()))));
  let col: THREE.Node<'vec3'> = mix(deep, refl, fresnel);
  // 航跡と殻の縁の光（空の色を受けた細い光）
  const glint = mix(opts.sky.horizonAway, opts.sky.horizonSun, 0.6);
  col = col.add(glint.mul(hull.mul(0.12).add(wakeAmp.mul(wakeWave.max(0)).mul(0.05))));
  // 波紋の光（触れた所から広がる金と水色の輪）
  col = col.add(mix(vec3(0.55, 0.85, 1.0), opts.sky.sunColor, 0.5).mul(rip.light.mul(0.16)));
  // 触れられる距離に近づいたとき、泡の周りの水がかすかに明るむ
  col = col.add(glint.mul(highlight.mul(exp(hullR.mul(-0.6))).mul(0.12)));
  col = col.add(opts.sky.sunColor.mul(glitter));
  material.colorNode = col;

  // 穴（天球の中とホールの床）。シェーダで丸く抜く
  let mask: THREE.Node<'bool'> | null = null;
  for (const h of opts.holes) {
    const out = p.sub(vec2(h.x, h.z)).length().greaterThan(holeOpen.mul(h.r));
    mask = mask ? mask.and(out) : out;
  }
  if (mask) material.maskNode = mask;

  return {
    material,
    reflectorTarget,
    time,
    body,
    boat,
    boatDir,
    highlight,
    holeOpen,
    dispose() {
      material.dispose();
      reflNode?.dispose();
    },
  };
}
