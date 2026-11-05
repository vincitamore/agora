"""agora-room: Agora rooms in a Hermes session (agora's own plugin; see docs/HERMES-PLUGIN.md in the agora checkout).

register(ctx) registers the room_post and room_read tools and the hooks, and starts nothing: a watch thread starts
at the first hook a live agent fires (on_session_start or pre_llm_call), so `hermes plugins doctor`, a listing, or
any process that only imports the plugin spawns no agora child.

Two hosts. When the plugin runs in the classic CLI's own process, that process is the session: one Resident reads
this process's environment and its working folder. When it runs in the Hermes gateway (Hermes 0.22: one gateway
runs every CLI, TUI and desktop session of the profile), the process environment is the gateway's and is shared by
every session, so each session gets a Resident of its own, configured by the `.agora-room.json` in the session's
recorded working folder (ctx.session_cwd(); `agora resident start` writes it), never by the gateway's AGORA_*
names. A session without that file gets the tools only, keyed by its own Hermes session id.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from .room import PROJECT_FILE, SUBAGENT, TOOLSET, Resident, tool_schemas

logger = logging.getLogger("agora-room")


def _in_gateway(ctx: Any) -> bool:
    """True when the plugin runs in the Hermes gateway (no classic CLI owns this process)."""
    manager = getattr(ctx, "_manager", None)
    return manager is not None and getattr(manager, "_cli_ref", None) is None


def _route_key() -> str:
    """The gateway's route key of the session whose turn runs in this context, or ""."""
    try:
        from hermes_cli.plugin_session import session_key
        return str(session_key() or "")
    except Exception:  # noqa: BLE001 - an older or different host: no route key
        return ""


def _session_cwd(ctx: Any) -> str:
    try:
        cwd = ctx.session_cwd()
    except Exception:  # noqa: BLE001
        cwd = ""
    return cwd or os.getcwd()


class Sessions:
    """The Residents of this process: one for the classic CLI's own session, else one per gateway session."""

    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx
        self.lock = threading.Lock()
        self.by_key: dict[str, Resident] = {}
        # the classic CLI's own session; its problems are said when it is first used (in the gateway it never is)
        self.default = self.make(env=None, cwd=None, set_process_env=True, quiet=True)
        self.default_said = False

    def make(self, *, env: dict | None, cwd: str | None, set_process_env: bool, quiet: bool = False) -> Resident:
        def inject(text: str, session_key: str | None) -> bool:
            return bool(self.ctx.inject_message(text, session_key=session_key))

        r = Resident(env=env, cwd=cwd, inject=inject, set_process_env=set_process_env)
        if not quiet:
            self.say(r)
        return r

    @staticmethod
    def say(r: Resident) -> None:
        for problem in r.cfg["problems"]:
            logger.warning("agora-room: %s", problem)

    def for_call(self, kw: dict) -> Resident:
        """The Resident of the session this hook or tool call runs for."""
        if not _in_gateway(self.ctx):
            if not self.default_said:
                self.default_said = True
                self.say(self.default)
            return self.default
        cwd = _session_cwd(self.ctx)
        route = _route_key()
        sid = str(kw.get("session_id") or "").strip()
        if (Path(cwd) / PROJECT_FILE).is_file():
            key = "dir:" + os.path.normcase(os.path.abspath(cwd))
        else:
            key = "session:" + (route or sid or "unknown")
        with self.lock:
            r = self.by_key.get(key)
            if r is None:
                # the gateway's own AGORA_* names belong to whoever started it, never to this session
                env = {k: v for k, v in os.environ.items() if not k.upper().startswith("AGORA_")}
                r = self.make(env=env, cwd=cwd, set_process_env=False)
                self.by_key[key] = r
        if route:
            r.route_key = route
        return r


def register(ctx: Any) -> None:
    sessions = Sessions(ctx)

    def started(r: Resident, kw: dict) -> None:
        if kw.get("platform") == SUBAGENT:
            return  # a subagent's session never watches the room
        r.learn_session(kw.get("session_id"))
        if r.cfg["rooms"]:
            r.start_thread()

    def on_session_start(**kw: Any) -> None:
        started(sessions.for_call(kw), kw)

    def pre_llm_call(**kw: Any) -> None:
        r = sessions.for_call(kw)
        started(r, kw)
        r.turn_start(**kw)
        return None

    def post_llm_call(**kw: Any) -> None:
        sessions.for_call(kw).turn_end(**kw)

    def on_session_end(**kw: Any) -> None:
        # Hermes fires this at the end of every turn, also a failed or interrupted one: the busy state never sticks.
        sessions.for_call(kw).turn_end(**kw)

    def post_api_request(**kw: Any) -> None:
        sessions.for_call(kw).api_request(**kw)

    def post_auxiliary_call(**kw: Any) -> None:
        sessions.for_call(kw).aux_call(**kw)

    def pre_tool_call(tool_name: Any = None, args: Any = None, **kw: Any) -> dict | None:
        return sessions.for_call(kw).pre_tool_call(tool_name, args, **kw)

    def post_tool_call(**kw: Any) -> None:
        sessions.for_call(kw).tool_event(**kw)

    for name, fn in (("on_session_start", on_session_start), ("pre_llm_call", pre_llm_call), ("post_llm_call", post_llm_call),
                     ("on_session_end", on_session_end), ("post_api_request", post_api_request),
                     ("post_auxiliary_call", post_auxiliary_call), ("pre_tool_call", pre_tool_call), ("post_tool_call", post_tool_call)):
        ctx.register_hook(name, fn)

    for name, schema, description in tool_schemas():

        def handler(args: Any = None, _name: str = name, **kw: Any) -> str:
            try:
                r = sessions.for_call(kw)
                method = r.post if _name == "room_post" else r.read
                return method(args if isinstance(args, dict) else {})
            except Exception as error:  # noqa: BLE001 - a tool answers with a structured failure, never a raise
                return json.dumps({"ok": False, "error": f"agora-room: {error}"})

        ctx.register_tool(name=name, toolset=TOOLSET, schema=schema, handler=handler, description=description)

    # Exposed for a probe from the same process (and the tests); Hermes never reads them.
    os.environ.setdefault("AGORA_ROOM_PLUGIN", "hermes")
    register.resident = sessions.default  # type: ignore[attr-defined]
    register.sessions = sessions  # type: ignore[attr-defined]
