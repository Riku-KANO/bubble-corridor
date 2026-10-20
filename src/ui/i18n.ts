// 画面に出す文言（日本語と英語）。UI-3: すべての文言は ja・en の両方のキーを持つ。
// 文言は HTML として解釈しない（呼び出し側は textContent で入れる）。差し込みは文字列のまま置き換える。
import type { Lang } from '../contracts/ids';

const ja = {
  // ── 題 ──
  title: '泡沫回廊',
  subtitle: 'A Ride Through Glass',
  back: '戻る',

  // ── 待ち列 ──
  'queue.waiting': '少しだけ、お待ちください',
  'queue.loading': '読み込み中',
  'queue.enter': '乗り場へ',

  // ── 入口 ──
  'home.ride': '乗る',
  'home.rideVR': 'VRで乗る',
  'home.howto': '乗り方',
  'home.comfort': '快適モード',
  'home.settings': '設定',
  'home.shelf': '写真の棚',
  'home.credits': 'クレジット',
  'ticket.label': '搭乗券',
  'ticket.number': '第{n}便',
  'ticket.route': '泡の発着場 → 夜明けの岸',

  // ── 乗車前の案内 ──
  'guide.label': '乗車前の案内',
  'guide.touch': '触れると鳴ります',
  'guide.look': '見回せます',
  'guide.comfort': '酔いやすい方は穏やかモードへ',
  'guide.skip': '飛ばす',
  'guide.gyro': '傾けて見回す',
  'guide.gyro.on': '傾けて見回せます',

  // ── 乗車中 ──
  'ride.hint': '触れると、鳴ります',
  'ride.pause': 'ポーズ',

  // ── ポーズ ──
  'pause.title': '一時停止',
  'pause.continue': '続ける',
  'pause.comfort': '快適モード',
  'pause.volume': '音量',
  'pause.alight': '降りる',

  // ── ライドフォトと乗車の記録 ──
  'photo.thanks': 'ご乗車ありがとうございました',
  'photo.alt': 'ライドフォト',
  'photo.pick': '3枚から選べます',
  'photo.shot.bloom': '朝露の温室',
  'photo.shot.freeze': '雨の回廊',
  'photo.shot.constellation': '星の天球',
  'photo.developing': '写真を現像しています',
  'photo.format': '保存の形',
  'photo.wide': '横長',
  'photo.square': '正方形',
  'photo.save': '保存',
  'photo.share': '共有',
  'photo.rideAgain': 'もう一度乗る',
  'photo.toHome': '入口へ',
  'photo.saveFailed': '保存できませんでした。もう一度お試しください。',
  'photo.shareFailed': '共有できませんでした。保存してからお試しください。',
  'record.title': '今回の乗車',
  'record.touches': '触れた数',
  'record.door': '選んだ扉',
  'record.constellations': '描いた星座',
  'record.hidden': '見つけた泡',
  'door.amber': '琥珀',
  'door.lapis': '瑠璃',

  // ── 写真の棚 ──
  'shelf.title': '写真の棚',
  'shelf.empty': 'まだ写真はありません。乗り終えると、ここに並びます。',
  'shelf.keep': '最新{n}枚まで、この端末に残ります',
  'shelf.delete': '削除',

  // ── 設定 ──
  'settings.title': '設定',
  'settings.quality': '画質',
  'settings.look': '見回し',
  'settings.comfort': '快適さ',
  'settings.sound': '音',
  'settings.display': '表示',
  'quality.preset': '画質の設定',
  'opt.auto': '自動',
  'opt.low': '低',
  'opt.medium': '中',
  'opt.high': '高',
  'look.mode': '見回しの方式',
  'look.drag': 'ドラッグで回す',
  'look.follow': 'マウスに追従',
  'look.gyro': '端末の傾きで見回す',
  'look.gyro.denied': '許可されませんでした。ドラッグで見回せます。',
  'look.fov': '視野角',
  'look.recenter': '見どころの前に正面へ戻す',
  'look.gaze': '見つめて触れるまでの時間',
  'unit.sec': '{n}秒',
  'comfort.standard': '標準',
  'comfort.gentle': '穏やか',
  'comfort.desc': '穏やかでは、上下の動きと向きの回転を半分にし、万華鏡の模様の回転を止めます。乗車時間はどちらも13分です。',
  'comfort.reducedFlash': '光の点滅をおさえる',
  'comfort.reducedFlash.desc': '天球の暗転からの点灯や、朝日の強さをやわらげます。',
  'comfort.vignette': 'VRの移動中の外周の暗さ',
  'comfort.posture': 'VRでの姿勢',
  'posture.seated': '座る',
  'posture.standing': '立つ',
  'sound.master': '全体',
  'sound.music': '音楽',
  'sound.sfx': '効果音',
  'sound.ambient': '環境音',
  'sound.note': '音が出せなくても、触れた反応は光でも分かります。',
  'display.lang': '言語',
  'lang.ja': '日本語',
  'lang.en': 'English',
  'display.textScale': '文字の大きさ',
  'text.standard': '標準',
  'text.large': '大',
  'text.xlarge': '特大',

  // ── 乗り方 ──
  'howto.title': '乗り方',
  'howto.screen': '画面で乗る',
  'howto.vr': 'VRで乗る',
  'howto.op.look': '見回す',
  'howto.op.touch': '触れる',
  'howto.op.choose': '選ぶ',
  'howto.op.gaze': '見つめて触れる',
  'howto.screen.look': 'ドラッグ。スマートフォンでは、端末を傾けても',
  'howto.screen.touch': 'クリック、またはタップ',
  'howto.screen.choose': '扉をクリック・タップ、または見つめる',
  'howto.vr.look': '頭を動かす',
  'howto.vr.touch': 'コントローラーか、手を伸ばして触れる',
  'howto.vr.choose': '扉に触れる、または見つめる',
  'howto.gaze': '同じ物を見つめると、触れたことになります',
  'howto.pause': 'ポーズは、Esc・隅の雫・画面の長押しで。',
  'howto.note': 'どれも任意です。何もしなくても、最後まで乗れます。',

  // ── クレジット ──
  'credits.title': 'クレジット',
  'credits.tagline': 'ガラスの泡に乗って、五つのガラスの部屋を巡る約13分。',
  'credits.music': '音楽と音: Web Audio で、ガラスの音とシンセサイザーをその場で演奏しています。',
  'credits.fonts': '書体: Zen Old Mincho、Noto Sans JP（SIL Open Font License 1.1）',
  'credits.engine': '描画: three.js（MIT License）',
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof ja;

const en: Record<MessageKey, string> = {
  title: 'Utakata',
  subtitle: 'A Ride Through Glass',
  back: 'Back',

  'queue.waiting': 'One moment, please',
  'queue.loading': 'Loading',
  'queue.enter': 'To the platform',

  'home.ride': 'Ride',
  'home.rideVR': 'Ride in VR',
  'home.howto': 'How to ride',
  'home.comfort': 'Comfort mode',
  'home.settings': 'Settings',
  'home.shelf': 'Photo shelf',
  'home.credits': 'Credits',
  'ticket.label': 'Boarding pass',
  'ticket.number': 'Ride No.{n}',
  'ticket.route': 'Bubble Terminal → Dawn Shore',

  'guide.label': 'Before you ride',
  'guide.touch': 'Touch, and it chimes',
  'guide.look': 'Look around',
  'guide.comfort': 'Prone to motion sickness? Try Gentle mode',
  'guide.skip': 'Skip',
  'guide.gyro': 'Look by tilting',
  'guide.gyro.on': 'Tilt your device to look around',

  'ride.hint': 'Touch, and it chimes',
  'ride.pause': 'Pause',

  'pause.title': 'Paused',
  'pause.continue': 'Resume',
  'pause.comfort': 'Comfort mode',
  'pause.volume': 'Volume',
  'pause.alight': 'Leave the ride',

  'photo.thanks': 'Thank you for riding',
  'photo.alt': 'Ride photo',
  'photo.pick': 'Pick one of three',
  'photo.shot.bloom': 'Dew Greenhouse',
  'photo.shot.freeze': 'Rain Corridor',
  'photo.shot.constellation': 'Celestial Sphere',
  'photo.developing': 'Developing your photo',
  'photo.format': 'Save as',
  'photo.wide': 'Wide',
  'photo.square': 'Square',
  'photo.save': 'Save',
  'photo.share': 'Share',
  'photo.rideAgain': 'Ride again',
  'photo.toHome': 'Back to the entrance',
  'photo.saveFailed': 'Could not save the photo. Please try again.',
  'photo.shareFailed': 'Could not share the photo. Try saving it first.',
  'record.title': 'This ride',
  'record.touches': 'Touches',
  'record.door': 'Door chosen',
  'record.constellations': 'Constellations drawn',
  'record.hidden': 'Little bubbles found',
  'door.amber': 'Amber',
  'door.lapis': 'Lapis',

  'shelf.title': 'Photo shelf',
  'shelf.empty': 'No photos yet. They gather here after each ride.',
  'shelf.keep': 'The latest {n} stay on this device',
  'shelf.delete': 'Delete',

  'settings.title': 'Settings',
  'settings.quality': 'Quality',
  'settings.look': 'Look',
  'settings.comfort': 'Comfort',
  'settings.sound': 'Sound',
  'settings.display': 'Display',
  'quality.preset': 'Graphics quality',
  'opt.auto': 'Auto',
  'opt.low': 'Low',
  'opt.medium': 'Medium',
  'opt.high': 'High',
  'look.mode': 'Look control',
  'look.drag': 'Drag to turn',
  'look.follow': 'Follow the mouse',
  'look.gyro': 'Look by tilting your device',
  'look.gyro.denied': 'Permission was declined. You can still drag to look around.',
  'look.fov': 'Field of view',
  'look.recenter': 'Face front before each highlight',
  'look.gaze': 'Gaze-to-touch time',
  'unit.sec': '{n} s',
  'comfort.standard': 'Standard',
  'comfort.gentle': 'Gentle',
  'comfort.desc': 'Gentle halves the vertical motion and the turning, and stops the kaleidoscope from spinning. The ride is 13 minutes either way.',
  'comfort.reducedFlash': 'Reduce flashing light',
  'comfort.reducedFlash.desc': 'Softens the lights returning after the dark sphere, and the strength of the sunrise.',
  'comfort.vignette': 'Edge darkening while moving in VR',
  'comfort.posture': 'VR posture',
  'posture.seated': 'Seated',
  'posture.standing': 'Standing',
  'sound.master': 'Master',
  'sound.music': 'Music',
  'sound.sfx': 'Effects',
  'sound.ambient': 'Ambience',
  'sound.note': 'Even without sound, every touch answers in light.',
  'display.lang': 'Language',
  'lang.ja': '日本語',
  'lang.en': 'English',
  'display.textScale': 'Text size',
  'text.standard': 'Standard',
  'text.large': 'Large',
  'text.xlarge': 'Extra large',

  'howto.title': 'How to ride',
  'howto.screen': 'On screen',
  'howto.vr': 'In VR',
  'howto.op.look': 'Look',
  'howto.op.touch': 'Touch',
  'howto.op.choose': 'Choose',
  'howto.op.gaze': 'Gaze to touch',
  'howto.screen.look': 'Drag. On a phone, you can tilt the device too',
  'howto.screen.touch': 'Click or tap',
  'howto.screen.choose': 'Click or tap a door, or gaze at it',
  'howto.vr.look': 'Move your head',
  'howto.vr.touch': 'Touch with a controller, or reach out',
  'howto.vr.choose': 'Touch a door, or gaze at it',
  'howto.gaze': 'Gaze at one thing, and it counts as a touch',
  'howto.pause': 'Pause with Esc, the droplet in the corner, or by holding the screen.',
  'howto.note': 'None of it is required. The ride carries on by itself.',

  'credits.title': 'Credits',
  'credits.tagline': 'About thirteen minutes in a glass bubble, drifting through five rooms of glass.',
  'credits.music': 'Music and sound: performed live with Web Audio, from glass tones and synthesizers.',
  'credits.fonts': 'Typefaces: Zen Old Mincho, Noto Sans JP (SIL Open Font License 1.1)',
  'credits.engine': 'Rendering: three.js (MIT License)',
};

export const MESSAGES: Readonly<Record<Lang, Readonly<Record<MessageKey, string>>>> = { ja, en };

export type MessageVars = Readonly<Record<string, string | number>>;

/**
 * 文言を引く。{name} は vars の値に置き換える。知らない差し込みは残さず、空にする。
 * 値は文字列のまま入れる（HTML として解釈するのは呼び出し側の責任で、UI は textContent だけを使う）。
 */
export function t(key: MessageKey, lang: Lang, vars?: MessageVars): string {
  const message = MESSAGES[lang][key];
  return message.replace(/\{(\w+)\}/g, (_match, name: string) => {
    if (!vars || !Object.prototype.hasOwnProperty.call(vars, name)) return '';
    return String(vars[name]);
  });
}

/** ブラウザの言語の並びから、対応している最初の言語。なければ英語 */
export function detectLang(languages: readonly string[]): Lang {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0];
    if (primary === 'ja') return 'ja';
    if (primary === 'en') return 'en';
  }
  return 'en';
}
