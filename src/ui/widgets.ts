// 設定やポーズで使うガラスの部品（切り替え、スイッチ、スライダー）。
// 行（Row）は一度だけ作り、状態が変わったら sync で変わったところだけ書き換える。
import type { Settings } from '../contracts/ui';
import { h, setAttr, setText, setVar } from './dom';
import type { MessageKey, MessageVars } from './i18n';
import type { Tr } from './screen';

let uid = 0;
export const nextId = (prefix: string): string => `ui-${prefix}-${++uid}`;

export type LabelRef = MessageKey | { readonly key: MessageKey; readonly vars: MessageVars };

export const labelText = (tr: Tr, ref: LabelRef): string => (typeof ref === 'string' ? tr(ref) : tr(ref.key, ref.vars));

export interface Row {
  readonly el: HTMLElement;
  sync(settings: Settings, tr: Tr): void;
}

/** 矢印キーで項目を行き来し、選ぶ（ラジオとタブの作法） */
export function arrowNav(container: HTMLElement, itemSelector: string): void {
  container.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const items = [...container.querySelectorAll<HTMLElement>(itemSelector)].filter((x) => !x.hidden);
    const i = items.findIndex((x) => x === document.activeElement);
    if (i < 0 || items.length === 0) return;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else next = items.length - 1;
    e.preventDefault();
    items[next].focus();
    items[next].click();
  });
}

export interface SegmentedConfig<T extends string | number> {
  readonly setting: string;
  readonly label: MessageKey;
  readonly options: readonly { readonly value: T; readonly label: LabelRef }[];
  get(s: Settings): T;
  pick(value: T): void;
}

/** 数個の選択肢から一つ選ぶ（ガラスの粒が並ぶ） */
export function segmentedRow<T extends string | number>(cfg: SegmentedConfig<T>): Row {
  const labelId = nextId('label');
  const label = h('span', { class: 'row-label', id: labelId });
  const group = h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': labelId });
  const buttons = cfg.options.map((o) =>
    h('button', { type: 'button', class: 'seg-opt', role: 'radio', 'data-value': String(o.value), on: { click: () => cfg.pick(o.value) } }),
  );
  group.append(...buttons);
  arrowNav(group, '.seg-opt');
  const el = h('div', { class: 'row', 'data-setting': cfg.setting }, label, group);
  return {
    el,
    sync(settings, tr) {
      setText(label, tr(cfg.label));
      const current = cfg.get(settings);
      const hit = Math.max(0, cfg.options.findIndex((o) => o.value === current));
      cfg.options.forEach((o, i) => {
        setText(buttons[i], labelText(tr, o.label));
        setAttr(buttons[i], 'aria-checked', String(o.value === current));
        setAttr(buttons[i], 'tabindex', i === hit ? '0' : '-1');
      });
    },
  };
}

export interface SwitchConfig {
  readonly setting: string;
  readonly label: MessageKey;
  readonly desc?: MessageKey;
  get(s: Settings): boolean;
  pick(on: boolean): void;
}

/** 入り切り（ガラスのスイッチ） */
export function switchRow(cfg: SwitchConfig): Row & { readonly button: HTMLButtonElement } {
  const labelId = nextId('label');
  const label = h('span', { class: 'row-label', id: labelId });
  const desc = cfg.desc ? h('span', { class: 'row-desc' }) : null;
  let on = false;
  const button = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-labelledby': labelId, on: { click: () => cfg.pick(!on) } }, h('span', { class: 'switch-knob' }));
  const el = h('div', { class: 'row row-switch', 'data-setting': cfg.setting }, h('div', { class: 'row-text' }, label, desc), button);
  return {
    el,
    button,
    sync(settings, tr) {
      on = cfg.get(settings);
      setText(label, tr(cfg.label));
      if (desc && cfg.desc) setText(desc, tr(cfg.desc));
      setAttr(button, 'aria-checked', String(on));
    },
  };
}

export interface SliderConfig {
  readonly setting: string;
  readonly label: MessageKey;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  get(s: Settings): number;
  pick(value: number): void;
  format(value: number, tr: Tr): string;
}

/** 連続した値（ガラスの玉をすべらせる） */
export function sliderRow(cfg: SliderConfig): Row {
  const labelId = nextId('label');
  const label = h('span', { class: 'row-label', id: labelId });
  const value = h('output', { class: 'row-value', 'aria-hidden': 'true' });
  let trNow: Tr | null = null;
  const input = h('input', {
    type: 'range',
    class: 'slider',
    min: cfg.min,
    max: cfg.max,
    step: cfg.step,
    'aria-labelledby': labelId,
    on: {
      input: () => {
        const v = Number(input.value);
        paint(v);
        cfg.pick(v);
      },
    },
  });
  function paint(v: number): void {
    setVar(input, '--fill', `${(((v - cfg.min) / (cfg.max - cfg.min)) * 100).toFixed(1)}%`);
    if (trNow) {
      const text = cfg.format(v, trNow);
      setText(value, text);
      setAttr(input, 'aria-valuetext', text);
    }
  }
  const el = h('div', { class: 'row row-slider', 'data-setting': cfg.setting }, label, h('div', { class: 'row-control' }, input, value));
  return {
    el,
    sync(settings, tr) {
      trNow = tr;
      setText(label, tr(cfg.label));
      const v = cfg.get(settings);
      if (Number(input.value) !== v) input.value = String(v);
      paint(v);
    },
  };
}

/** 説明の一文 */
export function noteRow(): { readonly el: HTMLElement; sync(text: string): void } {
  const el = h('p', { class: 'row-note' });
  return { el, sync: (text) => setText(el, text) };
}
