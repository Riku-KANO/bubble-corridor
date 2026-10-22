import { defineConfig } from '@playwright/test';

// 並行開発で複数の worktree が同時に e2e を回せるよう、ポートを環境変数で変えられるようにする
const port = Number(process.env.E2E_PORT ?? 4174);

// ブラウザのダウンロードを避け、端末にインストール済みの Chrome を使う（destroyer-game と同じ）
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  // 時間に敏感な検査（fps・音の時計）と重い通し（13分×2、高解像度の撮影）が同時に走りすぎないよう、並列は2まで
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 720 },
    locale: 'ja-JP',
    // WebXR を切るのは、本物の Chrome が localhost で navigator.xr を持ち、IWER（e2e/xr.spec.ts）が入らないため
    launchOptions: { args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebXR'] },
  },
  // 時間に敏感な検査（撮影の前後・部屋が見え始めるときのフレームの間隔）は、ほかの検査と同時に走らせると GPU を取り合って誤って落ちる。
  // 3 段に分け、前の段が終わってから次の段を走らせる（1 つのファイルの中は fullyParallel: false で順に走る）
  projects: [
    { name: 'main', testIgnore: /(photo|prewarm)\.spec\.ts/ },
    // 時間に敏感な検査は、同じ端末で別の作業（案1 の検査など）が GPU を使うと揺れる。落ちたら1回だけ試し直す（試し直しで通った物は flaky として報告される）
    { name: 'photo', testMatch: /photo\.spec\.ts/, dependencies: ['main'], retries: 1 },
    { name: 'prewarm', testMatch: /prewarm\.spec\.ts/, dependencies: ['photo'], retries: 1 },
  ],
  webServer: {
    // 毎回ビルドしてから配信する（古いビルドでテストしない）。既存サーバーは再利用しない
    command: `pnpm build && pnpm preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
