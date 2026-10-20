// 画面の部品が共通で受け取るもの。画面ごとの作りは screens/ に置く。
import type { UiCommands, UiState } from '../contracts/ui';
import type { MessageKey, MessageVars } from './i18n';

export type Tr = (key: MessageKey, vars?: MessageVars) => string;

export interface ScreenEnv {
  readonly commands: UiCommands;
  /** 今の言語で文言を引く */
  readonly tr: Tr;
  /** Blob を表示用の URL にする。使えない環境（jsdom）では null */
  blobUrl(blob: Blob): string | null;
}

export interface Screen {
  readonly el: HTMLElement;
  /** 状態を反映する。表示中の画面にだけ呼ばれ、変わったところだけ DOM に触る */
  update(state: UiState): void;
  /**
   * 表示になった（書く演出を最初から、フォーカスなど）。
   * delaySec は、画面が現れ始めるまでの秒（前の画面が消えるのを待つ間）。演出の始まりをこの分だけ遅らせる
   */
  show?(delaySec: number): void;
  /** 触れる状態になった（delay が過ぎた）。最初のフォーカスを置く。見えない間は呼ばれない */
  focus?(): void;
  /** 見えなくなった（タイマーや曇りを片付ける） */
  hide?(): void;
  dispose?(): void;
}
