import { describe, expect, it } from 'vitest';
import { parseParams } from './params';

describe('parseParams', () => {
  it('defaults to the scene list, mid quality, WebGPU', () => {
    const p = parseParams('');
    expect(p.scene).toBeNull();
    expect(p.benchSeconds).toBeNull();
    expect(p.quality).toBe('mid');
    expect(p.forceWebGL).toBe(false);
    expect(p.warmupSeconds).toBe(1);
  });

  it('reads scene, bench, quality and backend switches', () => {
    const p = parseParams('?scene=glass-gallery&bench=5&quality=high&webgl=1&stats=1&warmup=0');
    expect(p.scene).toBe('glass-gallery');
    expect(p.benchSeconds).toBe(5);
    expect(p.quality).toBe('high');
    expect(p.forceWebGL).toBe(true);
    expect(p.stats).toBe(true);
    expect(p.warmupSeconds).toBe(0);
  });

  it('rejects scene names that could escape the scenes folder', () => {
    expect(parseParams('?scene=../main').scene).toBeNull();
    expect(parseParams('?scene=Hello').scene).toBeNull();
  });

  it('clamps bench length and ignores bad quality', () => {
    expect(parseParams('?bench=9999').benchSeconds).toBe(120);
    expect(parseParams('?bench=-3').benchSeconds).toBeNull();
    expect(parseParams('?quality=ultra').quality).toBe('mid');
  });
});

describe('parseParams (S-05 perf switches)', () => {
  it('starts auto quality at mid and measures 10 s by default', () => {
    const p = parseParams('?scene=stress&quality=auto');
    expect(p.autoQuality).toBe(true);
    expect(p.quality).toBe('mid');
    expect(p.autoWindowSeconds).toBe(10);
  });

  it('turns dynamic resolution on by default but off while benchmarking a fixed preset', () => {
    expect(parseParams('?scene=a').dynres).toBe(true);
    expect(parseParams('?scene=a&bench=5').dynres).toBe(false);
    expect(parseParams('?scene=a&bench=5&dynres=1').dynres).toBe(true);
    expect(parseParams('?scene=a&dynres=0').dynres).toBe(false);
  });

  it('lets auto quality start from another preset, and tests pin the recommendation', () => {
    expect(parseParams('?quality=auto&autoFrom=low&autoForce=high').autoForce).toBe('high');
    expect(parseParams('?quality=auto&autoForce=ultra').autoForce).toBeNull();
    expect(parseParams('?quality=auto&autoFrom=low').quality).toBe('low');
    expect(parseParams('?quality=high&autoFrom=low').quality).toBe('high');
  });

  it('reads test hooks for the auto window and the dynamic-resolution target', () => {
    const p = parseParams('?autoWindow=2&dynresTarget=1&gpuTrust=1');
    expect(p.autoWindowSeconds).toBe(2);
    expect(p.dynresTargetMs).toBe(1);
    expect(p.gpuTrust).toBe(true);
    expect(parseParams('').gpuTrust).toBe(false);
  });
});
