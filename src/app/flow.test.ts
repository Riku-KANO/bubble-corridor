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

  it('VR では初回でも乗車前の案内（画面の DOM）を飛ばす（ヘッドセットの中からは見えず、6秒何も見えないまま待たせない。S-25 の申し送り）', () => {
    const vr = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'vr' }], first);
    expect(vr).toMatchObject({ screen: 'riding', viewMode: 'vr' });
    // 画面で乗るときの初回は、これまでどおり案内を出す
    expect(run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'screen' }], first).screen).toBe('guide');
  });

  it('画面で乗る案内の途中に VR の終わりが届いても、何も変えない', () => {
    const guide = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'screen' }], first);
    expect(reduceFlow(guide, { type: 'xrEnded' }, first)).toBe(guide);
  });

  it('VR のセッションが終わったら、乗車中ならポーズにして画面で続けられるようにする', () => {
    const riding = run([{ type: 'loaded' }, { type: 'enterHome' }, { type: 'ride', mode: 'vr' }], again);
    expect(reduceFlow(riding, { type: 'xrEnded' }, again)).toMatchObject({ screen: 'pause', viewMode: 'screen' });
  });
});
