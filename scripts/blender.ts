// Blender の呼び出し（ADR-0002）。
//   pnpm blender <script.py> [--blend <file.blend>] [-- <スクリプトへの引数>...]
// Blender は BLENDER の環境変数 → /Applications/Blender.app → PATH の順に探す（macOS では PATH にないことが多い）。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAC_APP = '/Applications/Blender.app/Contents/MacOS/Blender';

export function findBlender(): string | null {
  const env = process.env.BLENDER;
  if (env && existsSync(env)) return env;
  if (existsSync(MAC_APP)) return MAC_APP;
  try {
    const p = execFileSync('which', ['blender'], { encoding: 'utf8' }).trim();
    return p || null;
  } catch {
    return null;
  }
}

export interface BlenderRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** ヘッドレスで Python を走らせる。blend を渡せばそれを開いてから */
export function runBlender(script: string, args: readonly string[] = [], opts: { blend?: string; timeoutMs?: number; cwd?: string } = {}): BlenderRun {
  const bin = findBlender();
  if (!bin) throw new Error('Blender が見つかりません（BLENDER の環境変数で場所を指定できます）');
  const argv = ['-b', ...(opts.blend ? [opts.blend] : ['--factory-startup']), '--python-exit-code', '1', '-P', script, '--', ...args];
  const r = spawnSync(bin, argv, { encoding: 'utf8', timeout: opts.timeoutMs ?? 600_000, cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const head = sep >= 0 ? argv.slice(0, sep) : argv;
  const rest = sep >= 0 ? argv.slice(sep + 1) : [];
  const blendAt = head.indexOf('--blend');
  const blend = blendAt >= 0 ? head[blendAt + 1] : undefined;
  const script = head.find((a, i) => !a.startsWith('--') && head[i - 1] !== '--blend');
  if (!script) {
    console.error('使い方: pnpm blender <script.py> [--blend file.blend] [-- 引数...]');
    process.exit(1);
  }
  const bin = findBlender();
  if (!bin) {
    console.error('Blender が見つかりません');
    process.exit(1);
  }
  const r = spawnSync(bin, ['-b', ...(blend ? [blend] : ['--factory-startup']), '--python-exit-code', '1', '-P', script, '--', ...rest], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
