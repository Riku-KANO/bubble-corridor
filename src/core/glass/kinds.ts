/**
 * Glass kinds (アートディレクション > ガラスの種類, 技術設計 > ガラスの描画). Pure data, no GPU.
 * Numbers the design doc fixes are quoted with their section. Numbers marked 仮 are art values
 * the doc leaves open; they are listed in process/slices/S-01.md for the designer to confirm.
 */
export type GlassKind = 'clear' | 'frosted' | 'amber' | 'lapis' | 'jade' | 'bubble' | 'iridescent' | 'milky';

export const GLASS_KINDS: readonly GlassKind[] = [
  'clear',
  'frosted',
  'amber',
  'lapis',
  'jade',
  'bubble',
  'iridescent',
  'milky',
];

/** Linear-RGB triple, 0..1. */
export type Rgb = readonly [number, number, number];

/** 技術設計 > ガラスの描画: 屈折率1.5 */
export const GLASS_IOR = 1.5;
/** 技術設計 > ガラスの描画: 透過(transmission)1.0 */
export const GLASS_TRANSMISSION = 1.0;
/** アートディレクション > ガラスの種類: 曇りガラスは粗さ0.4〜0.6 */
export const FROSTED_ROUGHNESS_RANGE = [0.4, 0.6] as const;
/** アートディレクション > ガラスの種類: 透明ガラスは粗さ0 */
export const CLEAR_ROUGHNESS = 0;

/** Strength of chromatic dispersion where the quality preset allows it (仮). */
export const GLASS_DISPERSION = 0.8;
/** Thin-film interference for iridescent glass (仮: soap-bubble-like film). Thickness in nanometres. */
export const THIN_FILM = { ior: 1.3, thicknessNm: [120, 420] as const };

export interface GlassSpec {
  roughness: number;
  /** 1 = refracted backdrop (transmission). 0 = drawn opaque (milky glass scatters inside instead). */
  transmission: number;
  /** Beer–Lambert absorption: the colour left after light travels `distance` metres inside the glass. */
  absorption: { color: Rgb; distance: number };
  /** Face-on thickness in metres: the wall of a shell, or the depth of a solid body. */
  thickness: number;
  /**
   * How the light path changes with the view angle. A shell (blown wall) is crossed edge-on at its
   * silhouette, so the path grows towards grazing angles (断面の縁). A solid body is thinnest at its rim.
   */
  body: 'shell' | 'solid';
}

export const GLASS_SPECS: Readonly<Record<GlassKind, Readonly<GlassSpec>>> = {
  // 無色。断面の縁がわずかに緑: iron-green absorption that only shows over long (edge-on) paths.
  clear: {
    roughness: CLEAR_ROUGHNESS,
    transmission: GLASS_TRANSMISSION,
    absorption: { color: [0.6, 0.86, 0.72], distance: 0.3 },
    thickness: 0.045,
    body: 'shell',
  },
  // すりガラスの柔らかい拡散、透過は残す。
  frosted: {
    roughness: 0.45,
    transmission: GLASS_TRANSMISSION,
    absorption: { color: [0.86, 0.9, 0.93], distance: 1.0 },
    thickness: 0.05,
    body: 'shell',
  },
  // 琥珀・瑠璃・翡翠。厚い所ほど濃い: colour comes only from absorption (仮 hues and distances).
  amber: {
    roughness: CLEAR_ROUGHNESS,
    transmission: GLASS_TRANSMISSION,
    absorption: { color: [0.93, 0.52, 0.12], distance: 0.09 },
    thickness: 0.22,
    body: 'solid',
  },
  lapis: {
    roughness: CLEAR_ROUGHNESS,
    transmission: GLASS_TRANSMISSION,
    absorption: { color: [0.2, 0.36, 0.92], distance: 0.16 },
    thickness: 0.22,
    body: 'solid',
  },
  jade: {
    roughness: CLEAR_ROUGHNESS,
    transmission: GLASS_TRANSMISSION,
    absorption: { color: [0.28, 0.78, 0.52], distance: 0.11 },
    thickness: 0.22,
    body: 'solid',
  },
  // 内部に細かな泡: clear solid glass; the bubbles are separate small shapes inside (scatterInnerBubbles + innerBubbleMesh).
  bubble: {
    roughness: CLEAR_ROUGHNESS,
    transmission: GLASS_TRANSMISSION,
    absorption: { color: [0.8, 0.93, 0.86], distance: 0.9 },
    thickness: 0.45,
    body: 'solid',
  },
  // シャボン玉のような干渉の虹: thin-film on clear glass.
  iridescent: {
    roughness: CLEAR_ROUGHNESS,
    transmission: GLASS_TRANSMISSION,
    absorption: { color: [0.95, 0.97, 0.99], distance: 1.0 },
    thickness: 0.18,
    body: 'solid',
  },
  // 光を内部で散らす半透明、透過を抑え内側から発光: opaque scattering body under a glossy glass skin.
  milky: {
    roughness: 0.55,
    transmission: 0,
    absorption: { color: [0.96, 0.94, 0.9], distance: 1.0 },
    thickness: 0.3,
    body: 'solid',
  },
};
