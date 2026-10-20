// 外の輪の道具: headless Chrome で見どころの時刻や画面の流れを撮り、fps・描画呼び出し・コンソールエラーを出す。
//
//   pnpm snap ride [--base http://localhost:5173] [--mobile] [--only bloom,freeze] [--webgl] [--q low]
//   pnpm snap screens [--mobile]
//
// ride:    見どころごとに ?debug&t=<秒> を開いて撮る（時計はほぼ止める）。描画が安定するまで少し待つ。
// screens: 待ち列 → 入口 → 案内 → 乗車 → ポーズ → 写真 の順に撮る。
// 画像は .snaps/<flow>/ に保存する（git 管理外）。Read で開いて目で確かめる。
/// <reference lib="dom" />
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flow = args[0] && !args[0].startsWith('--') ? args[0] : 'ride';
const base = opt('--base') ?? `http://localhost:${process.env.DEV_PORT ?? 5173}`;
const mobile = flag('--mobile');
const only = opt('--only')?.split(',');
const extra = [flag('--webgl') ? 'webgl' : '', opt('--q') ? `quality=${opt('--q')}` : '', flag('--nofx') ? 'nofx' : ''].filter(Boolean).join('&');

/** 見どころと区間の見せ場（乗車の秒） */
const MOMENTS: readonly [string, number][] = [
  ['boarding', 1.5],
  ['platform', 30],
  ['greenhouse-enter', 64],
  ['greenhouse', 120],
  ['bloom', 160.5],
  ['dewfall', 164.5],
  ['rain', 240],
  ['freeze', 311],
  ['doors', 351],
  ['kaleidoscope', 390],
  ['kflower', 441],
  ['blackout', 481],
  ['stars', 492],
  ['celestial', 560],
  ['constellation', 591],
  ['dawn', 680],
  ['sunrise', 712],
  ['departure', 760],
];

const outDir = `.snaps/${flow}${mobile ? '-mobile' : ''}`;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({
  locale: 'ja-JP',
  viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
  hasTouch: mobile,
  isMobile: mobile,
});
const problems: string[] = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});

interface Stats {
  fps: number;
  calls: number;
  triangles: number;
  t: number;
  section: string;
  screen: string;
  backend: string;
}
const stats = (p: Page) => p.evaluate(() => (globalThis as unknown as { __utakata?: Stats }).__utakata ?? null);

let n = 0;
async function shot(name: string): Promise<void> {
  const file = `${outDir}/${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  const s = await stats(page);
  const st = s ? `${s.backend} ${s.fps.toFixed(1)}fps calls=${s.calls} tris=${Math.round(s.triangles / 1000)}k t=${s.t.toFixed(1)} ${s.section} ${s.screen}` : '(?debug の値なし)';
  console.log(`📸 ${file}  ${st}`);
}

if (flow === 'ride') {
  for (const [name, t] of MOMENTS) {
    if (only && !only.includes(name)) continue;
    await page.goto(`${base}/?debug&t=${t}&rate=0.1${extra ? `&${extra}` : ''}`);
    await page.waitForFunction(() => (globalThis as unknown as { __utakata?: { screen: string } }).__utakata?.screen === 'riding', null, { timeout: 30_000 });
    // 部屋の読み込みと fps の計測（0.5秒ごと）を待つ
    await page.waitForTimeout(2500);
    await shot(name);
  }
} else if (flow === 'screens') {
  await page.goto(`${base}/?debug${extra ? `&${extra}` : ''}`);
  await page.waitForTimeout(1500);
  await shot('queue');
  await page.getByRole('button', { name: /乗り場へ|To the platform/ }).click({ timeout: 30_000 });
  await page.waitForTimeout(1800);
  await shot('home');
  await page.getByRole('button', { name: /^乗る$|^Ride$/ }).first().click();
  await page.waitForTimeout(1500);
  await shot('guide');
  await page.waitForTimeout(6000);
  await shot('riding');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  await shot('pause');
  await page.goto(`${base}/?debug&t=777&rate=1${extra ? `&${extra}` : ''}`);
  await page.waitForTimeout(7000);
  await shot('photo');
} else {
  console.error(`不明な flow: ${flow}（ride / screens）`);
}

await browser.close();
if (problems.length > 0) {
  console.log(`⚠️ コンソールの問題 ${problems.length} 件`);
  for (const p of [...new Set(problems)].slice(0, 20)) console.log(`  ${p}`);
  process.exitCode = 1;
} else {
  console.log('✅ no console errors');
}
