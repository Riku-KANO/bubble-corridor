"""物の名前の規則（BLD-6）。小文字の `<部屋>.<部品>[.<番号>]`、例 `greenhouse.leaf.012`。

Blender が自動でつける `Cube.001` などの名前や、大文字・空白を含む名前を見つける。
部屋の一覧は案ごとに違うので、引数で受け取る。
"""
from __future__ import annotations

import re
from typing import Iterable

_NAME = re.compile(r'^(?P<room>[a-z][a-z0-9_]*)\.(?P<part>[a-z][a-z0-9_]*)(?:\.(?P<num>[0-9]+))?$')


def is_valid_name(name: str, rooms: Iterable[str] | None = None) -> bool:
    m = _NAME.match(name)
    if not m:
        return False
    return rooms is None or m.group('room') in set(rooms)


def check_names(objects: Iterable, rooms: Iterable[str] | None = None) -> list[str]:
    """規則に合わない名前の一覧（渡した順、重複なし）。objects は Blender の物か、名前の文字列。

    rooms を渡すと、先頭の部屋の部分がその一覧にあることも求める。
    """
    allowed = None if rooms is None else set(rooms)
    bad: list[str] = []
    for o in objects:
        name = o if isinstance(o, str) else o.name
        if not is_valid_name(name, allowed) and name not in bad:
            bad.append(name)
    return bad
