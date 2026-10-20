// ハーネス自体のテスト（スパイン、開発ループの実行権と停止条件、core の境界、版の比較）
import { describe, expect, it } from 'vitest';
import { coreViolations } from './check-core';
import { begin, finish } from './dev-loop';
import { appendNote, overlaps, parallelBatch, setStatus, startable, validate, type Slice } from './spine';
import { compareVersions } from './sync-core';

const slice = (id: string, extra: Partial<Slice> = {}): Slice => ({
  id,
  title: id,
  wave: 1,
  lane: id,
  milestone: 'M0',
  requirements: [],
  depends_on: [],
  paths: [`src/${id}/**`],
  tests: [],
  status: 'todo',
  notes: '',
  ...extra,
});

describe('スパイン', () => {
  it('依存が integrated のものだけが着手できる', () => {
    const s = [slice('S-00', { status: 'integrated' }), slice('S-10', { depends_on: ['S-00'] }), slice('S-20', { depends_on: ['S-10'] })];
    expect(startable(s).map((x) => x.id)).toEqual(['S-10']);
  });

  it('paths が重なるスライスは同じ組に入れない', () => {
    expect(overlaps(['src/core/sound/**'], ['src/core/**'])).toBe(true);
    expect(overlaps(['src/core/sound/**'], ['src/core/materials/**'])).toBe(false);
    const s = [slice('S-10', { paths: ['src/core/**'] }), slice('S-11', { paths: ['src/core/sound/**'] }), slice('S-12', { paths: ['src/ui/**'] })];
    expect(parallelBatch(s).map((x) => x.id)).toEqual(['S-10', 'S-12']);
  });

  it('検査: 依存がない・依存が未統合なのに green 以上・知らない要件 ID', () => {
    const errors = validate(
      [slice('S-10', { depends_on: ['S-99'] }), slice('S-11', { status: 'green', depends_on: ['S-12'] }), slice('S-12'), slice('S-13', { requirements: ['XXX-1'] })],
      new Set(['RIDE-1']),
    );
    expect(errors.some((e) => e.includes('S-99'))).toBe(true);
    expect(errors.some((e) => e.startsWith('S-11'))).toBe(true);
    expect(errors.some((e) => e.includes('XXX-1'))).toBe(true);
  });

  const yaml = [
    'slices:',
    '- id: S-10',
    '  title: a',
    '  status: todo',
    "  notes: ''",
    '- id: S-11',
    '  title: b',
    '  status: todo',
    "  notes: 'x'",
    '',
  ].join('\n');

  it('set は対象のブロックの status だけを書き換える', () => {
    const out = setStatus(yaml, 'S-11', 'red');
    expect(out).toContain('- id: S-10\n  title: a\n  status: todo');
    expect(out).toContain('- id: S-11\n  title: b\n  status: red');
  });

  it('note は日付つきで追記し、単一引用符を逃がす', () => {
    const out = appendNote(yaml, 'S-11', "赤の証跡 it's red", new Date('2026-10-21T00:00:00Z'));
    expect(out).toContain("  notes: 'x 2026-10-21 赤の証跡 it''s red'");
    expect(out).toContain("- id: S-10\n  title: a\n  status: todo\n  notes: ''");
  });
});

describe('開発ループの実行権', () => {
  const cfg = { max_runs: 3, max_no_progress: 2, max_run_minutes: 60, max_total_minutes: 600, stop_before: ['S-20'], max_parallel: 7 };
  const empty = { runs: 0, no_progress: 0, active: null, halt: null, cycle_started_at: null, last_summary: '', history: [] };
  const spine = [slice('S-00', { status: 'integrated' }), slice('S-10', { depends_on: ['S-00'] }), slice('S-11', { depends_on: ['S-00'] })];

  it('並行に着手できる組を返し、実行中の二重起動は skip', () => {
    const r = begin(empty, cfg, spine, 0);
    expect(r.result).toMatchObject({ action: 'run', slices: ['S-10', 'S-11'] });
    expect(begin(r.state, cfg, spine, 1000).result.action).toBe('skip');
  });

  it('状態が変われば進捗、変わらなければ停滞として数え、上限で止まる', () => {
    const r1 = begin(empty, cfg, spine, 0);
    const token1 = (r1.result as { token: string }).token;
    const moved = spine.map((s) => (s.id === 'S-10' ? { ...s, status: 'red' as const } : s));
    const f1 = finish(r1.state, cfg, moved, token1, 'continue', 'S-10 red', 1000);
    expect(f1.state.no_progress).toBe(0);
    const r2 = begin(f1.state, cfg, moved, 2000);
    const f2 = finish(r2.state, cfg, moved, (r2.result as { token: string }).token, 'continue', '同じ', 3000);
    expect(f2.state.no_progress).toBe(1);
    const r3 = begin(f2.state, cfg, moved, 4000);
    const f3 = finish(r3.state, cfg, moved, (r3.result as { token: string }).token, 'continue', '同じ', 5000);
    expect(f3.state.halt?.kind).toBe('stall');
    expect(begin(f3.state, cfg, moved, 6000).result.action).toBe('stop');
  });

  it('古い token の finish は拒否する', () => {
    const r = begin(empty, cfg, spine, 0);
    expect(finish(r.state, cfg, spine, 'old', 'continue', '', 10).ok).toBe(false);
  });

  it('blocked で終えると止まり、stop_before のスライスの手前で gate として止まる', () => {
    const r = begin(empty, cfg, spine, 0);
    const f = finish(r.state, cfg, spine, (r.result as { token: string }).token, 'blocked', '判断待ち', 10);
    expect(f.state.halt?.kind).toBe('blocked');
    const only = [slice('S-00', { status: 'integrated' }), slice('S-20', { depends_on: ['S-00'] })];
    expect(begin(empty, cfg, only, 0).result).toMatchObject({ action: 'stop', kind: 'gate' });
  });
});

describe('CORE-1 共通部品の境界', () => {
  it('core の外への相対 import と、許可していないパッケージを見つける', () => {
    const root = new URL('..', import.meta.url).pathname;
    const files = { [`${root}src/core/a.ts`]: "import { x } from '../config';\nimport * as T from 'three/webgpu';\nimport { y } from './sound/scale';\nimport z from 'lodash';" };
    const v = coreViolations(Object.keys(files), (f) => files[f]);
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('../config');
    expect(v[1]).toContain('lodash');
  });

  it('版の比較', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.10.0')).toBeLessThan(0);
  });
});
