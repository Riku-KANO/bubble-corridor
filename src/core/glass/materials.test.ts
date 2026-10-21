import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../quality';
import { FROSTED_ROUGHNESS_RANGE, GLASS_IOR } from './kinds';
import { createFrostedFloorMaterial, createGlass } from './materials';

const mid = QUALITY_PRESETS.mid;

/** Whether a node graph samples the given texture. */
function usesTexture(node: THREE.Node | null, map: THREE.Texture, seen = new Set<THREE.Node>()): boolean {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (
    (node as { isTextureNode?: boolean; value?: unknown }).isTextureNode &&
    (node as { value?: unknown }).value === map
  )
    return true;
  for (const child of node.getChildren()) if (usesTexture(child, map, seen)) return true;
  return false;
}

function physical(material: THREE.Material): THREE.MeshPhysicalNodeMaterial {
  expect(material).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
  return material as THREE.MeshPhysicalNodeMaterial;
}

describe('near glass materials', () => {
  it('refracts every transmissive kind at IOR 1.5 with full transmission', () => {
    for (const kind of ['clear', 'frosted', 'amber', 'lapis', 'jade', 'bubble', 'iridescent'] as const) {
      const m = physical(createGlass(kind, mid).material);
      expect(m.ior, kind).toBe(GLASS_IOR);
      expect(m.transmission, kind).toBe(1);
      expect(m.metalness, kind).toBe(0);
      m.dispose();
    }
  });

  it('makes clear glass perfectly smooth and frosted glass rough but still see-through', () => {
    expect(physical(createGlass('clear', mid).material).roughness).toBe(0);
    const frosted = physical(createGlass('frosted', mid).material);
    expect(frosted.roughness).toBeGreaterThanOrEqual(FROSTED_ROUGHNESS_RANGE[0]);
    expect(frosted.roughness).toBeLessThanOrEqual(FROSTED_ROUGHNESS_RANGE[1]);
    expect(frosted.transmission).toBeGreaterThan(0);
  });

  it('colours amber, lapis and jade by internal absorption, not by the surface', () => {
    const hue = (kind: 'amber' | 'lapis' | 'jade') => {
      const m = physical(createGlass(kind, mid).material);
      expect(m.color.getHex(), `${kind} surface`).toBe(0xffffff);
      expect(Number.isFinite(m.attenuationDistance), `${kind} absorbs`).toBe(true);
      return m.attenuationColor;
    };
    const amber = hue('amber');
    expect(amber.r).toBeGreaterThan(amber.b);
    const lapis = hue('lapis');
    expect(lapis.b).toBeGreaterThan(lapis.r);
    const jade = hue('jade');
    expect(jade.g).toBeGreaterThan(jade.r);
  });

  it("takes the thickness from an asset's thickness map when one is given (glTF thickness texture)", () => {
    const map = new THREE.Texture();
    const m = physical(createGlass('amber', mid, { thicknessMap: map }).material);
    expect(usesTexture(m.thicknessNode, map)).toBe(true);
  });

  it('turns dispersion and thin-film on only where the preset allows', () => {
    const orbLow = physical(createGlass('bubble', QUALITY_PRESETS.low, { role: 'orb' }).material);
    const orbMid = physical(createGlass('bubble', mid, { role: 'orb' }).material);
    expect(orbLow.dispersion).toBe(0);
    expect(orbMid.dispersion).toBeGreaterThan(0);
    const dropMid = physical(createGlass('iridescent', mid, { role: 'drop' }).material);
    const dropHigh = physical(createGlass('iridescent', QUALITY_PRESETS.high, { role: 'drop' }).material);
    expect(dropMid.iridescence).toBe(0);
    expect(dropMid.emissiveNode, 'cheap sheen stands in for thin-film').not.toBeNull();
    expect(dropHigh.iridescence).toBeGreaterThan(0);
  });

  it('keeps a rainbow in ordinary iridescent glass by tinting its reflection', () => {
    for (const preset of [QUALITY_PRESETS.low, mid, QUALITY_PRESETS.high]) {
      const m = physical(createGlass('iridescent', preset, { role: 'scenery' }).material);
      expect(m.specularColorNode).not.toBeNull();
    }
  });

  it('does not make ordinary iridescent glass glow: its rainbow stays in the reflection', () => {
    for (const preset of [QUALITY_PRESETS.low, mid, QUALITY_PRESETS.high]) {
      for (const placement of ['near', 'far'] as const) {
        const m = createGlass('iridescent', preset, { role: 'scenery', placement }).material;
        expect((m as THREE.MeshStandardNodeMaterial).emissiveNode, placement).toBeNull();
      }
    }
  });

  it('lets light drops glow on every preset (アセットリスト: 光の雫 = 虹色ガラス＋発光)', () => {
    for (const preset of [QUALITY_PRESETS.low, mid, QUALITY_PRESETS.high]) {
      const drop = physical(createGlass('iridescent', preset, { role: 'drop' }).material);
      expect(drop.emissiveNode).not.toBeNull();
    }
  });

  it('keeps milky glass out of the transmission pass and lights it from inside', () => {
    const { material, features } = createGlass('milky', mid);
    const m = physical(material);
    expect(features.path).toBe('opaque');
    expect(m.transmission).toBe(0);
    expect(m.transparent).toBe(false);
    expect(m.emissiveNode).not.toBeNull();
  });
});

describe('far glass', () => {
  it('uses the cheap see-through path on mid: no transmission, blended, own distance haze', () => {
    const { material, features } = createGlass('clear', mid, { placement: 'far' });
    expect(features.path).toBe('cheap');
    expect((material as THREE.MeshPhysicalNodeMaterial).transmission ?? 0).toBe(0);
    expect(material.transparent).toBe(true);
    expect(material.fog, 'haze is built in, scene fog would double it').toBe(false);
    expect((material as THREE.MeshStandardNodeMaterial).outputNode).not.toBeNull();
  });

  it('switches back to real transmission on high', () => {
    const { material, features } = createGlass('clear', QUALITY_PRESETS.high, { placement: 'far' });
    expect(features.path).toBe('transmission');
    expect(physical(material).transmission).toBe(1);
  });
});

describe('frosted floor', () => {
  it('is drawn opaque so that glass standing on it can show it through transmission', () => {
    const floor = createFrostedFloorMaterial();
    expect(floor.transparent).toBe(false);
    expect((floor as THREE.MeshPhysicalNodeMaterial).transmission ?? 0).toBe(0);
  });
});
