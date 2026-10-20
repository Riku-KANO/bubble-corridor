// S-18 CORE-5 共通部品の和集合（親が作成。実装担当は変更しない）
// 案1「ビードロの向こう」の src/core 0.4.0（~/develop/through-the-vidro の main、コミット b88d317）を、同じ中身のまま含み、
// 案2の部品と並べた和集合にする。案1のリポジトリは今後も変わるので、取り込んだ時点の git の blob の SHA を埋め込んで比べる。
// 最初は 0.3.0（8aa3a5c）を基準にしたが、案1が並行で 0.4.0 に進んだので取り直した（版がぶつからないよう、こちらは 0.5.0）。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coreViolations } from './check-core';
import { compareVersions } from './sync-core';

const CORE = fileURLToPath(new URL('../src/core/', import.meta.url));

/** 案1の src/core 0.4.0 の各ファイルと git の blob の SHA（git ls-tree -r b88d317 src/core。案1 の main、2026-10-21 08:12） */
const UPSTREAM: readonly [string, string][] = [
  ['CHANGELOG.md', 'e416088de84124ccc09382df1cc98d10b744e0a9'],
  ['VERSION', '1d0ba9ea182b0f7354f3daf12120744ec5e0c2f8'],
  ['audio/analysis.test.ts', 'd3de250a477e330e151b79ff3d74dc473106ecbe'],
  ['audio/analysis.ts', 'd4a8457fec6c56d99eced84a766162bdedf61637'],
  ['audio/engine.ts', 'fdfc242c76d4261dc50c567c47a9538067971ba9'],
  ['audio/glass.test.ts', '876b155cde90fb0c7816db4906b5825ba32cd4bd'],
  ['audio/glass.ts', 'dc5953cd5315666855a33622c1e080d7afe733df'],
  ['audio/mix.test.ts', 'cfad7a959f33c1ef6b000415913f29ae3f4d1fc7'],
  ['audio/mix.ts', 'a38faeac6fe8e867d731e1b014cfc6acf7c928c8'],
  ['audio/offline.ts', '620f434ad1972f5150abd6036f56cf4788921841'],
  ['audio/play.ts', 'f5d56715d35d29b0c28e8cd330366aa37a4a94ec'],
  ['audio/pop.test.ts', '4623368663febbf1cafc55a30d11ef3f6bf259b3'],
  ['audio/pop.ts', '53c9ef9e2aaee8d454ee20e2d2285c5462fab81d'],
  ['audio/reverb.test.ts', '73432dc3c95ecb3cbfc7ee9d9f5fb1e0a24d024b'],
  ['audio/reverb.ts', 'b750481170fe325b92e09670d932121c5ebce3e3'],
  ['audio/rng.ts', '863bc0b5ce3d954b04446f24b62f534194d2b78b'],
  ['audio/scale.test.ts', 'cc3a14dedeb81322d7481988f909a22a544b9952'],
  ['audio/scale.ts', '1493cd2fe868c24d0159c03faf701239912aba02'],
  ['audio/voices.test.ts', 'e01a6465ec0d859021f436d5d52de7d2f92da851'],
  ['audio/voices.ts', '517da99a9867faef8d87c000f0a9dba51e8d4b01'],
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
  ['params.test.ts', '90a383b95d0239d783df110536539c05cc3456a4'],
  ['params.ts', 'cdaf08506266721655ac1d4f049992499e0fd339'],
  ['perf/dynamic-resolution.test.ts', '0bd6de0025310de5456b65917b35db87f322d434'],
  ['perf/dynamic-resolution.ts', '5d6444e839452e68c2ea537af3ac5eede2e5c1f6'],
  ['perf/governor.test.ts', '2eb0ed21b749c3d858091bea078895629a6318e1'],
  ['perf/governor.ts', 'c8c5cd9d3609d5487cc39555eb8ae8881993ae79'],
  ['perf/gpu-span.test.ts', 'b55ec12d6db765d76a80635a3607d845fe848359'],
  ['perf/gpu-span.ts', 'cf803367739c35cd9f85791d18d7cb18e37d9406'],
  ['perf/quality-select.test.ts', 'ba30584ef335cb77eaefc02f11f6c4ca6ee6ec92'],
  ['perf/quality-select.ts', '7a08c32c3efec1e383e557d681edd1f173540c66'],
  ['quality.ts', '2850148b52501cca092539928b64206ff47fb04c'],
  ['renderer.ts', 'ae991be9ec0addd2b6edc6f396664744a04c2c4c'],
  ['scene.ts', 'dfc1a19d1b8cc24debe7782e571ec3b9ccaaf7c2'],
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

describe('CORE-5 案1の 0.4.0 をそのまま含む', () => {
  for (const [file, sha] of UPSTREAM) {
    if (MERGED.has(file)) continue;
    it(file, () => {
      const p = join(CORE, file);
      expect(existsSync(p), `${file} がない`).toBe(true);
      expect(gitBlobSha(readFileSync(p)), `${file} の中身が案1の 0.4.0（b88d317）と違う`).toBe(sha);
    });
  }
});

describe('CORE-5 / CORE-2 版と変更記録', () => {
  it('版は 0.5.0 以上（案1の 0.4.0 より新しい）', () => {
    const v = readFileSync(join(CORE, 'VERSION'), 'utf8').trim();
    expect(compareVersions(v, '0.5.0')).toBeGreaterThanOrEqual(0);
  });

  it('変更記録に両方の歴史と和集合の版がある', () => {
    const log = readFileSync(join(CORE, 'CHANGELOG.md'), 'utf8');
    for (const h of ['## 0.5.0', '## 0.4.0', '## 0.3.0', '## 0.2.0']) expect(log, h).toContain(h);
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
