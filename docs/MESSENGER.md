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
| `agora resolve <room> <address> [--json]` | what a `to:` names here: `person`, `seat`, `role`, `position`, `everyone` or `none`; the holders (seat, position, role, model, bearer, session, verdict); for `none` why (`retired`, `half-name`, `unknown`) and the nearest live holder: for `unknown`, the one live holder whose position, role or bearer the address is one letter off (dropped, added or changed; addresses of three letters or more), `ambiguous` when two are, never a guess |
| `agora messenger <room> [--once \| --stream]` | the notices it posted (`--json`: one `messenger-tick` line per tick: `since`, its starting point in the room; `due`, `posted`, and `held`, the incidents a working holder held back, by clock: 1 delivery, 2 lease, 3 queue) |

## One fold, no state

Every tick is a pure fold over durable records at an instant: the room read (the newest 1000
entries, with titles and pins), the board read, and this seat's session records with their posted
ledgers, seen records and activity records. It returns the notices that are due; when any are, the tick takes the room's messenger
lock (`<state>/messenger/<roomId>.lock`), reads again, and posts what the fresh fold still finds
due. A stream and the cycle's backstop tick on the same seat never post the same line twice.

**Its own posts are its incident record.** Each notice is one of a closed set of one-line forms
(below), and a tick skips an incident whose form already stands in the room after the incident
began. So a restart duplicates nothing, and anything that came due while the messenger was down is
posted by the next tick, once. The one other thing kept is its starting point in the room (below).

The board names accounts, and every session on a seat shares the seat's account. Who claimed is
read off the room: `post --claim <s>` commits the board claim, then the message that carries
`claim: <s>`, signed by its bearer (`task:<slug>` is the board subject `work:task:<slug>`). A post
carrying `release: <s>` from the claim's holder (the session that posted the claim, or its
successor, which inherits its posted ledger) also releases the board claim once the message has
landed; another session's `release:` leaves it held and the post says why. The CLI never renews a
lease. A verdict in the claim's thread by the holder settles the lease clock as a release does.

## The starting point

A messenger first started on a room with history does not raise what came before it. At its first
tick in a room it records `<state>/messenger/<roomId>.start.json`:

```json
{"v":1,"type":"messenger-start","since":"<iso>","startedAt":"<iso>","lookBackMs":<n>}
```

`since` is the first start's wall-clock instant (never `--at`) less the look-back **L** (10 min by
default; `--bounds L=0s` starts at the room head). An incident that began before `since` is not
raised, as one that began before the horizon H is not. The record is kept across restarts, so a
restart, a stream that died, or the cycle's backstop tick raises everything that came due while it
was down. A `--dry-run` reads a recorded point and writes none (with none recorded it folds from now
less L, and says so on stderr); the first real tick prints the point it recorded. A torn record is a
first start again, the conservative floor. Delete the file to start the room over.

Measured on a 393-line room with a day's history: the build before the starting point found 94
notices due on a first start under H alone (86 N5, 8 N9); this one finds none.

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
| delivery → taken | the delivery of a line addressed (`to:`) to a position held on this seat, not `ack: none`, or of the route line (N1) of an unaddressed request: the instant the holder's session admitted it, from its seen record (below), else the post | a board claim of `msg:<id>` by the addressee, or a later post of the addressee's that cites the message (`re: <id>`) or stands in its subject: a reply in its thread or, when the line is itself a reply, a later reply in that same thread (native threads are one level, so a reply's own thread never fills). The addressee is the holder's bearer, a bearer the address names, or the session holding the position the address names (read from its posted ledger) | evidence: an idle or dark addressee, **G** after it went quiet (not before the delivery) → N2 to the addressee, **G2** → N3 to the host human; none: **R** → N2, **R2** → N3. A busy addressee draws neither: the line waits in its own harness |
| lease | a claim of this seat's account | a renew or a board release; the holder's `release:` trailer naming the subject; the holder's verdict in the claim's thread | evidence: expiry alone never pings a working holder; an idle or dark holder, **G** after the later of expiry and its going quiet → N4 to the holder, **G2** → N3; none: expiry + **I** → N4, expiry + **R2** → N3 |
| open subject | a titled, unpinned human root addressed only to people, everyone, the seat or another seat | any claim of `msg:<root>`, or an agent's reply in its thread | **Bo** (4 h) → N6 to the orchestrator position, or the host human when none is stood |
| queue | no task is held (§ The queue) and one is queued: from the later of the head task's queueing and the end of the last task held | a claim of any `task:<slug>` | evidence on the `orchestrator` position: a working orchestrator is held; an idle or dark one, **G** after the later of that instant and its going quiet → N10 to the orchestrator, **G2** → N3 `started` to the host human; none: **R** → N10, **R2** → N3. With no orchestrator stood: **R** → N10 to the host human, once |
| waiting | a task parked by a waiting line (§ The queue) | the task leaves waiting: claimed, or the person answered | **R** after the line → N11 to the person it names (a person keeps no activity record), once; and N12 to the orchestrator position once for each orchestrator session whose record started after the line, so a successor learns it from the room |

Two pointers are posted at once, with no clock: an address that names no holder here (N5), and a
reply posted at top level with `re:` (N7). An address held only by a session whose process is gone
is such a pointer (N5, `retired`), but only for a line posted after its holder had gone. N5 is
never posted for a line whose address was held when it was posted, read from the evidence that
outlives the holder: a session that has since ended and held it was seen alive at or after the post
(its record's `lastSeen`, its activity record's `updatedAt`), a holder of the address posted after
the line (its answer, or any line it signed, a notice too), or the line's N2 stands (its clock ran).
So an answered line never draws one, and a holder's later exit does not raise pointers after the
fact. A record removed with `session --forget` takes its evidence with it. A lapsed lease whose
holder's session is gone has no holder to read evidence from, so it runs on the time-only bounds.

A position is an address of its own: `to: main.coding`, or its role alone (`to: coding`), names the
session that holds `main.coding` (its `--label`), whatever its bearer. The resolver reads it so, and
the holder's `watch --wake mine` wakes on it (`matchesAddress` with the session's position), so a
clock that runs for a position runs against a delivery that happens.

Delivery is read from the seen record when the holder's session has one for the line, and the N2 then says `since seen`; with none, the clock runs from the post and N2 says `since posted` (the next section). The N3 line's `observe:` token says what the evidence was: `idle`, `silent` (the watch stopped refreshing), `stalled` (a turn with no progress for S), `gone`, or what the resolver can attest (`unknown`, `absent`) when it ran on the backstop.

The bounds, `--bounds R=2h,R2=4h,I=1h,Bo=4h,H=24h,L=10m,T=30s,G=10m,G2=30m,S=2h,D=5m` (any subset; units `ms`, `s`, `m`, `h`; 0 < R < R2, 0 < G < G2, L ≤ H):

| Bound | Default | What it bounds |
|---|---|---|
| **G** | 10 min | an idle or dark holder on an unresolved delivery or lease, or an idle or dark orchestrator with a task queued and none held: N2, N4 or N10 |
| **G2** | 30 min | the same, to the human line: N3 |
| **S** | 2 h | a busy holder with no progress at all this long is stalled, which reads as dark |
| **D** | 5 min | a watch whose record is older than this (or three of its intervals) is silent, which reads as dark |
| **R**, **R2**, **I** | 2 h, 4 h, 1 h | the **backstops** for a holder whose session writes no activity record: delivery to N2, delivery to N3, lease expiry to N4, the queue to N10 and N3. They are long on purpose: a worker that cannot show evidence is not pinged on a short clock, and where every session writes a record they are never the clock. Shorten them (`R=15m,R2=45m,I=2m`) only on a seat that wants a tighter bound without a record. **R** is also the waiting clock's bound (a person keeps no record): a waiting line to N11 |
| **Bo** | 4 h | an open subject before N6 |
| **H** | 24 h | the horizon: an incident that began before it is not raised, whatever the starting point |
| **L** | 10 min | the look-back of a first start: an incident older than the messenger's first start in the room less L is not raised (the starting point, above) |
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

## The queue

A room's task queue is a fold over trailers, stored nowhere. A **task** is a subject (a root and
its thread) that some line marks `task: <slug>` (the root, or the orchestrator's intake reply), or
whose `task:<slug>` some line claims or releases. In log order:

| Line | The task becomes |
|---|---|
| `task: <slug>` (first sight) | **queued** |
| `claim: task:<slug>` | **active**, held by the claim's bearer |
| `release: task:<slug>` with `verdict:` on the same line | **done** |
| `release: task:<slug>` of an active task, on a line that says `waiting: <person>; needs: <thing>` (a body line, or the `waiting` trailer) | **waiting** on that person |
| any other `release: task:<slug>` of an active task | **queued** again |
| a `verdict:` the holder posts in the task's subject, with no release | **done** |
| a human's line in a waiting task's subject, or citing the waiting line with `re:` | **queued** again (the answer is in) |

A release with no verdict acts only on an active task: a stray release after a close (freeing a
lease the close left held) does not reopen it. The head of the queue is the queued task whose
subject is pinned, else the one whose root is oldest, among those queued since the horizon and the
starting point (an older one is not raised and does not hide a newer one). The queue clock runs
only while no task is active, and only for the head. A waiting written
in prose is no waiting line: the release hands the task back to the queue. `task` is not one of the
keys that makes a trailer block a block, so a line whose block holds only `task:` is not read; the
orchestrator's intake reply carries `to:` and `re:` beside it.

N3 says `started` on the queue clock and names the head task's root. N12 is the arming line: each
orchestrator session whose session record started after a waiting line gets it once, addressed to
the position, so a session that took the position from a predecessor reads what is parked from its
own deliveries; the session that wrote the line (it started before it) does not.

## The notices

Composed in code and posted in the subject's thread. They carry ids, ages and names, never the
words of the message they point at: a pointer, never a paraphrase. The set is pinned by exact
equality (`test/messenger.test.mjs`, scenario S60).

| # | Trigger | Text | Trailers |
|---|---|---|---|
| N1 | route chosen | `Routed: unaddressed request <id>.` | `to: <holder \| orchestrator>`, `re: <id>` |
| N2 | delivery clock: an idle or dark addressee past G (R with no record) | `Not taken <age> since <seen\|posted>: <id>.` | `to: <addressee>`, `re: <id>` |
| N3 | G2 on any clock (R2 with no record) | `<position> has not <taken\|renewed\|started> <id> after <age>; observe: <verdict>.` | `to: <host human>`, `re: <id>` (delivery and queue clocks) |
| N4 | lease lapsed, holder idle or dark past G (expiry + I with no record) | `Lease on <subject> expired <age> ago without renew or release.` | `to: <holder>` |
| N5 | unmatched address | `to: <addr> names no holder here (<kind>); nearest: <suggestion\|ambiguous\|none>.` | `re: <id>` |
| N6 | open subject at Bo | `Open subject <id> unclaimed after <age>.` | `to: orchestrator \| <host human>`, `re: <id>` |
| N7 | top-level `re:` | `Reply posted at top level; its subject is <root>.` | `re: <id>` |
| N8 | restore or position fault | `<position>: <verdict> by <attestor> <age>; path <path>; outcome <outcome>.` | `ack: none`; posted by `agora resident ensure` for each start or stop (docs/RESIDENTS.md, Grants), as the room's messenger position, in the Room subject; the tick does not raise it |
| N9 | no holder, no orchestrator | `No role fits <id>; for <human>.` | `to: <host human>`, `re: <id>` |
| N10 | queue clock: no task held, the orchestrator idle or dark past G (R with no record, or with none stood) | `Queued task:<slug> not started after <age>, with no task held: <root>.` | `to: orchestrator \| <host human>`, `re: <root>` |
| N11 | waiting clock: R after the waiting line | `Waiting on <person> for task:<slug> after <age>: <line id>.` | `to: <person>`, `re: <line id>` |
| N12 | an orchestrator session started after a waiting line | `On arming: task:<slug> waits on <person> after <age>: <line id>.` | `to: orchestrator`, `re: <line id>` |

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

`test/scenarios/` S01 (retired name: one N5 per incident naming the renamed holder; the first start
raises nothing older than its look-back and one pointer for a line after it; no pointer for a line
to a position answered by its session, or posted while it lived, once that session ends), S03
(never taken: one N2 in [R, R+I], one N3 at R2, an answered control quiet, and a line posted as a
reply in a subject quiet once its addressee posts later in that subject), S04 (lease lapse: the
board shows the lapse and its holder, one N4 within I, a released control quiet), S13 (audiences:
a position address wakes the session holding it), S19 (messenger deaf:
the stream killed, the cycle's backstop handles every incident raised while it was down, no
duplicates after a restart), S20 (unowned: one N6 at Bo, a claimed control quiet), S60 (the notice
set, and no notice carrying a message's words, the queue's and the waiting record's included), S64
(queue clock: nothing while a task is held; once none is, one N10 for the queued task at G of quiet
and one N3 `started` at G2; one N11 to the person a waiting line names and one N12 to the position
after a new session takes it). Each check has a red leg.
