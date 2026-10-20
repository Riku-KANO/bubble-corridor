// 写真の見せ方（ライドフォトと写真の棚で共通）。ガラスの中に浮かぶ写真、保存の形、保存と共有。
// ライドフォトでは、ここに 3 枚から選ぶ小さなガラス玉（data-shot）も並ぶ。
import { HIDDEN_BUBBLE_SECTIONS } from '../../config';
import type { ShotId } from '../../contracts/ids';
import type { FrameTier, PhotoFormat, PhotoRecord } from '../../contracts/photo';
import { arrowNav } from '../widgets';
import { h, setAttr, setClass, setFlag, setHidden, setText } from '../dom';
import type { ScreenEnv } from '../screen';

export const SHOT_ORDER: readonly ShotId[] = ['bloom', 'freeze', 'constellation'];

/** 隠れた泡の数で額縁が変わる（0〜1 通常、2〜3 銀、4 金、5 虹色） */
export function frameTier(hiddenTotal: number): FrameTier {
  if (hiddenTotal >= HIDDEN_BUBBLE_SECTIONS.length) return 'rainbow';
  if (hiddenTotal >= 4) return 'gold';
  if (hiddenTotal >= 2) return 'silver';
  return 'plain';
}

export interface PhotoPane {
  readonly el: HTMLElement;
  /** 保存・共有の隣に足すボタン（写真の棚の「削除」） */
  readonly actions: HTMLElement;
  /** 表示中の写真 */
  current(): PhotoRecord | null;
  update(record: PhotoRecord | null): void;
}

export function createPhotoPane(env: ScreenEnv, opts: { readonly choices: boolean }): PhotoPane {
  const { commands } = env;
  let record: PhotoRecord | null = null;
  let format: PhotoFormat = 'wide';

  const img = h('img', { class: 'photo-img', alt: '', decoding: 'async', draggable: 'false', hidden: true });
  const developing = h('p', { class: 'photo-developing' });
  const glass = h('div', { class: 'photo-glass' }, img, h('div', { class: 'photo-sheen', 'aria-hidden': 'true' }), developing);
  const stage = h('div', { class: 'photo-stage' }, h('div', { class: 'photo-rim', 'aria-hidden': 'true' }), glass);

  // 3枚から選ぶ（ライドフォトだけ）
  const orbs = new Map<ShotId, { readonly button: HTMLButtonElement; readonly image: HTMLImageElement }>();
  const choices = h('div', { class: 'shot-choices', role: 'group', hidden: !opts.choices });
  if (opts.choices) {
    for (const shot of SHOT_ORDER) {
      const image = h('img', { alt: '', decoding: 'async', draggable: 'false', hidden: true });
      const button = h('button', { type: 'button', class: 'orb', 'data-shot': shot, 'aria-pressed': 'false', on: { click: () => record && commands.choosePhoto(record, shot) } }, image, h('span', { class: 'orb-shine', 'aria-hidden': 'true' }));
      orbs.set(shot, { button, image });
      choices.append(button);
    }
  }

  // 保存の形
  const formatLabel = h('span', { class: 'row-label' });
  const formatButtons = (['wide', 'square'] as const).map((f) => h('button', { type: 'button', class: 'seg-opt', role: 'radio', 'data-value': f, on: { click: () => setFormat(f) } }));
  const formatGroup = h('div', { class: 'seg', role: 'radiogroup' }, ...formatButtons);
  arrowNav(formatGroup, '.seg-opt');
  const save = h('button', { type: 'button', class: 'btn', on: { click: () => record && fire(commands.savePhoto(record, format)) } });
  const share = h('button', { type: 'button', class: 'btn', on: { click: () => record && fire(commands.sharePhoto(record, format)) } });
  const actions = h('div', { class: 'pane-buttons' }, save, share);
  const controls = h('div', { class: 'pane-controls' }, h('div', { class: 'pane-format' }, formatLabel, formatGroup), actions);

  const el = h('div', { class: 'photo-pane', 'data-format': format, 'data-tier': 'plain' }, stage, choices, controls);

  /** 保存と共有は非同期。失敗しても画面は止めない（app 側が扱う） */
  function fire(p: Promise<void>): void {
    Promise.resolve(p).catch(() => undefined);
  }

  function setFormat(f: PhotoFormat): void {
    format = f;
    paintFormat();
  }

  function paintFormat(): void {
    setAttr(el, 'data-format', format);
    formatButtons.forEach((b, i) => {
      const on = (['wide', 'square'] as const)[i] === format;
      setAttr(b, 'aria-checked', String(on));
      setAttr(b, 'tabindex', on ? '0' : '-1');
    });
  }

  function shotImage(r: PhotoRecord, shot: ShotId): Blob | undefined {
    return r.shots.find((x) => x.shot === shot)?.image;
  }

  function setImage(target: HTMLImageElement, blob: Blob | undefined): boolean {
    const url = blob ? env.blobUrl(blob) : null;
    if (url) {
      if (target.getAttribute('src') !== url) target.setAttribute('src', url);
    } else if (target.hasAttribute('src')) target.removeAttribute('src');
    setHidden(target, url === null);
    return url !== null;
  }

  paintFormat();

  return {
    el,
    actions,
    current: () => record,
    update(next) {
      const { tr } = env;
      record = next;
      setText(developing, tr('photo.developing'));
      setText(save, tr('photo.save'));
      setText(share, tr('photo.share'));
      setText(formatLabel, tr('photo.format'));
      setAttr(formatGroup, 'aria-label', tr('photo.format'));
      setAttr(img, 'alt', tr('photo.alt'));
      setText(formatButtons[0], tr('photo.wide'));
      setText(formatButtons[1], tr('photo.square'));
      setFlag(save, 'disabled', next === null);
      setFlag(share, 'disabled', next === null);
      setAttr(el, 'data-tier', next ? frameTier(next.meta.hiddenTotal) : 'plain');
      const chosen = next ? shotImage(next, next.chosen) ?? next.shots[0]?.image : undefined;
      const shown = setImage(img, chosen);
      setHidden(developing, shown);
      setClass(glass, 'is-empty', !shown);
      if (opts.choices) {
        setAttr(choices, 'aria-label', tr('photo.pick'));
        for (const [shot, { button, image }] of orbs) {
          const blob = next ? shotImage(next, shot) : undefined;
          setImage(image, blob);
          setHidden(button, blob === undefined);
          setAttr(button, 'aria-label', tr(`photo.shot.${shot}` as const));
          setAttr(button, 'aria-pressed', String(next?.chosen === shot));
        }
      }
    },
  };
}
