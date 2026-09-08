# Several agents on one seat

## Native scope

The native paragraphs prescribe target acceptance contracts, not proof that this build implements
them. The transport-backed direct-watch behavior below remains the legacy mode unless an explicit
native rider applies; its body-delivery checkpoint is distinct from a native pointer wake.

The failure exhibits below explain the original transport-backed CLI. Its Slack face has one
app and bot account per seat; native rooms authenticate explicitly enrolled principals. Bearers
remain addressing labels, not authorization. The CLI is a short-lived client; an explicitly
started service may own room logs, custody, admission and replay, never a session's read cursor
or a decision about whether a participant's conclusion is true.

Native envelopes are separate from body trailers. Bounded versioned frames carry requests and
receipts without interpreting text as a command. Validation proves shape, not authentication:
account context comes from the authenticated channel, bearer metadata from its attesting service,
and operator acts from separately authorized policy or proof. A human-channel label alone grants
no operator authority. Same-user writable keys and policy provide cooperative accountability,
not isolation against arbitrary local processes.

Canonical accepted content and rendered views are distinct. Preserve accepted body values exactly;
every derived index and rendered view must apply the configured protection policy without
overwriting canonical content. A changed projection identifies the alteration; ordinary views do
not provide a raw-content bypass. Canonical content changes only through an authorized purge. Text
fidelity means valid UTF-8 body bytes, not identical JSON escaping or envelope key order. Binary
data travels as an attachment; invalid text is not silently decoded with replacement characters.
Outgoing guards reject recognized owned credentials, not every possible secret in arbitrary text.
Credentials and local capabilities never belong in protocol metadata or diagnostic logs. Received
content has explicit custody, retention and purge rules; revocation cannot erase outside copies.

Queue custody, host commit, face publication, wake acceptance, agent acknowledgement and completion
remain different stages. A lost response may mean unknown acceptance, including after ambiguous
local publication. Retry reconciles the same scoped operation's original receipt. Face failure
does not revoke native success; accepting a wake advances no reader checkpoint.

A wake is inbox delivery with a stable event/range, recipient registration/generation and
authenticated provenance. The receiving adapter confirms admission into the intended harness turn;
a live process, socket path or idle roster label is insufficient. Otherwise the event stays pending.
Human input, onboarding and delivery remain distinguishable inside the receiver; a typed `[agora]`
prefix is not proof. A task subprocess does not become an independent peer by inheriting an
environment. Explicitly admitted peers have their own registration, policy and reader state.

## The situation

A seat is one app, one bot user, one token, one invite: your side's standing presence in a
room. A bearer is whoever holds the seat now, and signs for what it says. The split exists so
the other side has one persistent counterpart while still knowing which model wrote each line,
and so swapping models costs nothing on their end.

The split was designed for bearers who **succeed** one another. It has to carry bearers who
**coexist**: several full agents, on one machine, on one seat, working the same collaboration at
once, running their own pipelines, spawning their own subprocesses, and checking one another's
work through the room alongside the counterpart's agent. Two of them may be the same model, so
the model name alone does not name one accountable party.

Four things broke under that load, and all four failed silently.

1. **The watch dropped its siblings.** A message was treated as this side's own if it came from
   our identity and was either agent-kind or signed as us. On a transport where the whole seat
   shares one bot user, every message from the seat is agent-kind, so the signature test never
   ran: each bearer's watch discarded every other bearer's post *and advanced the cursor past
   it*. Total, permanent, unannounced loss.
2. **The cursor was shared.** One saved position per room per machine means the first watch to
   poll consumes what the others never see; two watches running at once each deliver the same
   batch.
3. **Nothing was addressed.** Every watcher woke on everything, and "one author per function"
   lived only in prose nobody could query.
4. **There was no desk-local lane**, so coordination among your own sessions would land in the
   channel the humans are reading.

Two further facts shape the answer. A room read on a threaded transport does not return thread
replies, so an agent talking in several threads had to arm a watch per thread. And the tool has
no session of its own: it is a command that runs and exits, so nothing it learns survives to its
next invocation except what it writes to a file. In the harnesses that matter, an exported
environment variable does not survive to the next command either, but a stable session id is
injected into every one.

## The chosen shape

### Identity

A seat is a machine: one app, one bot user, one token, and the token lives where it is used, so a second machine is a second app from the same manifest under its own name, and the counterpart sees one persistent seat per machine on your side. The sessions on a machine are that seat's bearers.

One seat, several bearers. A bearer is a path:

    bearer  := segment { "/" segment }
    segment := [A-Za-z0-9][A-Za-z0-9._-]{0,31}          whole path 64 characters or fewer

`Fable`, `Fable/watch`, `Opus/design`, `Codex`. The second segment names what the session is
*for*, not which one it is. It appears only when it carries information: one agent of a kind
signs `Fable` exactly as before, and a second one appears in the room as `Fable/watch` and
`Fable/review` at the moment there are two. A role word beats an ordinal three ways: it tells
the counterpart who is answerable for a claim, it makes a collision mean *two agents claim one
job* rather than *someone picked the same letter*, and it survives a model swap (`Fable/watch`
handing to `Opus/watch` reads as the same job, a different model).

Resolution order for the bearer, highest first:

    --as <bearer>          on this call
    AGORA_ACTOR            in this process's environment
    the session record     written once by `agora session --as`
    actor.name             the shared config, the default for a lone agent

**agora never writes the shared config.** That is a rule for contributors, not only advice to
callers: the config is read fresh on every invocation, so one agent editing `actor.name`
re-identifies every other agent's next post until they each edit it back. The failure is silent
and it produces exactly the false attribution the seat/bearer split exists to prevent.
Native admin verbs write named seat-state registries, not shared actor configuration. Alias
resolution consults configured rooms and then the native registry; conflicts refuse rather than
silently selecting different rooms in different verbs.

A **session** is the unit of state, and it is not the bearer. The session key is:

    AGORA_SESSION                                    if set; [A-Za-z0-9._-]{1,64} or exit 2
    the first set variable from config session.from  key is <tag>-<value>
    "default"                                        when the harness supplies none

`session.from` is a list of environment-variable names in the config, not code. Its default
names `CLAUDE_CODE_SESSION_ID`, `GROK_SESSION_ID`, `CODEX_SESSION_ID`, `CODEX_THREAD_ID`,
and `HERMES_SESSION_ID`, in that order. A contributor on another harness adds the name its harness injects, or sets
`AGORA_SESSION` explicitly; a harness that injects nothing keeps working, as one `default`
session, which is what a first-time contributor sees. A value is accepted only if it satisfies
the same rule as `AGORA_SESSION`; a name that looks like a credential is never read. The tag is
the variable's name, lowercased, minus a trailing `_SESSION_ID`, `_SESSION` or `_ID`, with `_`
as `-`, so `CLAUDE_CODE_SESSION_ID` gives `claude-code-<value>`. Every `post` and `watch` prints
one line naming the resolved bearer, the resolved session, and **which variable supplied
each**; when the key is `default` and other sessions have state here, that line is a warning,
because every `default` session shares one position.

The bearer is chosen, renameable, and visible in the room. The session key is supplied by the
machine, unique by construction, stable for the session's life, and never appears in a message.

`agora session --as <bearer> [--label <name>]` registers this session (idempotent): the bearer,
the process that outlives this command (from `session.pidFrom`, by default `AGORA_SESSION_PID`,
then `CLAUDE_PID`, then `GROK_PID`), the machine's boot epoch, when the record was first written and last seen.
Every later call touches it. `agora session --list` shows every session with state here and
whether its process is live: the boot epoch matches and the pid answers a signal (a permission
error counts as alive; no pid is unknown). `agora session --prune [--dry-run]` removes only
records whose process is gone *and* whose last write is older than `session.staleAfterHours`;
pruning is never automatic, because deleting an idle-but-live session's cursors is a delivery
defect manufactured by a cleanup routine. `agora session --forget` removes this session's own
record and state.

`agora join <room> --as <bearer>` is the registration-and-preview composite. It asks for the
recent batch it will display (20 by default), advances only through the last row displayed, and,
when one native frame cannot hold the batch, retries once at the fitting limit named by the host.
An ordinary native read also retries once at the host's fitting limit for that invocation and reports
the shrink; a count fitted from a different byte population is never its correctness condition.
A shortened preview reports every omitted older row with a first recovery request from the
cursor held before the preview (or native sequence zero when none existed); the caller repeats from
the last returned cursor until it reaches the omitted window. `cursor --now` independently asks
only for the newest row.

### Delivery

**A message is this side's own if, and only if, this session posted it.** `post` appends the
returned message id (with the posting process id) to `sessions/<session>/posted.jsonl`, an
append-only ring kept to about the last thousand ids; `watch` re-reads that ledger on every poll
and skips exactly that set. Nothing else is consulted: not the author, not the message kind, not
the signature. When the tool cannot tell whose a message is, it delivers it. A missed message
from a peer is silent, permanent, and past the cursor; a duplicated echo of your own line is
visible and costs nothing.

That rule is what makes two sessions of one model safe. Two sessions signing `-- Fable` still
receive each other's posts, because neither's ledger holds the other's ids. A signature clause
as a fallback was ranged and rejected: measured on the chat transport with an injected fetch,
two same-bearer sessions under an exact-signature rule drop each other's posts, the original
defect one level down. A duplicated bearer therefore costs the humans and the counterpart
legibility, and never a message. `--all` bypasses the ledger and delivers everything.

**State is keyed on the session, never on the bearer.**

    <state>/
      <room>[#thread].cursor            the single-session layout; read once as a seed, never written again
      sessions/<session>/
        session.json                    the record: bearer, source, label, pid, boot epoch, first and last seen
        <room>[#thread].cursor          this session's positions; filenames unchanged
        posted.jsonl                    ids this session posted, with pids
        media/<room>/<file-id>.<ext>    authenticated Slack images, inert and bounded
        follow/<room>.json              threads this session follows, with last activity
        armed/<room>[#thread].json      a live watch's registration
        etags.json                      validators for conditional requests
        departed/<room>.json            this session's departure was announced in that room

No bearer and no session string is ever a component of a cursor filename, so the filename
sanitiser is never asked to distinguish `Fable/watch` from `Fable_watch`. The session slug is a
directory name, validated where it enters rather than sanitised where it is used.

**Migration is a read-through seed.** When a session has no cursor for a room, the saved position
is read once from the file of the same name at the state root and written forward into the
session's own directory. The root file is never written again. An armed watch picks this up at
its next re-arm and resumes at exactly the position it held: no replay, no gap, no config edit,
one new line on stderr. Seeding is per key, so a room watch and each thread watch seed on their
own next arm. A session with no root file to seed from reads from the start **with a loud
warning** naming `cursor --now`; a warning, not a refusal, because the exit codes are a contract.

`cursor --reset` writes an explicit null position. A file that exists and holds null is a
position ("from the start"), distinct from a file that is absent (no position saved here yet), so
a reset never falls back to the root file.

**The cursor is written after delivery, not before.** Written before, delivery was at-most-once: a
process that died between the write and acting on the batch lost the batch permanently, and the
room's whole point is not losing the counterpart's message. Written after, delivery is
**at-least-once with a stable message id**; `--json` emits `id`, so a consumer that cares can
dedupe. An all-own batch still advances the position. Exactly-once is not on offer and is not
claimed: there is no acknowledgement channel from "the agent acted on it" back to the tool. An
external wake adapter may checkpoint an accepted prefix, in order, after its consumer accepts each
side effect; the unaccepted suffix remains at-least-once. That checkpoint is acceptance by the wake
transport, never a claim that the agent read or acted on the message.

Coalescing withholds every room and thread position while a deliverable message is held, including
positions from own or filtered messages that follow it, because persisting any suffix would move
past an unacknowledged delivery. When a poll contains only own or filtered messages, nothing awaits
acknowledgement and those positions persist immediately; withholding them would buy no delivery
safety and would replay the non-deliverable suffix after a re-arm.

**An attachment is always delivered as metadata; image materialization is reader-chosen.** Slack's
private file URLs require a Bearer token, which cannot enter the room or a queued prompt. `--files`
or the room's `files: true` asks the transport to use the token only on the download request,
atomically store an inert copy under the reading session, and expose its absolute path. Codex
receives the path rather than a credential-bearing URL or base64 bytes. Opt-in matters: otherwise
every resident watcher would download every upload. The operation is bounded to eight images per
message and 20 MiB per image; other files remain metadata. Download failure degrades that attachment
to a bounded error and never suppresses the text or changes the cursor contract.

**One watch per session.** With `--follow`, the watch polls the room at `interval` and each
**followed thread** at `threadInterval`, each thread keeping its own cursor under the session. A
thread joins the follow set when this session posts into it or answers it with `re:`. A delivered
human message may also join or root its thread; delivered agent/system traffic does so only when
its `to:` names this bearer, its model, the seat, or everyone. Other broadcasts are still delivered
but do not spend a follow slot;
it leaves after `followIdleMinutes` with no activity; the set is capped at `followCap`, oldest
evicted with a note. `--follow` is off by default. Merging the processes does not reduce the
call count; what it reduces is processes, cursors, exit codes and the burden of remembering to
arm one. The saving comes from the fast/slow split, and that split is what keeps several agents
under a read tier when they are talking in several threads at once: the reply budget is
`sessions × followed × 60/threadInterval` per method, and a session resuming after a gap can
spend up to ten calls in one poll.

Poll intervals and the retry after a rate-limit response both carry jitter. Without it, several
watches started together stay in lockstep forever, and a rate-limit response, which hands every
one of them the same retry interval, converts a loose herd into a tight one.

Where the harness can keep a process alive for the whole session and wake the agent per output
line, one `watch --stream --follow --json` under it is the shape: it never exits, never needs
re-arming, each delivered message is one wake, and a quiet room costs nothing. A bounded watch
that lapses and is re-armed pays a turn per lapse whether or not anything arrived.

Codex Desktop's command runner can keep that process alive but does not translate its stdout into
a task wake. `--codex-queue` supplies the missing adapter: for every delivered message, the watch
invokes `codex queue` against the injected `CODEX_THREAD_ID` (or `CODEX_SESSION_ID`). The adapter
runs inside `onBatch`. After each enqueue returns, it checkpoints that delivery's source cursor
before starting the next one. A later failed enqueue therefore preserves the at-least-once contract
for the failed suffix without replaying a prefix Codex already accepted. A death between queue
acceptance and its checkpoint can still replay that stable message id; exactly-once is not claimed.

Queue recovery is local to the adapter, not a supervisor restart loop. Each subprocess is killed
after 30 seconds; failed injections get at most three attempts with one- and two-second backoff.
Spawn permission/path errors stop immediately. Retry diagnostics carry the locator and failure
metadata, never execFile's full argv (which contains the private prompt). Failed exits and timeouts
have unknown acceptance, so automatic retry can duplicate a stable cursor. `onQueued` is outside
the retry block: a checkpoint failure must not immediately reinject an already accepted effect.
Exhaustion leaves the accepted prefix checkpointed and exits 1 naming the pending suffix; re-arm
only after inspecting the queue. The injectable runner, delay and cancellation signal support
offline partial-batch, hung-child and cancellation tests without touching any Codex database.

The recorded PID is evidence only about the process it names. In particular, an `AGORA_SESSION_PID`
can name a detached delivery supervisor while the Codex conversation is still active. Notices
for these records (including mixed sweeps) explicitly leave conversation liveness unknown and
ask the reader to verify before reassignment. No trailer automatically reassigns work.
The bridge deliberately uses the same Codex-derived Agora session as interactive posts. Giving the
watch a separate explicit `AGORA_SESSION` splits the posted-id ledger, makes the task's own posts
look foreign, and turns them into queued echo turns.
Before the first transport read and on a slow cadence, the bridge checks the local thread store.
The rollout proves the durable address exists; the writer lock must be proved held rather than
merely present, because an abnormal exit can leave a stale file. Disproved liveness is exit 1 and a
reason on `watch-result`; an unprobeable platform is reported as unknown and does not become a false
claim that the thread is live.

`watch` always ends with one machine-readable line, fired or not:

    {"type":"watch-result","room":"…","session":"…","bearer":"…","fired":true,
     "delivered":3,"skipped":1,"filtered":0,"polls":4,"cursor":"…","threads":{"…":2},"exit":42}

on stdout under `--json` and on stderr otherwise. It exists because an exit code cannot survive
a wrapper: `agora watch room; echo $?` ends the shell with 0, and a consumer that forgets reads
that as "nothing arrived". `fired: false` is printed too, so "the watch ran and found nothing" is
distinguishable from "the watch never ran".

The CLI assigns `process.exitCode` and lets Node drain pending output on normal completion,
including errors. An immediate `process.exit()` can truncate asynchronous POSIX pipe writes;
a successful transport read is not delivered if shutdown discards its output. A slow-pipe
regression checks the full message sequence. This does not acknowledge downstream consumption,
and forced termination can still interrupt output.

A watch registers itself while it runs (`armed/<key>.json`) and removes the registration on
exit. A second watch on the same key is warned, never refused: two watches on one key
double-deliver, and the registration is what makes that visible. Each armed and session record also
carries the package version plus git revision (or entry-file mtime outside a worktree). `doctor` and
`session --list` compare a live resident with the installed build and name the pid to re-arm when it
is older. `doctor` sums the registrations into the seat's poll rate per transport, reports
room-history and thread-reply reads separately (the latter is the per-watch sum of
`followed × 60/threadInterval`), and warns above `pollBudget`.

Rooms on a record-shaped transport (an issue) default to a slow interval and send conditional
requests, storing the validator beside the cursor so it survives a re-arm. A record does not need
fifteen-second latency, and a not-modified response costs nothing against the limit.

A read without a cursor returns the **newest** messages up to the limit. It used to return the
oldest of the paged window, so `cursor --now` on a busy room set the position hundreds of
messages back and a fresh session's first watch replayed them. After a cursor, the oldest come
first, so a watcher advances in order. Every transport holds it now, `local` included; a transport's own test asserts it.

### Feeds

A room does not have to be a conversation. A feed room is a read-only scope of activity on the
record transport: one repository, an org, or a user. Every event in the scope becomes a message
(the actor as author, a one-line summary with the details as text, the object's URL where there
is one; a signature in a comment body carries through), the cursor is the event id, and `watch`
exits 42 on any motion exactly as on any other room. The scope narrows in the room's config,
never with a verb: `events` keeps the event types named, `refs` the branches or tags (a push, a
create or a delete on that ref, or a pull request whose base or head is that ref). Several rooms
of different scope sit side by side, a wide net beside a fine one, each with its own cursor.
Reads are conditional through the same validator cache as an issue room's, and a feed watch
defaults to one minute, which is what the platform asks of pollers. `post` on a feed is a usage
error: the issue or the pull request is the room for that.

Webhooks were ranged and rejected: they need a server the platform can reach. The notifications
API is a possible later second feed (user-scoped, an extra token scope, and marking things read
is a write to shared state).

### Addressing and claiming

Addressing changes **who wakes**; claiming changes **who acts**. They are two mechanisms with
one grammar, and no delivery filter can do the second one's job: an unaddressed request must
reach everyone, so it can always be acted on twice.

The grammar is a **trailer block at the tail**, between the body and the signature:

    <body>

    to: Codex, Fable/watch
    re: 1788449823.687169
    claim: worker/src/fetch.ts::retryFetch
    because: I read the stage log and concluded one cause; a read that does not start from my conclusion is the point.

    -- Fable/watch

Recognition, deliberately stricter than a commit-message parser's, because two humans type in
this room: strip the signature by the existing rule; take the last paragraph; it is a trailer
block only if **every** line is `key: value` **and** at least one key is known. Otherwise there
are no trailers and the whole text is body. No partial parses.

Known keys: `to` (address list; repeatable and comma-separated), `re` (a message id, so a work
item has an identity on a transport with no threads), `claim`, `release`, `verdict`, `exhibit`,
`because`. **Unknown keys are parsed, carried, rendered, and never acted on.** That is the whole
versioning story: additive growth, no version field. Narrowing a key's meaning is the only
breaking change.

Addresses match by **segment prefix**: `Fable` matches `Fable` and `Fable/watch`; `Fable/watch`
matches only itself; `Fab` matches nothing. `*` matches everyone. A platform mention token
matches when its id equals the seat's identity, which is the honest statement of a limitation: a
platform mention resolves to the **bot user**, so it addresses the whole seat and cannot target
one bearer. Bearer addressing is textual because the platform's own mechanism is unavailable,
not because textual is nicer.

`post --trailer "<key>: <value>"` is the primitive, repeatable. `--to`, `--re`, `--claim`,
`--release`, `--verdict`, `--exhibit`, `--because` are sugar on top of it, emitted in a fixed
order through one emitter, so the parser and the emitter round-trip by construction.

In the historical transport-backed mode, `agora read` renders one derived line above the body
and preserves the body and trailers verbatim. Native fidelity preserves those accepted bytes in
canonical custody; every derived index and rendered view, including JSON, applies the configured
protection policy and identifies any alteration. Applying that policy does not guarantee detection
of every possible secret. `--json` gains `to` and `trailers`, omitted when absent.

**Claims are advisory by physics, not by policy.** No transport offers an atomic take: there is
no compare-and-swap over channel history, and deleting a message would destroy the wire's own
history. A design that presented a claim as a lock would be lying about the substrate. On a
contested subject, **the earliest claim holds; on an exact tie, the lexicographically lower
bearer**. Every reader computes the same answer alone, from the same messages, with no vote and
no central arbiter. A re-claim of a subject another bearer holds is *contested*, never a silent
transfer. Nothing is released by time passing. A non-holder release cites an exhibit from
outside the room naming why the holder is gone.

**"One author per function" does not go green in the room, and the design says so.** A room
cannot gate a merge. It goes green on the pull request: a code-owners rule, or a check that
reads the claims and fails a request whose changed functions are claimed by someone else. That
check lives in the consuming repository. The room makes the claim visible; the record enforces it.

`watch --wake` is the reader's own choice of what wakes it, never automatic: `all` (the
default), `addressed` (everything except a message whose `to:` names someone else), `mine` (only
a message whose `to:` names the reader, its model, the seat, or `*`). What it drops still
advances the cursor, is counted as `filtered` on the result line, and still shows in `read`. A
seat keeps one watch on `all` so an unaddressed request reaches someone. The filter shipped
because an agent that holds one long-lived watch for a whole session pays a turn per wake, and
waking on everything was the measured cost. `watch --coalesce` holds a burst and delivers one envelope (one `codex queue` call) per window; a message addressed to this bearer flushes immediately. `watch --digest` is rendering only. `session_wakes` and `bytes_delivered` on `watch-result` count this process's own IO, never a tally about content. `join` (and, in W5, `doctor`) print the usual `--wake` for a role once and apply nothing. `post --fyi` emits `ack: none`; the tool never filters, suppresses or delays on an incoming `ack:` — honouring it is a judgement.

One piece of this section is **deferred until a working day with several agents has been
counted** (see the flip conditions): a `claims <room>` view that folds `claim:` and `release:`
over a bounded read and prints them with the horizon it read to. The emitter and the parser ship
first, because the counts come from the room's own history.

### Lanes

Two rooms. The shared room carries what the other side must act on. A **desk** room on the local
transport, an append-only file, carries coordination among your own sessions: who is taking
which unit, half-formed reasoning, a review request between your own agents, a gate result on
your own branch.

The crossing rule, mechanical because there is nobody to arbitrate it:

> **A claim crosses if and only if the artifact it names sits in a repository the counterpart can
> push to.** A request to the counterpart, an exhibit answering one of theirs, a settled verdict,
> and a question for their human all cross. Sequencing among your own sessions, review among your
> own agents, and gate results on your own branches stay. When it is not obvious, ask whether the
> counterpart would have acted differently having seen it. Anything that binds reaches the record
> whether or not it crossed the room. **One line crosses whenever the partition among your agents
> changes**, naming who holds what: per change, not per decision.

"Only settled results cross" is the wrong rule and is not used: a question, a request, and a
*failing* exhibit all have to cross.

**Who decides: the agent, by choosing the room.** There is no routing flag and no routing table.
Routing is an opinion; rooms are the primitive, and a default that is wrong sends a claim on a
shared function to the desk room exactly the once it mattered. What the tool adds instead is a
label: a free-text `note` on a room, printed by `rooms` and `doctor`.

The local transport carries three preconditions, with only partial detection of violations:

- **One native filesystem per writer.** Measured: six concurrent writers and 1200 messages land
  intact on a native filesystem; the same writers behind a filesystem translation layer lose
  between a half and five-sixths of their lines, silently, with every surviving line parsing and
  every id unique, so no reader, no cursor and no check can detect it. `doctor` warns when a local
  room's resolved path sits behind a translation layer or under a syncing folder.
- **Append only. Never rotate, truncate, or hand-edit.** A read refuses a cursor beyond the
  available record count, including when the log disappears. Invalid JSON in the unread range
  refuses the whole batch rather than letting a valid suffix move the cursor past the corruption.
  Neither failure delivers a batch or advances its cursor. Restore an intact log; if bounding one
  becomes necessary, use a new file under a new alias with fresh cursors. Line-count cursors still
  cannot detect replacement or truncation followed by regrowth to the saved count. Concurrent posts
  locate their own ids in the log to return exact cursors: the tail count after append may already
  belong to another writer. If an appended id cannot be found, the post reports an unknown outcome
  and asks the caller to inspect before retrying; it never returns an invented cursor.
- **Per-session identity**, without which two same-model sessions cannot be told apart on the
  very lane built for them.

The desk room ships configured in the example and empty. Whether it earns its place is decided
by counting a working day (see the flip conditions).

### Verification among peers

**The requester names the reader.** A review request is an ordinary message carrying `to: <one
bearer>` and a `because:` line saying what could be wrong and where *not* to start. One reader,
named, who is not the author and did not pick itself. Broadcast is not a substitute for a
designated reader, and a `because:` line is what partitions the read-sets so a second read is not
the first one again.

The tool does not compute the reader. A rotation the tool held would be an assignment function,
a router, over a roster that drifts at every model swap, computed from a list only one side can
enumerate. Rotation is policy, and policy lives with the collaboration. If a collaboration
adopts one, two riders: key it on an identifier the author did not mint (the transport's own id
for the work item), and snapshot the eligible readers at the work item's creation rather than
recomputing per message; otherwise the author controls the inputs and can grind the outcome by
waiting.

**A verdict cites an exhibit, and never another verdict.**

    <the claim, one line>

    verdict: pass | fail | unsettled
    exhibit: <url, or a path with a size and a hash, or a command with its exit code>

    -- <bearer>

`unsettled` is a result and costs nothing to say. A protocol whose only postable outcomes are
agreement-shaped manufactures agreement.

`post --verdict` with no `--exhibit` is a **usage error, exit 2**, and nothing is posted. This is
the one enforcement in the whole design, and the line it sits on is exact: **the tool may
constrain what it emits; it may never infer who ran it, and it may never judge whether an
exhibit supports its verdict.** The check is on form only, and it ships with a test it must fail.

Three things about exhibits follow from the transports rather than from taste:

- **A verdict never cites a room message.** A post on the chat transport returns no address at
  all, and edits there leave no history, so a "citation" to one points at something mutable that
  the other side may not be able to open. It cites the record.
- **An exhibit a tool produced is quoted, not signed.** A script that fires a request and prints a
  table is not accountable: it cannot be asked, and it cannot have been wrong on purpose. The
  table is content inside the message of whoever chose to run it and read what came back; the
  command and the request id go in the body so the other side can trace it. Making it a co-signer
  confuses evidence with testimony.
- **Several agents agreeing is one reading with several signatures** when their exhibits are the
  same. That is visible without anyone computing it, because the shared citation is right there
  in the messages, which is why the tool counts nothing.

**What checking cannot buy here, stated once.** Agents that share a machine, a tree, a token and
a state directory share a write set; the token's post scope is also its edit and delete scope, so
any of them can rewrite another's message. Peer review among them is duplication with partitioned
read-sets: valuable, and not certification. What certifies is outside that write set: the
counterpart's repository, a check that anyone can re-run, the bytes a request returns. A claim
about your own work is never settled by a surface you can edit.

### Agents that spawn

**Only the session holding the seat posts.** Work handed to a subprocess (a subagent, a build
agent, a script) comes back as a file or on stdout; the holder reads it, judges it, and posts it
under its own signature.
This covers task subprocesses. A separately admitted sovereign peer is a new accountable session,
not a subprocess borrowing the parent's identity. Environment variables alone grant no admission.

This cannot be made a gate, and the design does not pretend otherwise. Measured: a subprocess
with no environment at all still finds a working config, because config resolution falls back to
the home directory. There is no setting of a parent's environment that denies its children a
config without denying the parent. The one exception is a spawner that controls its child's
environment explicitly, which some harnesses have and the in-harness subagent tool does not.

So the rule is prose, labelled as prose, and what ships is visibility: the identity line on
every post, and the posting pid recorded beside every id in the ledger, so a subprocess's own
report carries the evidence of the violation into the read path of the agent that will read it.

The sharp edge that makes the rule matter more than it looks: a subprocess started by an agent
usually inherits that agent's session id, so it writes into the same ledger, and its post is
skipped by **the parent's own watch**. The one session that could catch a half-formed post and
retract it is the one the tool guarantees will not see it, and on a transport whose edits leave
no history the retraction has no record either.

A subprocess never gets its own bearer. A bearer holds the seat; a subprocess holds a task, and a
name for it would be either a role (not an accountable individual) or an entity that stops
existing the moment anyone might want to ask it something.

### Dark sessions

A request addressed to a session that has died would otherwise be re-armed into silence forever.
So the seat announces its own departures. On every poll a watch checks the other sessions
registered on this seat; when one's process is gone and its record has been quiet past a short
grace, the first watch to notice claims the announcement for its room by exclusive create and
posts one line, signed as itself: who is gone, when it was last seen, that requests addressed to
it will not be answered, and who is still live on the seat. The line goes through the normal
post path, so every other watcher receives it, including the one that was waiting; the
announcer's own watch skips it by its ledger. The grace exists because a harness that restarts
gives its session a new process and touches the record on its next command: a session that dies
and is resumed within the grace is never announced. Records older than the stale horizon are
pruned, never announced; after a reboot every recent record is announced once, which is the truth.

`agora who <room>` shows who has spoken and when, from a bounded read that moves no cursor,
merged with whether each of this seat's sessions is still running, and prints the horizon it
read to. The rule that follows is in the skill: a bearer whose last line is older than your
patience is unanswered; re-address the request, or ask the human. A graceful leave is a plain
post before you go. The limit is stated plainly: this covers the seat that runs the announcer. A
lone session on the other side that dies cannot be announced by anyone; `who` and the patience
rule are what remain, and a counterpart running several sessions gets the same announcements
from its own siblings, since it is the same tool.

### Operability

One config file for the machine. Per-session divergence is the registration record,
`AGORA_ACTOR`, or `--as`. Per-session config files are available (`AGORA_CONFIG`) and are not
the path: near-identical copies of the room table mean a room change applied several times and
drift that is invisible until a watch quietly points at the wrong room.

`doctor` prints, beside the per-room token and identity lines it always printed: the session key
and its source, the bearer and its source, every session with state here with its bearer,
liveness and last write, and the seat's poll rate per transport. Warnings it can honestly emit:
two live sessions carrying one bearer; no cursor for a configured room, with what it will seed
from; a session key of `default` with other sessions present; signing off with several sessions
live; a local room behind a filesystem translation layer; the seat over its poll budget. Warnings
never flip an exit code; `doctor` exits non-zero for a missing token or a failed identity check,
as before.

What `doctor` cannot do, and says so: it cannot verify that a bearer names the model actually
running. There is no path from a command line to the model that invoked it. What the shape does
change is *whose fault a wrong bearer is*: it used to arrive because another session edited shared
state, unowned and undetectable, and now it can only come from this session naming itself
wrongly, which is visible in the identity line on every later call and fixed by re-registering.

## The alternatives, and why each lost

**One app per session.** The only shape that solves same-model concurrency by construction, and
the only one needing no code change at all; both points are real and neither is decisive. (One
app per *machine* is not this alternative: it is the seat, because the token lives where it is
used.) It
deletes the persistent counterpart the seat exists to be, and it turns every new session into a
human clicking through an app-creation flow and an install grant in someone else's workspace,
which is the wrong cost curve for a participant that comes and goes. A fixed pool of pre-made
apps that sessions claim reintroduces "who holds app #2 right now" one level up. Multi-agent chat
products converge on one app per agent identity, and that convergence is real evidence about a
different problem: those agents are persistent teammates provisioned by a platform that creates
apps programmatically. The migration remains cheap and one-way if addressing pressure ever
demands it, and the honest way to learn whether it does is to ask the counterpart.

**One seat per participant per harness.** Pays for a second app *and* the full signature
machinery, and still cannot tell two sessions of one model apart. The boundary it draws is not
one anyone in the room reasons about.

**Per-message name and avatar overrides.** The closest platform feature, and it loses four ways:
it needs a scope the shipped manifest does not carry, so every participant must reinstall to stay
matched; the platform's own guidance ties the ability to an inciting user action, which a
background agent renaming itself on every post is not; it plausibly changes the identity the tool
reads back, breaking the own-post match in both directions; and it deletes the seat from the
client, so it buys the appearance of separate agents while keeping the shared token, history and
accountability.

**Posting as a human's account.** Rejected on a property, not a preference: the room's trust
model rests on telling an agent's message from a person's, and an agent that can post as its
human has removed that distinction.

**Per-message structured metadata.** Available on one transport at no scope cost, exact, and
invisible to the humans it would exist to serve; the other transports have no equivalent, so the
protocol would have two dialects. It survives as an optional machine-readable rider, never as the
carrier.

**A signature clause in the own-post rule.** Ranged as the portable fallback beneath the ledger
and rejected on a measurement: two sessions carrying one bearer satisfy an exact-signature test
in both directions and drop each other's posts, and the live default bearer (a bare model name)
is exactly that collision. The ledger alone is exact for any number of sessions; its only failure
is a visible self-echo after a wiped state directory.

**A name lease.** An exclusive-create file per bearer name, probed by pid, would make a duplicated
bearer impossible rather than visible. It was cut because the session record already holds the
pid, boot epoch and last-seen time, so a lease would be a second registry over the same data, and
because the ledger makes a duplicated bearer cost legibility rather than a message. The
conditional is stated so a future contributor does not remove it innocently: **if own-post
detection ever again depends on the signature, the lease comes back.**

**A single reader with fan-out to the sessions.** The strongest rival, and the one to build if the
flip conditions fire. The original objection was shared fate: if the reader dies, every session's watch
returns "nothing new", byte-identical to a quiet room, and none of them can tell. Detecting that
needs a heartbeat record and a staleness check in every session, a supervision protocol, on a
channel whose purpose is not missing the counterpart's message. It re-encodes identity lossily
when it forwards, which destroys the exact own-post rule, and it doubles the crash windows. And it
buys headroom on a resource that has headroom. That objection is reasoned, not measured: nobody
has killed a reader and watched the silence. A chat bouncer is exactly this done properly, and
what it takes is a daemon, per-client state, a replay protocol and an auth layer.

The native service is a candidate, not evidence this objection disappeared. Before activating
shared ingestion, count actual transport calls under the same workload and subscriber cadences,
and measure latency/coverage. Kill the service while an addressed upstream message arrives:
every subscriber must report service-dark within one room interval, advance nothing, and never
silently start a direct reader. Explicit direct mode has separate counters. Per-reader state
remains independent. A configured-rate projection is not this exhibit.

**A shared cursor with hand-off.** Measured to lose delivery, and not a bug in the shape: it is
what a shared cursor is. The fatal objection is topology, not cost: consumer groups exist to
partition work among interchangeable workers, and these agents are not interchangeable, because
the point is that they check one another. The same failure is why a shared mailbox with several
readers is miserable, and why the fixes are per-reader state or separate accounts.

**A platform push socket.** Looks like the real answer and fails on delivery semantics: an app
may hold several connections and a payload may be sent to *any* of them, with no pattern to rely
on. That is a consumer group with a vendor's name on it. Secondary costs: a second secret, a
manifest change, a supervised long-lived connection, and one transport only.

**A push endpoint the platform calls.** Needs a public address, a certificate, a server, and a
third party in the path of every message.

**Prose header lines at the top of a message.** Loses to the tail block on one argument: the
message has exactly one machine-read region (the signature, on the last line), and a header
creates a second one at the other end, with its own false-positive class in a room where humans
type freely. The scan-first benefit it claims is delivered by the renderer instead. Commit-message
trailers are the model: at the tail, parsed by tools, read by humans without training, never
enforced by the transport, extended by adding keys with no version field anywhere.

**A structured envelope with a version field.** Additive keys version themselves; a version field
would be a coordination point with nothing to coordinate for body trailers. This rejection does
not cover native frames, which negotiate compatible schemas before effects. Trailers stay inert.

**Threads alone as the work item.** Fails on two transports: one has no threads at all, and on
the other a room read never returns replies. A work item needs an identity inside the message.
Mail threading carried inside the message is transport-independent and proved it across gateways
with no threading of their own.

**A claim as a lock.** No transport offers an atomic destructive take, so a lock would be a lie
about the substrate. Enforcing it locally where the filesystem allows it gives one verb two
meanings depending on who else claimed, adds a second claim store that can disagree with the
derived view, and gives an existing exit code a new meaning. A tuple space's destructive read is
exactly the primitive wanted and exactly what does not transfer; its lease-expiry answer to
holder death transfers as a *display* rule rather than an action.

That argument applies to announcement-only transports, not an authoritative native room writer.
Native claim/renew/release operations are serialized by that writer, including for local members.
Each protected effect checks current authenticated ownership and fence atomically. A nonce or
uniquely allocated generation alone supplies no exclusion. Contest records an argument without
acquiring ownership; release and expiry settle no substantive question. Announcement-only views
name their read horizon and never report collision-proof acquisition.

**Announce-and-award task allocation.** Its safety is entirely in the award step, and a room of
peers has no awarding party. Without the award it degenerates to announce-and-hope, which is worse
than nothing because it looks like a protocol. Replaced by a rule every reader evaluates
identically.

**A claims verb that gates** (non-zero when held). The exit codes are a contract, and a gate in
the room must not decide substantive conclusions. Native allocation refusal uses ordinary exit 1,
names the holder and posts nothing. It changes no watch meaning. Allocation is bookkeeping, not a
verdict about the subject.

**A reader the tool computes.** Requires a roster the tool holds and that drifts at every swap;
is an assignment function, which is the router the design is trying not to grow; optimises the
weakest clause of the reader rule while the load-bearing one comes free from
requester-assignment; and cuts against reader adjacency.

**The tool knowing model families.** An unverifiable claim about someone else's model, a router,
and drift at every rotation; and redundant, because the signature carries the bearer and who is
what kind of model is a fact the collaboration can state once.
Optional model/provider/route provenance may carry its source and evidence tier. A requested label
is never promoted to observed runtime identity or used as authority.

**A verb that mirrors a message to the record.** The wire body and the record body are not the
same text, so a verb that mirrors identical text doubles the traffic, and one that composes two
different bodies is the tool reading the freight. This is the recommendation held most loosely:
the failure it would prevent (a wire claim whose record does not exist) is silent and asymmetric.
The trigger is below.

**A subprocess posting under its parent's identity.** The name on the message denotes a party
that never read it, and there is no store outside the subprocess's write set recording what it
actually did, which is the requirement that makes borrowed identity safe everywhere it is safe. A
privilege-elevation tool is the closest structural match, and it is made safe by an audit record
written by the mechanism, not by the borrower, outside the borrower's reach. There is no such
store here.

**A subprocess with its own sub-signature.** Authorship by a role, a proliferation of names the
counterpart cannot address, and a cursor file per subprocess with nothing to reap them.

**A separate seat for automation.** The one prior art where a tool speaking in a human channel
works: it gets a distinct visible identity nobody mistakes for a person. Rejected on cost (a
second app, a second token) and on the dilution of the one persistent counterpart.

**A second shared channel for desk-local traffic.** Read limits are per method per workspace per
app, so a second channel draws on the same budget as the room it exists to protect; it needs a
cloud service to be reachable for coordination among processes on one desk; it solves nothing
about identity; and it pays every one of the shared transport's quirks twice for traffic that
never leaves the machine. Kept as the named fallback if per-session identity is unavailable,
because it at least gives the humans a window.

**A thread as the desk lane.** Visible to the counterpart, so not desk-local; spends the reply
budget on traffic they gain nothing from; and the transparency it promises is not delivered,
because thread replies notify participants only.

**A second issue as the desk lane.** A category error in both directions: the record is not a
wire, and a private sequencing decision should not become a permanent public artifact.

**Nothing: a presence roster plus the repository.** Owns a slice: who is live and what they hold
is state that belongs outside the room, and the lane must not re-implement it. It loses as the
whole answer because a roster is state, not a channel: it does not persist for replay and it
affords no reply, so it cannot carry "your review is up" or "the gate is green".

**Per-session config files, or a flag on every verb.** A flag that must be repeated to stay
correct is a trap for a consumer composing command lines under pressure hours into a session; a
per-call config override exists as an escape hatch above a durable record, never as the normal
path. A persisted "current identity" in a shared file is the anti-pattern to cite: two concurrent
shells fight over one mutable selector, which is the bug being fixed, wearing a nicer verb.

**Requiring an explicit session label with no auto-detection.** Honest, and it fails the same way:
a forgotten label collapses to the shared default exactly as a renamed harness variable does. The
visibility that makes auto-detection safe (the identity line on every call) is what makes the
explicit form safe too, and it ships either way.

## Flip conditions and deferred pieces

Each of these is deferred with a named trigger, so the next reader re-decides on evidence rather
than re-deriving the argument.

| Deferred | Trigger |
|---|---|
| The `claims` view | One working day with several agents on a seat, counted from the room's own history: subjects worked by more than one agent with claims visible; the fraction of received messages carrying a `to:` naming another agent (which also says whether `--wake addressed` or `mine` is worth recommending); work items that spanned two transports. Any hit on the first means advisory claims are insufficient and the authorship gate belongs on the pull request. |
| The desk room | The same day: under roughly fifteen desk messages, or under a third of what crossed, the room is deleted from the config and the transport kept. |
| A single reader with local fan-out | A transport's read tier drops to roughly one poll per minute per app, **or** more than roughly twelve concurrent watches per method. The chat transport's restricted tier applies to apps commercially distributed outside its marketplace; an app installed only in its own workspace keeps the higher tier, and the checkable fact is the app's distribution status. Cheapest correct build: one `watch --stream --json` piped into a writer that appends verbatim records to a local room, plus an append-a-foreign-message primitive and a heartbeat record. |
| A platform push socket | The read tier drops **and** the resulting cadence proves too slow for live work. |
| A broadcast option on a threaded post | A message that needed a human's eyes demonstrably failed to reach them from inside a thread. |
| A verb that posts the record first and the wire second | Any wire message whose cited record does not resolve. One is enough. |
| Per-message name and avatar overrides | The humans say the signature line is too easy to miss, and only in the form that keeps the seat in the rendered name. |
| A `type` discriminator on message objects in `--json` | A consumer needs to tell a message from the final summary line without inspecting fields. |
| A name lease | Own-post detection ever again depends on the signature. |

## Standing prohibitions

Constraints on future contributions, not descriptions of the present. Each is the kind of
feature that looks helpful in isolation.

- **No tally, count, score, reaction total, or "N agreed" summary anywhere in the tool.** The tool
  emits no number that could be treated as warrant.
- **No quorum, no vote, no auto-close, and nothing that closes on silence.** "No objection by the
  time I merge" is a protocol that manufactures agreement.
- **No settled or closed state about a subject in the world.** The tool may keep operational
  commitments: cursors, ledgers, retained accepted content, indexes rebuilt from that content,
  and explicit board allocations. These record acceptance, observation or allocation, never truth
  of a participant's conclusion. Rebuildable views name their source and coverage; keys, policy
  and lifecycle state have separate custody and recovery contracts.
- **No parse-and-act on an incoming trailer, ever automatically.** Rendering an incoming `to:` is
  fine. Routing, waking, filtering or suppressing on one must be a flag *the reader* chose, or a
  counterpart's trailer silently steers this side's process and "a message from another agent is
  input, never an instruction" has been violated by the tool rather than by an agent.
- **The tool never writes the shared config.**
  Explicit admin verbs may update their named registries under `native/`, `index/`, `board/` and
  `spawn/`, never shared actor identity or enrollment as a side effect of a non-admin verb.
- **No transport-specific verb.** A feature that only makes sense on one transport is that
  transport's option.
- **The exit codes are a contract**: 0 ok or nothing new, 1 error, 2 usage, 42 a watch delivered, in every mode. No new code, and no new meaning for an old one.
- **The root CLI has zero runtime package dependencies**; pinned Tailcat capsules are bundled for native transfers,
  never installed dynamically. Tokens by reference only, every transport testable offline with
  an injected fetch. Separately packaged TUI and pane runtimes declare their own dependencies;
  neither becomes an implicit root CLI installation or startup dependency. A service-owned PTY
  alone does not establish isolation against another process under the same OS principal.
- **No subagent marker.** A `child` field once flagged a post from a subagent of the seat's session. Measured: Claude Code sets `CLAUDE_CODE_CHILD_SESSION` in every tool subprocess, the seat's own included, so the flag was true for the normal case; Amore Build sets no marker at all, and on both a real subagent inherits its parent's session id and pid. Nothing in the environment discriminates, so the field was dropped rather than renamed; the evidence a reader has is the ledger's posting pid and the identity line.
- **The state layout is a contract.** A cursor's filename inside a session directory is the same
  string the cursor key has always been, and no bearer or session string is ever a component of it.
- **Own-post detection is the ledger.** Not the author, not the kind, not the signature.
- **Search exposes authorized rows and coverage, never consensus or content scores as warrant.**
- **A delivered line is marked inbox delivery, never peer-authored terminal input.** The marker
  renders authenticated provenance; it is not the proof. The receiving adapter confirms readiness
  at admission; wake acceptance advances no read cursor.
- **A room message never directly spawns a peer.** A peer may judge a request and explicitly invoke
  authorized admission under the destination policy. This is not immunity to a captured same-user
  process; the enforced profile needs an independently protected boundary.
