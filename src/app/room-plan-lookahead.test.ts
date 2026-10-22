// S-29 レビュー1巡目 P1-1: 先の時刻に描く部屋を先に読む（実装担当が追加）。
// 岸の区間（660 秒〜）は降車の乗り場を頭から描く。天球の間に読んでおかないと、岸の頭で読み込みの終わった乗り場がそのまま場面に足され、
// 先読みなしで初めて描かれて止まる。
import { describe, expect, it } from 'vitest';
import { RIDE_DURATION } from '../config';
import { createRide, generateRideData, streamingPlan } from '../ride';
import type { ScreenId } from '../contracts/ui';
import { LOOKAHEAD_SEC, holdsSceneForVrExit, withLookahead } from './room-plan';

const ride = createRide(generateRideData());
const aheadOf = (t: number) => streamingPlan(Math.min(RIDE_DURATION, t + LOOKAHEAD_SEC), ride);

describe('先を見て読む部屋', () => {
  it('岸の頭（660 秒）に描く乗り場は、天球の間（先を見る秒数の手前から）に持つ部屋に入る', () => {
    const before = withLookahead(streamingPlan(640, ride), aheadOf(640));
    expect(before.keep).toContain('platform');
    // 見せる部屋はいまの計画のまま（先読みで場面に足さない）
    expect(before.visible).toBe(streamingPlan(640, ride).visible);
    expect(before.visible).not.toContain('platform');
    // 先を見る窓の手前ではまだ持たない
    const early = withLookahead(streamingPlan(630, ride), aheadOf(630));
    expect(early).toBe(streamingPlan(630, ride));
  });

  it('次の部屋は、いまの計画がもう持っているので、計画は同じ参照のまま（余計な計画の切り替えを起こさない）', () => {
    for (const t of [10, 100, 215, 340, 470, 700, 740, 770]) {
      const plan = streamingPlan(t, ride);
      expect(withLookahead(plan, aheadOf(t)), `t=${t}`).toBe(plan);
    }
  });

  it('同じ組には同じ参照を返し、凍結してある（RoomManager は参照で同じ計画かを比べる）', () => {
    const plan = streamingPlan(645, ride);
    const a = withLookahead(plan, aheadOf(645));
    expect(withLookahead(plan, aheadOf(645))).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.keep)).toBe(true);
    expect(a.keep).toEqual(expect.arrayContaining([...plan.keep]));
    expect(new Set(a.keep).size).toBe(a.keep.length);
  });

  it('先を見る秒数は、次の部屋を描き始める窓より長い（読み込みと先読みの余裕）', () => {
    expect(LOOKAHEAD_SEC).toBeGreaterThan(15);
  });
});

describe('VR を出る途中の場面', () => {
  it('VR のセッションが続いているあいだに画面が入口になったら、場面を直前のまま保つ。それ以外は保たない', () => {
    expect(holdsSceneForVrExit(true, 'home')).toBe(true);
    const others: ScreenId[] = ['queue', 'guide', 'riding', 'pause', 'photo', 'shelf', 'settings', 'howto', 'credits'];
    for (const s of others) expect(holdsSceneForVrExit(true, s), s).toBe(false);
    for (const s of [...others, 'home' as const]) expect(holdsSceneForVrExit(false, s), `VR でない ${s}`).toBe(false);
  });
});
