// 画面効果の合成（TSL）。場面の描画（pass）を1回の全画面の合成で仕上げる。
//
//   場面 ─ pass ─┬─ 膜の放射状の歪み → 万華鏡の折り返し（2つの像を混ぜる）→ 色収差（3回の読み出し）
//                └─ ブルーム（高輝度だけを縮小して拡大。ゼロの間は計算しない）→ 足す
//   → トーンマップと色空間（renderOutput）→ 膜の虹色の縞 → 泡越しの縁 → 白い霧 → 暗さ
//
// 縞・縁・霧・暗さは表示の色（トーンマップ後）で重ねる。HDR の明るさに左右されず、白い霧が真っ白になり、
// 暗さが本当の黒になる（黒い画面は天球の暗転でしか使わない）。万華鏡は鏡の多重反射を計算せず、
// 画面の中心から極座標で6分割に折り返して読み直すだけ（設計書「描画の工夫」）。
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';

// TSL の型定義は演算ごとに型が細かく分かれて扱いにくいので、このファイルの中だけ緩い形に読み替える。
type Arg = N | number;
interface N {
  add(...v: Arg[]): N;
  sub(...v: Arg[]): N;
  mul(...v: Arg[]): N;
  div(...v: Arg[]): N;
  toVar(): N;
  sample(uv: Arg): N;
  readonly x: N;
  readonly y: N;
  readonly r: N;
  readonly g: N;
  readonly b: N;
  readonly rgb: N;
}
export interface U extends N {
  value: number;
}
const { Fn, abs, atan, clamp, cos, dot, float, length, max, mix, mod, pow, renderOutput, sin, smoothstep, uniform, uv, vec2, vec3, vec4 } = TSL as unknown as {
  Fn: (body: () => N) => () => N;
  abs: (a: Arg) => N;
  atan: (y: Arg, x: Arg) => N;
  clamp: (a: Arg, lo: Arg, hi: Arg) => N;
  cos: (a: Arg) => N;
  dot: (a: Arg, b: Arg) => N;
  float: (a: Arg) => N;
  length: (a: Arg) => N;
  max: (a: Arg, b: Arg) => N;
  mix: (a: Arg, b: Arg, t: Arg) => N;
  mod: (a: Arg, b: Arg) => N;
  pow: (a: Arg, b: Arg) => N;
  renderOutput: (c: Arg) => N;
  sin: (a: Arg) => N;
  smoothstep: (lo: Arg, hi: Arg, x: Arg) => N;
  uniform: (v: number) => U;
  uv: () => N;
  vec2: (...a: Arg[]) => N;
  vec3: (...a: Arg[]) => N;
  vec4: (...a: Arg[]) => N;
};

const TAU = Math.PI * 2;
/** 万華鏡の鏡の数（60度の楔を交互に鏡映して6分割） */
const FOLD_SEGMENTS = 6;
/** 薄膜の虹色の彩度（1 だと原色に近すぎる。石けん膜のような淡さにする） */
const FILM_SATURATION = 0.65;

/** 毎フレーム更新する値（resolveFx の結果をそのまま入れる） */
export interface CompositeUniforms {
  readonly aspect: U;
  readonly edge: U;
  readonly stripes: U;
  readonly distortion: U;
  readonly aberration: U;
  readonly fold: U;
  readonly foldAngle: U;
  readonly bloom: U;
  readonly white: U;
  readonly dark: U;
}

/** ブルームが 0 の間は計算しない（高輝度の抽出と5段のぼかしを丸ごと省く） */
class GatedBloomNode extends BloomNode {
  active = false;

  override updateBefore(frame: THREE.NodeFrame): boolean | undefined {
    // false を返すと、そのフレームでは更新しなかったものとして数えられる
    if (!this.active) return false;
    return super.updateBefore(frame);
  }
}

export interface Composite {
  readonly pipeline: THREE.RenderPipeline;
  readonly scenePass: THREE.PassNode;
  readonly bloom: GatedBloomNode;
  readonly u: CompositeUniforms;
  dispose(): void;
}

export function createComposite(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): Composite {
  const u: CompositeUniforms = {
    aspect: uniform(1),
    edge: uniform(0),
    stripes: uniform(0),
    distortion: uniform(0),
    aberration: uniform(0),
    fold: uniform(0),
    foldAngle: uniform(0),
    bloom: uniform(0),
    white: uniform(0),
    dark: uniform(0),
  };

  const scenePass = TSL.pass(scene, camera);
  const sceneTex = scenePass.getTextureNode('output') as unknown as N;

  // 見どころの光（HDR で 1 を超えるもの）だけを拾う。しきい値を高めにして、普段の明るい面はにじませない
  const bloomNode = new GatedBloomNode(sceneTex as never, 1, 0.6, 0.85);
  bloomNode.smoothWidth.value = 0.35;
  const bloomTex = (bloomNode as unknown as { getTextureNode(): N }).getTextureNode();

  // ── 小さな道具 ──
  /** 範囲の外は折り返して読む（端の引き延ばしを出さない） */
  const mirror = (v: N): N => float(1).sub(abs(float(1).sub(mod(v, 2))));
  const LUMA = vec3(0.2126, 0.7152, 0.0722);
  /** 薄膜干渉の虹色（淡い）。d は膜の厚み（1 で色相が一巡） */
  const film = (d: N): N => {
    const pal = vec3(0.5).add(cos(d.mul(TAU).add(vec3(0, TAU / 3, (TAU * 2) / 3))).mul(0.5));
    const gray = dot(pal, LUMA);
    return gray.add(pal.sub(gray).mul(FILM_SATURATION));
  };
  const screenBlend = (base: N, top: N): N => vec3(1).sub(vec3(1).sub(base).mul(vec3(1).sub(top)));

  const compose = Fn(() => {
    const uvN = uv();
    const aspV = vec2(u.aspect, 1);

    // 画面の中心を原点にした、縦を 1 とする座標（y は上向き）
    const p0 = uvN.sub(0.5).mul(aspV).toVar();
    const r0 = length(p0).toVar();

    // ── 泡越しの縁の重み（画面の縁だけ。中央は 0）──
    const q = uvN.sub(0.5).mul(2);
    const qa = pow(abs(q), vec2(3.0));
    const e = pow(qa.x.add(qa.y), float(1 / 3)).toVar(); // 角の丸い四角の距離。辺で 1、角で約 1.26
    const rimW = smoothstep(0.72, 1.2, e).toVar();
    // 殻が下から上へ閉じていく（edge が 0 → 0.5 の間は下の縁から先に現れる）
    const close = u.edge.mul(2);
    const closing = clamp(close.mul(1.7).sub(uvN.y.mul(0.7)), 0, 1);
    const edgeAmt = pow(rimW, 1.3).mul(closing).toVar();

    // ── 膜の通過: 放射状の歪み（外側ほど強い樽型＋外へ走るさざ波）と泡の縁のわずかな屈折 ──
    const wave = sin(r0.mul(13).sub(u.distortion.mul(9))).mul(0.02);
    const bulge = r0.mul(r0).mul(0.2);
    const lens = float(1).add(u.distortion.mul(bulge.add(wave))).add(edgeAmt.mul(0.07));
    const pD = p0.mul(lens).toVar();

    // ── 万華鏡の折り返し: 角度を 60 度ごとに交互に鏡映して、右向きの楔だけを読む ──
    const seg = TAU / FOLD_SEGMENTS;
    const ang = atan(pD.y, pD.x).sub(u.foldAngle);
    const folded = abs(mod(ang, seg * 2).sub(seg)).sub(seg * 0.5); // -30度〜+30度
    const pF = vec2(cos(folded), sin(folded)).mul(length(pD).mul(0.9));

    // 色収差: 中心から放射の向きに R と B をずらす（膜を通る瞬間だけ）
    const radial = p0.div(max(r0, 1e-4)).div(aspV);
    const off = radial.mul(u.aberration.mul(0.016).mul(r0.add(0.3))).toVar();

    const toUv = (p: N): N => p.div(aspV).add(0.5);
    const tap = (p: N): N => {
      const base = toUv(p).toVar();
      return vec3(
        sceneTex.sample(mirror(base.add(off))).r,
        sceneTex.sample(mirror(base)).g,
        sceneTex.sample(mirror(base.sub(off))).b,
      );
    };
    const uvA = toUv(pD).toVar();
    const uvF = toUv(pF).toVar();
    const colA = tap(pD);
    const colF = tap(pF);
    let hdr: N = mix(colA, colF, u.fold);

    // ── ブルーム（折り返しと歪みの後の座標で読む。ゼロなら足さない）──
    const glowA = bloomTex.sample(mirror(uvA)).rgb;
    const glowF = bloomTex.sample(mirror(uvF)).rgb;
    hdr = hdr.add(mix(glowA, glowF, u.fold).mul(u.bloom.mul(0.9)));

    // ── トーンマップと色空間（ここから先は表示の色）──
    let col: N = renderOutput(vec4(hdr, 1)).rgb;
    // 泡の内側の映り込みは、周りが暗い部屋では弱い（暗い天球で縁だけが光らないように）
    const litness = clamp(dot(col, LUMA).mul(4), 0, 1);

    // ── 膜の虹色の縞: 厚みの場（上下の傾き＋中心の膨らみ＋ゆらぎ）を、通過とともに厚くして縞を走らせる ──
    const thick = u.distortion
      .mul(2.6)
      .add(uvN.y.mul(1.9))
      .add(uvN.x.mul(0.6))
      .add(r0.mul(r0).mul(1.3))
      .add(sin(p0.x.mul(4).add(p0.y.mul(2.5))).mul(0.2))
      .add(sin(p0.y.mul(9).sub(p0.x.mul(3))).mul(0.08))
      .toVar();
    const filmCol = film(thick);
    // 輝度は保って色味だけを乗せ、うっすら明るい膜の照りを足す（縞が出ても場面は読める）
    const chroma = filmCol.sub(dot(filmCol, LUMA));
    const stripeW = u.stripes;
    col = col.mul(float(1).add(chroma.mul(stripeW).mul(1.25))).add(filmCol.mul(stripeW).mul(0.1));

    // ── 泡越しの縁: 画面の縁にだけ、泡の内側の反射の白と薄膜の虹色（中央は澄んだまま）──
    const ang2 = atan(q.y, q.x);
    // 膜の厚みは縁へ向かって増え、角度でうねる（石けん膜の渦）
    const rimFilm = film(e.mul(1.7).add(sin(ang2.mul(3).add(e.mul(4))).mul(0.18)).add(0.1));
    // 窓の映り込み: 左上と右下に、縁に沿った細い光の弧
    const glint = pow(max(cos(ang2.sub(2.35)), 0), 10)
      .add(pow(max(cos(ang2.add(0.8)), 0), 14).mul(0.5))
      .mul(smoothstep(0.85, 1.08, e));
    const rim = rimFilm.mul(0.85).add(vec3(0.95, 0.98, 1).mul(glint).mul(0.75));
    col = screenBlend(col, rim.mul(edgeAmt).mul(litness.mul(0.5).add(0.5)).mul(0.4));

    // ── 白い霧（VR への切り替え）と暗さ（天球の暗転）──
    col = mix(col, vec3(1, 0.99, 0.97), u.white);
    col = col.mul(float(1).sub(u.dark));

    return vec4(col, 1);
  });

  const pipeline = new THREE.RenderPipeline(renderer);
  // 縞・縁・霧・暗さを表示の色で重ねるため、トーンマップは compose の中で行う
  pipeline.outputColorTransform = false;
  pipeline.outputNode = compose() as unknown as THREE.Node;

  return {
    pipeline,
    scenePass,
    bloom: bloomNode,
    u,
    dispose() {
      pipeline.dispose();
      scenePass.dispose();
      bloomNode.dispose();
    },
  };
}
