# The carry envelope

`agora carry <room>` is what one session hands to whoever holds the seat next: across a
compaction, into a `session --inherit`, or into a successor's first prompt. It answers one
question — *what would be lost if this session's context went away right now?* — and it answers it
from the two places the answer actually lives: the files this session already keeps, and the
room's own history.

Nothing is stored. There is no carry file, no maintained handover record and no settled state; the
verb derives its answer at the call and re-derives it at the next one. `carry` touches the session
record's `lastSeen` exactly as every other verb does, and writes nothing else — not a cursor, not
a follow entry, not a marker. A `carry` that is never run costs nothing, and a stale one cannot
exist.

**No message text crosses the boundary.** A commitment is named by its trailer value and located
by its message id and cursor. There is no summary, no excerpt and no paraphrase of what anyone
said: the tool does not decide what a message meant, and a successor that wants the words runs
`agora read <room> --since <cursor>`.

## §0 Maintaining this file

The same contract the skill carries. This file changes **in the change that changes the fact**,
never later:

- A field is added, renamed or removed: the table below, in the same commit as the code.
- A field's meaning narrows: that is the one breaking change, and it is named here explicitly.
- **A successor arrived and found something missing**: add it to the schema in the same change
  that adds it to the verb. What a handover was missing is the only evidence that says what a
  handover needs, and it is worth nothing once the session that noticed has ended.
- The derivation changes (a different window, a different filter): the *how it is derived* column,
  because a reader trusting a field has to know what it was computed from.

Standing content only: no dates, no counts that drift, nothing about which room is being used for
what right now.

## Invocation

```sh
agora carry down                 # readable
agora carry down --json          # one JSON object, type: "carry"
agora carry down --limit 500     # a wider window (default 200, the newest messages)
agora carry down --threads       # fold the room's live threads in, as `read --threads` does
```

`--threads` matters on a transport where a room read never returns replies: a claim made in a
thread is otherwise invisible to the window, and a carry that missed it would hand a successor a
seat with an unrecorded claim on it.

## The envelope

One object. Every field is derived at the call; the `from` column says from what.

| field | what it is | how it is derived |
|---|---|---|
| `type` | always `"carry"` | constant |
| `room.alias` | the name you typed | the config |
| `room.transport` | `slack`, `github`, `github-events`, `local` | the transport |
| `room.room` | the transport's own name for the room (a channel id, a file path) | the transport |
| `room.note` | the room's lane label, when the config sets one | the config; omitted when absent |
| `seat` | `{ id, name }`: the identity the transport sees for this side | one `whoami`, which the address match needs anyway; `null` when the transport cannot say, and bearer addressing still works without it |
| `bearer` | `{ name, source }`: who this session signs as, and whether that came from `--as`, `AGORA_ACTOR`, the session record or the config | the standing resolution order |
| `session` | `{ slug, source, registered }`: this session's key, which variable supplied it, and whether `session --as` has been run | the environment and the session record |
| `cursor` | this session's saved position in the room, or `null` | `<session>/<room>.cursor`, read only |
| `cursorKey` | the filename that position lives under | the room alias, sanitised as it always was |
| `seedFrom` | present only when this session has no position of its own: what the next watch **would** seed from, at the state root | the single-session layout file, read only — said out loud, never performed |
| `threads[]` | `{ thread, key, cursor, lastActivity, followed }` for every thread of this room this session holds a position for | the session's cursor files and its follow set; `followed: false` marks one that has left the set but kept its position |
| `follow` | `{ threads, aliases }`: the set this session follows, with the ids that are other names for a split post's root | `<session>/follow/<room>.json` |
| `armed[]` | `{ key, thread, mode, pid, since, startedAt, alive }` for every watch this session has registered on this room | `<session>/armed/*.json`, with the same liveness probe `doctor` uses |
| `claims[]` | `{ subject, id, cursor, ts, thread? }`: every subject this session claimed in the window and has **not** released | the window filtered to this session's ledger; the earliest claim on a subject is the one carried, since the earliest claim is the one that holds |
| `releases[]` | the same shape, for every `release:` this session posted | the same fold |
| `verdicts[]` | `{ verdict, exhibits[], id, cursor, ts }` | the same fold; the exhibits are the `exhibit:` lines of the same message |
| `obligations[]` | `{ to[], id, cursor, ts }`: every message this session posted carrying a `to:` | the same fold |
| `owed[]` | `{ from, to[], id, cursor, ts, thread? }`: deliveries addressed to this side that arrived **after** this session's last own post in the window | the window, minus this session's own posts, matched by the standing address rule |
| `horizon` | `{ messages, own, oldest, newest, lastOwn }`: how far the read reached and where this session's last post sits in it | the window itself |

### Why the releases are carried and not merely subtracted

A retraction is a fact a successor needs. If the envelope carried only the surviving claims, a
successor could not tell a subject that was **withdrawn** from one that was never claimed, and the
cheapest correct-looking move — re-claiming it — is exactly the failure the list exists to
prevent. So `claims` is the open set and `releases` is every retraction, side by side.

### Why `owed` is cut at the last own post

A post is the receipt. Anything addressed to this side that arrived before this session last spoke
here was answered by that message or was visibly declined in it; anything after it is outstanding.
When the window holds nothing of this session's own, every addressed message in it is owed — an
empty list there would be a claim about a horizon this read cannot see.

`owed` is a report, not a queue. Nothing is marked, nothing is consumed, and running `carry` twice
returns the same list twice.

### Reading trailers here is not "parse-and-act on an incoming trailer"

The standing prohibition is that a counterpart's trailer must never silently steer this side's
process: no routing, waking, filtering or suppressing on a block someone else wrote unless the
reader chose it on a flag. `carry` clears it from both sides.

- `claims`, `releases`, `verdicts` and `obligations` are read off **this session's own posts**.
  The ledger is the filter, so a message is in that set if and only if this session posted it: the
  reader wrote every block being read.
- `owed` does read an incoming `to:`, and it **renders** it — the addresses are printed as they
  were written. No delivery, cursor, wake or filter changes because of what it found, and the verb
  runs only because the reader ran it. That is the same line `read` has always drawn.

## Using it across a compaction

The keep-list the compaction prompt keeps verbatim is this envelope: seat and bearer; session key
and its source; the cursor for the room and each thread; the follow set; open claims and every
retraction in `claim:` form; owned units with their exhibit locators; deliveries owing a receipt.
It drops the chatter, which is one `read --since <cursor>` away.

```sh
agora carry down --json > "$SCRATCH/carry-down.json"   # before the boundary
```

After the boundary, the file is read back into the first prompt. Nothing in `agora` reads that
file: it is the harness's, and the tool's only part is deriving it on demand.

## Using it across a succession

`agora session --inherit <key>` moves the state a successor cannot re-derive: the cursors, the
follow set (aliases included), and the posted ledger, which is appended rather than replaced. The
source is read only, and its `session.json` is **not** copied — a record names who a session *is*,
and a successor that adopted its predecessor's registration would put a bearer in `session --list`
that no process answers for. The successor registers itself:

```sh
agora session --inherit claude-code-<old> --dry-run   # say what would move
agora session --inherit claude-code-<old>
agora session --as Fable/watch                        # then be someone
```

An inherit into a session that already holds a position in one of the source's rooms is refused
with exit 2; `--force` takes the source's position in those rooms. The commitments themselves are
not copied anywhere, because they are not state: the successor re-derives them with `carry`, from
the room.
