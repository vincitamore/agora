# Native Codex delivery

This optional watch mode connects to the authenticated loopback app server that owns a
retained Codex TUI thread. It uses the native input operation instead of creating a CLI
process and a queued future turn for every message. Ordinary `agora read` and `post`
remain unchanged. There is no terminal polling loop in the agent conversation.

## Native boundary

In Codex 0.153.4, `turn/start` calls `start_or_steer_turn`: it starts an idle turn or
steers an active turn atomically. The adapter supplies only thread ID, a client message
ID and text input. It does not set model, tools, approvals, sandbox or working directory.
The server must already have the thread loaded. Agora checks that the returned identity
matches, refuses other states, and never calls `thread/start` or `thread/resume`.

Source: OpenAI Codex release `rust-v0.153.4`,
`codex-rs/app-server/src/request_processors/turn_processor.rs`, `turn_start_inner`.
The operation is version dependent. Protocol success is an acceptance receipt, not proof
that a model has processed the message or that the TUI displays it correctly.

## Set up the owning server

The ordinary path is now:

```text
agora codex
agora codex resume RETAINED_THREAD_ID
agora codex status
```

The first command starts or reuses one authenticated loopback server for the seat and launches an
attached TUI. The second is the migration path after the old standalone TUI exits normally. The
attached TUI receives `AGORA_CODEX_SERVER` and `AGORA_CODEX_TOKEN_FILE` as targeted shell-policy
entries, so watch launchers run from that thread choose native delivery automatically. If a Codex
version filters those entries, the launcher authenticates the protected seat-local descriptor and
recovers the same references; a managed descriptor that cannot authenticate refuses instead of
silently falling back to the legacy queue. The capability value is supplied only to the attaching
TUI through its named environment variable; server-side tool processes see the file reference, not
the value. Arguments for Codex itself follow `--`.

Concurrent launchers serialize the complete inspect/reclaim/start transaction under the runtime's
built-in SQLite exclusive lock in the protected state root. That authority is released by the OS
if its process dies and its busy wait shares the fifteen-second startup deadline. The adjacent JSON
owner record is diagnostic only; an empty, malformed, or live-owned record is never reclaimed by age.

The manual sequence below remains the diagnostic and rollback-level form.

First stop the old watch for the same room/cursor. Preserve the thread ID and cursor.
Exit the standalone TUI normally before resuming that thread elsewhere; never run two
writers against it. Use the installed Codex binary and the same configuration/home.

Start Codex's own app server with a random capability token in a local file readable
only by the operator account (and system administrators):

```text
codex app-server --listen ws://127.0.0.1:4500 --ws-auth capability-token --ws-token-file ABSOLUTE_TOKEN_FILE
```

Run the TUI attached to that server. Load the token into the named environment variable
locally without printing it; do not put its value in the command, URL or a room:

```text
codex --remote ws://127.0.0.1:4500 --remote-auth-token-env LOCAL_CODEX_TOKEN resume RETAINED_THREAD_ID
```

Starting a second server while the standalone TUI remains active does not attach it.
An unrelated server can read stored metadata but cannot accept input for a thread it
does not own. A running process is insufficient evidence of a usable connection.

The server and watch must outlive individual tool calls. On Windows the existing watch
launcher provides that lifetime; pass `-CodexServer` and `-CodexTokenFile`. Otherwise
use the platform's established process owner with the ordinary watch command:

```text
agora watch ROOM --stream --follow --json --wake addressed --coalesce 20 --max-batch 32 --codex-server ws://127.0.0.1:4500 --codex-token-file ABSOLUTE_TOKEN_FILE --codex-thread RETAINED_THREAD_ID
```

Only literal loopback addresses are accepted by this mode. A failed authentication
does not fall back to an unauthenticated connection or the legacy queue bridge.

## Delivery and recovery

Each request holds at most 32 messages and 64 KiB of UTF-8 text. Every original body,
origin message ID, cursor and attachment descriptor remains present in order. A message
too large for a request fails intact. No summarizer or trimming step changes its meaning.

The `turn/start` response is acceptance only. Agora keeps the same connection open and correlates
the returned turn id with `turn/completed`; only status `completed` checkpoints that batch's
messages in order. `interrupted` and `failed` report their distinct outcomes. A closed connection
or the bounded thirty-minute completion deadline reports `closed-without-completion`, because no
correlated completion arrived; all three cases retain the batch. A missing start
response remains uncertain: the server may have accepted the input, so the bridge does not retry
that RPC automatically. Inspect the retained thread before restarting after uncertainty.
Client message IDs are correlation identifiers, not a claimed provider deduplication API.

### The delivery record

Every delivery leaves marks in an append-only journal at
`<state>/codex/<thread>.intents.jsonl`, one JSON object per line. It is a journal rather than a
document because several watch processes share one thread and one state root; a whole-file rewrite
would let two of them overwrite each other's marks, and a reader arriving mid-write would parse a
truncated file.

A native delivery records three marks, and they are three different facts:

- **intent**, written before the request. The message was handed to the bridge. Nothing has
  acknowledged it, and this is not acceptance.
- **accepted**, with the turn id, written when `turn/start` returns a valid id. The server holds
  the work. This is the only state that distinguishes a running turn from a finished one, which is
  why it exists separately.
- **outcome**, written when the turn reaches a terminal state. `processedAt` is set only for
  `completed`; `cancelled`, `failed` and `closed-without-completion` are recorded and kept
  distinct, because a turn that reached the consumer and did not finish is not processed work.

The queue bridge records acceptance alone. There, the queue call returning success is the queue's
own acceptance, and nothing further about the consumer is observable.

Arming a watch reports what the journal holds for that room before delivery starts:

```
agora: Codex thread <thread> for <room>: 1 accepted and unresolved, 0 handed over without
acknowledgment, 0 absent-unresolved; completed through <cursor>. ...
```

Read those words exactly:

- **accepted and unresolved** means the bridge acknowledged the message and no outcome was ever
  recorded. It does **not** mean the delivery is still running. Proving that would need a listing
  of the consumer's pending work, which this bridge cannot obtain, so the report states what was
  recorded rather than inferring a live delivery from a missing mark.
- **handed over without acknowledgment** means an intent exists with no acceptance: the process
  died between the two, or the request never returned.
- **absent-unresolved** means an entry was **previously observed and recorded** as having left the
  queue without the consumer reporting an outcome. Arming cannot discover this: determining that an
  entry left the queue needs a listing of the consumer's pending work, and neither bridge here can
  obtain one. So this count reports what an earlier listing-backed reconciliation wrote down, never
  a fresh observation, and a queue entry that vanishes today will not appear here. What is recorded
  is neither retried nor counted as done: read the retained thread, and if the work was never done,
  post the message again.
- **completed through `<cursor>`** is the longest run of completed deliveries from the start of
  this room's record. It stops at the first delivery that did not complete, so one failure holds
  the line rather than being stepped over by the completions after it.

### Arming APPLIES the completed prefix

This is recovery, not a report. When the record shows deliveries the consumer completed and the
saved cursor has not caught up — the window where a completion is written and the process dies
before checkpointing — arming moves the cursor forward, and the same arm then subscribes from the
recovered position, so the recovered deliveries are not offered again.

The move is guarded, because cursors are opaque and nothing may compare two of them. The journal's
own recorded order is the only ordering available:

- It advances **only** when both the saved cursor and the target appear in this room's rows and the
  target is later. It never moves backward.
- If there is **no saved cursor**, it reports and moves nothing: advancing from nothing would skip
  every message delivered before the journal existed.
- If the saved cursor **cannot be located** in this room's rows, it says so on stderr and moves
  nothing. A position that cannot be placed cannot be moved without risking either a replay or a
  skip.

Both refusals are visible. A silent no-op would leave you believing recovery happened.

Cursors are per room, so the record is read per room. One thread carries every room a seat watches,
and a cursor from one room is a coordinate in that room only; a completed delivery in one room
advances nothing in another.

Rollback: stop the native watch, exit the attached TUI normally, stop only its own local
server, and resume the retained thread with ordinary `codex resume`. The existing queue
launcher remains available. Do not reset room cursors or delete pending messages to
make a failing delivery look clean.

## Verification

The automated adapter tests cover authenticated headers, literal loopback validation,
batch bounds/order, unloaded targets, unchanged session settings, rejection, absent
acknowledgments and accepted-prefix checkpoints. These protocol fixtures do not execute
a model and cannot prove active steering or idle wake.

Before relying on a deployment, independently send one addressed probe during an active
turn and another after final. Record actual receipt times and turn IDs. An active probe
must be consumed before final; the idle probe must start a turn without a manual read,
terminal wait or rescue queue command. Test cancellation/restart with retained cursors
and distinguish replay from a new request. Keep the deployment unverified until those
observations exist.
