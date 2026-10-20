// 音量の系統（全体 / 音楽 / 効果音 / 環境音）。案1と共有する。

export interface MixerVolumes {
  readonly master: number;
  readonly music: number;
  readonly sfx: number;
  readonly ambient: number;
}

export interface Mixer {
  readonly master: GainNode;
  readonly music: GainNode;
  readonly sfx: GainNode;
  readonly ambient: GainNode;
  /** 音量を変える（0〜1）。クリックノイズを避けるため rampSec かけて動かす */
  setVolumes(v: MixerVolumes, rampSec?: number): void;
}

/** 人の耳に合わせ、つまみの値（0〜1）を2乗して音量にする */
export function sliderToGain(v: number): number {
  const x = Math.min(1, Math.max(0, v));
  return x * x;
}

export function createMixer(ctx: BaseAudioContext, dest: AudioNode = ctx.destination): Mixer {
  const master = ctx.createGain();
  const music = ctx.createGain();
  const sfx = ctx.createGain();
  const ambient = ctx.createGain();
  music.connect(master);
  sfx.connect(master);
  ambient.connect(master);
  master.connect(dest);
  return {
    master,
    music,
    sfx,
    ambient,
    setVolumes(v, rampSec = 0.05) {
      const t = ctx.currentTime;
      for (const [node, value] of [
        [master, v.master],
        [music, v.music],
        [sfx, v.sfx],
        [ambient, v.ambient],
      ] as const) {
        node.gain.cancelScheduledValues(t);
        node.gain.setTargetAtTime(sliderToGain(value), t, Math.max(0.001, rampSec / 3));
      }
    },
  };
}
