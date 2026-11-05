"""Drives plugins/hermes/agora-room through its own register(ctx) with a fake Hermes PluginContext, for
test/hermes-plugin-room.test.mjs. One JSON request per stdin line, one JSON answer per stdout line.

The process is started with the test's environment (a temp agora config and state, a temp home), so the plugin
reads it exactly as it reads a Hermes process's. Timers are recorded and run on request; the watch thread is
never started: the test runs each tick itself.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import traceback
from pathlib import Path
from typing import Any

ROOT = Path(sys.argv[1]).resolve()

spec = importlib.util.spec_from_file_location("agora_room_plugin", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
assert spec and spec.loader
pkg = importlib.util.module_from_spec(spec)
sys.modules["agora_room_plugin"] = pkg
spec.loader.exec_module(pkg)
room = sys.modules["agora_room_plugin.room"]

timers: list = []
room.Resident._timer = staticmethod(lambda fn, ms: timers.append((fn, ms)))  # type: ignore[attr-defined]
room.Resident.start_thread = lambda self: None  # type: ignore[method-assign]


class FakeContext:
    def __init__(self) -> None:
        self.hooks: dict[str, list] = {}
        self.tools: dict[str, dict] = {}
        self.sent: list[dict] = []
        self.accept = True

    def register_hook(self, name, fn):
        self.hooks.setdefault(name, []).append(fn)

    def register_tool(self, name, toolset, schema, handler, description=""):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "description": description}

    def inject_message(self, content, role="user", *, session_key=None, origin=None):
        self.sent.append({"content": content, "session_key": session_key, "accepted": self.accept})
        return self.accept


ctx = FakeContext()
resident: Any = None


def run_timers() -> None:
    while timers:
        fn, _ms = timers.pop(0)
        fn()


def answer(req: dict) -> dict:
    global resident
    op = req["op"]
    if op == "register":
        pkg.register(ctx)
        resident = pkg.register.resident
        for k, v in (req.get("set") or {}).items():
            setattr(resident, k, v)
        return {"tools": {n: {"toolset": t["toolset"], "schema": t["schema"]} for n, t in ctx.tools.items()},
                "hooks": sorted(ctx.hooks), "problems": resident.cfg["problems"], "session": resident.session}
    if op == "set":
        for k, v in (req.get("values") or {}).items():
            setattr(resident, k, v)
        if "accept" in req:
            ctx.accept = bool(req["accept"])
        return {}
    if op == "arm":
        return {"armed": resident.arm()}
    if op == "hook":
        results = [fn(**(req.get("kw") or {})) for fn in ctx.hooks.get(req["name"], [])]
        run_timers() if req.get("timers") else None
        return {"results": results}
    if op == "tick":
        resident.tick()
        if req.get("timers", True):
            run_timers()
        return {}
    if op == "timers":
        n = len(timers)
        run_timers()
        return {"ran": n}
    if op == "tool":
        return {"result": json.loads(ctx.tools[req["name"]]["handler"](req.get("args") or {}))}
    if op == "sent":
        return {"sent": ctx.sent}
    if op == "state":
        return {"state": resident.state(), "sent": ctx.sent, "timers": len(timers)}
    if op == "stop":
        resident.stop()
        return {}
    if op == "fn":
        fn = getattr(room, req["name"])
        return {"value": fn(*req.get("args", []), **req.get("kw", {}))}
    raise ValueError(f"unknown op {op}")


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        out = {"ok": True, **answer(json.loads(line))}
    except Exception as error:  # noqa: BLE001
        out = {"ok": False, "error": f"{type(error).__name__}: {error}", "trace": traceback.format_exc()[-2000:]}
    sys.stdout.write(json.dumps(out, default=str) + "\n")
    sys.stdout.flush()
