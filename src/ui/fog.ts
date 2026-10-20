// 曇り（core/fog/condensation）を画面の要素に重ねる。
// 曇りは canvas に描く部品。文字は DOM に別に出す（読み上げと、曇りが何も描かない環境のため）ので、
// ここでは「曇らせる・晴らす」だけを使い、どの呼び出しが失敗しても画面は止めない。
// 動かすのは出ている間だけ（autoTick を切って、自分の requestAnimationFrame で tick を呼ぶ）。隠れた曇りは動かさない。
import { createCondensation, type Condensation } from '../core/fog/condensation';

export interface Fog {
  /** 曇らせる（初回はここで canvas を作って host に置く） */
  show(sec: number): void;
  /** 晴らす */
  hide(sec: number): void;
  dispose(): void;
}

export interface FogOptions {
  /** 曇りの色（CSS の色） */
  readonly tint?: string;
}

const quiet = (): void => undefined;
/** 晴れ終わってから、動かすのをやめるまでの余裕（ms） */
const SETTLE_MS = 120;

export function createFog(host: HTMLElement, opts: FogOptions = {}): Fog {
  let fog: Condensation | null = null;
  let failed = false;
  let raf = 0;
  /** この時刻（ms）を過ぎたら動かすのをやめる。Infinity は出している間ずっと */
  let runUntil = 0;
  const onResize = () => fit();

  function fit(): void {
    if (!fog) return;
    const box = host.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    try {
      fog.resize(Math.round(box.width), Math.round(box.height), Math.min(window.devicePixelRatio || 1, 2));
    } catch {
      // 大きさを変えられなくても続ける
    }
  }

  function frame(ms: number): void {
    raf = 0;
    if (!fog || ms > runUntil) return;
    try {
      fog.tick(ms / 1000);
    } catch {
      // 描けなくても続ける
    }
    raf = requestAnimationFrame(frame);
  }

  function run(): void {
    if (raf !== 0 || typeof requestAnimationFrame !== 'function') return;
    raf = requestAnimationFrame(frame);
  }

  function ensure(): Condensation | null {
    if (fog || failed) return fog;
    try {
      const box = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(box.width || window.innerWidth));
      const height = Math.max(1, Math.round(box.height || window.innerHeight));
      fog = createCondensation({ width, height, dpr: Math.min(window.devicePixelRatio || 1, 2), tint: opts.tint, autoTick: false });
      fog.canvas.classList.add('fog-canvas');
      fog.canvas.setAttribute('aria-hidden', 'true');
      host.prepend(fog.canvas);
      window.addEventListener('resize', onResize);
      fit();
    } catch {
      failed = true;
      fog = null;
    }
    return fog;
  }

  return {
    show(sec) {
      const f = ensure();
      if (!f) return;
      fit();
      runUntil = Infinity;
      run();
      try {
        f.fogIn(sec).catch(quiet);
      } catch {
        // 曇らせられなくても DOM の表示は続く
      }
    },
    hide(sec) {
      if (!fog) return;
      runUntil = performance.now() + sec * 1000 + SETTLE_MS;
      try {
        fog.clear(sec).catch(quiet);
      } catch {
        // 晴らせなくても続ける
      }
    },
    dispose() {
      window.removeEventListener('resize', onResize);
      if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      runUntil = 0;
      try {
        fog?.dispose();
      } catch {
        // 片付けに失敗しても続ける
      }
      fog?.canvas.remove();
      fog = null;
    },
  };
}
