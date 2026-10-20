// 生の HTML を挿入せずに要素を作る小さな道具（innerHTML などは Lint で禁止）。
// 文字は必ず textContent / テキストノードで入れるので、文言や外から来る値が HTML として解釈されることはない。

export type Child = Node | string | number | null | undefined | false;

type Listeners = { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };

export interface Props {
  readonly class?: string;
  readonly text?: string;
  readonly hidden?: boolean;
  /** イベントの購読 */
  readonly on?: Listeners;
  /** CSS のカスタムプロパティ（--name）の値 */
  readonly vars?: Readonly<Record<string, string | number>>;
  /** それ以外は属性として入れる（true は空の属性、false・null・undefined は入れない） */
  readonly [attr: string]: unknown;
}

function applyProps(el: Element, props: Props | null): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', String(value));
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'hidden') (el as HTMLElement).hidden = Boolean(value);
    else if (key === 'on') {
      for (const [type, fn] of Object.entries(value as Record<string, EventListener>)) el.addEventListener(type, fn);
    } else if (key === 'vars') {
      for (const [name, v] of Object.entries(value as Record<string, string | number>)) (el as HTMLElement).style.setProperty(name, String(v));
    } else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function appendChildren(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** HTML の要素を作る */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG の要素を作る */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

// ── 差分だけを反映する小道具（同じ値なら DOM に触らない） ─────────────────────

export function setText(el: Element, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** 真偽の属性（hidden・disabled・inert など）を入れる・外す */
export function setFlag(el: Element, name: string, on: boolean): void {
  if (on !== el.hasAttribute(name)) {
    if (on) el.setAttribute(name, '');
    else el.removeAttribute(name);
  }
}

export function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

export function setClass(el: Element, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

export function setVar(el: HTMLElement, name: string, value: string | number): void {
  const v = String(value);
  if (el.style.getPropertyValue(name) !== v) el.style.setProperty(name, v);
}

/** CSS の動き（class に付けた animation）を最初からやり直す */
export function replay(el: HTMLElement, className: string): void {
  el.classList.remove(className);
  void el.offsetWidth; // 再計算を強制して、アニメーションを最初から始める
  el.classList.add(className);
}
