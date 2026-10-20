import { describe, expect, it } from 'vitest';
import { INITIAL_FLOW, reduceFlow, type FlowAction, type FlowState } from './flow';

const first = { seenGuide: false };
const again = { seenGuide: true };

function run(actions: FlowAction[], ctx = first, from: FlowState = INITIAL_FLOW): FlowState {
  return actions.reduce((s, a) => reduceFlow(s, a, ctx), from);
}

describe('UI-1 画面の流れ', () => {
  it('待ち列は読み込みが終わるまで入口へ進めない', () => {
    expect(run([{ type: 'enterHome' }]).screen).toBe('queue');
    expect(run([{ type: 'loaded' }, { type: 'enterHome' }]).screen).toBe('home');
  });

  it('初回は乗車前の案内を挟み、案内の後に乗車する', () => {
    const s = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'screen' }]);
    expect(s.screen).toBe('guide');
    expect(reduceFlow(s, { type: 'guideDone' }, first).screen).toBe('riding');
  });

  it('2回目以降は案内を出さない', () => {
    const s = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'screen' }], again);
    expect(s.screen).toBe('riding');
  });

  it('VR で乗ると viewMode が vr になる', () => {
    const s = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'vr' }], again);
    expect(s).toMatchObject({ screen: 'riding', viewMode: 'vr' });
  });

  it('ポーズして続ける・降りると入口へ戻る', () => {
    const riding = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'screen' }], again);
    const paused = reduceFlow(riding, { type: 'pause' }, again);
    expect(paused.screen).toBe('pause');
    expect(reduceFlow(paused, { type: 'resume' }, again).screen).toBe('riding');
    expect(reduceFlow(paused, { type: 'alight' }, again).screen).toBe('home');
  });

  it('乗車が終わるとライドフォトへ。もう一度乗るは待ち列と案内を飛ばす', () => {
    const riding = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'screen' }, { type: 'guideDone' }]);
    const photo = reduceFlow(riding, { type: 'rideEnd' }, again);
    expect(photo.screen).toBe('photo');
    expect(reduceFlow(photo, { type: 'rideAgain' }, first).screen).toBe('riding');
    expect(reduceFlow(photo, { type: 'toHome' }, again).screen).toBe('home');
  });

  it('入口から設定などを開き、戻ると開いた画面へ帰る', () => {
    const home = run([{ type: 'loaded' }, { type: 'enterHome' }]);
    const settings = reduceFlow(home, { type: 'open', screen: 'settings' }, first);
    expect(settings.screen).toBe('settings');
    expect(reduceFlow(settings, { type: 'back' }, first).screen).toBe('home');
    const photo: FlowState = { ...home, screen: 'photo' };
    const shelf = reduceFlow(photo, { type: 'open', screen: 'shelf' }, first);
    expect(reduceFlow(shelf, { type: 'back' }, first).screen).toBe('photo');
  });

  it('遷移できない組み合わせでは同じ state を返す（何も起きない）', () => {
    const home = run([{ type: 'loaded' }, { type: 'enterHome' }]);
    for (const a of [{ type: 'pause' }, { type: 'resume' }, { type: 'rideEnd' }, { type: 'back' }, { type: 'guideDone' }] as FlowAction[]) {
      expect(reduceFlow(home, a, first)).toBe(home);
    }
  });

  it('VR のセッションが乗車前の案内の途中で終わったら、入口へ戻る', () => {
    const guide = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'vr' }], first);
    expect(guide.screen).toBe('guide');
    expect(reduceFlow(guide, { type: 'xrEnded' }, first)).toMatchObject({ screen: 'home', viewMode: 'screen' });
  });

  it('VR のセッションが終わったら、乗車中ならポーズにして画面で続けられるようにする', () => {
    const riding = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'vr' }], again);
    expect(reduceFlow(riding, { type: 'xrEnded' }, again)).toMatchObject({ screen: 'pause', viewMode: 'screen' });
  });
});
