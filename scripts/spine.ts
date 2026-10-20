// 開発スパイン（process/spine.yaml）の参照と更新。
//   pnpm spine list                 一覧（状態つき）
//   pnpm spine next                 次に着手できるスライス（依存が integrated で、todo / red / green のもの）
//   pnpm spine ready                並行に着手できるスライスの一覧（同じ wave で paths が重ならない）
//   pnpm spine show S-10            1件の詳細
//   pnpm spine set S-10 red         状態を変える
//   pnpm spine note S-10 '<text>'   notes に追記する（日付つき）
//   pnpm spine validate             形と依存の検査（check.sh から呼ぶ）
// set・note は対象の `- id:` ブロックだけを書き換える（並行する worktree の notes と衝突しにくくする）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const STATUSES = ['todo', 'red', 'green', 'reviewed', 'integrated', 'blocked'] as const;
export type Status = (typeof STATUSES)[number];

export interface Slice {
  id: string;
  title: string;
  wave: number;
  lane: string;
  milestone: string;
  requirements: string[];
  depends_on: string[];
  paths: string[];
  tests: string[];
  status: Status;
  notes: string;
}

const SPINE = fileURLToPath(new URL('../process/spine.yaml', import.meta.url));

export function readSpine(file = SPINE): Slice[] {
  const doc = parse(readFileSync(file, 'utf8')) as { slices?: Slice[] };
  return doc.slices ?? [];
}

export function validate(slices: readonly Slice[], reqIds: ReadonlySet<string> | null): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const s of slices) {
    if (!/^S-\d{2}$/.test(s.id)) errors.push(`${s.id}: id は S-00 の形`);
    if (ids.has(s.id)) errors.push(`${s.id}: id が重複`);
    ids.add(s.id);
    if (!STATUSES.includes(s.status)) errors.push(`${s.id}: status が不正（${String(s.status)}）`);
    for (const k of ['requirements', 'depends_on', 'paths', 'tests'] as const) {
      if (!Array.isArray(s[k])) errors.push(`${s.id}: ${k} は配列`);
    }
    if (reqIds) for (const r of s.requirements ?? []) if (!reqIds.has(r)) errors.push(`${s.id}: 要件 ${r} が docs/requirements.md にない`);
  }
  for (const s of slices) {
    for (const d of s.depends_on ?? []) {
      if (!ids.has(d)) errors.push(`${s.id}: 依存 ${d} がない`);
      const dep = slices.find((x) => x.id === d);
      if (dep && ['green', 'reviewed', 'integrated'].includes(s.status) && dep.status !== 'integrated' && dep.id !== s.id) {
        errors.push(`${s.id}: ${s.status} だが依存 ${d} が ${dep.status}`);
      }
    }
  }
  return errors;
}

/** 依存がすべて integrated で、まだ終わっていないもの（wave 順、id 順） */
export function startable(slices: readonly Slice[]): Slice[] {
  const done = new Set(slices.filter((s) => s.status === 'integrated').map((s) => s.id));
  return slices
    .filter((s) => ['todo', 'red', 'green'].includes(s.status) && s.depends_on.every((d) => done.has(d)))
    .sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id));
}

function globBase(p: string): string {
  return p.replace(/\*\*.*$/, '').replace(/\*.*$/, '');
}

/** paths が重なるか（前方一致で近似する） */
export function overlaps(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) for (const y of b) {
    const bx = globBase(x);
    const by = globBase(y);
    if (bx === '' || by === '' || bx.startsWith(by) || by.startsWith(bx)) return true;
  }
  return false;
}

/** 並行に着手できる組: 着手できるもののうち、互いに paths が重ならないもの */
export function parallelBatch(slices: readonly Slice[]): Slice[] {
  const out: Slice[] = [];
  for (const s of startable(slices)) if (out.every((o) => !overlaps(o.paths, s.paths))) out.push(s);
  return out;
}

/** 対象の `- id: <ID>` ブロックの範囲（行番号）。見つからなければ null */
function blockRange(lines: readonly string[], id: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trim() === `- id: ${id}`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('- id:')) end++;
  return [start, end];
}

export function setStatus(text: string, id: string, status: Status): string {
  const lines = text.split('\n');
  const r = blockRange(lines, id);
  if (!r) throw new Error(`${id} がない`);
  for (let i = r[0]; i < r[1]; i++) {
    if (/^ {2}status:/.test(lines[i])) {
      lines[i] = `  status: ${status}`;
      return lines.join('\n');
    }
  }
  throw new Error(`${id} に status がない`);
}

export function appendNote(text: string, id: string, note: string, date = new Date()): string {
  const lines = text.split('\n');
  const r = blockRange(lines, id);
  if (!r) throw new Error(`${id} がない`);
  const day = date.toISOString().slice(0, 10);
  for (let i = r[0]; i < r[1]; i++) {
    if (/^ {2}notes:/.test(lines[i])) {
      // notes は1行の単一引用符の文字列で持つ（複数行にしない）
      const raw = lines.slice(i, r[1]).join('\n').replace(/^ {2}notes:\s*/, '');
      const current = raw.startsWith("'") ? raw.slice(1, raw.lastIndexOf("'")).replace(/''/g, "'").replace(/\s*\n\s*/g, ' ') : raw.trim();
      const next = (current ? `${current} ` : '') + `${day} ${note}`;
      lines.splice(i, r[1] - i, `  notes: '${next.replace(/'/g, "''")}'`);
      return lines.join('\n');
    }
  }
  throw new Error(`${id} に notes がない`);
}

function readRequirementIds(): Set<string> {
  const md = readFileSync(fileURLToPath(new URL('../docs/requirements.md', import.meta.url)), 'utf8');
  return new Set([...md.matchAll(/\*\*([A-Z]+-\d+)\s/g)].map((m) => m[1]));
}

function main(argv: string[]): number {
  const [cmd = 'list', id, ...rest] = argv;
  const slices = readSpine();
  const show = (s: Slice) => `${s.id}  [${s.status}]  w${s.wave} ${s.lane.padEnd(11)} ${s.title}`;
  switch (cmd) {
    case 'list':
      for (const s of slices) console.log(show(s));
      return 0;
    case 'next': {
      const s = startable(slices)[0];
      console.log(s ? show(s) : '着手できるスライスはありません');
      return 0;
    }
    case 'ready':
      for (const s of parallelBatch(slices)) console.log(show(s));
      return 0;
    case 'show': {
      const s = slices.find((x) => x.id === id);
      if (!s) return (console.error(`${id} がない`), 1);
      console.log(JSON.stringify(s, null, 2));
      return 0;
    }
    case 'set': {
      const status = rest[0] as Status;
      if (!id || !STATUSES.includes(status)) return (console.error('使い方: spine set <ID> <status>'), 1);
      writeFileSync(SPINE, setStatus(readFileSync(SPINE, 'utf8'), id, status));
      console.log(`${id} → ${status}`);
      return 0;
    }
    case 'note': {
      const text = rest.join(' ').trim();
      if (!id || !text) return (console.error("使い方: spine note <ID> '<text>'"), 1);
      writeFileSync(SPINE, appendNote(readFileSync(SPINE, 'utf8'), id, text));
      return 0;
    }
    case 'validate': {
      const errors = validate(slices, readRequirementIds());
      for (const e of errors) console.error(`spine: ${e}`);
      if (errors.length === 0) console.log(`spine: ${slices.length} 件 OK`);
      return errors.length === 0 ? 0 : 1;
    }
    default:
      console.error(`不明なコマンド: ${cmd}`);
      return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
