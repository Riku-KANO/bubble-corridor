// S-25 gondola.rise を鳴らす時刻（実装担当が追加）。乗るたびに一度だけ、案内の頭（遅らせて）か乗車の頭。途中から乗るときは鳴らさない
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRiseSounder } from './rise-sound';

const DELAY_SEC = 1.5;

function make() {
  let n = 0;
  const s = createRiseSounder(() => n++, DELAY_SEC);
  return { s, count: () => n };
}

describe('gondola.rise を鳴らす時刻', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('案内が出る乗り方（画面）では案内に入って遅れて一度。乗車の頭では鳴らさない', () => {
    const { s, count } = make();
    s.guideStarted('screen');
    expect(count()).toBe(0);
    vi.advanceTimersByTime(DELAY_SEC * 1000 - 1);
    expect(count()).toBe(0);
    vi.advanceTimersByTime(2);
    expect(count()).toBe(1);
    vi.advanceTimersByTime(4500);
    s.rideStarted(0);
    expect(count()).toBe(1);
  });

  it('案内を遅れの前に飛ばしたら、待っている音を取り消し、乗車の頭で一度', () => {
    const { s, count } = make();
    s.guideStarted('screen');
    vi.advanceTimersByTime(500);
    s.rideStarted(0);
    expect(count()).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(count()).toBe(1);
  });

  it('案内のない乗り方（2回目以降・もう一度乗る）は乗車の頭で一度', () => {
    const { s, count } = make();
    s.rideStarted(0);
    expect(count()).toBe(1);
  });

  it('VR は案内が画面に出ないので、案内の状態を通っても乗車の頭で一度', () => {
    const { s, count } = make();
    s.guideStarted('vr');
    vi.advanceTimersByTime(5000);
    expect(count()).toBe(0);
    s.rideStarted(0);
    expect(count()).toBe(1);
  });

  it('?t= で途中から乗るときは鳴らさない', () => {
    const { s, count } = make();
    s.rideStarted(590);
    expect(count()).toBe(0);
  });

  it('乗るたびに数え直す（二度目の乗車でも一度鳴る）', () => {
    const { s, count } = make();
    s.guideStarted('screen');
    vi.advanceTimersByTime(2000);
    s.rideStarted(0);
    s.rideStarted(0);
    expect(count()).toBe(2);
  });
});
