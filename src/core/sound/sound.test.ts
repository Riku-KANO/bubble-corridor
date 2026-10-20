// S-11 共通部品の音の仕組み（音階・拍・残響）（親が作成。実装担当は変更しない）
import { describe, expect, it } from 'vitest';
import { nextGridTime } from './grid';
import { chordTones, midiToHz, nearestPitch, pentatonic, touchCandidates } from './scale';
import { createReverbImpulse, REVERB_SECONDS } from './space';

describe('AUD-2 音階への揃え', () => {
  it('調の5音: 長調は 1 2 3 5 6、短調は 1 ♭3 4 5 ♭7（音名を昇順）', () => {
    expect(pentatonic({ tonic: 0, mode: 'major' })).toEqual([0, 2, 4, 7, 9]);
    expect(pentatonic({ tonic: 9, mode: 'minor' })).toEqual([0, 2, 4, 7, 9]); // A minor = C major pentatonic と同じ音名
    expect(pentatonic({ tonic: 2, mode: 'major' })).toEqual([2, 4, 6, 9, 11]); // D E F# A B
  });

  it('和音の構成音', () => {
    expect(chordTones({ root: 0, quality: 'maj' })).toEqual([0, 4, 7]);
    expect(chordTones({ root: 9, quality: 'min' })).toEqual([0, 4, 9]);
    expect(chordTones({ root: 7, quality: 'dom7' })).toEqual([2, 5, 7, 11]);
    expect(chordTones({ root: 0, quality: 'maj7' })).toEqual([0, 4, 7, 11]);
    expect(chordTones({ root: 2, quality: 'sus4' })).toEqual([2, 7, 9]);
    expect(chordTones({ root: 0, quality: 'add9' })).toEqual([0, 2, 4, 7]);
  });

  it('触れた音の候補は、調の5音と和音の共通部分', () => {
    // C major ペンタ（C D E G A）× F maj（F A C）→ A, C
    expect(touchCandidates({ tonic: 0, mode: 'major' }, { root: 5, quality: 'maj' })).toEqual([0, 9]);
    // × C maj → C E G
    expect(touchCandidates({ tonic: 0, mode: 'major' }, { root: 0, quality: 'maj' })).toEqual([0, 4, 7]);
  });

  it('共通部分が2音未満なら調の5音をそのまま使う（どう触れても演奏になる）', () => {
    // C major ペンタ × B dim（B D F）→ D だけ → 5音
    expect(touchCandidates({ tonic: 0, mode: 'major' }, { root: 11, quality: 'dim' })).toEqual([0, 2, 4, 7, 9]);
  });

  it('nearestPitch は範囲内で最も近い音、同じ距離なら高い方', () => {
    expect(nearestPitch([0, 4, 7], 61)).toBe(60); // C#4 → C4
    expect(nearestPitch([0, 4, 7], 62)).toBe(64); // D4 は C4 と E4 から2ずつ → 高い方
    expect(nearestPitch([0, 4, 7], 90, 48, 84)).toBe(84); // 範囲の上端に収める（C6）
    expect(nearestPitch([9], 40, 60, 80)).toBe(69);
  });

  it('midiToHz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(81)).toBeCloseTo(880, 6);
  });
});

describe('AUD-3 拍への合わせ', () => {
  const beat = 60 / 72;
  it('次の8分音符の格子点（now より後）', () => {
    expect(nextGridTime(0.1, 0, 72, 0.5)).toBeCloseTo(beat / 2, 9);
    expect(nextGridTime(beat / 2 + 0.01, 0, 72, 0.5)).toBeCloseTo(beat, 9);
  });

  it('格子点ちょうどならその点（遅らせない）', () => {
    expect(nextGridTime(beat, 0, 72, 0.5)).toBeCloseTo(beat, 9);
  });

  it('予約の余裕 minLead に満たなければ次の格子点', () => {
    const almost = beat / 2 - 0.01;
    expect(nextGridTime(almost, 0, 72, 0.5, 0.02)).toBeCloseTo(beat, 9);
    expect(nextGridTime(almost, 0, 72, 0.5, 0.005)).toBeCloseTo(beat / 2, 9);
  });

  it('origin がずれていても格子は origin から刻む', () => {
    expect(nextGridTime(10.1, 10, 72, 0.5)).toBeCloseTo(10 + beat / 2, 9);
  });

  it('応答の遅れは最大でも8分音符1つ分（約0.42秒）と minLead の和を超えない', () => {
    for (let now = 0; now < 5; now += 0.037) {
      const at = nextGridTime(now, 0, 72, 0.5, 0.03);
      expect(at).toBeGreaterThanOrEqual(now + 0.03 - 1e-9);
      expect(at - now).toBeLessThanOrEqual(beat / 2 + 0.03 + 1e-9);
    }
  });
});

describe('AUD-6 空間ごとの残響', () => {
  function fakeContext(sampleRate = 8000) {
    return {
      sampleRate,
      createBuffer(channels: number, length: number, sr: number) {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        return { numberOfChannels: channels, length, sampleRate: sr, duration: length / sr, getChannelData: (i: number) => data[i] };
      },
    } as unknown as BaseAudioContext;
  }
  const energy = (a: Float32Array, from: number, to: number) => {
    let e = 0;
    for (let i = from; i < to; i++) e += a[i] * a[i];
    return e;
  };

  it('長さは部屋の広さに応じる（回廊は短く、天球は長い）', () => {
    const ctx = fakeContext();
    const small = createReverbImpulse(ctx, 'small');
    const huge = createReverbImpulse(ctx, 'huge');
    expect(small.duration).toBeGreaterThan(REVERB_SECONDS.small * 0.8);
    expect(small.duration).toBeLessThan(REVERB_SECONDS.small * 1.5);
    expect(huge.duration).toBeGreaterThan(REVERB_SECONDS.huge * 0.8);
    expect(huge.duration).toBeGreaterThan(small.duration * 3);
  });

  it('ステレオで、減衰し、左右は同じではない', () => {
    const ir = createReverbImpulse(fakeContext(), 'medium');
    expect(ir.numberOfChannels).toBe(2);
    const l = ir.getChannelData(0);
    const r = ir.getChannelData(1);
    const n = l.length;
    expect(energy(l, 0, n / 4)).toBeGreaterThan(energy(l, (3 * n) / 4, n) * 20);
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(l[i] - r[i]);
    expect(diff).toBeGreaterThan(0);
  });

  it('同じ種からは同じ応答（決定的）', () => {
    const a = createReverbImpulse(fakeContext(), 'large', 7).getChannelData(0);
    const b = createReverbImpulse(fakeContext(), 'large', 7).getChannelData(0);
    expect(Array.from(a.slice(0, 500))).toEqual(Array.from(b.slice(0, 500)));
  });
});
