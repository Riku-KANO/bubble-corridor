// 見回すと触れる（PC とスマートフォン）。
// STUB: 署名は確定。中身は input 担当が本実装に置き換える。
import type { InputDeps, LookControl, LookOptions, LookState, TouchInput } from '../contracts/input';
import type { Touchable } from '../contracts/room';

export function createLookControl(_deps: InputDeps, _opts: LookOptions): LookControl {
  const look: LookState = { yaw: 0, pitch: 0 };
  return {
    look,
    setOptions() {},
    recenter() {
      look.yaw = 0;
      look.pitch = 0;
    },
    update() {},
    setEnabled() {},
    dispose() {},
  };
}

export function createTouchInput(_deps: InputDeps): TouchInput {
  const state: { list: readonly Touchable[] } = { list: [] };
  return {
    setTouchables(list) {
      state.list = list;
    },
    setGazeDwell() {},
    update() {},
    onIdleChime() {},
    setEnabled() {},
    dispose() {
      state.list = [];
    },
  };
}
