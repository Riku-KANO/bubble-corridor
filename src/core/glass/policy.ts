import type { QualityPreset } from '../quality';
import { GLASS_SPECS, type GlassKind } from './kinds';

/**
 * Which rendering features a piece of glass gets, decided from where it stands, what it is for,
 * and the quality preset. Pure: the material factory and the sensors both call this.
 *
 * 技術設計 > 1フレームの描画の流れ (2, 3), 技術設計 > ガラスの描画, 技術設計 > 品質プリセット,
 * 空間の可読性と導線 > 画面をうるさくしない (8: 遠景のガラスは単純な表現に切り替える).
 */

/**
 * Set by level design. near: always transmission. far: the cheap path unless the preset allows far
 * transmission. behind-glass: stands behind other transmissive glass on a main sightline, so it stays on
 * the cheap path on every preset (技術設計 > ガラスの描画 > 対策1: 重なる場所は遠景側を安価な表現に切り替える).
 */
export type GlassPlacement = 'near' | 'far' | 'behind-glass';

/**
 * What the glass is for. 技術設計 > ガラスの描画: 分散と薄膜干渉は手の玉・光の雫・見せ場に限って使う.
 * Everything else is scenery.
 */
export type GlassRole = 'scenery' | 'orb' | 'drop' | 'showcase';

export interface GlassUse {
  placement: GlassPlacement;
  role: GlassRole;
}

/**
 * transmission: refracts the opaque scene behind it (MeshPhysical transmission).
 * cheap: no transmission; environment reflection + distance haze, alpha-blended (遠景の安価な表現).
 * opaque: drawn with the opaque objects (milky glass), so other glass can show it.
 */
export type GlassPath = 'transmission' | 'cheap' | 'opaque';

/** film: real thin-film interference. cheap: a view-angle rainbow sheen. none: not iridescent glass. */
export type ThinFilmMode = 'film' | 'cheap' | 'none';

export interface GlassFeatures {
  path: GlassPath;
  dispersion: boolean;
  thinFilm: ThinFilmMode;
}

/**
 * 技術設計 > 品質プリセット, 分散: 低=なし / 中=手の玉のみ / 高=見せ場にも.
 * Light drops join the showcase tier (仮: the preset table does not list them; see S-01.md 判断待ち).
 */
const HEAVY_OPTICS_ROLES: Readonly<Record<QualityPreset['dispersion'], readonly GlassRole[]>> = {
  none: [],
  orb: ['orb'],
  showcase: ['orb', 'drop', 'showcase'],
};

/** Whether dispersion and thin-film interference may be used for this role under the preset. */
export function heavyOpticsAllowed(role: GlassRole, level: QualityPreset['dispersion']): boolean {
  return HEAVY_OPTICS_ROLES[level].includes(role);
}

export function resolveGlassFeatures(
  kind: GlassKind,
  use: GlassUse,
  preset: Pick<QualityPreset, 'dispersion' | 'farGlassTransmission'>,
): GlassFeatures {
  let path: GlassPath;
  if (GLASS_SPECS[kind].transmission === 0) path = 'opaque';
  else if (use.placement === 'behind-glass') path = 'cheap';
  else if (use.placement === 'far' && !preset.farGlassTransmission) path = 'cheap';
  else path = 'transmission';

  const heavy = path === 'transmission' && heavyOpticsAllowed(use.role, preset.dispersion);
  let thinFilm: ThinFilmMode = 'none';
  if (kind === 'iridescent') thinFilm = heavy ? 'film' : 'cheap';

  return { path, dispersion: heavy, thinFilm };
}
