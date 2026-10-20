// S-18 CORE-5 共通部品の和集合（親が作成。実装担当は変更しない）
// 案1「ビードロの向こう」の src/core 0.3.0（~/develop/through-the-vidro のコミット 8aa3a5c）を、同じ中身のまま含み、
// 案2の部品と並べた和集合にする。案1のリポジトリは今後も変わるので、取り込んだ時点の git の blob の SHA を埋め込んで比べる。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coreViolations } from './check-core';
import { compareVersions } from './sync-core';

const CORE = fileURLToPath(new URL('../src/core/', import.meta.url));

/** 案1の src/core 0.3.0 の各ファイルと git の blob の SHA（git ls-tree -r 8aa3a5c src/core） */
const UPSTREAM_0_3_0: readonly [string, string][] = [
  ['CHANGELOG.md', 'dbb6280fa897ddbb8af87088964e92be87860fc8'],
  ['VERSION', '0d91a54c7d439e84e3dd17d3594f1b2b6737f430'],
  ['bench.test.ts', 'c24bf59b07b9debdf21ad20849e40d086f9ac5bd'],
  ['bench.ts', 'e1a5fd46cba11eda5326897c0e4ee69b0b90264a'],
  ['glass/fused-bubbles.test.ts', '88fa0b476102418238afa44e9cb1e3de11c40777'],
  ['glass/fused-bubbles.ts', '483c4f3c26d57d1e23fd6f18bb09ccc3beca86ec'],
  ['glass/index.ts', '5a003060f4852135324d6595f493fc58439f1d26'],
  ['glass/kinds.ts', '4d042eabd0878eb1ad1eb4ee839eb9ad616fd0c4'],
  ['glass/materials.test.ts', '2cb47bd76ec7732eb72eaf00866869ec5bd0b916'],
  ['glass/materials.ts', 'c7c96f78c19ee1005b7a93693265ac0e2b29a6c4'],
  ['glass/meshes.ts', 'cfd5cf36f9962a55f89ef9526018273826208081'],
  ['glass/optics.test.ts', 'cba5c21fb2b316578cad571320a9959f9b2cea45'],
  ['glass/optics.ts', 'ec59bd34a7f602230671ac56df93011b23087ed0'],
  ['glass/overlap.test.ts', '413441a137d1b4594bf4f767b23238925452f6e9'],
  ['glass/overlap.ts', 'a5cd7925a8f596ed40fbd455e7748cbe55bbd3ed'],
  ['glass/policy.test.ts', 'daa95e798ce12acc569ddf84d08c5fd86a54c7bc'],
  ['glass/policy.ts', '271f37d03879e4d056f1a8ec993f246bcc027e87'],
  ['params.test.ts', '8671eba4678f84c944592185ffef2539199137b3'],
  ['params.ts', 'b81a529c8e93799ff201ee92e772b8ba29855f5c'],
  ['perf/dynamic-resolution.test.ts', '755a3f971016683c5d187d479fa1cef46b9da3f4'],
  ['perf/dynamic-resolution.ts', 'aec35ecdec65d303c2560cdbe8a0d687121de2a8'],
  ['perf/governor.test.ts', '2ee3eee18a374f193fb6fe31f6c3c164698cb1e5'],
  ['perf/governor.ts', '86a5173d0de46855874580ec62eafa59a70d1a6f'],
  ['perf/quality-select.test.ts', 'ba30584ef335cb77eaefc02f11f6c4ca6ee6ec92'],
  ['perf/quality-select.ts', '7a08c32c3efec1e383e557d681edd1f173540c66'],
  ['quality.ts', '8744293ab3bf8e2f1540e479028d3b7e731c18c6'],
  ['renderer.ts', '02a4af1d0ea9413effa1ae80209fe37f459236f4'],
  ['scene.ts', '0f8d8234475cfcf9fdc3af3a61931c917a2c0670'],
  ['transition/curve.test.ts', '988e7c38a1f92ceb0bb1fa46867e21c792c611ce'],
  ['transition/curve.ts', '9612177f2fc0d5d416b6c38ea79473d775b6475c'],
  ['transition/index.ts', '641ac27ea614f3ade118737e12d2418e91f475e6'],
  ['transition/transition.test.ts', '2fe5cefe935f2848c1df2d366b4af432f4050948'],
  ['transition/transition.ts', 'a4cfc812e56ed1c77f1ba32731901b85dc7ef1b2'],
];

/** 和集合で中身を合わせ直すファイル（版、変更記録、説明） */
const MERGED = new Set(['VERSION', 'CHANGELOG.md', 'README.md']);

const gitBlobSha = (buf: Buffer) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('CORE-5 案1の 0.3.0 をそのまま含む', () => {
  for (const [file, sha] of UPSTREAM_0_3_0) {
    if (MERGED.has(file)) continue;
    it(file, () => {
      const p = join(CORE, file);
      expect(existsSync(p), `${file} がない`).toBe(true);
      expect(gitBlobSha(readFileSync(p)), `${file} の中身が案1の 0.3.0 と違う`).toBe(sha);
    });
  }
});

describe('CORE-5 / CORE-2 版と変更記録', () => {
  it('版は 0.4.0 以上（案1の 0.3.0 より新しい）', () => {
    const v = readFileSync(join(CORE, 'VERSION'), 'utf8').trim();
    expect(compareVersions(v, '0.4.0')).toBeGreaterThanOrEqual(0);
  });

  it('変更記録に両方の歴史と和集合の版がある', () => {
    const log = readFileSync(join(CORE, 'CHANGELOG.md'), 'utf8');
    for (const h of ['## 0.4.0', '## 0.3.0', '## 0.2.0']) expect(log, h).toContain(h);
    expect(log).toContain('泡沫回廊');
    expect(log).toContain('ビードロ');
  });
});

describe('CORE-5 名前のぶつかりと曲線', () => {
  it('quality.ts は案1の版（QUALITY_PRESETS）、案2の自動判定と動的な解像度は quality-tier.ts', async () => {
    const q = await import('../src/core/quality');
    expect(q).toHaveProperty('QUALITY_PRESETS');
    const t = await import('../src/core/quality-tier');
    expect(typeof t.detectTier).toBe('function');
    expect(typeof t.presetFor).toBe('function');
    expect(typeof t.DynamicResolution).toBe('function');
  });

  it('動きの曲線は1つ: easeGlass は案1の glassEase と同じ値', async () => {
    const { easeGlass } = await import('../src/core/easing');
    const { glassEase } = await import('../src/core/transition/curve');
    for (let x = 0; x <= 1.0001; x += 0.05) expect(easeGlass(x)).toBeCloseTo(glassEase(Math.min(1, x)), 9);
  });
});

describe('CORE-1 和集合でも core の外を import しない', () => {
  it('違反なし', () => {
    const files = walk(CORE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(coreViolations(files)).toEqual([]);
  });
});
