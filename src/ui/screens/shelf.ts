// 写真の棚。過去のライドフォトが小さなガラス玉として棚に並ぶ（最新 10 枚）。選ぶと拡大され、保存・削除できる。
import { PHOTO } from '../../config';
import type { PhotoRecord } from '../../contracts/photo';
import { h, setAttr, setHidden, setText } from '../dom';
import type { Screen, ScreenEnv } from '../screen';
import { createPhotoPane } from './photo-pane';
import { createSubHeader } from './sub-header';

interface Orb {
  readonly button: HTMLButtonElement;
  readonly image: HTMLImageElement;
  record: PhotoRecord;
}

/** 日付 YYYY-MM-DD を 2026.10.20 の形にする（刻印と同じ書き方） */
export const dotDate = (date: string): string => date.replaceAll('-', '.');

export function createShelfScreen(env: ScreenEnv): Screen {
  const header = createSubHeader(env, 'shelf.title');
  const pane = createPhotoPane(env, { choices: false });
  const caption = h('p', { class: 'shelf-caption' });
  const remove = h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => void deleteSelected() } });
  pane.actions.append(remove);
  const strip = h('div', { class: 'shelf-strip', role: 'group' });
  const empty = h('p', { class: 'shelf-empty', hidden: true });
  const keep = h('p', { class: 'shelf-keep' });
  const view = h('div', { class: 'shelf-view' }, pane.el, caption);
  const el = h('section', { class: 'screen screen-shelf', 'data-room': 'shelf' }, header.el, h('div', { class: 'shelf-body' }, empty, view, h('div', { class: 'shelf-board' }, strip), keep));

  const orbs = new Map<string, Orb>();
  let selectedId: string | null = null;
  let list: readonly PhotoRecord[] = [];

  function deleteSelected(): Promise<void> {
    const r = pane.current();
    if (!r) return Promise.resolve();
    return Promise.resolve(env.commands.deletePhoto(r.id)).catch(() => undefined);
  }

  function select(id: string): void {
    selectedId = id;
    paintSelection();
  }

  function paintSelection(): void {
    const record = list.find((r) => r.id === selectedId) ?? list[0] ?? null;
    selectedId = record?.id ?? null;
    pane.update(record);
    setHidden(view, record === null);
    setText(caption, record ? `${env.tr('ticket.number', { n: record.meta.rideNo })}  ${dotDate(record.meta.date)}` : '');
    for (const [id, orb] of orbs) setAttr(orb.button, 'aria-pressed', String(id === selectedId));
  }

  return {
    el,
    update(state) {
      const { tr } = env;
      header.update();
      list = state.shelf.slice(0, PHOTO.keep);
      setText(empty, tr('shelf.empty'));
      setText(remove, tr('shelf.delete'));
      setText(keep, tr('shelf.keep', { n: PHOTO.keep }));
      setAttr(strip, 'aria-label', tr('shelf.title'));
      setHidden(empty, list.length > 0);
      setHidden(strip.parentElement as HTMLElement, list.length === 0);
      setHidden(keep, list.length === 0);

      // 棚の玉は id で突き合わせ、増えた分だけ作り、消えた分だけ外す
      const ids = new Set(list.map((r) => r.id));
      for (const [id, orb] of orbs) {
        if (ids.has(id)) continue;
        orb.button.remove();
        orbs.delete(id);
      }
      list.forEach((record, i) => {
        let orb = orbs.get(record.id);
        if (!orb) {
          const image = h('img', { alt: '', decoding: 'async', draggable: 'false', hidden: true });
          const button = h('button', { type: 'button', class: 'orb', 'aria-pressed': 'false', on: { click: () => select(record.id) } }, image, h('span', { class: 'orb-shine', 'aria-hidden': 'true' }));
          orb = { button, image, record };
          orbs.set(record.id, orb);
        }
        orb.record = record;
        if (strip.children[i] !== orb.button) strip.insertBefore(orb.button, strip.children[i] ?? null);
        const thumb = (record.shots.find((s) => s.shot === record.chosen) ?? record.shots[0])?.image;
        const url = thumb ? env.blobUrl(thumb) : null;
        if (url) {
          if (orb.image.getAttribute('src') !== url) orb.image.setAttribute('src', url);
        } else if (orb.image.hasAttribute('src')) orb.image.removeAttribute('src');
        setHidden(orb.image, url === null);
        setAttr(orb.button, 'aria-label', `${tr('ticket.number', { n: record.meta.rideNo })} ${dotDate(record.meta.date)}`);
      });
      paintSelection();
    },
    show() {
      selectedId = null;
      header.focus();
    },
  };
}
