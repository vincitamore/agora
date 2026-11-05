"""agora-room: Agora rooms in a Hermes session (agora's own plugin; see docs/HERMES-PLUGIN.md in the agora checkout).

register(ctx) registers the room_post and room_read tools and the hooks, and starts nothing: the watch thread starts
at the first hook a live agent fires (on_session_start or pre_llm_call), so `hermes plugins doctor`, a listing, or
any process that only imports the plugin spawns no agora child.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from .room import SUBAGENT, TOOLSET, Resident, tool_schemas

logger = logging.getLogger("agora-room")


def register(ctx: Any) -> None:
    def inject(text: str, session_key: str | None) -> bool:
        return bool(ctx.inject_message(text, session_key=session_key))

    resident = Resident(inject=inject, set_process_env=True)
    for problem in resident.cfg["problems"]:
        logger.warning("agora-room: %s", problem)

    def started(**kw: Any) -> None:
        if kw.get("platform") == SUBAGENT:
            return  # a subagent's session never watches the room
        resident.learn_session(kw.get("session_id"))
        if resident.cfg["rooms"]:
            resident.start_thread()

    def on_session_start(**kw: Any) -> None:
        started(**kw)

    def pre_llm_call(**kw: Any) -> None:
        started(**kw)
        resident.turn_start(**kw)
        return None

    def post_llm_call(**kw: Any) -> None:
        resident.turn_end(**kw)

    def on_session_end(**kw: Any) -> None:
        # Hermes fires this at the end of every turn, also a failed or interrupted one: the busy state never sticks.
        resident.turn_end(**kw)

    def post_api_request(**kw: Any) -> None:
        resident.api_request(**kw)

    def post_auxiliary_call(**kw: Any) -> None:
        resident.aux_call(**kw)

    def pre_tool_call(tool_name: Any = None, args: Any = None, **kw: Any) -> dict | None:
        return resident.pre_tool_call(tool_name, args, **kw)

    def post_tool_call(**kw: Any) -> None:
        resident.tool_event(**kw)

    for name, fn in (("on_session_start", on_session_start), ("pre_llm_call", pre_llm_call), ("post_llm_call", post_llm_call),
                     ("on_session_end", on_session_end), ("post_api_request", post_api_request),
                     ("post_auxiliary_call", post_auxiliary_call), ("pre_tool_call", pre_tool_call), ("post_tool_call", post_tool_call)):
        ctx.register_hook(name, fn)

    handlers = {"room_post": resident.post, "room_read": resident.read}
    for name, schema, description in tool_schemas():
        method = handlers[name]

        def handler(args: Any = None, _method: Any = method, **_kw: Any) -> str:
            try:
                return _method(args if isinstance(args, dict) else {})
            except Exception as error:  # noqa: BLE001 - a tool answers with a structured failure, never a raise
                return json.dumps({"ok": False, "error": f"agora-room: {error}"})

        ctx.register_tool(name=name, toolset=TOOLSET, schema=schema, handler=handler, description=description)

    # Exposed for a probe from the same process (and the tests); Hermes never reads it.
    os.environ.setdefault("AGORA_ROOM_PLUGIN", "hermes")
    register.resident = resident  # type: ignore[attr-defined]
