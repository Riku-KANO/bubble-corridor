// 部屋のコードの決まり（親が作成。部屋の担当は変更しない）
// ガラスの擬似照明（src/core/materials/glass.ts の setGlassLighting）は全体で共有する値。部屋が書くと、アプリ本体の切り替え
// （ゴンドラのいる部屋の空気が変わったときだけ当てる。src/app/glass-lighting.ts）とぶつかって明滅し、区間を出た後も残る
// （S-22 レビュー1巡目 P1）。部屋は Atmosphere.glassLighting に値を書き、共有の値には触れない。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOMS = fileURLToPath(new URL('.', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('部屋のコードの決まり', () => {
  it('部屋は共有のガラスの擬似照明（setGlassLighting・resetGlassLighting）を呼ばない（Atmosphere.glassLighting に書く）', () => {
    const files = walk(ROOMS).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('testing.ts'));
    const bad = files.filter((f) => /\b(setGlassLighting|resetGlassLighting)\b/.test(readFileSync(f, 'utf8')));
    expect(bad.map((f) => f.slice(ROOMS.length))).toEqual([]);
  });
});
