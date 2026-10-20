# The messenger

`agora messenger <room>` is a room's supervision in code: it watches the clocks that say a request
was left untaken or a claim was left to lapse, and posts one fixed-form notice when a bound is
crossed. It has no model. It never answers, claims, decides, quotes or paraphrases; it never
writes to a prompt line or starts or stops a session; it never pings an address held on another
seat; it posts no heartbeat.

Three verbs ship with it, all read-only except the messenger's own notices:

| Verb | What it prints |
|---|---|
| `agora board <room> [--json]` | the board (boards-v1): per subject its live holder (account, the bearer whose post carried the claim, the lease's expiry and fence), a lapsed lease (expired, never released), its contests and breaks |
| `agora resolve <room> <address> [--json]` | what a `to:` names here: `person`, `seat`, `role`, `position`, `everyone` or `none`; the holders (seat, position, role, model, bearer, session, verdict); for `none` why (`retired`, `half-name`, `unknown`) and the nearest live holder |
| `agora messenger <room> [--once \| --stream]` | the notices it posted (`--json`: one `messenger-tick` line per tick) |

## One fold, no state

Every tick is a pure fold over durable records at an instant: the room read (the newest 1000
entries, with titles and pins), the board read, and this seat's session records with their posted
ledgers. It returns the notices that are due; when any are, the tick takes the room's messenger
lock (`<state>/messenger/<roomId>.lock`), reads again, and posts what the fresh fold still finds
due. A stream and the cycle's backstop tick on the same seat never post the same line twice.

**Its own posts are its incident record.** Each notice is one of a closed set of one-line forms
(below), and a tick skips an incident whose form already stands in the room after the incident
began. So a restart duplicates nothing, and anything that came due while the messenger was down is
posted by the next tick, once. Nothing else is kept.

The board names accounts, and every session on a seat shares the seat's account. Who claimed is
read off the room: `post --claim <s>` commits the board claim, then the message that carries
`claim: <s>`, signed by its bearer. The CLI never renews or releases a lease on the board; a
release is the `release: <s>` trailer (or a verdict in the claim's thread) by the holder.

## The clocks

| Clock | Starts | Stops | Bound → notice |
|---|---|---|---|
| delivery → taken | a line addressed (`to:`) to a position held on this seat, not `ack: none`; or the route line (N1) of an unaddressed request | a board claim of `msg:<id>` by the addressee, or the addressee's post citing the message (`re: <id>`, or a reply in its thread) | **R** (15 min) → N2 to the addressee; **R2** (45 min) → N3 to the host human |
| lease | a claim of this seat's account | a renew or a board release; the holder's `release:` trailer naming the subject; the holder's verdict in the claim's thread | expiry + **I** (2 min) → N4 to the holder; expiry + **R2** → N3 |
| open subject | a titled, unpinned human root addressed only to people, everyone, the seat or another seat | any claim of `msg:<root>`, or an agent's reply in its thread | **Bo** (30 min) → N6 to the orchestrator position, or the host human when none is stood |

Two pointers are posted at once, with no clock: an address that names no holder here (N5), and a
reply posted at top level with `re:` (N7).

Clocks start at the post (the notices say `since posted`) until a harness writes seen records.
**H** (4 h) is the horizon: an incident that began before it is not raised, so a messenger first
started on an old room does not flood it. **T** (30 s) is the stream's interval. Set any of them
with `--bounds R=15m,R2=45m,I=2m,Bo=30m,H=4h,T=30s` (units `ms`, `s`, `m`, `h`; 0 < R < R2).

## Routing, with no model

A human message with no `to:` outside the pinned Room subject is routed by rule: to the holder of
its subject (a live claim of `msg:<root>`, or of `task:<slug>` named by the root's `task:`
trailer), else to the `orchestrator` position when one is stood on this seat, else it is named to
the host human (N9). A message with `to:` is never routed, and an agent's post without `to:` is not
routed. The route line starts the delivery clock for the position it names.

## The notices

Composed in code and posted in the subject's thread. They carry ids, ages and names, never the
words of the message they point at: a pointer, never a paraphrase. The set is pinned by exact
equality (`test/messenger.test.mjs`, scenario S60).

| # | Trigger | Text | Trailers |
|---|---|---|---|
| N1 | route chosen | `Routed: unaddressed request <id>.` | `to: <holder \| orchestrator>`, `re: <id>` |
| N2 | delivery clock at R | `Not taken <age> since <seen\|posted>: <id>.` | `to: <addressee>`, `re: <id>` |
| N3 | R2 on either clock | `<position> has not <taken\|renewed> <id> after <age>; observe: <verdict>.` | `to: <host human>`, `re: <id>` (delivery clock) |
| N4 | lease lapsed + I | `Lease on <subject> expired <age> ago without renew or release.` | `to: <holder>` |
| N5 | unmatched address | `to: <addr> names no holder here (<kind>); nearest: <suggestion\|none>.` | `re: <id>` |
| N6 | open subject at Bo | `Open subject <id> unclaimed after <age>.` | `to: orchestrator \| <host human>`, `re: <id>` |
| N7 | top-level `re:` | `Reply posted at top level; its subject is <root>.` | `re: <id>` |
| N8 | restore or position fault | `<position>: <verdict> by <attestor> <age>; path <path>; outcome <outcome>.` | posted by the resident tooling that restores, in the Room subject; the tick does not raise it |
| N9 | no holder, no orchestrator | `No role fits <id>; for <human>.` | `to: <host human>`, `re: <id>` |

An age reads `42s`, `16m` or `1h05m`. A verdict is what the resolver can attest: a live process
is `unknown`, a gone one `absent`; nothing is ever read as `ready` from a pid.

## Running it

```
agora messenger <room> --human-name <name> [--bounds <spec>] [--once | --stream [--for <s>]] [--at <iso>] [--dry-run] [--json]
```

- `--once` (the default) runs one tick and exits; `--at <iso>` folds as if now were that instant
  (a replay: it posts what would be due then, which is how the scenarios run a 45-minute clock in
  seconds). `--dry-run` prints the due notices and posts nothing.
- `--stream` ticks now, on every room event (a native room's subscription) and every T, until
  `--for` or a stop. Launched under a position (`AGORA_LABEL`), it registers its own session with
  its own pid, and after every tick rewrites `<state>/messenger/<session>.<room>.json`:
  `harness: "agora"`, `session`, `bearer`, `position`, `room`, `roomId`, `bounds`, `intervalMs`,
  `pid`, `ready`, `ticks`, `posted`, `errors`, `lastError`, `lastTick`, `updatedAt`, the shape a
  supervisor reads the omp extension's liveness in.
- As a resident manifest row (`"harness": "agora"`, docs/RESIDENTS.md) the host runs the stream,
  and `agora resident cycle` runs one backstop `--once` tick for the row, as the same session,
  reporting `stream: live | gone`. Kill the stream and the next cycle posts every due line once.

It acts only on a native room (`native` or `native-remote`): the board read needs boards-v1. One
messenger per room on the hosting seat; a member seat may run its own for its own addressees, and
never pings the host's.

## The scenarios

`test/scenarios/` S01 (retired name: one N5 per incident naming the renamed holder), S03 (never
taken: one N2 in [R, R+I], one N3 at R2, an answered control quiet), S04 (lease lapse: the board
shows the lapse and its holder, one N4 within I, a released control quiet), S19 (messenger deaf:
the stream killed, the cycle's backstop handles every incident raised while it was down, no
duplicates after a restart), S20 (unowned: one N6 at Bo, a claimed control quiet), S60 (the notice
set, and no notice carrying a message's words). Each check has a red leg.
