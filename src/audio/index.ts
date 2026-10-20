// 音楽と音（楽曲の構成データ、演奏、触れた音、環境音、効果音）。
// STUB: 署名は確定。中身は audio 担当が本実装に置き換える。今は音を出さず、実時間の時計を返す。
import type { AudioEngine } from '../contracts/audio';
import type { EventBus } from '../contracts/events';
import { createWallClock } from '../ride/clock';

export interface AudioEngineOptions {
  /** テストや確認ページで AudioContext を差し替える */
  readonly context?: AudioContext;
}

export function createAudioEngine(_bus: EventBus, _opts: AudioEngineOptions = {}): AudioEngine {
  const clock = createWallClock();
  let unlocked = false;
  return {
    clock,
    get unlocked() {
      return unlocked;
    },
    async unlock() {
      unlocked = true;
    },
    setDoor() {},
    touch() {
      return clock.time;
    },
    chime() {},
    lure() {},
    sfx() {},
    setListener() {},
    setVolumes() {},
    playLobby() {},
    stopLobby() {},
    dispose() {},
  };
}
