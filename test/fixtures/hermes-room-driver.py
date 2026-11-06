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
pkg.Sessions.start_rearm = lambda self: None  # type: ignore[method-assign]  # the test runs each re-arm pass itself


class FakeManager:
    """The gateway's PluginManager as the plugin sees it: no classic CLI, a profile home, maybe a live message host."""

    def __init__(self, home: str | None = None) -> None:
        self._cli_ref = None
        self.home_path = Path(home) if home else None
        self._gateway_message_injector = None

    @property
    def has_gateway_message_injector(self) -> bool:
        return self._gateway_message_injector is not None


class FakeAuthority:
    """gateway.session_authorities' authority for one home: the local sessions it holds open, by chat id."""

    def __init__(self, profile: str, home: str) -> None:
        self.profile, self.profile_id = profile, home
        self.sessions: dict[str, Any] = {}
        self.restorable: set[str] = set()
        self.restored: list[str] = []


authority: FakeAuthority | None = None


def fake_gateway(profile: str, home: str) -> None:
    """Gateway internals the plugin reaches to reopen a local session, faked as modules, and a live gateway loop."""
    global authority
    import asyncio
    import threading
    import types
    authority = FakeAuthority(profile, home)
    auth = authority

    def authority_for_home(runner, h):
        return auth if room.same_path(str(h), auth.profile_id) else None

    def restore_local_session(a, sid):
        if sid not in a.restorable:
            raise KeyError(f"no local session receipt for {sid}")
        a.sessions[sid] = types.SimpleNamespace(route=f"agent:{a.profile}:local:dm:{sid}")
        a.restored.append(sid)

    gw = types.ModuleType("gateway")
    gw.__path__ = []  # type: ignore[attr-defined]
    sa = types.ModuleType("gateway.session_authorities")
    sa.authority_for_home = authority_for_home  # type: ignore[attr-defined]
    lr = types.ModuleType("gateway.session_local_recovery")
    lr.restore_local_session = restore_local_session  # type: ignore[attr-defined]
    sys.modules.update({"gateway": gw, "gateway.session_authorities": sa, "gateway.session_local_recovery": lr})
    loop = asyncio.new_event_loop()
    threading.Thread(target=loop.run_forever, daemon=True).start()
    runner = types.SimpleNamespace(_gateway_loop=loop, config=types.SimpleNamespace(multiplex_profiles=False))
    ctx._manager._gateway_message_injector = (runner, lambda **kw: True)
    ctx.require_live = True


class FakeContext:
    def __init__(self) -> None:
        self.hooks: dict[str, list] = {}
        self.tools: dict[str, dict] = {}
        self.sent: list[dict] = []
        self.accept = True
        self.require_live = False  # accept only a session the fake gateway holds open
        self.cwd = ""
        self.profile_name = "default"
        self.unloads: list = []
        self._manager: Any = None  # None: no gateway (the classic CLI's own process, or a bare import)

    def register_hook(self, name, fn):
        self.hooks.setdefault(name, []).append(fn)

    def register_tool(self, name, toolset, schema, handler, description=""):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "description": description}

    def session_cwd(self):
        return self.cwd

    def on_unload(self, fn):
        self.unloads.append(fn)

    def inject_message(self, content, role="user", *, session_key=None, origin=None):
        accepted = self.accept
        if self.require_live:
            accepted = accepted and authority is not None and str(session_key or "").rsplit(":dm:", 1)[-1] in authority.sessions
        self.sent.append({"content": content, "session_key": session_key, "accepted": accepted})
        return accepted


ctx = FakeContext()
resident: Any = None


def run_timers() -> None:
    while timers:
        fn, _ms = timers.pop(0)
        fn()


def keyed(cwd: str) -> Any:
    r = pkg.register.sessions.by_key.get(pkg.Sessions.dir_key(cwd))
    if r is None:
        raise KeyError(f"no resident for {cwd}")
    return r


def answer(req: dict) -> dict:
    global resident
    op = req["op"]
    if op == "register":
        if req.get("gateway"):
            # a plugin load in a gateway serving this profile
            ctx._manager = FakeManager(req.get("profileHome"))
            ctx.profile_name = req.get("profile") or "default"
        pkg.register(ctx)
        resident = pkg.register.resident
        for k, v in (req.get("set") or {}).items():
            setattr(resident, k, v)
        return {"tools": {n: {"toolset": t["toolset"], "schema": t["schema"]} for n, t in ctx.tools.items()},
                "hooks": sorted(ctx.hooks), "problems": resident.cfg["problems"], "session": resident.session,
                "profile": pkg.register.sessions.profile, "profileHome": pkg.register.sessions.profile_home}
    if op == "fake-gateway":
        fake_gateway(req["profile"], req["profileHome"])
        authority.restorable.update(req.get("restorable") or [])  # type: ignore[union-attr]
        return {}
    if op == "authority":
        a = authority
        if "restorable" in req:
            a.restorable = set(req["restorable"])  # type: ignore[union-attr]
        if req.get("close"):
            a.sessions.clear()  # type: ignore[union-attr]
        return {"open": sorted(a.sessions), "restored": a.restored}  # type: ignore[union-attr]
    if op == "rearm":
        report = pkg.register.sessions.rearm_pass(now_ms=req.get("now_ms"))
        return {"rearmed": report["rearmed"], "pending": [x["session"] for x in report["pending"]],
                "skipped": [{"file": Path(x["file"]).name, "reason": x["reason"]} for x in report["skipped"]],
                "residents": len(pkg.register.sessions.by_key)}
    if op == "unload":
        for fn in ctx.unloads:
            fn()
        return {}
    if op == "keyed":
        r = keyed(req["cwd"])
        for k, v in (req.get("values") or {}).items():
            setattr(r, k, v)
        do = req.get("do")
        if do == "arm":
            r.arm()
        elif do == "tick":
            r.tick()
            run_timers()
        elif do == "flush":
            r.flush()
        elif do == "stop":
            r.stop()
        return {"state": r.state(), "sent": ctx.sent, "liveness": r.liveness_path}
    if op == "set":
        for k, v in (req.get("values") or {}).items():
            setattr(resident, k, v)
        if "accept" in req:
            ctx.accept = bool(req["accept"])
        return {}
    if op == "gateway":
        # the plugin as the Hermes gateway hosts it: no classic CLI owns the process, each call names its session's folder
        if not isinstance(getattr(ctx, "_manager", None), FakeManager):
            ctx._manager = FakeManager()
        ctx.cwd = req["cwd"]
        r = pkg.register.sessions.for_call(req.get("kw") or {})
        if req.get("route"):
            r.route_key = req["route"]
        r.learn_session((req.get("kw") or {}).get("session_id"))
        return {"session": r.session, "rooms": r.cfg["rooms"], "actor": r.cfg["actor"], "deny": r.cfg["deny"], "pid": r.pid, "ownerPid": r.cfg["ownerPid"],
                "stateRoot": r.cfg["stateRoot"], "residents": len(pkg.register.sessions.by_key), "isDefault": r is pkg.register.sessions.default}
    if op == "gateway-tool":
        ctx.cwd = req["cwd"]
        return {"result": json.loads(ctx.tools[req["name"]]["handler"](req.get("args") or {}, session_id=req.get("session_id")))}
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
