// 画面効果の合成（TSL）。場面の描画（pass）を1回の全画面の合成で仕上げる。
//
//   場面 ─ pass ─┬─ 膜の放射状の歪み → 万華鏡の折り返し（2つの像を混ぜる）→ 色収差（1〜3回の読み出し）
//        └ 深さ ─┤   （折り返しはゴンドラより遠い所だけ）
//                └─ ブルーム（高輝度だけを縮小して拡大。ゼロの間は計算しない）→ 足す
//   → トーンマップと色空間（renderOutput）→ 膜の虹色の縞 → 泡越しの縁 → 白い霧 → 暗さ
//
// 縞・縁・霧・暗さは表示の色（トーンマップ後）で重ねる。HDR の明るさに左右されず、白い霧が真っ白になり、
// 暗さが本当の黒になる（黒い画面は天球の暗転でしか使わない）。万華鏡は鏡の多重反射を計算せず、
// 画面の中心から極座標で6分割に折り返して読み直すだけ（設計書「描画の工夫」）。
//
// 万華鏡で回るのは周りの模様であり、ゴンドラは回らない（設計書「万華鏡の間」）。視界の下側のゴンドラの縁と手すりは
// いつも見えていて動かない基準なので、場面の深さを読んで、ゴンドラの範囲より手前の画素は折り返さず、
// 折り返した先の画素がゴンドラなら混ぜない（ゴンドラが模様の中に増えない）。
//
// 座標の向き: three の QuadMesh の uv() は上端が y=0。ここでは up = 1 - uv.y（上端が 1）を作り、
// 画面の上下に関わる決まり（殻が下から閉じる、窓の映り込み、膜の厚みの傾き）はすべて up で書く。
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { CAMERA, GONDOLA_DIAMETER } from '../config';
import { EDGE_MAX } from './resolve';

// TSL の型定義は演算ごとに型が細かく分かれて扱いにくいので、このファイルの中だけ緩い形に読み替える。
type Arg = N | number;
interface N {
  add(...v: Arg[]): N;
  sub(...v: Arg[]): N;
  mul(...v: Arg[]): N;
  div(...v: Arg[]): N;
  negate(): N;
  greaterThan(v: Arg): N;
  toVar(): N;
  assign(v: Arg): N;
  sample(uv: Arg): N;
  readonly x: N;
  readonly y: N;
  readonly r: N;
  readonly g: N;
  readonly b: N;
  readonly rgb: N;
}
interface Branch {
  Else(body: () => void): void;
}
export interface U extends N {
  value: number;
}
const { Fn, If, abs, atan, clamp, cos, dot, float, length, max, min, mix, mod, perspectiveDepthToViewZ, pow, renderOutput, sin, smoothstep, sqrt, uniform, uv, vec2, vec3, vec4 } =
  TSL as unknown as {
    Fn: (body: () => N) => () => N;
    If: (cond: N, body: () => void) => Branch;
    abs: (a: Arg) => N;
    atan: (y: Arg, x: Arg) => N;
    clamp: (a: Arg, lo: Arg, hi: Arg) => N;
    cos: (a: Arg) => N;
    dot: (a: Arg, b: Arg) => N;
    float: (a: Arg) => N;
    length: (a: Arg) => N;
    max: (a: Arg, b: Arg) => N;
    min: (a: Arg, b: Arg) => N;
    mix: (a: Arg, b: Arg, t: Arg) => N;
    mod: (a: Arg, b: Arg) => N;
    perspectiveDepthToViewZ: (depth: Arg, near: Arg, far: Arg) => N;
    pow: (a: Arg, b: Arg) => N;
    renderOutput: (c: Arg) => N;
    sin: (a: Arg) => N;
    smoothstep: (lo: Arg, hi: Arg, x: Arg) => N;
    sqrt: (a: Arg) => N;
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
/**
 * 折り返しで読む楔の中心の向き（ラジアン、右が 0、上が +）。右向きから少し上へ振って、画面の下側（ゴンドラの縁と手すり）を
 * 読まないようにする。楔が縁を読むと、その分だけ折り返しの像に穴があく。
 */
const FOLD_WEDGE_CENTER = (20 * Math.PI) / 180;
/** これ未満の強さは 0 とみなして、その効果の読み出しや計算を省く */
/** 効果の強さがこれ未満なら0とみなして読み出しを省く（ブルームの計算を省く境と同じ値を使う） */
export const FX_EPS = 0.002;
/** 白い霧の色（合成と、後処理なしの板で同じ色にする） */
export const WHITE_FOG_RGB = [1, 0.99, 0.97] as const;

/**
 * 万華鏡の折り返しの対象にしない距離（m、視点から画素までの距離）。
 * ゴンドラは直径 2.4m の泡で、視点は座席（泡の中心のすぐ上）にある。縁・手すり・座席はすべて泡の半径の内側（≒1.2〜1.4m）に
 * あるので、半径より少し先までを「ゴンドラ」とみなして折り返さず、その先から部屋として折り返す。
 */
// 目の高さ（座席は泡の中心より上）の分だけ泡の底が遠いので、それも足す。部屋の物は視点から約2m より遠くに置く
export const FOLD_NEAR = GONDOLA_DIAMETER / 2 + CAMERA.seatEyeHeight + 0.05;
export const FOLD_FAR = FOLD_NEAR + 0.6;

/** 毎フレーム更新する値（resolveFx の結果と、カメラの値） */
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
  /** カメラの near / far と、縦の視野の半分の tan（深さから視点までの距離を出す） */
  readonly near: U;
  readonly far: U;
  readonly tanHalfFov: U;
  /** 描画先の1画素の高さ（uv）。深さを周りの1画素ぶんまで見るのに使う */
  readonly texel: U;
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

export interface CompositeOptions {
  /** ブルームの解像度（画面に対する倍率）。スマートフォンでは 0.25 に落とす。既定は 0.5 */
  readonly bloomResolution?: number;
}

export function createComposite(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, options: CompositeOptions = {}): Composite {
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
    near: uniform(0.05),
    far: uniform(2000),
    tanHalfFov: uniform(0.6),
    texel: uniform(1 / 720),
  };

  const scenePass = TSL.pass(scene, camera);
  const sceneTex = scenePass.getTextureNode('output') as unknown as N;
  const depthTex = scenePass.getTextureNode('depth') as unknown as N;

  // 見どころの光（HDR で 1 を超えるもの）だけを拾う。しきい値を高めにして、普段の明るい面はにじませない
  const bloomNode = new GatedBloomNode(sceneTex as never, 1, 0.6, 0.85);
  bloomNode.smoothWidth.value = 0.35;
  bloomNode.setResolutionScale(options.bloomResolution ?? 0.5);
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
    const uvN = uv(); // 上端が 0
    const up = float(1).sub(uvN.y); // 上端が 1
    const aspV = vec2(u.aspect, 1);

    // 画面の中心を原点にした、縦を 1 とする座標（y は上向き）。q は縦横とも -1〜1
    const q = vec2(uvN.x.mul(2).sub(1), up.mul(2).sub(1));
    const p0 = q.mul(aspV).mul(0.5).toVar();
    const r0 = length(p0).toVar();
    /** 縦を 1 とする座標 → テクスチャの uv（上端が 0） */
    const toUv = (p: N): N => vec2(p.x.div(u.aspect).add(0.5), float(0.5).sub(p.y));

    // ── 泡越しの縁（画面の縁だけ。中央は 0）。edge は縁の強さそのもの（0〜EDGE_MAX）──
    const qa = pow(abs(q), vec2(3.0));
    const e = pow(qa.x.add(qa.y), float(1 / 3)).toVar(); // 角の丸い四角の距離。辺で 1、角で約 1.26
    const rimW = smoothstep(0.72, 1.2, e).toVar();
    // 殻が下から上へ閉じていく（閉じ具合 0 → 1 の間は、下の縁（up=0）から先に現れる）
    const closeProgress = u.edge.div(EDGE_MAX);
    const closing = clamp(closeProgress.mul(1.7).sub(up.mul(0.7)), 0, 1);
    const edgeShape = pow(rimW, 1.3).mul(closing).toVar();

    // ── 膜の通過: 放射状の歪み（膜が手前へふくらむ。外側ほど大きく見える＋外へ走るさざ波）と泡の縁のわずかな屈折 ──
    // どちらも画面の内側を読む向きにして、画面の外（折り返しの読み）に出さない
    const wave = sin(r0.mul(13).sub(u.distortion.mul(9))).mul(0.02);
    const bulge = r0.mul(r0).mul(0.2);
    const lens = float(1).sub(u.distortion.mul(bulge.add(wave))).sub(edgeShape.mul(u.edge).mul(0.14));
    const pD = p0.mul(lens).toVar();

    // 色収差: 中心から放射の向きに R と B をずらす（膜を通る瞬間だけ。0 の間は1回の読み出し）
    const radial = vec2(p0.x.div(u.aspect), p0.y.negate()).div(max(r0, 1e-4)); // uv の向き（y は下向き）
    const off = radial.mul(u.aberration.mul(0.008).mul(r0.add(0.3))).toVar();
    const tap = (p: N): N => {
      const base = toUv(p).toVar();
      const out = vec3(0).toVar();
      If(u.aberration.greaterThan(FX_EPS), () => {
        out.assign(vec3(sceneTex.sample(mirror(base.add(off))).r, sceneTex.sample(mirror(base)).g, sceneTex.sample(mirror(base.sub(off))).b));
      }).Else(() => {
        out.assign(sceneTex.sample(mirror(base)).rgb);
      });
      return out;
    };
    const uvA = toUv(pD).toVar();
    const hdr = tap(pD).toVar();

    // ── 万華鏡の折り返し: 角度を 60 度ごとに交互に鏡映して、1つの楔（FOLD_WEDGE_CENTER の向き）だけを読む ──
    // 入りと出は外周から（中心は最後に現れ、最初に消える）。2つの像が全面で重なる時間を作らない。
    // ゴンドラ（近い画素）は、折り返さず、折り返した先に取り込まない。
    const foldW = float(0).toVar();
    const uvF = vec2(0, 0).toVar();
    If(u.fold.greaterThan(FX_EPS), () => {
      const seg = TAU / FOLD_SEGMENTS;
      const ang = atan(pD.y, pD.x).sub(u.foldAngle);
      const folded = abs(mod(ang, seg * 2).sub(seg)).sub(seg * 0.5).add(FOLD_WEDGE_CENTER); // 楔の中心 ±30度
      const pF = vec2(cos(folded), sin(folded)).mul(length(pD).mul(0.9));
      uvF.assign(toUv(pF));

      const rn = r0.div(length(aspV).mul(0.5)); // 中心 0、四隅 1
      const reveal = smoothstep(0, 0.15, u.fold.sub(float(1).sub(rn).mul(0.7)));
      // 視点からの距離（深さは視線方向の奥行きなので、視線の傾きで割り戻す）。
      // 縁の細い物は、色は半透明に混ざっていても深さは0か1なので、周りの1画素ぶんも含めて近い方を取る
      const distAt = (t: N): N => {
        const m = mirror(t);
        const viewZ = perspectiveDepthToViewZ(depthTex.sample(m).r, u.near, u.far);
        const nx = m.x.mul(2).sub(1).mul(u.tanHalfFov).mul(u.aspect);
        const ny = float(1).sub(m.y.mul(2)).mul(u.tanHalfFov);
        return viewZ.negate().mul(sqrt(nx.mul(nx).add(ny.mul(ny)).add(1)));
      };
      const nearest = (t: N): N => {
        const dy = u.texel.mul(1.25);
        const dx = dy.div(u.aspect);
        return min(
          min(distAt(t), distAt(t.add(vec2(dx, 0)))),
          min(min(distAt(t.sub(vec2(dx, 0))), distAt(t.add(vec2(0, dy)))), distAt(t.sub(vec2(0, dy)))),
        );
      };
      const gate = smoothstep(FOLD_NEAR, FOLD_FAR, nearest(uvA)).mul(smoothstep(FOLD_NEAR, FOLD_FAR, nearest(uvF)));
      foldW.assign(reveal.mul(gate));
      If(foldW.greaterThan(0.001), () => {
        hdr.assign(mix(hdr, tap(pF), foldW));
      });
    });

    // ── ブルーム（折り返しと歪みの後の座標で読む。ゼロなら足さない）──
    If(u.bloom.greaterThan(FX_EPS), () => {
      const glow = bloomTex.sample(mirror(uvA)).rgb.toVar();
      If(foldW.greaterThan(0.001), () => {
        glow.assign(mix(glow, bloomTex.sample(mirror(uvF)).rgb, foldW));
      });
      hdr.assign(hdr.add(glow.mul(u.bloom.mul(0.9))));
    });

    // ── トーンマップと色空間（ここから先は表示の色）──
    let col: N = renderOutput(vec4(hdr, 1)).rgb;
    // 泡の内側の映り込みは、周りが暗い部屋では弱い（暗い天球で縁だけが光らないように）
    const litness = clamp(dot(col, LUMA).mul(4), 0, 1);

    // ── 膜の虹色の縞: 厚みの場（上下の傾き＋中心の膨らみ＋ゆらぎ）を、通過とともに厚くして縞を走らせる ──
    // 膜は下ほど厚い（重力で下がる）ので、厚みは (1 - up) で傾ける
    const thick = u.distortion
      .mul(2.6)
      .add(float(1).sub(up).mul(3.2))
      .add(uvN.x)
      .add(r0.mul(r0).mul(2.2))
      .add(sin(p0.x.mul(6).add(p0.y.mul(4))).mul(0.2))
      .add(sin(p0.y.mul(13).sub(p0.x.mul(4))).mul(0.08))
      .toVar();
    const filmCol = film(thick);
    // 輝度は保って色味だけを乗せ、うっすら明るい膜の照りを足す（縞が出ても場面は読める）
    const chroma = filmCol.sub(dot(filmCol, LUMA));
    col = col.mul(float(1).add(chroma.mul(u.stripes).mul(0.7))).add(filmCol.mul(u.stripes).mul(0.08));

    // ── 泡越しの縁: 画面の縁にだけ、泡の内側の反射の白と薄膜の虹色（中央は澄んだまま）──
    const ang2 = atan(q.y, q.x); // 画面の上が +y
    // 膜の厚みは縁へ向かって増え、角度でうねる（石けん膜の渦）
    const rimFilm = film(e.mul(1.7).add(sin(ang2.mul(3).add(e.mul(4))).mul(0.18)).add(0.1));
    // 窓の映り込み: 左上と右下に、縁に沿った細い光の弧
    const glint = pow(max(cos(ang2.sub(2.35)), 0), 10)
      .add(pow(max(cos(ang2.add(0.8)), 0), 14).mul(0.5))
      .mul(smoothstep(0.85, 1.08, e));
    const rim = rimFilm.mul(0.85).add(vec3(0.95, 0.98, 1).mul(glint).mul(0.75));
    col = screenBlend(col, rim.mul(edgeShape).mul(litness.mul(0.8).add(0.2)).mul(u.edge.mul(0.8)));

    // ── 白い霧（VR への切り替え）と暗さ（天球の暗転）──
    col = mix(col, vec3(...WHITE_FOG_RGB), u.white);
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
