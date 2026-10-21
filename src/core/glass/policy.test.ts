import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, type QualityLevel } from '../quality';
import { GLASS_KINDS } from './kinds';
import { heavyOpticsAllowed, resolveGlassFeatures } from './policy';

const levels: QualityLevel[] = ['low', 'mid', 'high'];

describe('glass render path', () => {
  it('draws near glass with transmission on every preset', () => {
    for (const level of levels) {
      for (const kind of GLASS_KINDS.filter((k) => k !== 'milky')) {
        const f = resolveGlassFeatures(kind, { placement: 'near', role: 'scenery' }, QUALITY_PRESETS[level]);
        expect(f.path, `${kind} @ ${level}`).toBe('transmission');
      }
    }
  });

  it('switches far glass to the cheap path unless the preset allows far transmission', () => {
    const far = { placement: 'far', role: 'scenery' } as const;
    expect(resolveGlassFeatures('clear', far, QUALITY_PRESETS.low).path).toBe('cheap');
    expect(resolveGlassFeatures('clear', far, QUALITY_PRESETS.mid).path).toBe('cheap');
    expect(resolveGlassFeatures('clear', far, QUALITY_PRESETS.high).path).toBe('transmission');
    expect(
      resolveGlassFeatures('clear', far, { ...QUALITY_PRESETS.low, farGlassTransmission: true }).path,
    ).toBe('transmission');
  });

  it('keeps glass placed behind other glass on the cheap path even on high (対策1)', () => {
    const behind = { placement: 'behind-glass', role: 'scenery' } as const;
    for (const level of levels) {
      expect(resolveGlassFeatures('clear', behind, QUALITY_PRESETS[level]).path, level).toBe('cheap');
    }
  });

  it('keeps milky glass opaque so other glass can see it through their backdrop', () => {
    for (const level of levels) {
      for (const placement of ['near', 'far'] as const) {
        const f = resolveGlassFeatures('milky', { placement, role: 'scenery' }, QUALITY_PRESETS[level]);
        expect(f.path).toBe('opaque');
        expect(f.dispersion).toBe(false);
      }
    }
  });
});

describe('heavy optics (dispersion, thin-film) follow the dispersion preset', () => {
  it('allows nothing on "none"', () => {
    for (const role of ['scenery', 'orb', 'drop', 'showcase'] as const) {
      expect(heavyOpticsAllowed(role, 'none')).toBe(false);
    }
  });

  it('allows only the hand orb on "orb"', () => {
    expect(heavyOpticsAllowed('orb', 'orb')).toBe(true);
    expect(heavyOpticsAllowed('drop', 'orb')).toBe(false);
    expect(heavyOpticsAllowed('showcase', 'orb')).toBe(false);
    expect(heavyOpticsAllowed('scenery', 'orb')).toBe(false);
  });

  it('adds light drops and showcases on "showcase", never ordinary scenery', () => {
    expect(heavyOpticsAllowed('orb', 'showcase')).toBe(true);
    expect(heavyOpticsAllowed('drop', 'showcase')).toBe(true);
    expect(heavyOpticsAllowed('showcase', 'showcase')).toBe(true);
    expect(heavyOpticsAllowed('scenery', 'showcase')).toBe(false);
  });

  it('turns dispersion on per preset for the hand orb', () => {
    const orb = { placement: 'near', role: 'orb' } as const;
    expect(resolveGlassFeatures('bubble', orb, QUALITY_PRESETS.low).dispersion).toBe(false);
    expect(resolveGlassFeatures('bubble', orb, QUALITY_PRESETS.mid).dispersion).toBe(true);
    expect(resolveGlassFeatures('bubble', orb, QUALITY_PRESETS.high).dispersion).toBe(true);
  });

  it('never disperses glass that is drawn without transmission', () => {
    const farShowcase = { placement: 'far', role: 'showcase' } as const;
    expect(resolveGlassFeatures('clear', farShowcase, QUALITY_PRESETS.mid).dispersion).toBe(false);
  });

  it('gives iridescent glass real thin-film only where heavy optics are allowed, a cheap sheen elsewhere', () => {
    const drop = { placement: 'near', role: 'drop' } as const;
    expect(resolveGlassFeatures('iridescent', drop, QUALITY_PRESETS.low).thinFilm).toBe('cheap');
    expect(resolveGlassFeatures('iridescent', drop, QUALITY_PRESETS.mid).thinFilm).toBe('cheap');
    expect(resolveGlassFeatures('iridescent', drop, QUALITY_PRESETS.high).thinFilm).toBe('film');
    const scenery = { placement: 'near', role: 'scenery' } as const;
    expect(resolveGlassFeatures('iridescent', scenery, QUALITY_PRESETS.high).thinFilm).toBe('cheap');
  });

  it('never adds thin-film to non-iridescent glass', () => {
    const orb = { placement: 'near', role: 'orb' } as const;
    for (const kind of GLASS_KINDS.filter((k) => k !== 'iridescent')) {
      expect(resolveGlassFeatures(kind, orb, QUALITY_PRESETS.high).thinFilm).toBe('none');
    }
  });
});
