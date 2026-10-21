import {
  abs,
  color,
  cos,
  dot,
  float,
  fwidth,
  hash,
  max,
  mix,
  mx_noise_float,
  normalView,
  oneMinus,
  output,
  positionLocal,
  positionView,
  positionViewDirection,
  positionWorld,
  pow,
  smoothstep,
  texture,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { QualityPreset } from '../quality';
import { GLASS_DISPERSION, GLASS_IOR, GLASS_SPECS, type GlassKind, type GlassSpec, THIN_FILM } from './kinds';
import { beerLambert, fresnelF0, SHELL_MIN_COS, SOLID_MIN_COS } from './optics';
import { type GlassFeatures, type GlassPlacement, type GlassRole, resolveGlassFeatures } from './policy';

/**
 * Glass materials (MeshPhysicalNodeMaterial + TSL, so WebGPU and WebGL2 share them).
 * 技術設計 > ガラスの描画, アートディレクション > ガラスの種類, 空間の可読性と導線 (1, 2, 8).
 *
 * Lifetime: every factory returns a new material; the caller disposes it.
 */

/**
 * Distance haze for far glass (空間の可読性と導線 > 8 奥ほど霞ませる). Linear like THREE.Fog, so pass the
 * scene's fog colour and distances. DEFAULT_HAZE (仮) is only a fallback.
 */
export interface HazeSpec {
  color: THREE.ColorRepresentation;
  near: number;
  far: number;
}

export const DEFAULT_HAZE: Readonly<HazeSpec> = { color: 0xdfe7ec, near: 15, far: 90 };

export interface GlassOptions {
  placement?: GlassPlacement;
  role?: GlassRole;
  /** Face-on thickness in metres (wall of a shell, depth of a solid). Default: the kind's spec. */
  thickness?: number;
  /**
   * Thickness map of an asset (glTF thickness texture: G channel, scaled by `thickness`). 技術設計 >
   * ガラスの描画: 厚みは厚みマップで場所ごとに変える. When given, it replaces the procedural ムラ below.
   */
  thicknessMap?: THREE.Texture;
  /** Procedural ムラ for shapes without a map: ± fraction of thickness (仮 0.35). 0 turns it off. */
  thicknessVariation?: number;
  /** Size of the procedural thickness ripples, metres (仮 0.45). Match it to the object's size. */
  thicknessScale?: number;
  /** Haze for the cheap far path. */
  haze?: HazeSpec;
  /** Inner glow of milky glass (乳白: 内側から発光). Linear intensity. */
  glow?: { color: THREE.ColorRepresentation; intensity: number };
}

export interface GlassResult {
  material: THREE.MeshPhysicalNodeMaterial | THREE.MeshStandardNodeMaterial;
  features: GlassFeatures;
}

/** Creates the glass material for a kind, picking the render path from placement, role and the preset. */
export function createGlass(
  kind: GlassKind,
  preset: Pick<QualityPreset, 'dispersion' | 'farGlassTransmission'>,
  options: GlassOptions = {},
): GlassResult {
  const features = resolveGlassFeatures(
    kind,
    { placement: options.placement ?? 'near', role: options.role ?? 'scenery' },
    preset,
  );
  const spec = GLASS_SPECS[kind];
  let material: GlassResult['material'];
  if (features.path === 'opaque') material = milkyGlass(spec, options);
  else if (features.path === 'cheap') material = cheapGlass(spec, features, options);
  else material = transmissiveGlass(spec, features, options);
  material.name = `glass:${kind}:${features.path}`;
  return { material, features };
}

/** |cos| of the angle between the surface normal and the view direction (1 = head-on). */
const cosView = () => abs(dot(normalView, positionViewDirection)).clamp(0, 1);

/** 0..1 noise over the object's surface, stable in object space. */
const surfaceNoise = (scale: number) => mx_noise_float(positionLocal.div(scale)).mul(0.5).add(0.5);

function thicknessNode(spec: GlassSpec, options: GlassOptions) {
  const base = float(options.thickness ?? spec.thickness);
  const variation = options.thicknessVariation ?? 0.35;
  let local: THREE.Node<'float'> = base;
  if (options.thicknessMap)
    local = base.mul(texture(options.thicknessMap).g); // the map's own UV channel
  else if (variation > 0) {
    const ripple = surfaceNoise(options.thicknessScale ?? 0.45)
      .sub(0.5)
      .mul(2 * variation);
    local = base.mul(float(1).add(ripple));
  }
  // Same law as optics.viewPathFactor: a shell is crossed edge-on at its silhouette (the green of 断面の縁),
  // the chord through a solid shrinks towards its rim.
  const c = cosView();
  const angle = spec.body === 'shell' ? float(1).div(max(c, SHELL_MIN_COS)) : max(c, SOLID_MIN_COS);
  return local.mul(angle);
}

/** 0..1 rainbow that shifts with the view angle, standing in for thin-film where the real one is off. */
function rainbow() {
  const t = oneMinus(cosView()).mul(1.4).add(surfaceNoise(0.3).mul(0.35));
  return cos(t.add(vec3(0, 0.33, 0.67)).mul(Math.PI * 2))
    .mul(0.5)
    .add(0.5);
}

/** Light drops glow (アセットリスト > 3Dモデル: 光の雫 = 虹色ガラス＋発光), strongest towards the rim. */
function dropGlow(strength: number) {
  return rainbow()
    .mul(smoothstep(0.0, 0.85, oneMinus(cosView())).mul(0.75).add(0.25))
    .mul(strength);
}

function transmissiveGlass(
  spec: GlassSpec,
  features: GlassFeatures,
  options: GlassOptions,
): THREE.MeshPhysicalNodeMaterial {
  const thickness = options.thickness ?? spec.thickness;
  const m = new THREE.MeshPhysicalNodeMaterial({
    color: 0xffffff, // 色は表面ではなく内部の吸収で出す
    metalness: 0,
    roughness: spec.roughness,
    transmission: spec.transmission,
    ior: GLASS_IOR,
    thickness,
    attenuationColor: new THREE.Color(...spec.absorption.color),
    attenuationDistance: spec.absorption.distance,
  });
  m.thicknessNode = thicknessNode(spec, options);
  if (features.dispersion) m.dispersion = GLASS_DISPERSION;
  if (features.thinFilm === 'film') {
    m.iridescence = 1;
    m.iridescenceIOR = THIN_FILM.ior;
    m.iridescenceThicknessNode = mix(THIN_FILM.thicknessNm[0], THIN_FILM.thicknessNm[1], surfaceNoise(0.25));
  } else if (features.thinFilm === 'cheap') {
    // Tint the reflection, like a film would: the rainbow appears only where something is reflected,
    // so iridescent things do not glow in the dark (F0 0.016–0.18 instead of 0.04).
    m.specularColorNode = rainbow().mul(4).add(0.4);
  }
  if (features.thinFilm !== 'none' && options.role === 'drop') {
    // Weaker over the real film so the film still shows.
    m.emissiveNode = dropGlow(features.thinFilm === 'film' ? 0.3 : 0.6);
  }
  return m;
}

/**
 * 遠景の安価な表現: no transmission. Fresnel-weighted see-through (reflection of the environment map,
 * stronger towards the silhouette) blended over the scene, then faded into the haze with distance.
 */
function cheapGlass(
  spec: GlassSpec,
  features: GlassFeatures,
  options: GlassOptions,
): THREE.MeshStandardNodeMaterial {
  const haze = options.haze ?? DEFAULT_HAZE;
  const thickness = options.thickness ?? spec.thickness;
  // Body tint seen through two walls (or the solid body), from the same absorption law as the near path.
  const tint = beerLambert(spec.absorption.color, spec.absorption.distance, thickness * 2);
  const saturation = 1 - Math.min(...tint) / Math.max(...tint, 1e-3);
  const m = new THREE.MeshStandardNodeMaterial({
    transparent: true,
    metalness: 0,
    roughness: Math.max(spec.roughness, 0.05),
    fog: false, // the haze below replaces scene fog; both would double it
  });
  const f0 = fresnelF0(GLASS_IOR);
  const fresnel = float(f0).add(float(1 - f0).mul(pow(oneMinus(cosView()), 5)));
  const body = color(new THREE.Color(...tint)).mul(0.2 + 0.6 * saturation);
  // A film colours what the glass reflects, so the stand-in rainbow sits where the reflection is: the rim.
  m.colorNode = features.thinFilm === 'none' ? body : mix(body, rainbow(), fresnel.mul(0.9));
  const baseAlpha = 0.14 + 0.4 * saturation + (spec.roughness > 0.3 ? 0.3 : 0);
  m.opacityNode = mix(float(baseAlpha), float(1), fresnel);
  if (features.thinFilm !== 'none' && options.role === 'drop') m.emissiveNode = dropGlow(0.5);
  const hazeColor = uniform(new THREE.Color(haze.color));
  const h = positionView
    .length()
    .sub(haze.near)
    .div(Math.max(haze.far - haze.near, 1e-3))
    .clamp(0, 1);
  // Far glass melts into the haze: its colour goes to the haze and it lets more of the (equally hazy)
  // background through, so stacked far shapes lose contrast instead of turning into solid silhouettes.
  m.outputNode = vec4(mix(output.rgb, hazeColor, h), output.a.mul(oneMinus(h.mul(0.25))));
  return m;
}

/** 乳白ガラス: 透過を抑え、内側から発光. A scattering body under a glossy glass skin, drawn opaque. */
function milkyGlass(spec: GlassSpec, options: GlassOptions): THREE.MeshPhysicalNodeMaterial {
  const glow = options.glow ?? { color: 0xffb46e, intensity: 2.6 };
  const m = new THREE.MeshPhysicalNodeMaterial({
    color: new THREE.Color(...spec.absorption.color),
    metalness: 0,
    roughness: spec.roughness,
    transmission: 0,
    ior: GLASS_IOR,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  // Light scattered from inside: brightest where the view crosses the most milky glass (the middle).
  m.emissiveNode = color(new THREE.Color(glow.color))
    .mul(glow.intensity)
    .mul(mix(float(0.35), float(1), pow(cosView(), 1.5)));
  return m;
}

export interface FrostedFloorOptions {
  /** Tile size in metres (仮 1.2). */
  tileSize?: number;
  /** Brass joint width in metres (仮 0.024). */
  jointWidth?: number;
  frostColor?: THREE.ColorRepresentation;
  brassColor?: THREE.ColorRepresentation;
}

/**
 * 曇りガラスの床 with brass joints (空間の可読性と導線 > 1 歩ける面は透明にしない).
 * Drawn opaque on purpose: transmissive glass only refracts opaque things, and the floor is what stands
 * behind almost every piece of glass. A see-through floor would vanish behind all of them.
 */
export function createFrostedFloorMaterial(
  options: FrostedFloorOptions = {},
): THREE.MeshStandardNodeMaterial {
  const tile = options.tileSize ?? 1.2;
  const jointHalf = (options.jointWidth ?? 0.024) * 0.5;
  const frost = new THREE.Color(options.frostColor ?? 0xdfe6ea);
  const brass = new THREE.Color(options.brassColor ?? BRASS_COLOR);

  const p = positionWorld.xz.div(tile);
  const cell = p.floor();
  const f = p.fract().sub(0.5).abs();
  const toJoint = float(0.5).sub(max(f.x, f.y)).mul(tile); // metres to the nearest joint
  // Floor covered by one pixel, from the unfolded world position (toJoint folds back at every joint, so
  // its own derivative vanishes right on the joints).
  const footprint = fwidth(positionWorld.xz);
  const aa = max(max(footprint.x, footprint.y), 1e-4);
  // Fade the joints out where a pixel covers more floor than a joint is wide (no moiré towards the horizon).
  const resolvable = oneMinus(smoothstep(jointHalf * 2, jointHalf * 8, aa));
  const joint = oneMinus(smoothstep(float(jointHalf).sub(aa), float(jointHalf).add(aa), toJoint)).mul(
    resolvable,
  );
  // Each tile catches light a little differently, and glows softly in the middle (light through frost).
  const tileTone = hash(cell.x.add(cell.y.mul(57.0)))
    .mul(0.06)
    .add(0.94);
  const pillow = smoothstep(0, 0.5, toJoint.div(tile)).mul(0.08).add(0.92);
  const frostTone = color(frost).mul(tileTone).mul(pillow);

  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.5 });
  m.colorNode = mix(frostTone, color(brass), joint);
  m.metalnessNode = joint;
  m.roughnessNode = mix(float(0.5), float(0.36), joint); // 曇りガラスの粗さ0.4〜0.6 / 真鍮
  return m;
}

/** 真鍮の鈍い金 (アートディレクション > 色の進行). */
export const BRASS_COLOR = 0xb08d57;

/** Thin brass frames (アートディレクション > 形のルール: 直線と細い線は真鍮の枠だけに許す). */
export function createBrassMaterial(): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({ color: BRASS_COLOR, metalness: 1, roughness: 0.38 });
}

/**
 * Air bubbles inside bubble glass. Opaque on purpose (like the floor) so the surrounding transmissive
 * glass refracts them; small bright mirrors read as trapped air.
 */
export function createInnerBubbleMaterial(): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({ color: 0xf4f8fa, metalness: 1, roughness: 0.12 });
}
