import js from '@eslint/js';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['dist/', '.claude/', 'node_modules/', 'playwright-report/', 'test-results/', '.snaps/', 'blender/'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    rules: {
      // セキュリティ: 動的コード実行と生HTML挿入を禁止（destroyer-game と同じ）
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'innerHTML は使わない（XSS対策）。textContent か src/ui/dom.ts の h() を使う。' },
        { property: 'outerHTML', message: 'outerHTML は使わない（XSS対策）。' },
        { property: 'insertAdjacentHTML', message: 'insertAdjacentHTML は使わない（XSS対策）。' },
        { object: 'document', property: 'write', message: 'document.write は使わない。' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // 案1と共有する src/core のテストは案1の書き方のまま取り込む（中身を書き換えない。ADR-0005・ADR-0011）。
    // 案1の lint では許される書き方（偽のデバイスの中で this を受ける）だけを、テストに限って許す
    files: ['src/core/**/*.test.ts'],
    rules: { '@typescript-eslint/no-this-alias': 'off' },
  },
);
