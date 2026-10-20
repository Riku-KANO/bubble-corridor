import { describe, expect, it } from 'vitest';
import { RIDE_DURATION } from '../config';
import { parseParams } from './params';

describe('確認用の URL パラメータ（外から来る値の検証）', () => {
  it('何もなければ既定値', () => {
    expect(parseParams('')).toEqual({
      debug: false,
      t: null,
      rate: 1,
      webgl: false,
      lang: null,
      screen: null,
      door: null,
      quality: null,
      nofx: false,
    });
  });

  it('既知のキーを読む', () => {
    const p = parseParams('?debug&t=590&rate=4&webgl&lang=en&screen=home&door=amber&quality=low&nofx');
    expect(p).toEqual({ debug: true, t: 590, rate: 4, webgl: true, lang: 'en', screen: 'home', door: 'amber', quality: 'low', nofx: true });
  });

  it('範囲外・不正な値は捨てる', () => {
    const p = parseParams(`?t=${RIDE_DURATION + 1}&rate=abc&lang=fr&door=red&screen=%3Cscript%3E&quality=ultra`);
    expect(p.t).toBeNull();
    expect(p.rate).toBe(1);
    expect(p.lang).toBeNull();
    expect(p.door).toBeNull();
    expect(p.screen).toBeNull();
    expect(p.quality).toBeNull();
    expect(parseParams('?t=-3').t).toBeNull();
    expect(parseParams('?t=').t).toBeNull();
  });
});
