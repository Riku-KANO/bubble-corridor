import { defineConfig } from 'vitest/config';

// 並行開発で複数の worktree が同時に dev サーバーを立てられるよう、ポートを環境変数で変えられるようにする
const devPort = Number(process.env.DEV_PORT ?? 5173);

export default defineConfig({
  // 本番ビルドは index.html だけ。dev/*.html（担当ごとの確認ページ）は dev サーバーでだけ開ける
  build: {
    target: 'es2022',
    sourcemap: false,
    // three/webgpu は大きいので警告閾値を上げ、分割は動的 import で明示する
    chunkSizeWarningLimit: 2500,
    // フォントを data: URI にインライン化しない（CSP の font-src 'self' を保つ）
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  server: { port: devPort, strictPort: false },
  preview: { port: Number(process.env.PREVIEW_PORT ?? 4173) },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // DOM が要るテストはファイル先頭に `// @vitest-environment jsdom` を書く
    restoreMocks: true,
  },
});
