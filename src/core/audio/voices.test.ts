import { describe, expect, it } from 'vitest';
import { type GateState, mayRequestResume, VoiceAllocator } from './voices';

const opts = { maxVoices: 4, maxPerGroup: 2, resumeGrace: 0.25 };
const running: GateState = { realtime: true, running: true, resumeRequestedAt: null, wallNow: 10 };

describe('voice admission (gate)', () => {
  const alloc = new VoiceAllocator<string>(opts);

  it('always accepts on a running or offline context', () => {
    expect(alloc.accepts(running)).toBe(true);
    expect(alloc.accepts({ realtime: false, running: false, resumeRequestedAt: null, wallNow: 10 })).toBe(
      true,
    );
  });

  it('refuses before any gesture asked audio to start', () => {
    expect(alloc.accepts({ realtime: true, running: false, resumeRequestedAt: null, wallNow: 10 })).toBe(
      false,
    );
  });

  it('accepts only within the grace period right after the unlocking gesture', () => {
    const at = (wallNow: number): GateState => ({
      realtime: true,
      running: false,
      resumeRequestedAt: 10,
      wallNow,
    });
    expect(alloc.accepts(at(10))).toBe(true);
    expect(alloc.accepts(at(10.2))).toBe(true);
    // A resume() that never completes (Chrome without user activation) must not keep queueing sounds.
    expect(alloc.accepts(at(10.3))).toBe(false);
    expect(alloc.accepts(at(60))).toBe(false);
    expect(alloc.accepts(at(9))).toBe(false);
  });
});

describe('voice allocation', () => {
  it('counts only voices that have not ended', () => {
    const alloc = new VoiceAllocator<string>(opts);
    alloc.add({ start: 0, end: 1, level: 1, group: null, data: 'a' });
    alloc.add({ start: 0, end: 3, level: 1, group: null, data: 'b' });
    expect(alloc.active(0.5)).toBe(2);
    expect(alloc.active(2)).toBe(1);
    expect(alloc.active(5)).toBe(0);
  });

  it('never refuses a new sound: at the cap it steals the quietest voice', () => {
    const alloc = new VoiceAllocator<string>(opts);
    alloc.add({ start: 0, end: 4, level: 0.9, group: null, data: 'loud' });
    alloc.add({ start: 0, end: 4, level: 0.1, group: null, data: 'quiet' });
    alloc.add({ start: 0, end: 4, level: 0.8, group: null, data: 'loud2' });
    alloc.add({ start: 0, end: 4, level: 0.7, group: null, data: 'loud3' });
    expect([...alloc.makeRoom(0.1, null)]).toEqual(['quiet']);
    expect(alloc.active(0.1)).toBe(3);
  });

  it('treats an old, decayed voice as quieter than a fresh one', () => {
    const alloc = new VoiceAllocator<string>(opts);
    alloc.add({ start: 0, end: 2, level: 1, group: null, data: 'old' }); // at t=1.5: -45 dB
    alloc.add({ start: 1.4, end: 3.4, level: 0.3, group: null, data: 'b' });
    alloc.add({ start: 1.4, end: 3.4, level: 0.3, group: null, data: 'c' });
    alloc.add({ start: 1.4, end: 3.4, level: 0.3, group: null, data: 'd' });
    expect([...alloc.makeRoom(1.5, null)]).toEqual(['old']);
  });

  it('limits voices per emitter (group) and steals within that group first', () => {
    const alloc = new VoiceAllocator<string>(opts);
    const emitter = {};
    alloc.add({ start: 0, end: 4, level: 0.5, group: emitter, data: 'e1' });
    alloc.add({ start: 0.2, end: 4, level: 0.5, group: emitter, data: 'e2' });
    alloc.add({ start: 0, end: 4, level: 0.05, group: null, data: 'elsewhere' });
    // Room is left globally, but the emitter is full: its oldest (most decayed) voice goes.
    expect([...alloc.makeRoom(0.3, emitter)]).toEqual(['e1']);
    expect([...alloc.makeRoom(0.3, null)]).toEqual([]);
  });
});

describe('releasing an emitter', () => {
  it('forgets that emitter’s voices so they no longer count or get stolen', () => {
    const alloc = new VoiceAllocator<string>(opts);
    const gone = {};
    const kept = {};
    alloc.add({ start: 0, end: 4, level: 0.01, group: gone, data: 'g1' });
    alloc.add({ start: 0, end: 4, level: 0.01, group: gone, data: 'g2' });
    alloc.add({ start: 0, end: 4, level: 0.5, group: kept, data: 'k1' });
    alloc.releaseGroup(gone);
    expect(alloc.active(0.1)).toBe(1);
    alloc.add({ start: 0, end: 4, level: 0.6, group: null, data: 'n1' });
    alloc.add({ start: 0, end: 4, level: 0.7, group: null, data: 'n2' });
    alloc.add({ start: 0, end: 4, level: 0.8, group: null, data: 'n3' });
    // At the cap the quietest *remaining* voice goes, never a released one.
    expect([...alloc.makeRoom(0.1, null)]).toEqual(['k1']);
  });
});

describe('whether to ask the browser to resume', () => {
  it('asks only for a suspended or interrupted realtime context during a user activation', () => {
    expect(mayRequestResume({ realtime: true, state: 'suspended', activationActive: true })).toBe(true);
    expect(mayRequestResume({ realtime: true, state: 'interrupted', activationActive: true })).toBe(true);
    // No activation: Chrome would leave resume() pending forever.
    expect(mayRequestResume({ realtime: true, state: 'suspended', activationActive: false })).toBe(false);
    // Browsers without navigator.userActivation: try (the gesture handler is the activation).
    expect(mayRequestResume({ realtime: true, state: 'suspended', activationActive: null })).toBe(true);
    expect(mayRequestResume({ realtime: true, state: 'running', activationActive: true })).toBe(false);
    expect(mayRequestResume({ realtime: true, state: 'closed', activationActive: true })).toBe(false);
    expect(mayRequestResume({ realtime: false, state: 'suspended', activationActive: true })).toBe(false);
  });
});
