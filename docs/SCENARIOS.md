# Scenarios

A scenario puts scripted participants in a real room and measures what the tool did. It runs the
real seat service and the real CLI in a temporary root, drives mock agents (sessions) through the
CLI and mock people through `agora/client`, and reads the outcome back from the records the CLI and
service wrote: the room as `read --json` returns it, the lines a watch printed, saved cursors,
session records, the resident marker, a post's own stderr. Nothing a scenario counts is taken from
what the runner meant to do.

The rig lives in `test/scenarios/`:

| Path | What it is |
|---|---|
| `run.mjs` | runs one leg of one scenario and prints its observation lines |
| `lib/seat.mjs` | `openSeat`: a seat service started through the CLI in a temp root, one native room, a fake home; every process it starts is stopped by its exact pid |
| `lib/participants.mjs` | `Agent` (a session driving the CLI), `Human` (a person through `agora/client`), and `behaviours`: the failure classes as scripted acts |
| `lib/room.mjs` | the room read back, and the facts counted off it |
| `lib/observe.mjs` | observation lines, the verdict table, the recording, the two gates |
| `lib/fixture.mjs` | replay fixtures, the `read --json` converter, the replay's analyses and its red-leg variations |
| `lib/suite.mjs` | the gate as node:test cases: the normal leg and one red leg per check, each its own process |
| `sNN-*.mjs` / `sNN-*.test.mjs` | a scenario and its gate |
| `recorded/SNN.json` | what each check observed on the build it was recorded on |
| `fixtures/baseline-synthetic.jsonl` | a neutral replay fixture for S00 |

The scenarios are `*.test.mjs`, so `npm test` runs them. On their own:

```
node --test "test/scenarios/*.test.mjs"
node test/scenarios/run.mjs S14                    # the normal leg's lines
node test/scenarios/run.mjs S14 --leg red:untitled-roots
```

## Observation lines

Each check prints one line on stdout:

```json
{"type":"observation","scenario":"S14","leg":"normal","check":"untitled-roots","expected":0,"observed":3,"verdict":"red-as-expected","note":"5 top-level messages"}
```

`expected` is the check's bar, the behaviour wanted. `observed` is what this build did. `bounds`,
where a check depends on one, names each bound by its symbol with the value it ran at
(`{"DEPART_GRACE_MINUTES":5}`). A bound runs at its configured value: the scenario imports the
constant and builds the fixture against it (a record aged past the grace, a transcript older than
the idle bound), and never overrides it to make the run quick.

The gate reads these lines and never the exit code. A leg that prints nothing has stopped asserting
and fails.

## Verdicts and the expected-red convention

A scenario's recording pins, per check, whether it met its bar on the build it was recorded on
(`today`: `green` or `red`) and what it observed. The verdict compares this run against it:

| Recording | This run | Verdict | Gate |
|---|---|---|---|
| green | meets the bar | `pass` | holds |
| green | short of the bar | `fail` | fails |
| red | observes exactly the recorded failure | `red-as-expected` | holds |
| red | meets the bar | `flipped` | fails: update the recording |
| red | anything else | `drifted` | fails: different, not fixed |

So a failure the framework has not fixed yet is pinned, not skipped: CI stays green while the tool
fails in exactly the recorded way, and it goes red the moment the failure changes. A fix shows as
`flipped`. The change that fixes it re-records in the same commit:

```
node test/scenarios/run.mjs S14 --record
```

`--record` rewrites `recorded/S14.json` from the normal leg's observations on this build. Read the
FLIPPED or DRIFTED line before running it: a `drifted` check is short of its bar in a new way, and
re-recording it moves the pin without a fix.

The gate also judges each line again against the recording on disk, so a scenario cannot pass by
printing a verdict.

## Red legs

Every check names a red leg: a planted variation of the world (a participant's act, a
registration, an address, a lost record) under which that check must fail. The suite runs each
red leg as its own process and requires the named check's verdict to be `fail`, `flipped` or
`drifted`. A check whose red leg leaves it `pass` or `red-as-expected` is not admitted, and a leg
that crashes before printing the check's line is a signal, not a discriminating failure.

- For a check that is green today, the variation breaks the behaviour (`fail`).
- For a check that is red today, the variation is the fix done by hand where a participant can do
  it (the reply also passes `--thread`; the agent posts its own swap line), so the check is shown
  able to go green (`flipped`). Where no participant can do the fix, the variation moves the
  counted population (a second top-level `re:` reply) and the check is shown to count what it
  names (`drifted`).

A pass licenses only the difference its red leg varied: each check's red leg is printed in the
suite's test names.

## Writing a scenario

A scenario module exports `scenario`:

```js
export const scenario = {
  id: "S14",
  name: "subjects",
  checks: {
    "untitled-roots": { bar: "0 top-level messages without a title", redLeg: "the agents title their own top-level posts" },
  },
  async run(ctx) {
    const seat = await openSeat();
    try {
      // participants act; ctx.red("untitled-roots") is true on that check's red leg
      // read the records back; then one ctx.check per declared check
      ctx.check("untitled-roots", 0, count);
    } finally {
      await seat.close();
    }
  },
};
```

`ctx.red(check)` plants a check's variation; `ctx.only` names the check a red leg is for, so a
scenario with arms may skip the others; `ctx.baseline(check, observed)` is the bar of a baseline
check (one whose bar is "unchanged since the recording"); `ctx.log` writes to stderr. Register the
module in `lib/scenarios.mjs`, add a two-line `sNN-*.test.mjs` calling `scenarioSuite`, then run
the normal leg with `--record` and read every line before committing the recording.

Rules: temp roots only (`openSeat` points AGORA_CONFIG, AGORA_STATE, HOME and USERPROFILE inside
its root, so `~/.agora` is never read); the real service and CLI, with any in-process part named as
such in the scenario's header; stop what you start by its exact pid; a check's bar is never
vacuous (a count that could be met by nothing happening takes at least one).

Participants are neutral: people Ada, Grace and Lin; seats `host` and `member`; bearers like
`coding/Opus` and `review/Sonnet`. A scenario never carries a real room's names or text.

## Replaying a fixture (S00)

S00 replays a message fixture through scripted participants and, for every bearer any session
held, reads the whole room with one reader session per wake mode (`all`, `addressed`, `mine`). It
counts, per message: who woke under each mode, addresses that name nobody present (split into
retired bearers, half-names and unknown names), top-level replies that carry `re:`, top-level
messages with no title, and human lines answered by two or more agents.

A fixture is JSON lines in room order:

```json
{"event":"register","session":"s-build","author":"Opus/build"}
{"id":"q1","author":"Ada","kind":"human","text":"Can someone look?","to":["coding"],"title":"Parser test"}
{"id":"a1","author":"coding/Opus","session":"s-coding","kind":"agent","text":"Taking it.","thread":"q1"}
{"id":"a2","author":"Sonnet/build","session":"s-build","kind":"agent","text":"Drafted.","re":"q1"}
```

`id` is a label local to the fixture; `thread` and `re` name labels. `session` lets one session
post under several bearers (a rename). A `register` line puts a session in the room, or renames
it, without a post; a session is present from its first line.

The in-repo fixture is synthetic and recorded. A private export is replayed in place and is never
copied into the repository:

```
node test/scenarios/run.mjs S00 --fixture /path/to/room.messages.jsonl --from read-json
AGORA_SCENARIO_FIXTURE=/path/to/room.messages.jsonl node test/scenarios/run.mjs S00 --from read-json
```

`--from read-json` converts `agora read --json` lines in memory: bodies without signature or
trailer block, `to` carried, `re` (an id or a cursor) and `thread` resolved to labels, title
annotations kept, every agent author registered at the start. The export does not say which
bearers one session held, so a rename reads as two sessions and a retired bearer is not counted as
retired. A run on a private fixture prints `measured` verdicts, counts only (no per-message rows
unless `--detail`), and cannot be recorded. The suite never reads `AGORA_SCENARIO_FIXTURE`.
