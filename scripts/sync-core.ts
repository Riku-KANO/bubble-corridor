// 共通部品を相手のリポジトリへコピーする（ADR-0005）。対象は src/core と blender/scripts/common（それぞれ VERSION を持つ）。
//   pnpm core:sync ../through-the-vidro            何が変わるかを表示するだけ
//   pnpm core:sync ../through-the-vidro --apply    コピーする
// 相手の VERSION の方が新しい（または同じ版で中身が違う）ときは止まる。先に相手から取り込むこと。
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 案1と共有する場所（リポジトリからの相対） */
export const SHARED_DIRS = ['src/core', 'blender/scripts/common'] as const;

function parseVersion(v: string): number[] {
  return v.trim().split('.').map((x) => Number(x) || 0);
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function syncOne(rel: string, target: string, apply: boolean): number {
  const src = join(ROOT, rel);
  if (!existsSync(join(src, 'VERSION'))) {
    console.log(`${rel}: まだない（とばす）`);
    return 0;
  }
  const dst = join(target, rel);
  const mine = readFileSync(join(src, 'VERSION'), 'utf8').trim();
  const theirs = existsSync(join(dst, 'VERSION')) ? readFileSync(join(dst, 'VERSION'), 'utf8').trim() : null;
  const changed = files(src).filter((f) => {
    if (f.includes('__pycache__')) return false;
    const other = join(dst, relative(src, f));
    return !existsSync(other) || readFileSync(other, 'utf8') !== readFileSync(f, 'utf8');
  });
  console.log(`${rel}: こちら ${mine} / 相手 ${theirs ?? '(なし)'}、違うファイル ${changed.length} 件`);
  for (const f of changed) console.log(`  ${relative(src, f)}`);
  if (theirs !== null) {
    const cmp = compareVersions(mine, theirs);
    if (cmp < 0) return (console.error(`${rel}: 相手の方が新しい版です。先に相手から取り込んでください。`), 1);
    if (cmp === 0 && changed.length > 0) return (console.error(`${rel}: 同じ版で中身が違います。VERSION を上げて CHANGELOG に記録してください。`), 1);
  }
  if (!apply || changed.length === 0) return 0;
  cpSync(src, dst, { recursive: true, filter: (p) => !p.includes('__pycache__') });
  console.log(`  コピーしました → ${dst}`);
  return 0;
}

function main(argv: string[]): number {
  const target = argv.find((a) => !a.startsWith('--'));
  const apply = argv.includes('--apply');
  if (!target) {
    console.error('使い方: pnpm core:sync <相手のリポジトリ> [--apply]');
    return 1;
  }
  let status = 0;
  for (const rel of SHARED_DIRS) status = Math.max(status, syncOne(rel, target, apply));
  if (!apply) console.log('（表示のみ。--apply でコピーします）');
  return status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
