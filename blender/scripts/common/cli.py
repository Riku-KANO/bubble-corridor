"""Blender の `-- 引数...` の後ろだけを取り出す（`blender -b -P script.py -- --out x`）。"""
from __future__ import annotations

import sys


def script_args(argv: list[str] | None = None) -> list[str]:
    """最初の `--` より後ろの引数。

    `pnpm previz:render -- --stills 30` のように後ろへ `--` が重なっても（pnpm は渡された引数をそのまま足す）、
    2つ目以降の `--` は捨てる（スクリプトは位置引数を取らない）。
    """
    argv = sys.argv if argv is None else argv
    return [a for a in argv[argv.index('--') + 1:] if a != '--'] if '--' in argv else []
