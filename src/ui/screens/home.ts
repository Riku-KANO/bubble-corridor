// 入口（ホーム）。ガラスのアーチに光でタイトルが書かれ、その下にガラスの切符が浮かぶ。
// 切符には「第3便」のように乗車回数が刻まれる。主な項目は「乗る」。
import { h, replay, setAttr, setHidden, setText } from '../dom';
import type { Screen, ScreenEnv } from '../screen';
import { armWrites, disarmWrites } from '../write';

export function createHomeScreen(env: ScreenEnv): Screen {
  const { commands } = env;
  const title = h('h1', { class: 'title write' });
  const subtitle = h('p', { class: 'subtitle' });
  const arch = h(
    'div',
    { class: 'arch' },
    h('div', { class: 'arch-light', 'aria-hidden': 'true' }),
    h('div', { class: 'arch-rim', 'aria-hidden': 'true' }),
    h('div', { class: 'arch-text' }, title, subtitle),
  );

  const ticketLabel = h('span', { class: 'ticket-label' });
  const ticketNumber = h('span', { class: 'ticket-number' });
  const ticketRoute = h('span', { class: 'ticket-route' });
  const ticket = h('div', { class: 'ticket' }, h('div', { class: 'ticket-body' }, ticketLabel, ticketNumber, ticketRoute), h('span', { class: 'ticket-hole', 'aria-hidden': 'true' }));

  const ride = h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => commands.ride('screen') } });
  const rideVR = h('button', { type: 'button', class: 'btn btn-secondary', hidden: true, on: { click: () => commands.ride('vr') } });

  const howto = h('button', { type: 'button', class: 'chip', on: { click: () => commands.open('howto') } });
  const settings = h('button', { type: 'button', class: 'chip', on: { click: () => commands.open('settings') } });
  const shelf = h('button', { type: 'button', class: 'chip', on: { click: () => commands.open('shelf') } });
  const credits = h('button', { type: 'button', class: 'chip', on: { click: () => commands.open('credits') } });
  let gentle = false;
  const comfort = h('button', { type: 'button', class: 'chip-main', 'aria-pressed': 'false', on: { click: () => commands.setSettings({ comfort: gentle ? 'standard' : 'gentle' }) } });
  const comfortState = h('span', { class: 'chip-state' });
  const comfortChip = h('span', { class: 'chip chip-toggle' }, comfort, comfortState);

  const el = h(
    'section',
    { class: 'screen screen-home', 'data-room': 'home' },
    h('div', { class: 'home-hero' }, arch, ticket),
    h('div', { class: 'home-actions' }, ride, rideVR),
    h('div', { class: 'home-menu' }, howto, comfortChip, settings, shelf, credits),
  );

  return {
    el,
    update(state) {
      const { tr } = env;
      setText(title, tr('title'));
      setText(subtitle, tr('subtitle'));
      setText(ticketLabel, tr('ticket.label'));
      setText(ticketNumber, tr('ticket.number', { n: state.progress.rideCount + 1 }));
      setText(ticketRoute, tr('ticket.route'));
      setText(ride, tr('home.ride'));
      setText(rideVR, tr('home.rideVR'));
      setHidden(rideVR, !state.xrSupported);
      setText(howto, tr('home.howto'));
      setText(settings, tr('home.settings'));
      setText(shelf, tr('home.shelf'));
      setText(credits, tr('home.credits'));
      gentle = state.settings.comfort === 'gentle';
      setText(comfort, tr('home.comfort'));
      setAttr(comfort, 'aria-pressed', String(gentle));
      setText(comfortState, tr(gentle ? 'comfort.gentle' : 'comfort.standard'));
    },
    show(delaySec) {
      armWrites([title], 0.35 + delaySec);
      replay(el, 'enter');
    },
    focus() {
      ride.focus({ preventScroll: true });
    },
    hide() {
      disarmWrites([title]);
    },
  };
}
