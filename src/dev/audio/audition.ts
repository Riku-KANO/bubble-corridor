// 確認ページ用: 出来事（キュー）の効果音を、いますぐ鳴らして聴く。
// 乗車中の効果音はエンジンが先読みの中で乗車の秒から予約するので、ボタンから単体で聴くための別の経路を持つ
// （別の AudioContext に、エンジンと同じ配線と効果音の定義で鳴らす。本番のエンジンには、確認用の入り口を持たせない）。
import type { Cue } from '../../contracts/events';
import type { DoorChoice } from '../../contracts/ids';
import type { Volumes } from '../../contracts/audio';
import { cueEffect, playEvents } from '../../audio/effects';
import { createGraph } from '../../audio/graph';
import type { Graph } from '../../audio/graph';
import { harmonyAt } from '../../audio/score';

export interface Auditioner {
  /** cue の効果音を、cue.t の和音で鳴らす */
  play(cue: Cue, door: DoorChoice): void;
  setVolumes(v: Volumes): void;
}

export function createAuditioner(): Auditioner {
  let ctx: AudioContext | null = null;
  let graph: Graph | null = null;
  let bus: GainNode | null = null;
  let volumes: Volumes | null = null;
  const ensure = (): AudioContext => {
    if (!ctx || !graph || !bus) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      graph = createGraph(ctx);
      if (volumes) graph.mixer.setVolumes(volumes, 0.001);
      bus = ctx.createGain();
      bus.connect(graph.sfxGate);
      const send = ctx.createGain();
      send.gain.value = 0.5;
      bus.connect(send).connect(graph.reverb('large').send);
    }
    return ctx;
  };
  return {
    play(cue, door) {
      const c = ensure();
      void c.resume();
      const evs = cueEffect(cue, harmonyAt(cue.t + 0.01, door));
      if (evs && bus) playEvents(c, bus, evs, c.currentTime + 0.02);
    },
    setVolumes(v) {
      volumes = v;
      graph?.mixer.setVolumes(v);
    },
  };
}
