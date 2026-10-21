// 雨の回廊の材質（TSL）。ガラスは core の createGlass に任せ、ここはガラス以外（水・雨・光）と、
// 焼き込んだ床の濡れた反射、雨粒の簡易な屈折（環境画像を歪めて読む。設計書「描画の工夫」）を作る。
// 時刻は uniform で受け取る（フレームの積み上げで状態を作らない）。流れの時刻 uFlow は雨が止まると止まる。
import * as THREE from 'three/webgpu';
import {
  abs,
  asin,
  atan,
  cameraPosition,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  hash,
  instancedBufferAttribute,
  step,
  length,
  materialColor,
  max,
  mix,
  mod,
  normalWorld,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vertexColor,
} from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
const floatUniform = (v = 0) => uniform(v);
/** float の uniform（値は .value で変える） */
export type FloatUniform = ReturnType<typeof floatUniform>;
export { floatUniform };

/** 部屋の時刻（乗車の秒）と、流れの時刻（雨が止まると止まる） */
export interface RainClock {
  readonly uTime: FloatUniform;
  readonly uFlow: FloatUniform;
}

export function createRainClock(): RainClock {
  return { uTime: floatUniform(0), uFlow: floatUniform(0) };
}

/**
 * 環境画像（Blender の正距円筒のパノラマ。blender/scripts/rooms/rain.py の render_env）の向き → UV。
 * Blender のカメラは前が +Y、three の向き (x, y, z) は Blender の (x, -z, y)。u = 0.5 + atan2(x, -z) / 2π、v は上が 0（flipY = false）。
 */
export function envUv(dir: V3): V2 {
  const u = atan(dir.x, dir.z.negate()).mul(1 / (2 * Math.PI)).add(0.5);
  const v = float(0.5).sub(asin(dir.y.clamp(-1, 1)).mul(1 / Math.PI));
  return vec2(u, v);
}

function viewDir(): V3 {
  return normalize(positionWorld.sub(cameraPosition));
}

/** シュリックのフレネル（水・濡れた石の F0 ≈ 0.02） */
function fresnel(n: V3, i: V3, f0 = 0.02): F {
  const c = dot(n, i.negate()).clamp(0, 1);
  return float(f0).add(float(1 - f0).mul(pow(float(1).sub(c), 5)));
}

/**
 * 焼き込んだ濡れた石の床: 回廊に沿った石の目地（UV は m 単位）、石ごとのわずかな色のむら、水たまりの映り込み。
 * 拡散の光はライトマップ（材質の lightMap）、映り込みは環境画像を emissive で足す。
 */
export function decorateWetFloor(m: THREE.MeshStandardNodeMaterial, env: THREE.Texture, opts: { tile: number; wet: number }): void {
  const p = uv().div(opts.tile);
  const row = floor(p.y);
  const q = vec2(p.x.add(row.mul(0.5)), p.y); // 1列ごとに半分ずらす
  const cell = floor(q);
  const f = fract(q);
  const edge = vec2(abs(f.x.sub(0.5)), abs(f.y.sub(0.5))).mul(2);
  const grout = smoothstep(0.92, 0.985, max(edge.x, edge.y));
  const h = hash(cell.x.mul(17.3).add(cell.y.mul(131.1)));
  const tint = mix(float(0.82), float(1.16), h);
  m.colorNode = materialColor.rgb.mul(tint).mul(float(1).sub(grout.mul(0.45)));
  // 水たまり: 大きなむら（目地に水がたまる）
  const puddle = smoothstep(0.35, 0.75, hash(dot(floor(p.mul(0.37)), vec2(7.1, 3.3))).mul(0.6).add(grout.mul(0.6)));
  m.roughnessNode = mix(float(0.38), float(0.08), puddle);
  const i = viewDir();
  const r = reflect(i, normalWorld);
  const refl = texture(env, envUv(r)).rgb;
  m.emissiveNode = refl.mul(fresnel(normalWorld, i, 0.03)).mul(mix(float(opts.wet * 0.45), float(opts.wet), puddle));
}

/** 水面（水路は回廊に沿って流れ、中庭の池は雨の波紋）。映り込みは環境画像。雨が止まると波紋も止まる */
export function waterMaterial(env: THREE.Texture, clock: RainClock, kind: 'channel' | 'pool'): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const p = uv();
  let slope: V2;
  if (kind === 'channel') {
    // 流れ: レールに沿って（u）ゆるく進む細かな波
    const a = sin(p.x.mul(9).sub(clock.uFlow.mul(2.2)).add(sin(p.y.mul(13)).mul(0.6)));
    const b = sin(p.x.mul(17).add(p.y.mul(6)).sub(clock.uFlow.mul(3.1)));
    slope = vec2(a.mul(0.05).add(b.mul(0.025)), b.mul(0.03));
  } else {
    // 雨の波紋: 0.55m の格子のマスごとに、ずれた周期で輪が広がる（2枚重ねて密にする）
    const ring = (scale: number, offset: number): V2 => {
      const q = p.div(scale).add(offset);
      const cell = floor(q);
      const local = fract(q).sub(vec2(hash(dot(cell, vec2(3.1, 7.7))).mul(0.6).add(0.2), hash(dot(cell, vec2(5.3, 1.9))).mul(0.6).add(0.2)));
      const phase = fract(clock.uFlow.mul(0.9).add(hash(dot(cell, vec2(11.7, 2.3)))));
      const d = length(local);
      const rr = phase.mul(0.42);
      const e = d.sub(rr).div(0.035); // 負になりうる。2乗は掛け算で（pow の底に負を渡さない）
      const w = exp(e.mul(e).negate()).mul(float(1).sub(phase).pow(1.5));
      return normalize(local.add(1e-4)).mul(w.mul(0.22));
    };
    slope = ring(0.55, 0).add(ring(0.71, 0.37));
  }
  const n = normalize(vec3(slope.x, 1, slope.y));
  const i = viewDir();
  const r = reflect(i, n);
  const refl = texture(env, envUv(r)).rgb;
  const deep = vec3(0.012, 0.016, 0.02);
  m.colorNode = deep.add(refl.mul(fresnel(n, i, 0.02).mul(0.95).add(0.04)));
  return m;
}

/**
 * ガラスを伝う水の筋（壁・屋根・庇に重ねる。足し算で光る）。UV は m 単位で、v が増える向きに水が流れる。
 * roof では雨粒がはねる小さな輪も出す（屋根を雨が叩く）。
 */
export function waterFilmMaterial(clock: RainClock, kind: 'wall' | 'roof', strength: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  m.fog = false;
  const p = uv();
  const lanes = 11; // 1m あたりの筋の数
  const col = floor(p.x.mul(lanes));
  const h = hash(col.mul(1.37));
  const present = smoothstep(0.45, 0.6, h);
  const wobble = sin(p.y.mul(3.1).add(h.mul(40))).mul(0.12);
  const x = abs(fract(p.x.mul(lanes)).sub(0.5).sub(wobble));
  const line = smoothstep(0.1, 0.0, x).mul(present);
  // 流れ落ちる雫の頭（筋ごとに速さが違う）。雨が止まると uFlow が止まり、雫も止まる
  const speed = mix(float(0.35), float(1.1), hash(col.mul(7.9)));
  const head = fract(p.y.mul(0.55).sub(clock.uFlow.mul(speed).mul(0.55)).add(h.mul(9.3)));
  const drop = exp(head.mul(-14)).add(exp(float(1).sub(head).mul(-80)).mul(0.6));
  let lum: F = line.mul(float(0.1).add(drop.mul(0.9)));
  if (kind === 'roof') {
    // はねる雨: 0.24m の格子のマスごとに、ずれた時刻で小さな輪（半径 4cm まで）が光る。光るマスは 3 割ほど
    const q = p.div(0.24);
    const cell = floor(q);
    const jitter = vec2(hash(dot(cell, vec2(3.7, 9.1))), hash(dot(cell, vec2(8.3, 2.9)))).sub(0.5).mul(0.5);
    const lp = fract(q).sub(0.5).sub(jitter);
    const cycle = clock.uFlow.mul(1.3).add(hash(dot(cell, vec2(12.9, 78.2))));
    const ph = fract(cycle);
    const live = step(0.68, hash(dot(cell, vec2(5.1, 1.7)).add(floor(cycle).mul(0.37))));
    const e = length(lp).sub(ph.mul(0.17)).div(0.035);
    const ring = exp(e.mul(e).negate()).mul(float(1).sub(ph).pow(2)).mul(live);
    lum = lum.add(ring.mul(0.4));
  }
  m.colorNode = vec3(0.72, 0.8, 0.9).mul(lum).mul(strength);
  return m;
}

/** 焼き込まない暗い遠景（建物の影）。霧に溶ける */
export function cityMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ color: 0x1e252e });
  // 下ほど暗く（雨の街の足もと）
  m.colorNode = vec3(0.012, 0.016, 0.022).add(vec3(0.02, 0.025, 0.032).mul(smoothstep(0, 18, positionWorld.y)));
  return m;
}

/** 街の灯り: 水の膜越しににじむ丸い光（頂点の色、UV 0〜1 の板）。遠いほど雨の霞で弱く */
export function cityLightsMaterial(intensity: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.fog = false;
  const d = length(uv().sub(0.5)).mul(2);
  const disc = pow(smoothstep(1, 0, d), 1.6).add(smoothstep(1, 0.75, d).mul(0.15));
  const dist = length(positionWorld.sub(cameraPosition));
  const haze = exp(dist.mul(-1 / 55));
  m.colorNode = vertexColor().rgb.mul(disc).mul(haze).mul(intensity);
  return m;
}

/** 発光の材質（柱の雫の灯り、扉の奥の光）。強さは uniform で変える */
export function glowMaterial(color: THREE.ColorRepresentation, intensity: FloatUniform | number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const c = new THREE.Color(color);
  m.colorNode = vec3(c.r, c.g, c.b).mul(intensity);
  return m;
}

/** 床に落ちる扉の光（足し算の楕円のにじみ。PlaneGeometry(1, 1) の局所座標で。大きさは物の scale で） */
export function lightPoolMaterial(color: THREE.ColorRepresentation, intensity: FloatUniform): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.fog = false;
  const c = new THREE.Color(color);
  const q = positionGeometry.xy.mul(2);
  const d = length(vec2(q.x, q.y.mul(0.8)));
  m.colorNode = vec3(c.r, c.g, c.b).mul(pow(smoothstep(1, 0, d), 2)).mul(intensity);
  return m;
}

// ── 雨 ──────────────────────────────────────────────────────────────

export interface RainAttributes {
  /** 止まる位置 xyz と種（0〜1） */
  readonly drop: THREE.InstancedBufferAttribute;
  /** 止まる時刻（乗車の秒） */
  readonly freeze: THREE.InstancedBufferAttribute;
  /** 落ちる下の端の高さ（床、または庇の上） */
  readonly floor: THREE.InstancedBufferAttribute;
}

export interface FallSpec {
  /** 落ちる速さ（m/s） */
  readonly speed: number;
  /** 床の高さ（雨粒ごとの下の端がないときの既定）と、上の端（雨はこの間を繰り返し落ちる） */
  readonly floorY: number;
  readonly topY: number;
  /** 止まる直前に減速する時間（秒） */
  readonly ease: number;
}

/**
 * 時刻 t の雨粒の高さ（止まる位置 restY、止まる時刻 tf）。止まった後は restY。
 * 止まる前は floorY〜topY を落ち続け、tf にちょうど restY に着く（減速して止まる）。TS 側の確かめ用に同じ式を持つ。
 */
export function dropY(restY: number, tf: number, t: number, spec: FallSpec): number {
  const x = Math.max(0, tf - t);
  const dist = spec.speed * (x - spec.ease * (1 - Math.exp(-x / spec.ease)));
  const h = spec.topY - spec.floorY;
  return spec.floorY + ((((restY - spec.floorY + dist) % h) + h) % h);
}

function fallCenter(attr: RainAttributes, clock: RainClock, spec: FallSpec): { center: V3; tf: F; seed: F } {
  const d = instancedBufferAttribute<'vec4'>(attr.drop, 'vec4');
  const tf = instancedBufferAttribute<'float'>(attr.freeze, 'float');
  const floorY = instancedBufferAttribute<'float'>(attr.floor, 'float');
  const x = max(tf.sub(clock.uTime), 0);
  const dist = x.sub(float(spec.ease).mul(float(1).sub(exp(x.div(-spec.ease))))).mul(spec.speed);
  const y = mod(d.y.sub(floorY).add(dist), float(spec.topY).sub(floorY)).add(floorY);
  return { center: vec3(d.x, y, d.z), tf, seed: d.w };
}

/** 落ちる雨の筋（カメラへ向く細い板。足し算でかすかに光る）。止まる時刻に縮んで消え、ガラス玉に替わる */
export function rainStreakMaterial(attr: RainAttributes, clock: RainClock, spec: FallSpec, length_: number, width: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.fog = false;
  const { center, tf, seed } = fallCenter(attr, clock, spec);
  const k = float(1).sub(smoothstep(tf.sub(0.22), tf.add(0.02), clock.uTime));
  const toCam = cameraPosition.sub(center);
  const side = normalize(vec3(toCam.z, 0, toCam.x.negate()).add(vec3(1e-5, 0, 0)));
  const q = positionGeometry; // PlaneGeometry(1, 1): -0.5〜0.5
  const len = float(length_).mul(mix(float(0.7), float(1.2), seed)).mul(k);
  m.positionNode = center.add(side.mul(q.x.mul(width))).add(vec3(0, q.y.add(0.5).mul(len), 0));
  // 頭（下）ほど明るい。遠いほど弱い。止まると消える
  const along = q.y.add(0.5);
  const dist = length(toCam);
  const fade = exp(dist.mul(-1 / 26)).mul(k).mul(smoothstep(0.3, 2.5, dist));
  m.colorNode = vec3(0.62, 0.68, 0.76).mul(float(1).sub(along).pow(0.7)).mul(fade).mul(0.55);
  return m;
}

/**
 * 止まった雨粒（ガラス玉）の材質を core のガラスに重ねる: 止まる時刻に現れ（scale）、中に環境画像を逆さに映す（球のレンズの簡易な屈折）。
 * instanced: InstancedMesh の雨粒（止まる時刻は属性）。個別の雨粒（触れられる物）は scaleNode を省き、CPU で大きさを動かす。
 */
export function decorateDropGlass(material: THREE.Material, env: THREE.Texture, opts: { attr?: RainAttributes; clock?: RainClock; strength: number }): void {
  const m = material as THREE.MeshStandardNodeMaterial;
  if (opts.attr && opts.clock) {
    const d = instancedBufferAttribute<'vec4'>(opts.attr.drop, 'vec4');
    const tf = instancedBufferAttribute<'float'>(opts.attr.freeze, 'float');
    const grow = smoothstep(tf.sub(0.06), tf.add(0.28), opts.clock.uTime);
    // 一瞬だけ少し大きくなってから落ち着く（雨粒がガラス玉に「変わる」）
    const pop = float(1).add(sin(smoothstep(tf, tf.add(0.5), opts.clock.uTime).mul(Math.PI)).mul(0.18));
    m.positionNode = d.xyz.add(positionLocal.sub(d.xyz).mul(grow.mul(pop)));
  }
  // 球のレンズ: 視線に垂直な法線の成分の分だけ逆へ曲げる（縁ほど強く曲がり、像は上下左右が逆になる）
  const i = viewDir();
  const n = normalWorld;
  const perp = n.sub(i.mul(dot(n, i)));
  const out = normalize(i.sub(perp.mul(1.15)));
  const img = texture(env, envUv(out)).rgb;
  const centerW = dot(n, i.negate()).clamp(0, 1);
  const prev = m.emissiveNode as V3 | null;
  const add = img.mul(smoothstep(0.05, 0.6, centerW)).mul(opts.strength);
  m.emissiveNode = prev ? prev.add(add) : add;
  // 中心ほど向こうを隠す（屈折した像が向こうの景色の代わりになる）
  const prevA = m.opacityNode as F | null;
  const a = smoothstep(0.1, 0.7, centerW).mul(0.72);
  m.opacityNode = prevA ? max(prevA, a) : a;
}

/** 触れた雨粒が残す虹色の輪（足し算の光。ガラスではない）。uFade は 0〜1 */
export function rainbowRingMaterial(uFade: FloatUniform): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  m.fog = false;
  // 輪の角度で色相を回す（TorusGeometry の局所座標）
  const a = atan(positionGeometry.y, positionGeometry.x);
  const hue = vec3(0, 0.33, 0.67).add(a.mul(1 / (2 * Math.PI)));
  const rainbow = vec3(0.5).add(vec3(0.5).mul(cos(hue.mul(Math.PI * 2))));
  m.colorNode = mix(vec3(0.85), rainbow, 0.85).mul(uFade).mul(2.2);
  return m;
}

/**
 * 金属（core の createBrass）に環境画像の映り込みを足す。金属は映り込みで見える物なので、環境画像を使わない場面では
 * 黒く沈む（core の擬似反射は控えめ）。tint は映り込みの色を部屋の光に寄せる倍率（例: 金の万華鏡）。
 */
export function decorateMetal(material: THREE.Material, env: THREE.Texture, opts: { strength: number; tint?: THREE.Node<'vec3'> | THREE.Node<'color'> }): void {
  const m = material as THREE.MeshStandardNodeMaterial;
  const i = viewDir();
  const r = reflect(i, normalWorld);
  let add: V3 = texture(env, envUv(r)).rgb.mul(materialColor.rgb).mul(opts.strength);
  if (opts.tint) add = add.mul(vec3(opts.tint as THREE.Node<'vec3'>));
  const prev = m.emissiveNode as V3 | null;
  m.emissiveNode = prev ? prev.add(add) : add;
}

/** 環境画像の映り込み（鏡・磨いた板）。焼き込んだ拡散の光に足す。縁ほど強く（フレネル）、tint で部屋の光の色に寄せる */
export function decorateMirror(material: THREE.Material, env: THREE.Texture, opts: { strength: number; f0: number; tint?: THREE.Node<'vec3'> | THREE.Node<'color'> }): void {
  const m = material as THREE.MeshStandardNodeMaterial;
  const i = viewDir();
  const r = reflect(i, normalWorld);
  let add: V3 = texture(env, envUv(r)).rgb.mul(fresnel(normalWorld, i, opts.f0)).mul(opts.strength);
  if (opts.tint) add = add.mul(vec3(opts.tint as THREE.Node<'vec3'>));
  const prev = m.emissiveNode as V3 | null;
  m.emissiveNode = prev ? prev.add(add) : add;
}

/**
 * 灯りのにじみ（カメラへ向く板に、足し算の丸いぼかし）。雨の空気で灯りがにじんで見える。
 * centers は灯りの中心（インスタンスごと）。板の大きさは size（m）。光なので物との距離の検査からは外す。
 */
export function haloMaterial(centers: THREE.InstancedBufferAttribute, size: number, color: THREE.ColorRepresentation, intensity: FloatUniform | number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.fog = false;
  const c = instancedBufferAttribute<'vec3'>(centers, 'vec3');
  const toCam = normalize(cameraPosition.sub(c));
  const side = normalize(vec3(toCam.z, 0, toCam.x.negate()).add(vec3(1e-5, 0, 0)));
  const up = normalize(toCam.cross(side).negate());
  const q = positionGeometry;
  // 少し手前へ出して、灯りの玉の上に重ねる
  m.positionNode = c.add(toCam.mul(0.12)).add(side.mul(q.x.mul(size))).add(up.mul(q.y.mul(size)));
  const d = length(vec2(q.x, q.y)).mul(2);
  const glow = exp(d.mul(d).mul(-5)).add(exp(d.mul(-3.2)).mul(0.25)).mul(smoothstep(1, 0.7, d));
  const col = new THREE.Color(color);
  m.colorNode = vec3(col.r, col.g, col.b).mul(glow).mul(intensity);
  return m;
}
