import { describe, expect, it } from 'vitest';
import { glassEase } from './curve';
import { acceptsEscape, segment, Transition } from './transition';

describe('Transition', () => {
  it('plays forward on the common curve and finishes', () => {
    const t = new Transition({ id: 'x', seconds: 2 });
    expect(t.progress).toBe(0);
    expect(t.value).toBe(0);
    t.update(1);
    expect(t.progress).toBeCloseTo(0.5, 6);
    expect(t.value).toBeCloseTo(glassEase(0.5), 6);
    expect(t.finished).toBeNull();
    t.update(5);
    expect(t.progress).toBe(1);
    expect(t.value).toBe(1);
    expect(t.finished).toBe('forward');
  });

  it('plays the same motion backwards when reversed (戻る操作は逆再生)', () => {
    const t = new Transition({ id: 'x', seconds: 2 });
    t.update(0.8);
    const valueAtTurn = t.value;
    t.reverse();
    expect(t.direction).toBe(-1);
    t.update(0.3);
    expect(t.value).toBeLessThan(valueAtTurn);
    expect(t.value).toBeCloseTo(glassEase(0.25), 6);
    t.update(0.6);
    expect(t.progress).toBe(0);
    expect(t.finished).toBe('reversed');
  });

  it('can start from the end and play backwards (潜った後に戻る)', () => {
    const t = new Transition({ id: 'x', seconds: 2 }, { startAtEnd: true });
    expect(t.progress).toBe(1);
    expect(t.direction).toBe(-1);
    t.update(2);
    expect(t.finished).toBe('reversed');
  });

  it('waits mid-pose until the next scene is ready, then continues (遷移のルール 2)', () => {
    let ready = false;
    const t = new Transition({ id: 'x', seconds: 2 }, { holdAt: 0.4, isReady: () => ready });
    t.update(3);
    expect(t.progress).toBeCloseTo(0.4, 6);
    expect(t.holding).toBe(true);
    expect(t.finished).toBeNull();
    ready = true;
    t.update(0.6);
    expect(t.holding).toBe(false);
    expect(t.progress).toBeCloseTo(0.7, 6);
    t.update(1);
    expect(t.finished).toBe('forward');
  });

  it('does not hold while going back', () => {
    const t = new Transition({ id: 'x', seconds: 2 }, { holdAt: 0.4, isReady: () => false });
    t.update(3);
    t.reverse();
    t.update(1);
    expect(t.finished).toBe('reversed');
  });

  it('ignores negative or non-finite time steps', () => {
    const t = new Transition({ id: 'x', seconds: 1 });
    t.update(-1);
    t.update(Number.NaN);
    expect(t.progress).toBe(0);
  });
});

describe('acceptsEscape (遷移のルール 4)', () => {
  it('accepts Esc during transitions longer than 0.5 s', () => {
    expect(acceptsEscape({ id: 'a', seconds: 1.5 })).toBe(true);
    expect(acceptsEscape({ id: 'b', seconds: 2.0 })).toBe(true);
  });

  it('lets short transitions (0.5 s or less) simply finish', () => {
    expect(acceptsEscape({ id: 'c', seconds: 0.25 })).toBe(false);
    expect(acceptsEscape({ id: 'd', seconds: 0.5 })).toBe(false);
  });
});

describe('segment', () => {
  it('maps a sub-range of progress onto 0..1 and clamps outside it', () => {
    expect(segment(0.1, 0.2, 0.6)).toBe(0);
    expect(segment(0.4, 0.2, 0.6)).toBeCloseTo(0.5, 6);
    expect(segment(0.9, 0.2, 0.6)).toBe(1);
  });
});
