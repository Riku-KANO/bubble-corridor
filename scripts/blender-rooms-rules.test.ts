// 部屋の Blender のスクリプトの決まり（親が作成）。
// 書き出し直すたびに形が変わると、物との距離・容量・焼き込みが毎回変わり、レビューと統合で確かめた絵が保てない。
// Blender の Python は hash() の種を実行ごとに変える（sys.flags.hash_randomization=1）ので、乱数の種に hash() を使わない
// （S-20 レビュー1巡目 P2-1）。zlib.crc32 などの決まった値を使う。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOMS = fileURLToPath(new URL('../blender/scripts/rooms/', import.meta.url));

describe('部屋の Blender のスクリプトの決まり', () => {
  it('組み込みの hash() を使わない（実行ごとに値が変わり、書き出しが決定的でなくなる）', () => {
    const files = existsSync(ROOMS) ? readdirSync(ROOMS).filter((f) => f.endsWith('.py')) : [];
    const bad = files.filter((f) => /(^|[^._a-zA-Z0-9])hash\(/m.test(readFileSync(join(ROOMS, f), 'utf8')));
    expect(bad).toEqual([]);
  });
});
