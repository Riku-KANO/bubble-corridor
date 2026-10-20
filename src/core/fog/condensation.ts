// 曇りと指の文字の効果。案1と共有する。
// ポーズ（泡の内側に息を吹きかけたような曇り）、乗車前の案内（曇りガラスの立て札に指で書く）、
// 乗車中の案内（泡の内側の曇りに書く）に使う。canvas に描くので、DOM にも 3D のテクスチャにも使える。
// STUB: 署名は確定。中身は M0（core-visual 担当）で本実装に置き換える。

export interface WriteOptions {
  /** 全行を書き終えるまでの秒 */
  readonly durationSec?: number;
  /** CSS の font（例: "300 28px 'Zen Old Mincho'"） */
  readonly font?: string;
  readonly align?: 'center' | 'left';
  /** 行の間隔（文字の高さに対する倍率） */
  readonly lineHeight?: number;
}

export interface Condensation {
  /** 描画先。DOM に置くか、CanvasTexture の元にする */
  readonly canvas: HTMLCanvasElement;
  /** 曇りの濃さ（0〜1） */
  readonly density: number;
  /** 曇らせる（中心から広がる） */
  fogIn(durationSec: number): Promise<void>;
  /** 晴らす */
  clear(durationSec: number): Promise<void>;
  /** 指でなぞった文字を書く。書き終わると resolve */
  write(lines: readonly string[], opts?: WriteOptions): Promise<void>;
  /** 書いた文字を曇りに溶かして消す */
  erase(durationSec: number): Promise<void>;
  /** 毎フレーム（requestAnimationFrame の外から動かすとき）。now は秒 */
  tick(now: number): void;
  resize(width: number, height: number, dpr: number): void;
  dispose(): void;
}

export interface CondensationOptions {
  readonly width: number;
  readonly height: number;
  readonly dpr?: number;
  /** 曇りの色（CSS の色） */
  readonly tint?: string;
  /** 時刻の出どころ（テストで差し替える）。既定は performance.now()/1000 */
  readonly now?: () => number;
  /** 自分で requestAnimationFrame を回すか（既定 true。3D のテクスチャにするときは false で tick を呼ぶ） */
  readonly autoTick?: boolean;
}

export function createCondensation(opts: CondensationOptions): Condensation {
  // STUB: 何も描かない
  const canvas = document.createElement('canvas');
  canvas.width = opts.width;
  canvas.height = opts.height;
  let density = 0;
  return {
    canvas,
    get density() {
      return density;
    },
    async fogIn() {
      density = 1;
    },
    async clear() {
      density = 0;
    },
    async write() {},
    async erase() {},
    tick() {},
    resize(w, h) {
      canvas.width = w;
      canvas.height = h;
    },
    dispose() {},
  };
}
