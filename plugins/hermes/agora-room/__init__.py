"""agora-room: Agora rooms in a Hermes session (agora's own plugin; see docs/HERMES-PLUGIN.md in the agora checkout).

register(ctx) registers the room_post and room_read tools and the hooks, and starts no agora child: a watch thread
starts at the first hook a live agent fires (on_session_start or pre_llm_call), so `hermes plugins doctor`, a listing,
or any process that only imports the plugin spawns no agora child.

Two hosts. When the plugin runs in the classic CLI's own process, that process is the session: one Resident reads
this process's environment and its working folder. When it runs in the Hermes gateway (Hermes 0.22: one gateway
runs every CLI, TUI and desktop session of the profile), the process environment is the gateway's and is shared by
every session, so each session gets a Resident of its own, configured by the `.agora-room.json` in the session's
recorded working folder (ctx.session_cwd(); `agora resident start` writes it), never by the gateway's AGORA_*
names. A session without that file gets the tools only, keyed by its own Hermes session id.

Re-arm. In the gateway the watch is a thread of the gateway process, so it dies when the gateway stops, while the
resident's `hermes chat --cli` client lives on, idle: no hook fires, nothing arms the watch again. So register()
also starts one small thread that waits for the gateway to come up (a published plugin message host) and then
resumes, from the liveness files under ~/.agora/hermes-room, each watch of this profile whose client still runs
(room.rearm_candidates): the same agora key, cursors and queue, the same Hermes session. In a process that never
becomes a gateway (a listing, doctor) it gives up after REARM_WAIT_S having started nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from .room import (PROJECT_FILE, REARM_RETRY_S, REARM_WAIT_S, REARM_WINDOW_S, SUBAGENT, TOOLSET, Resident, home_of,
                   rearm_candidates, tool_schemas)

logger = logging.getLogger("agora-room")


def _in_gateway(ctx: Any) -> bool:
    """True when the plugin runs in the Hermes gateway (no classic CLI owns this process)."""
    manager = getattr(ctx, "_manager", None)
    return manager is not None and getattr(manager, "_cli_ref", None) is None


def _gateway_live(ctx: Any) -> bool:
    """True when this process is a running gateway: no classic CLI, and a live plugin message host is published."""
    manager = getattr(ctx, "_manager", None)
    if manager is None or getattr(manager, "_cli_ref", None) is not None:
        return False
    return bool(getattr(manager, "has_gateway_message_injector", False))


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


def _profile(ctx: Any) -> tuple[str | None, str | None]:
    """(profile name, profile home) of this plugin's copy, read at registration, while the host scopes the active
    profile to the one being loaded (later, on a thread of its own, the ambient profile may be another's)."""
    try:
        value = ctx.profile_name
        name = str(value()) if callable(value) else (str(value) if value else None)
    except Exception:  # noqa: BLE001
        name = None
    home = getattr(getattr(ctx, "_manager", None), "home_path", None)
    return name or None, (str(home) if home else None)


def _chat_ids(route_key: str | None, hermes_session: str | None) -> list[str]:
    """The ids a local session may be held under: the chat id its route key ends with, then the hook's session id."""
    out: list[str] = []
    if route_key and ":dm:" in route_key:
        out.append(route_key.rsplit(":dm:", 1)[1])
    if hermes_session and hermes_session not in out:
        out.append(hermes_session)
    return out


def _revive_local(ctx: Any, route_key: str | None, hermes_session: str | None) -> tuple[str | None, str | None]:
    """Reopen a resident's local session in this gateway, as the gateway itself does before it admits a cron or kanban
    wake into a local session that is not open. A gateway that restarted holds no local session until a client
    attaches, and an idle `hermes chat --cli` client redials only at its next call, so without this every injection
    is refused ("not a live local session"). (None, route key) when the session is open; (why not, None) otherwise.

    This reaches gateway internals (session_authorities, session_local_recovery); Hermes gives plugins no seam for
    it (docs/HERMES-PLUGIN.md, Upstream asks). Every step is guarded: a moved seam is a refusal, never a crash."""
    manager = getattr(ctx, "_manager", None)
    host = getattr(manager, "_gateway_message_injector", None)
    runner = host[0] if isinstance(host, tuple) and host else None
    loop = getattr(runner, "_gateway_loop", None)
    home = getattr(manager, "home_path", None)
    if runner is None or loop is None or home is None or loop.is_closed():
        return "no live gateway in this process", None
    try:
        if asyncio.get_running_loop() is loop:
            return "called on the gateway loop", None
    except RuntimeError:
        pass
    ids = _chat_ids(route_key, hermes_session)
    if not ids:
        return "no Hermes session id to reopen", None

    async def reopen() -> tuple[str | None, str | None]:
        from gateway.session_authorities import authority_for_home  # type: ignore[import-not-found]
        from gateway.session_local_recovery import restore_local_session  # type: ignore[import-not-found]
        authority = authority_for_home(runner, home)
        if authority is None:
            return f"this gateway serves no session authority for {home}", None
        scope: Any = contextlib.nullcontext()
        if getattr(getattr(runner, "config", None), "multiplex_profiles", False) is True:
            from gateway.run import _async_profile_runtime_scope  # type: ignore[import-not-found]
            scope = _async_profile_runtime_scope(Path(authority.profile_id))
        last = "not found"
        async with scope:
            for sid in ids:
                live = authority.sessions.get(sid)
                if live is None:
                    try:
                        restore_local_session(authority, sid)
                    except Exception as error:  # noqa: BLE001 - the next id, else the reason
                        last = f"{type(error).__name__}: {getattr(error, 'reason', None) or error}"
                        continue
                    live = authority.sessions.get(sid)
                if live is not None:
                    route = getattr(live, "route", None)
                    if route_key and route and route != route_key:
                        return f"session {sid} is open under route {route}, not {route_key}", None
                    return None, route or route_key
        return f"could not reopen session {' or '.join(ids)}: {last}", None

    future = asyncio.run_coroutine_threadsafe(reopen(), loop)
    try:
        return future.result(timeout=15)
    except Exception as error:  # noqa: BLE001
        future.cancel()
        return f"reopening failed: {type(error).__name__}: {error}", None


class Sessions:
    """The Residents of this process: one for the classic CLI's own session, else one per gateway session."""

    def __init__(self, ctx: Any) -> None:
        self.ctx = ctx
        self.lock = threading.Lock()
        self.by_key: dict[str, Resident] = {}
        self.profile, self.profile_home = _profile(ctx)
        self.unloaded = False
        self.rearm_report: dict | None = None
        # the classic CLI's own session; its problems are said when it is first used (in the gateway it never is)
        self.default = self.make(env=None, cwd=None, set_process_env=True, quiet=True)
        self.default_said = False

    def make(self, *, env: dict | None, cwd: str | None, set_process_env: bool, quiet: bool = False) -> Resident:
        def inject(text: str, session_key: str | None) -> bool:
            return bool(self.ctx.inject_message(text, session_key=session_key))

        def revive(route_key: str | None, hermes_session: str | None) -> tuple[str | None, str | None]:
            if not _in_gateway(self.ctx):
                return "not in a gateway", None
            return _revive_local(self.ctx, route_key, hermes_session)

        r = Resident(env=env, cwd=cwd, inject=inject, set_process_env=set_process_env, revive=revive,
                     profile=self.profile, profile_home=self.profile_home)
        if not quiet:
            self.say(r)
        return r

    @staticmethod
    def say(r: Resident) -> None:
        for problem in r.cfg["problems"]:
            logger.warning("agora-room: %s", problem)

    @staticmethod
    def dir_key(cwd: str) -> str:
        return "dir:" + os.path.normcase(os.path.abspath(cwd))

    @staticmethod
    def gateway_env() -> dict:
        # the gateway's own AGORA_* names belong to whoever started it, never to a session
        return {k: v for k, v in os.environ.items() if not k.upper().startswith("AGORA_")}

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
            key = self.dir_key(cwd)
        else:
            key = "session:" + (route or sid or "unknown")
        with self.lock:
            r = self.by_key.get(key)
            if r is None:
                r = self.make(env=self.gateway_env(), cwd=cwd, set_process_env=False)
                self.by_key[key] = r
        if route:
            r.route_key = route
        return r

    # ---- re-arm ----

    def resume(self, row: dict, by: str = "plugin-load") -> Resident | None:
        """Resume one ready candidate of room.rearm_candidates as this process's watch for its folder. None when this
        process already watches that folder, or the folder no longer configures that session."""
        key = self.dir_key(row["cwd"])
        with self.lock:
            if self.unloaded:
                return None
            r = self.by_key.get(key)
            if r is not None and (r.armed or r._thread is not None or r.stopped):
                return None
            if r is None:
                r = self.make(env=self.gateway_env(), cwd=row["cwd"], set_process_env=False)
            if r.session != row["session"] or not r.cfg["rooms"] or not r.cfg["watch"]:
                return None
            r.adopt(row["doc"], by=by)
            self.by_key[key] = r
        r.start_thread()
        return r

    def rearm_pass(self, now_ms: int | None = None, by: str = "plugin-load") -> dict:
        """One look at the liveness files: resume every ready watch of this profile. Returns what was seen."""
        report = rearm_candidates(home_of(os.environ), profile=self.profile, profile_home=self.profile_home,
                                  host_pid=os.getpid(), now_ms=int(time.time() * 1000) if now_ms is None else now_ms)
        rearmed: list[str] = []
        for row in report["ready"]:
            r = self.resume(row, by=by)
            if r is not None:
                rearmed.append(row["session"])
                logger.info("agora-room: re-armed the watch of %s (last tick %s; the process that ran it went away)",
                            row["session"], (r.rearmed or {}).get("lastTickBefore"))
        summary = {k: [{"session": x.get("session"), "file": x.get("file"), "reason": x.get("reason")} for x in v]
                   for k, v in report.items()}
        self.rearm_report = {**summary, "rearmed": rearmed}
        return {**report, "rearmed": rearmed}

    def start_rearm(self) -> None:
        """The re-arm thread (see the module doc). AGORA_ROOM_REARM=off in the gateway's environment turns it off."""
        if str(os.environ.get("AGORA_ROOM_REARM", "")).strip().lower() in ("off", "0", "false", "no"):
            return
        threading.Thread(target=self._rearm_loop, name="agora-room-rearm", daemon=True).start()

    def _rearm_loop(self) -> None:
        deadline = time.monotonic() + REARM_WAIT_S
        while not _gateway_live(self.ctx):
            if self.unloaded or time.monotonic() > deadline:
                return  # not a gateway (a listing, doctor), or one that never came up: nothing was started
            time.sleep(1.0)
        until = time.monotonic() + REARM_WINDOW_S
        while not self.unloaded:
            try:
                report = self.rearm_pass()
            except Exception as error:  # noqa: BLE001 - re-arming never takes the plugin down
                logger.warning("agora-room: re-arm: %s", error)
                return
            if not report["pending"] or time.monotonic() > until:
                return
            time.sleep(REARM_RETRY_S)

    def unload(self) -> None:
        """Plugin unload (a reload, a disable): stop every watch this copy runs, leaving each liveness file armed so
        the next load resumes it; a stale copy's threads must not keep polling beside the new copy's."""
        with self.lock:
            self.unloaded = True
            residents = [self.default, *self.by_key.values()]
        for r in residents:
            r.halt()


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

    on_unload = getattr(ctx, "on_unload", None)
    if callable(on_unload):
        try:
            on_unload(sessions.unload)
        except Exception as error:  # noqa: BLE001 - an older host: a reload leaves the old threads to the process
            logger.debug("agora-room: on_unload: %s", error)
    sessions.start_rearm()

    # Exposed for a probe from the same process (and the tests); Hermes never reads them.
    os.environ.setdefault("AGORA_ROOM_PLUGIN", "hermes")
    register.resident = sessions.default  # type: ignore[attr-defined]
    register.sessions = sessions  # type: ignore[attr-defined]
