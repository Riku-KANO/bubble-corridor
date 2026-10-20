#!/usr/bin/env bash
# 決定論のセンサーを順に実行する（中の輪）。--quick で重い項目（ビルド、動きの上限、e2e）を省く。
# 実装担当の完了条件は `scripts/check.sh --quick` の ALL OK。統合の前は親が `scripts/check.sh` を回す。
set -u
cd "$(dirname "$0")/.."
quick=0; [ "${1:-}" = "--quick" ] && quick=1
fail=0
run() { echo "== $1"; shift; "$@" || { echo "   -> NG"; fail=1; }; }
run "core boundary" node --import ./scripts/ts-resolve.mjs scripts/check-core.ts
run "spine"         node --import ./scripts/ts-resolve.mjs scripts/spine.ts validate
run "typecheck"     pnpm -s typecheck
run "lint"          pnpm -s lint
run "unit"          pnpm -s exec vitest run --reporter=dot
if [ $quick -eq 0 ]; then
  run "build"   pnpm -s build
  if [ -f public/assets/rail.json ]; then run "comfort" node --import ./scripts/ts-resolve.mjs scripts/comfort.ts; else echo "== comfort"; echo "   -> SKIP（public/assets/rail.json がまだない）"; fi
  run "e2e"     pnpm -s e2e
fi
[ $fail -eq 0 ] && echo "ALL OK" || echo "FAILED"
exit $fail
