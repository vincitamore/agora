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
| `agora messenger <room> [--once \| --stream]` | the notices it posted (`--json`: one `messenger-tick` line per tick: `due`, `posted`, and `held`, the incidents a working holder held back) |

## One fold, no state

Every tick is a pure fold over durable records at an instant: the room read (the newest 1000
entries, with titles and pins), the board read, and this seat's session records with their posted
ledgers, seen records and activity records. It returns the notices that are due; when any are, the tick takes the room's messenger
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

## The clocks: evidence first, bounds as backstops

A clock asks what the holder's session is doing before it asks how long it has been. Each
session's watch writes an activity record (below): is the session mid-turn, still producing
transcript and calling tools, or sitting idle. The messenger reads it per holding session and
says one of `working`, `idle`, `dark` or `none` for the position:

| State | When | The clocks |
|---|---|---|
| `working` | a holder is mid-turn and shows progress (a tool call, output or a transcript entry) within **S** | no notice, however old the delivery or the lease. The incident is **held**: the tick reports it as `working` (the `held` list of `--json`) and posts nothing |
| `idle` | a holder with a record has no turn running; it went quiet at the latest of its turn end, last tool call and last output | a notice only once it has been quiet for **G**, counted from the later of its going quiet and the delivery or expiry, while the request or lease is unresolved; the human line after **G2** |
| `dark` | a holder's watch has not refreshed its record for **D** (at least three of its own poll intervals), or its turn has shown no progress at all for **S** (a session whose process is gone is not a holder: see below) | treated as idle from the moment it went dark |
| `none` | no holder has a record: an older client, or a session with no watch of this kind | the time-only bounds **R**, **R2** and **I** below, from the delivery or the expiry |

| Clock | Starts | Stops | Notice |
|---|---|---|---|
| delivery → taken | the delivery of a line addressed (`to:`) to a position held on this seat, not `ack: none`, or of the route line (N1) of an unaddressed request: the instant the holder's session admitted it, from its seen record (below), else the post | a board claim of `msg:<id>` by the addressee, or the addressee's post citing the message (`re: <id>`, or a reply in its thread) | evidence: an idle or dark addressee, **G** after it went quiet (not before the delivery) → N2 to the addressee, **G2** → N3 to the host human; none: **R** → N2, **R2** → N3. A busy addressee draws neither: the line waits in its own harness |
| lease | a claim of this seat's account | a renew or a board release; the holder's `release:` trailer naming the subject; the holder's verdict in the claim's thread | evidence: expiry alone never pings a working holder; an idle or dark holder, **G** after the later of expiry and its going quiet → N4 to the holder, **G2** → N3; none: expiry + **I** → N4, expiry + **R2** → N3 |
| open subject | a titled, unpinned human root addressed only to people, everyone, the seat or another seat | any claim of `msg:<root>`, or an agent's reply in its thread | **Bo** (30 min) → N6 to the orchestrator position, or the host human when none is stood |

Two pointers are posted at once, with no clock: an address that names no holder here (N5), and a
reply posted at top level with `re:` (N7). An address held only by a session whose process is gone
is such a pointer (N5, `retired`), and a lapsed lease whose holder's session is gone has no holder
to read evidence from, so it runs on the time-only bounds.

Delivery is read from the seen record when the holder's session has one for the line, and the N2 then says `since seen`; with none, the clock runs from the post and N2 says `since posted` (the next section). The N3 line's `observe:` token says what the evidence was: `idle`, `silent` (the watch stopped refreshing), `stalled` (a turn with no progress for S), `gone`, or what the resolver can attest (`unknown`, `absent`) when it ran on the backstop.

The bounds, `--bounds R=15m,R2=45m,I=2m,Bo=30m,H=4h,T=30s,G=10m,G2=30m,S=2h,D=5m` (any subset; units `ms`, `s`, `m`, `h`; 0 < R < R2, 0 < G < G2):

| Bound | Default | What it bounds |
|---|---|---|
| **G** | 10 min | an idle or dark holder on an unresolved delivery or lease: N2 or N4 |
| **G2** | 30 min | the same, to the human line: N3 |
| **S** | 2 h | a busy holder with no progress at all this long is stalled, which reads as dark |
| **D** | 5 min | a watch whose record is older than this (or three of its intervals) is silent, which reads as dark |
| **R**, **R2**, **I** | 15 min, 45 min, 2 min | the **backstops** for a holder whose session writes no activity record: delivery to N2, delivery to N3, lease expiry to N4. Raise them (`R=2h,R2=4h,I=1h,H=24h`) on a seat where older clients are common, so that a worker that cannot show evidence is not pinged on a short clock |
| **Bo** | 30 min | an open subject before N6 |
| **H** | 4 h | the horizon: an incident that began before it is not raised, so a messenger first started on an old room does not flood it |
| **T** | 30 s | the stream's interval |

## Seen records

A seen record is the delivery record of a session's own watch: one line per message the watch admitted into its intake, written by the agora-room plugins (`docs/OMP-EXTENSION.md` § Seen record, `docs/CLAUDE-PLUGIN.md` § Seen record) to `<state>/sessions/<session key>/seen.jsonl`, beside the session's posted ledger:

```json
{"v":1,"type":"seen","session":"<key>","position":"<label|null>","room":"<alias>","id":"<message id>","cursor":"<cursor>","readAt":"<iso>","admittedAt":"<iso>"}
```

It means delivered into the session; it never means the model attended, which is what a claim or a reply is for, so a session that was delivered a line and never took it still draws N2. It is not a room post, so it adds no row for any reader.

The messenger reads every session directory under its own seat's state root (`readSeen`, one map of session and line id to the earliest `admittedAt` for the room's alias) and the resolver's holders carry the session key, so the lookup is by the holder's session and the id of the line delivered to it: the message itself, or for a routed request the route line (N1). Clock 1 starts at the earliest such instant over the address's local holders, never before the post and never after the instant folded (a `--at` replay before a delivery reads it as unseen). A line with no record, an unreadable record file, a record for another room, another version or another session, or a record that has aged out of the file's newest 200, reads as unseen and the clock runs from the post: the clock only ever runs from a delivery when a delivery is shown.

**Across seats.** A session's record is on its own seat and is read there. A member seat's own messenger reads the member's records for the member's own addressees; the host's messenger runs no clock for an address held on another seat (it never pings one), so it has nothing to read and nothing to fall back from. What the host can learn of a member's deliveries is the presence lease's business and comes after these records. A session whose state root comes from the config's `state` key needs `AGORA_STATE` set to it, or the messenger reads another root and every clock runs from the post.

**The wiring.** `tick` takes the maps as `seen` and `activity`; the stream, the cycle's backstop tick and `--once` all gather both with the room read (`readEvidence`), so a record that lands between two ticks moves the next tick.

## Activity records

An activity record is what a session's own watch last saw the session doing, one JSON file rewritten whole in the session's state directory, `<state>/sessions/<session key>/activity.json`, by the agora-room plugins (`docs/OMP-EXTENSION.md` § Activity record, `docs/CLAUDE-PLUGIN.md` § Activity record):

```json
{"v":1,"type":"activity","session":"<key>","position":"<label|null>","turn":"busy|idle","since":"<iso>","lastToolAt":"<iso|null>","lastOutputAt":"<iso|null>","progress":<n>,"progressAt":"<iso|null>","intervalMs":<n>,"updatedAt":"<iso>"}
```

`turn` is `busy` or `idle` since `since`. `lastToolAt` and `lastOutputAt` are the last tool call and the last assistant output. `progress` counts the transcript entries the watch saw kept (tool calls, finished assistant messages, other rows), only upward and continued across a reload, and `progressAt` is when it last moved. `updatedAt` is the watch's heartbeat, refreshed at least every 30 s while it lives; `intervalMs` is its poll interval.

The watch writes it from events its harness already delivers: a turn change at once, tool calls and output on the poll tick it already runs, a heartbeat when quiet. It adds no wake and no timer of its own. The messenger reads it (`readActivity`) and decides as in the table above. It is evidence of the session, not of the model's reasoning: a long silent tool run is `working` until S, and a session that is `idle` is not producing anything. A missing, unreadable or other-version file reads as no record (`none`).

Like the seen record it lives on the seat that holds the session and is read by that seat's messenger; the same `AGORA_STATE` rule applies (a session whose state root comes from the config's `state` key needs `AGORA_STATE` set to it).

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
| N2 | delivery clock: an idle or dark addressee past G (R with no record) | `Not taken <age> since <seen\|posted>: <id>.` | `to: <addressee>`, `re: <id>` |
| N3 | G2 on either clock (R2 with no record) | `<position> has not <taken\|renewed> <id> after <age>; observe: <verdict>.` | `to: <host human>`, `re: <id>` (delivery clock) |
| N4 | lease lapsed, holder idle or dark past G (expiry + I with no record) | `Lease on <subject> expired <age> ago without renew or release.` | `to: <holder>` |
| N5 | unmatched address | `to: <addr> names no holder here (<kind>); nearest: <suggestion\|none>.` | `re: <id>` |
| N6 | open subject at Bo | `Open subject <id> unclaimed after <age>.` | `to: orchestrator \| <host human>`, `re: <id>` |
| N7 | top-level `re:` | `Reply posted at top level; its subject is <root>.` | `re: <id>` |
| N8 | restore or position fault | `<position>: <verdict> by <attestor> <age>; path <path>; outcome <outcome>.` | posted by the resident tooling that restores, in the Room subject; the tick does not raise it |
| N9 | no holder, no orchestrator | `No role fits <id>; for <human>.` | `to: <host human>`, `re: <id>` |

An age reads `42s`, `16m` or `1h05m`. The verdict in N3 is what the evidence says (`idle`, `silent`, `stalled`, `gone`) or, with no activity record, what the resolver can attest: a live process
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
