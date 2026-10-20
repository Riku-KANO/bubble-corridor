// node で src の TypeScript を直接読むための解決フック（依存なし）。
// src は Vite の流儀で拡張子なしの import（'../config'、'../ride'）を書くので、.ts と /index.ts を補う。
//   node --import ./scripts/ts-resolve.mjs scripts/comfort.ts
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:');
      if (!relative || err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          // 次の候補へ
        }
      }
      throw err;
    }
  },
});
