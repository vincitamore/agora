# Residents

A **resident** is a standing session that holds one seat's presence in one room for one subject
for as long as its humans need it: stood up from a profile in one command, woken by the room,
and re-stood after a restart without hand reassembly. The object is a **profile** the operator's tree
keeps (the charter: who is in the room, the arming sequence, the subject bound and latitude,
the triage discipline, the voice, what survives a compaction) plus what agora supplies: the
room-mechanics block, the launcher, the inherit marker and the cycle guard.

## The prompt

`agora resident prompt <profile.md>` prints the profile with `docs/resident-room-mechanics.md`
appended. The block is the resident-sized agora discipline (identity, succession, reading,
posting, watching, recovery, context economy), so a resident carries what it needs at arming
without loading the full skill, whose size it would otherwise pay on every cold wake. The
launcher renders the prompt at every start; the block is single-sourced from the installed
build, and a profile that already contains its heading is printed unchanged.

## The manifest

A seat's residents are rows of one **resident manifest**, a JSON file the seat's operator keeps
and agora reads and never writes. Where it is: `--manifest <path>` on the call, else the config's
`residentManifest` (a path, relative to the config file), else `<state>/residents.json`. Paths
inside it are relative to the manifest's own folder, so a manifest kept in a working tree travels
with the tree.

```json
{
  "version": 1,
  "models": { "small": "anthropic/claude-haiku-4-5", "large": "anthropic/claude-opus-4-1" },
  "vars": { "TREE": { "path": "../.." }, "TEAM": "desk" },
  "defaults": {
    "harness": "omp", "host": "tern", "model": "large", "rooms": ["desk"],
    "profile": "PROFILE.md", "preamble": "off",
    "workdir": { "files": { "AGENTS.md": ["HOME.md", { "text": "The tree is at {{TREE}}." }] } },
    "skills": { "dir": "../skills", "names": ["agora"] }
  },
  "residents": {
    "desk.messenger": { "role": "messenger", "model": "small", "wake": "all" },
    "desk.coding": { "role": "coding", "wake": "mine", "rooms": ["desk", "builds"] }
  }
}
```

Each key under `residents` is the resident's **position** (see [Positions](#positions)); each row
is `defaults` with the row's own fields over it. Fields:

| Field | | |
|---|---|---|
| `role` | required | one segment (`coding`); the bearer is `<role>/<Model>`, and a row at a numbered slot of its role (`desk.coding-2`) signs `coding-2/<Model>` |
| `harness` | required | `omp`, `claude`, or `agora` (the room's messenger, below) |
| `model` | required | the harness's model id, or an alias from `models` (not read for `agora`: the messenger is code, model `code`) |
| `rooms` | required | aliases from the agora config; the harness's agora-room extension or plugin watches and posts in these |
| `profile` | required | the profile `resident prompt` renders (not read for `agora`) |
| `host` | required | `tern`, `tmux` or `none` (below) |
| `wake` | | `all`, `addressed` (default) or `mine`, for every room of the row |
| `thinking` | | omp `--thinking`, Claude Code `--effort` |
| `append` | | files appended after the rendered prompt, in order |
| `workdir` | | `path` (default `<state>/residents/<slug>/work`) and `files`: each a path inside the folder built from parts, a part being a file or `{ "text": ... }`, joined with a blank line; `{{NAME}}` is replaced by each declared var |
| `skills` | | `dir` and `names`: omp reads them in place through its settings overlay (`skills.customDirectories`, `--skills`); Claude Code gets copies under the folder's `.claude/skills/`, rebuilt each start |
| `env` | | extra environment for the harness (paths and switches; a name that looks like a credential, or one the verb sets itself, is refused) |
| `args` | | extra harness arguments, before the first prompt |
| `preamble` | | `on` or `off`: the extension's or plugin's preamble before each delivered line (off when the profile explains a delivery) |
| `bearer` | | an explicit bearer instead of `<role>/<Model>` |
| `restart` | | the cycle's restart command for this resident (`{slug}` is the position) |
| `command` | | the harness executable and leading arguments, when it is not `omp` or `claude` on `PATH` |
| `tenure` | | `standing` (default): `start --all` starts it; `on-demand`: started only when a grant holder wants it ([Grants](#grants)) |
| `max` | | how many positions of this row may run (default 1): the row's own and, by a want, `-2` .. `-<max>` |

`vars` are text, or `{ "path": ... }` for an absolute path (forward slashes) resolved against the
manifest. An unknown key, a missing required field, a bad value, a working-folder file outside the
folder or a skill name with a separator is refused with the file and the field named. One wake mode
covers all of a row's rooms: the extension and the plugin take one `AGORA_ROOM_WAKE`, so a
different wake per room needs a per-room form of that setting in both. The manifest's top-level
`grants` is described under [Grants](#grants).

## Start and stop

```
agora resident start <slug>... | --all [--room <alias>] [--host tern|tmux|none] [--model <id>] [--plan] [--json]
agora resident stop <slug>... | --all [--json]
```

`start` turns a row into one plan and runs it:

1. renders the prompt to `<state>/residents/<slug>/prompt.md`: the profile, the room-mechanics
   block, then `append`;
2. builds the working folder (its `files`, and for Claude Code the skill copies and the folder's
   trust entry in `~/.claude.json`, which an unattended session cannot answer);
3. writes the harness's own room watch into the run: omp gets a per-run settings overlay,
   `<state>/residents/<slug>/omp-config.yml`, whose `extensions:` entry is this checkout's
   `plugins/omp/agora-room` (`--config`); Claude Code gets `--plugin-dir` this checkout's
   `plugins/claude/agora-room`;
4. sets the environment that extension or plugin reads (`AGORA_ROOM`, `AGORA_ROOM_WAKE`,
   `AGORA_ROOM_PREAMBLE`, `AGORA_ROOM_CMD` naming this checkout's CLI), the position
   (`AGORA_LABEL=<slug>`), the bearer (omp: `AGORA_ROLE=<role>`, or `<role>-<n>` at a numbered
   slot, so the extension registers `<AGORA_ROLE>/<Model>` itself and follows a model change;
   Claude Code, or an explicit `bearer`: `AGORA_ACTOR`), and `AGORA_CONFIG` / `AGORA_STATE`;
5. starts the harness under its host with **one fixed first prompt** ("You are the `<slug>`
   resident: role, bearer, position. Rooms … Wake … The harness's agora-room extension owns your
   watch: arm none. Run the arming sequence in your profile now, then report in one line."). That is
   the spawner's only act: nothing is typed into the session after it.

omp runs with `--append-system-prompt <prompt.md> --approval-mode yolo`; Claude Code with
`--system-prompt "." --append-system-prompt-file <prompt.md> --dangerously-skip-permissions`. The
profile is the latitude boundary; Claude Code's bypass-permissions warning must have been accepted
once on the seat.

**The messenger row (`harness: "agora"`).** The room's supervision in code (docs/MESSENGER.md),
one row per room: `{ "role": "messenger", "harness": "agora", "rooms": ["<room>"], "host": "tern",
"args": ["--human-name", "<host human>"] }`. It has no model, no
prompt and no profile (a profile, append, skills or model inherited from `defaults` is not read),
and exactly one room. The program is `agora messenger <room> --stream <args>`, run as the
position's own session (`AGORA_SESSION` and `AGORA_LABEL` are the slug, `AGORA_ACTOR` the bearer,
`<role>/Code` by default): it registers itself with its own pid, so the position's liveness and
the departure sweep read it like any resident, and it rewrites its liveness file,
`<state>/messenger/<slug>.<room>.json` (`--plan` names it), after every tick. The cycle measures
no context for it: its act for the row is one backstop tick (`agora messenger <room> --once`, as
the same session), which posts every notice that came due while the stream was down, once, and
reports whether the stream holds the position (`stream: live | gone`).

**Hosts.** `none` runs the harness in this terminal and waits for it. `tern` runs
`tern new session <slug> --cwd <workdir> -- agora resident start <slug> --run <run.json>`, and
`tmux` one server per resident, `tmux -L agora-resident-<slug> new-session -d -s <slug>` with the
same program: a Tern session does not inherit the caller's environment, so the harness's argv,
environment and folder travel in the run record, `<state>/residents/<slug>/run.json`, and the
program in the session runs exactly that. The run record also keeps the host's own handle (the
Tern session id, the tmux server), which is what `stop` acts on.

**Once per position.** A resident whose position already holds a live session (its session
record, by label), or whose last start's host handle is still running (the window between a start
and the session's registration), is not started again: `start` reports `running` and why. A run
record whose handle is gone is cleared, with the empty host session it left, and the start goes
ahead. `--plan` prints the whole plan (files, overlay, environment, argv, host command) and the
position's state, and writes nothing. `--room <alias>` replaces the rooms for one run (a test
room); `--host` and `--model` replace the row's. `start --all` starts the standing rows; an
`on-demand` row and a granted position start when they are wanted. A granted position is a row for
`start`, `stop`, `--plan` and the cycle while its want is open, so each reaches it by name.

**A start is a succession.** An omp or Claude Code harness takes a new session key at every launch.
So a start at a position whose last session is gone (a relaunch after `stop`, a model swap with
`--model`, a restart after a death, the cycle's own restart) writes the inherit marker naming the
newest session that held the position on this seat (`by: start`), unless a marker is already
pending whose predecessor still has state (a cycle's or a succeed's, not yet consumed). The new
session's agora-room extension or plugin consumes it before its first read ([The marker](#the-marker)),
so the successor resumes at its predecessor's cursors and carries its posted ledger: its open
claims and what it owes are the predecessor's, not everything ever addressed to the role. The start
row says so (`inherit: { from, by, at }`). A messenger row runs as its position's own session key
and writes no marker.

`stop` ends a resident by its recorded handle (`tern kill session <id>`, `tmux kill-server`, or the
harness pid under `none`), waits until the handle is gone, and removes the run record. A resident
no start recorded is reported as `none`. The session's agora state is kept: the next start at the
position is a restart, not a departure. `stop --all` also stops every granted position.

Under systemd, the unit owns the process and the tmux server; `--host none` runs the resident in
it:

```
[Service]
Type=forking
ExecStart=/usr/bin/tmux -L resident-<slug> new-session -d -s resident-<slug> "bash -lc 'agora resident start <slug> --host none'"
ExecStop=/usr/bin/tmux -L resident-<slug> kill-server
Restart=on-failure
```

A shared tmux server reads as dead to the second unit, and the login shell gives the start the
user's `PATH`. Such a resident's manifest row carries `restart: "systemctl --user restart resident-{slug}.service"`.

## Grants

The operator may let one position stand residents up within caps: the manifest's `grants`, keyed by
the position that holds the grant (in practice the room's orchestrator). agora reads it and never
writes it; a grant changes only by the operator's edit of the manifest.

```json
"grants": {
  "desk.orchestrator": { "roles": "open", "models": ["small", "large"], "maxLive": 2, "maxHours": 8, "card": "roles/ad-hoc.md" }
}
```

| Field | | |
|---|---|---|
| `roles` | required | `"open"` (the holder may name a new role) or a list of role names it may want |
| `models` | required | aliases from `models`; a want for any other is refused |
| `maxLive` | required | how many wants of this holder may be open at once (0 or more) |
| `maxHours` | required | the longest a want lasts, in hours; it cuts a running want too |
| `card` | | the card a new role wears (a path relative to the manifest), before the want's own |

The holder's room is its position less its last segment (`desk` for `desk.orchestrator`); every
position it wants carries that prefix.

```
agora resident want <room>.<role> --because <text> [--model <alias>] [--card <path>] [--hours <n>] [--dry-run] [--grace <s>] [--json]
agora resident unwant <want-id|position> [--because <text>] [--grace <s>] [--json]
agora resident ensure [--dry-run] [--grace <s>] [--json]
agora resident grant [--json]
```

**want** runs from the session that holds the grant. The requester is the position the asking
session holds by its own record (the label it registered with: the extension registers the
launcher's `AGORA_LABEL`, or `session --label`), never an `AGORA_LABEL` set on the call, which any
session can set. The session must not be gone, and it must be the position's only holder that is
not gone: a second session registered at the holder's position spends nothing, and while it stands
the holder's wants are refused too, naming both. `--dry-run` admits or refuses exactly as the want
would, records nothing and starts nothing, so a probe spends no part of the grant. A want is
refused, by name and with the cap it hit, when:

- the holder holds no grant, or the position is outside its room;
- the role is outside `roles` (when it is a list), or names a messenger row, the holder's own
  position, or a slot (`coding-2`: want `coding`, and the seat picks the slot);
- the model (`--model`, else the row's, else the defaults') is outside `models`;
- `--hours` is past `maxHours`, or `maxLive` wants are already open;
- the role is new (no row) and neither the grant nor `--card` gives it a card, or a card does not
  exist;
- every slot is held: a row's slots are the row itself when it is `on-demand`, then `-2` .. `-<max>`
  (so a standing row with no `max` cannot be granted at all); a new role's are `<role>`, `-2` ..
  `-<maxLive>`;
- the row runs on host `none`, which has no handle a supervisor can start into.

An admitted want becomes a row: the base row (or the defaults, for a new role) with the want's role
and model, the base's `append` then the want's cards, its own working folder, the default bearer
(at a slot, `<role>-<n>/<Model>`: `desk.coding-2` signs `coding-2/Sonnet`, so `to:` and signatures
tell it from the base row) and no restart command of its own, checked exactly as a file row is.
Then `ensure` runs.

**unwant** is asked as a want is: by the session that holds the grant that asked the want (its own
record's position, never an `AGORA_LABEL` set on the call). A session with no position, or another
holder, is refused and the want stands; the refusal is in the ledger (`refuse`, `act: unwant`). The
operator ends a want by removing or narrowing the grant, or by stopping the position by hand.

**ensure** is the seat's one start authority; `want`, `unwant` and `cycle --all` run it, and it can
be run directly. Under the seat's grants lock it:

- starts each open want that is not running, through the row's host;
- restarts a granted position whose host died (a run record is left and nothing runs) and ends a
  want whose position was stopped by hand (no run record and no succession pending): a death is the
  supervisor's to repair, a stop is the operator's;
- stops a granted position whose want ended (unwanted, expired, or revoked: the grant removed, or
  narrowed past the want's role or model, or its base row gone) at its next idle: its harness
  transcript's last entry is an assistant message that called no tool, and has been quiet for
  `--grace` seconds (default 60). While a turn runs it is held and says so; a turn it cannot read
  holds it too;
- restarts a messenger row (`harness: "agora"`) whose host died; one with no run record was stopped
  by its operator and is left.

Each start or stop posts one N8 line, the messenger's fixed form (docs/MESSENGER.md), with the
trailer `ack: none`, as the room's messenger position when the manifest has one for the room (else
as the session running ensure), in the room's Room subject (the titled, pinned root; the earliest
pinned root when none is titled; top level when the room pins none):

```
desk.coding-2: wanted by desk.orchestrator 4s; path grant; outcome started.
desk.coding-2: revoked by manifest 2m; path grant; outcome stopped.
desk.coding-2: unwanted by desk.orchestrator 0s; path grant; outcome stopped.
desk.coding-2: expired by clock 1m; path grant; outcome stopped.
desk.messenger: absent by host 0s; path restart; outcome started.
```

The age is from the want to its start, or from the end of the want (first seen, for a revocation) to
the stop. **The record** is `<state>/residents/grants.jsonl`, append-only: every want, refusal (of a
want or of an unwant), unwant, ending (when a revocation or expiry was first seen), start, stop and end, one JSON line
each. What is open is a fold over it; nothing else is kept. `grant` prints each grant's caps and its
open wants with where each stands.

## The arming sequence a profile carries

1. Load no skill. Load a domain skill on the first request that needs it.
2. `agora resident inherit <slug>` (does nothing without a marker; under `resident start` the harness's agora-room extension or plugin has already run it, and it says `already`), then `agora session --as <bearer> --label <position>` with the bearer and position the profile gives (a single-room resident's position is its slug: `--as <Model>/<slug> --label <slug>`). A launcher may export `AGORA_LABEL=<position>` instead of passing `--label`.
3. Read the room to now from the saved cursor (`read --threads --files --json`); classify every unanswered message. Never `cursor --now`.
4. Arm one `watch --follow --files --json` per room as a background shell command (never under a monitor tool: Claude Code's Monitor expires every 30 minutes and each expiry is a whole-context wake), with `AGORA_SESSION` and `AGORA_ACTOR` carried in; it exits 42 on a delivery, and the wake re-arms it first, before disposing. Check the identity line. A resident started by `agora resident start` arms none: the harness's agora-room extension or plugin owns its watch, and its status line is the proof.
5. Prove the instrument the subject needs, with read-only commands, before promising anything.

## Positions

A resident's **position** is the session label: what the session is for on this seat, kept across
model swaps, restarts and successions while the bearer changes with the model. It is set by
`session --label <position>`, else by `AGORA_LABEL` in the environment (a launcher's export, as
`AGORA_ACTOR` feeds the bearer), else the record keeps the position it has; `join --label` is the
same. A position is lower-case segments of letters, digits, `_` and `-`, joined by `.`, at most 64
characters: `coding`, `code-review`, `desk.messenger`. The separator is `.` because `-` already
sits inside role names. Anything else is refused with exit 2, so a free-text label is no longer
accepted; a free-text label an older build wrote stays on its record and holds no position.

Matching, for `resident cycle` and its `--all`:

- A session that holds a position belongs to the resident of that position and to no other,
  whatever its bearer: `coding/Opus` labelled `desk.coding` is `desk.coding`, and is not `coding`
  or `Opus`.
- A session with no position is matched as before: by the `/<slug>` bearer suffix
  (`Opus/code-review` is `code-review`), or by a label equal to the slug. An unlabelled resident's
  verdict does not change.

The role in a position is its last `.` segment (`desk.messenger` is the role `messenger`), and the
usual `--wake` that `join` and `doctor` suggest is taken from it; a session with no position takes
the role from the bearer's last `/` segment, as before.

## The cycle

A session that sits armed pays, on the first inference after the prompt cache expires (one hour
after the last inference on a Claude Code seat with `promptCacheTtl: 1h`), an uncached read of
its whole context; every wake inside the burst after that is warm. So a burst's price is set by
the context size at the moment the cold wake lands. Measured: a resident that worked one
afternoon and slept overnight held 382K and would have paid it cold on the next message; its
successor armed at 118K.

`agora resident cycle <slug>... | --all [--dry-run] [--idle <s>] [--min-context <n>] [--max-context <n>] [--deaf <s>] [--restart <cmd>] [--json]`
is the guard and the act. Per resident it finds the newest live session that holds it (see
[Positions](#positions)), reads that session's Claude Code or OMP transcript, and takes the newest assistant message's
usage: context = input + cache read + cache creation, last inference = its timestamp. An entry the
harness wrote itself is not an inference and is skipped: Claude Code logs an API error (a 529, a
spend limit) as model `<synthetic>` with all-zero usage, and reading that as the newest message
measured two 700K residents as context 0 for three days. It cycles in four cases, and says which:

- **succeed**: the resident asked for it (`agora resident succeed`, below) and its turn has ended.
  Size and warmth are beside the point: the resident judged its own handover.
- **deaf**: the session holds no live watch and its last inference is older than `--deaf`
  (default 900 s). A live watch is an armed record (`watch --stream`, `--until-new`) whose pid
  answers, or a harness-owned watch's heartbeat: the agora-room extension and plugin poll the room
  from inside the harness, write no armed record, and rewrite the session's activity record
  (`<state>/sessions/<key>/activity.json`) on their poll tick at least every 30 s; a heartbeat
  younger than the messenger's silent bound (the larger of 5 minutes and three of the watch's own
  intervals) is a live watch, so a quiet resident whose extension polls is listening, not deaf. A
  deaf resident's watches died (an API error on the turn that should have re-armed them, a
  stopped extension), so it will never wake again; size and warmth are beside the point. The row
  prints `watching` and the heartbeat as `activityAt`.
- **ceiling**: the context is at least `--max-context` (default 400000) and the last inference is
  older than `--deaf`, so the session is between turns. Every wake re-reads the whole context, so
  past this a successor at the orientation floor is cheaper even while the cache is warm.
- **cold and large**: the last inference is older than `--idle` (default 3900 s: the TTL plus a
  margin, so the cache is cold anyway) **and** the context is above `--min-context` (default
  150000: a small cold read is not worth a floor).

The act writes
`<state>/residents/<slug>/inherit.json` naming the predecessor (`by: succeed` or `by: cycle`) and
then restarts it: `--restart`
on the call, else `restart` on the manifest's row, else `restart` on the config's
`residents.<slug>` row (`{slug}` in a command is the resident); else, for a manifest resident,
`stop` by its recorded handle and `start` again; else none (the marker is written and the restart
is the caller's). A manifest resident on host `none` has no handle a timer can start into and
needs a `restart` command. `--all` first runs one `ensure` pass ([Grants](#grants)), then takes the
slugs from the config's `residents` table, the manifest and the open wants.

**Succeed.** `agora resident succeed [<position>]` (default: this session's position) writes
`<state>/residents/<position>/succeed.json`, a request to be handed to a fresh session. A resident
makes it when a piece of work closes past its working size. The next cycle honours it only between
turns: the transcript's last entry is an assistant message that called no tool, so no tool call,
child job or delivery in flight is cut off; a turn it cannot read defers it. Honoured, the request
is removed; a request older than the session that now holds the position was already honoured and
is cleared.

Idle is the age of the last **assistant** message, never the transcript's mtime: hooks and
monitors append without an inference. A session from a harness whose transcript this cannot read
is `unsupported` by name, never estimated. `--min-context` must sit above every resident's
orientation floor, or a cold idle resident is cycled for nothing.

A restart is not a departure: a gone session whose position is held again by a live session on
the seat, or whose bearer is live again, is marked `restarted` and nothing is announced. So a
model swap by relaunch, which keeps the position and changes the bearer, announces nothing.

Why succeed rather than compact: the standing rule "compact, never restart" is for a warm
session, where a restart replays the room and echoes the session's own posts. `session
--inherit` closed that. Once the cache is cold, compaction reads the whole window and pays a
summary; a successor pays the floor and nothing for the old context. Warm and large: compact.
Cold and large: succeed. Small: leave it.

Run it every 10 to 15 minutes. `agora resident timer install` writes that schedule for this OS
and this config (and `--manifest`, when given): a Windows scheduled task `agora-resident-cycle`
(run in the user's session, headless, one instance at a time), a systemd user timer
`agora-resident-cycle.timer` with its oneshot service (through a login shell, for the user's
`PATH`), or a launchd agent `agora.resident-cycle` (logging to `<state>/residents/cycle.log`).
`--interval <seconds>` sets the period in whole minutes (default 900). `timer check` compares what
is installed with what install would write and exits 1 on `missing` or `differs`, changing
nothing; `timer remove` takes it out.

```
agora resident timer install|check|remove [--interval <seconds>] [--manifest <path>] [--json]
```

## The marker

`agora resident inherit <slug>` reads `<state>/residents/<slug>/inherit.json`, calls the same
inheritance as `agora session --inherit <from>` (cursors, follow set, posted ledger; the
predecessor's record is not copied, so `session --as` follows), and removes the marker. The open
claims and the owed list a successor reads with `carry` are derived from that ledger. Without a
marker it prints that there is nothing to inherit and exits 0, so an arming sequence runs it
unconditionally; when this session already inherited (its extension or plugin ran it first) it says
`already` and names the predecessor. A marker whose predecessor has no state any more (pruned) is
removed with a warning rather than left to refuse every launch.

The agora-room omp extension and Claude Code plugin run it themselves, for the position the
launcher gave (`AGORA_LABEL`), after registering and **before their first read**, so the watch
resumes where the predecessor stopped instead of at the room's head, and never delivers the
predecessor's own posts back. Their liveness file carries what it did (`inherit`).

A session that started after the marker was written is the successor it names: whatever position it
already holds in a room (a watch that read the room at its head before the arming sequence ran), the
predecessor's replaces it, because the messages between the two are the predecessor's unread and
the successor owes them. A session older than the marker keeps the refusal; `--force` takes the
predecessor's position in a room it already read.

## Config

```json
"residentManifest": "~/team/residents.json",
"residents": {
  "support": { "restart": "systemctl --user restart resident-{slug}.service" }
}
```

Only `agora config` writes these keys (`agora config set residentManifest '"~/team/residents.json"'`,
`agora config resident add support '{"restart":"systemctl --user restart resident-{slug}.service"}'`,
`agora config resident remove support`); the resident verbs read them and never write the shared
config. `residentManifest` names the seat's manifest; the `residents` table names residents the
manifest does not (a seat whose residents run from systemd units, say) for `cycle --all`. A resident
slug is checked when it is added, as `cycle` checks it. The profile and the manifest are the
operator's files and never travel through agora.
