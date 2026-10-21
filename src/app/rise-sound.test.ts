// S-25 gondola.rise を鳴らす時刻（実装担当が追加）。乗るたびに一度だけ、案内の頭か乗車の頭。途中から乗るときは鳴らさない
import { describe, expect, it } from 'vitest';
import { createRiseSounder } from './rise-sound';

function make() {
  let n = 0;
  const s = createRiseSounder(() => n++);
  return { s, count: () => n };
}

describe('gondola.rise を鳴らす時刻', () => {
  it('案内が出る乗り方（画面）では案内の頭で一度。乗車の頭では鳴らさない', () => {
    const { s, count } = make();
    s.guideStarted('screen');
    expect(count()).toBe(1);
    s.rideStarted(0);
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
    s.rideStarted(0);
    s.rideStarted(0);
    expect(count()).toBe(2);
  });
});
