// 泡沫回廊（Utakata: A Ride Through Glass）の入口
import '@fontsource/zen-old-mincho/400.css';
import '@fontsource/noto-sans-jp/300.css';
import '@fontsource/noto-sans-jp/400.css';
import './styles/base.css';
import { startApp } from './app/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app がありません');
startApp(root).catch((err: unknown) => {
  console.error(err);
  const p = document.createElement('p');
  p.className = 'fatal';
  p.textContent = 'この端末では表示できませんでした / This device could not start the ride.';
  root.append(p);
});
