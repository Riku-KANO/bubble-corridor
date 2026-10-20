// 開発ループの実行権と停止条件（game-design-agents の development_loop.py と同じ考え方）。
// 定期実行（/loop、Desktop の定期タスク）の各回は新しいセッションなので、会話ではなくここの状態とスパインを読む。
//   pnpm loop begin                          実行権を取る → {action: run|skip|stop, token, slices, deadline, previous_summary}
//   pnpm loop status --token <t>             token が有効か、期限、停止状態
//   pnpm loop finish --token <t> --outcome continue|blocked --summary '<...>'
//   pnpm loop stop --reason '<...>'          手動で止める
//   pnpm loop resume --note '<...>'          停止を解除する（人だけが行う。ループからは呼ばない）
// 上限は process/development-loop.json が正。状態は process/.loop-state.json（git 管理外、checkout ごと）。
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parallelBatch, readSpine, type Slice } from './spine.ts';

const CONFIG = fileURLToPath(new URL('../process/development-loop.json', import.meta.url));
const STATE = fileURLToPath(new URL('../process/.loop-state.json', import.meta.url));

interface LoopConfig {
  max_runs: number;
  max_no_progress: number;
  max_run_minutes: number;
  max_total_minutes: number;
  /** このスライスの手前で止める（人の判断・関門の確認が要る） */
  stop_before: string[];
  /** 一巡で並行に進めるスライスの上限 */
  max_parallel: number;
}

interface LoopState {
  runs: number;
  no_progress: number;
  active: { token: string; slices: string[]; started_at: number; deadline: number; snapshot: Record<string, string> } | null;
  halt: { kind: 'limit' | 'stall' | 'blocked' | 'manual' | 'gate' | 'done'; reason: string } | null;
  cycle_started_at: number | null;
  last_summary: string;
  history: { event: string; at: number; [k: string]: unknown }[];
}

const EMPTY: LoopState = { runs: 0, no_progress: 0, active: null, halt: null, cycle_started_at: null, last_summary: '', history: [] };

export function readConfig(): LoopConfig {
  return JSON.parse(readFileSync(CONFIG, 'utf8')) as LoopConfig;
}

function readState(): LoopState {
  if (!existsSync(STATE)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(STATE, 'utf8')) as Partial<LoopState>) };
  } catch {
    return structuredClone(EMPTY);
  }
}

function writeState(s: LoopState): void {
  s.history = s.history.slice(-50);
  writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`);
}

function snapshot(slices: readonly Slice[]): Record<string, string> {
  return Object.fromEntries(slices.map((s) => [s.id, s.status]));
}

export type BeginResult =
  | { action: 'run'; token: string; slices: string[]; deadline: string; previous_summary: string }
  | { action: 'skip'; reason: string }
  | { action: 'stop'; kind: string; reason: string };

export function begin(state: LoopState, cfg: LoopConfig, slices: readonly Slice[], now: number): { state: LoopState; result: BeginResult } {
  const s = structuredClone(state);
  if (s.halt) return { state: s, result: { action: 'stop', kind: s.halt.kind, reason: s.halt.reason } };
  if (s.active && s.active.deadline > now) return { state: s, result: { action: 'skip', reason: `実行中（token ${s.active.token.slice(0, 8)}、期限 ${new Date(s.active.deadline).toISOString()}）` } };
  if (s.active) {
    // 前の実行が finish せずに期限切れ。進捗の判定ができないので停滞として数える
    s.history.push({ event: 'expired', at: now, token: s.active.token });
    s.no_progress++;
    s.active = null;
  }
  const halt = (kind: NonNullable<LoopState['halt']>['kind'], reason: string) => {
    s.halt = { kind, reason };
    s.history.push({ event: 'stop', at: now, kind, reason });
    return { state: s, result: { action: 'stop' as const, kind, reason } };
  };
  if (s.cycle_started_at === null) s.cycle_started_at = now;
  if (s.runs >= cfg.max_runs) return halt('limit', `起動の上限（${cfg.max_runs} 回）に達した`);
  if (now - s.cycle_started_at > cfg.max_total_minutes * 60_000) return halt('limit', `初回から ${cfg.max_total_minutes} 分を超えた`);
  if (s.no_progress >= cfg.max_no_progress) return halt('stall', `${cfg.max_no_progress} 回続けて進捗がない`);
  const batch = parallelBatch(slices).filter((x) => !cfg.stop_before.includes(x.id)).slice(0, cfg.max_parallel);
  if (batch.length === 0) {
    const waiting = parallelBatch(slices).filter((x) => cfg.stop_before.includes(x.id));
    if (waiting.length > 0) return halt('gate', `${waiting.map((x) => x.id).join(', ')} の手前（stop_before）。関門と判断を人が確かめる`);
    const blocked = slices.filter((x) => x.status === 'blocked');
    if (blocked.length > 0) return halt('blocked', `${blocked.map((x) => x.id).join(', ')} が blocked`);
    return halt('done', '着手できるスライスがない（すべて統合済み、または依存待ち）');
  }
  const token = randomUUID().replace(/-/g, '');
  const deadline = now + cfg.max_run_minutes * 60_000;
  s.active = { token, slices: batch.map((x) => x.id), started_at: now, deadline, snapshot: snapshot(slices) };
  s.runs++;
  s.history.push({ event: 'begin', at: now, token, slices: s.active.slices });
  return {
    state: s,
    result: { action: 'run', token, slices: s.active.slices, deadline: new Date(deadline).toISOString(), previous_summary: s.last_summary },
  };
}

export function finish(
  state: LoopState,
  cfg: LoopConfig,
  slices: readonly Slice[],
  token: string,
  outcome: 'continue' | 'blocked',
  summary: string,
  now: number,
): { state: LoopState; ok: boolean; message: string } {
  const s = structuredClone(state);
  if (!s.active || s.active.token !== token) return { state: s, ok: false, message: 'token が古いか、実行中ではない（上書きしない）' };
  if (now > s.active.deadline + 5 * 60_000) return { state: s, ok: false, message: '期限切れの token（再取得して再開する）' };
  const before = s.active.snapshot;
  const progressed = slices.some((x) => before[x.id] !== undefined && before[x.id] !== x.status && x.status !== 'blocked');
  s.no_progress = progressed ? 0 : s.no_progress + 1;
  s.last_summary = summary;
  s.history.push({ event: 'finish', at: now, token, outcome, progressed, summary });
  s.active = null;
  if (outcome === 'blocked') s.halt = { kind: 'blocked', reason: summary };
  else if (s.no_progress >= cfg.max_no_progress) s.halt = { kind: 'stall', reason: `${cfg.max_no_progress} 回続けて進捗がない` };
  if (s.halt) s.history.push({ event: 'stop', at: now, kind: s.halt.kind, reason: s.halt.reason });
  return { state: s, ok: true, message: progressed ? '進捗あり' : '進捗なし（状態の変化がない）' };
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv: string[]): number {
  const [cmd] = argv;
  const cfg = readConfig();
  const state = readState();
  const now = Date.now();
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  switch (cmd) {
    case 'begin': {
      const r = begin(state, cfg, readSpine(), now);
      writeState(r.state);
      out(r.result);
      return 0;
    }
    case 'status': {
      const token = arg(argv, '--token');
      const a = state.active;
      out({
        valid: !!a && a.token === token && a.deadline > now && !state.halt,
        remaining_minutes: a ? Math.round((a.deadline - now) / 60_000) : 0,
        halt: state.halt,
        runs: state.runs,
        no_progress: state.no_progress,
        slices: a?.slices ?? [],
      });
      return 0;
    }
    case 'finish': {
      const token = arg(argv, '--token') ?? '';
      const outcome = arg(argv, '--outcome');
      const summary = arg(argv, '--summary') ?? '';
      if (outcome !== 'continue' && outcome !== 'blocked') return (console.error('--outcome は continue か blocked'), 1);
      const r = finish(state, cfg, readSpine(), token, outcome, summary, now);
      if (!r.ok) return (console.error(r.message), 1);
      writeState(r.state);
      out({ ok: true, message: r.message, halt: r.state.halt });
      return 0;
    }
    case 'stop': {
      const reason = arg(argv, '--reason') ?? '手動停止';
      state.halt = { kind: 'manual', reason };
      state.history.push({ event: 'stop', at: now, kind: 'manual', reason });
      writeState(state);
      out({ ok: true, halt: state.halt });
      return 0;
    }
    case 'resume': {
      const note = arg(argv, '--note') ?? '';
      state.halt = null;
      state.no_progress = 0;
      state.history.push({ event: 'resume', at: now, note });
      writeState(state);
      out({ ok: true });
      return 0;
    }
    default:
      console.error('使い方: pnpm loop begin|status|finish|stop|resume');
      return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
