// CORE-1: src/core は案1と共有する部品なので、core の外を import しない（three などの外部パッケージは可）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE = join(ROOT, 'src/core');
const ALLOWED_PACKAGES = [/^three(\/(webgpu|tsl))?$/, /^three\/addons\//];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

export function coreViolations(files: readonly string[], read: (f: string) => string = (f) => readFileSync(f, 'utf8')): string[] {
  const out: string[] = [];
  const importRe = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(importRe)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('.')) {
        const target = resolve(dirname(f), spec);
        if (relative(CORE, target).startsWith('..')) out.push(`${relative(ROOT, f)}: core の外を import している（${spec}）`);
      } else if (!ALLOWED_PACKAGES.some((re) => re.test(spec)) && !spec.startsWith('node:')) {
        out.push(`${relative(ROOT, f)}: 許可していないパッケージ（${spec}）`);
      }
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = walk(CORE).filter((f) => !f.endsWith('.test.ts'));
  const errors = coreViolations(files);
  for (const e of errors) console.error(e);
  const version = readFileSync(join(CORE, 'VERSION'), 'utf8').trim();
  const changelog = readFileSync(join(CORE, 'CHANGELOG.md'), 'utf8');
  if (!changelog.includes(`## ${version}`)) {
    console.error(`src/core/CHANGELOG.md に VERSION（${version}）の記録がない（CORE-2）`);
    errors.push('changelog');
  }
  if (errors.length === 0) console.log(`core: ${files.length} ファイル、版 ${version} OK`);
  process.exit(errors.length === 0 ? 0 : 1);
}
