// @ts-check
/**
 * S64 · queue-clock. The orchestrator queues tasks as the seed's card says (its intake reply carries
 * `task: <slug>`, a take is `claim: task:<slug>`, a close is `release:` with a verdict, a task with no
 * bar is parked by a release whose line is `waiting: <person>; needs: <thing>`). Ada asks for three:
 * "faster" is parked on her, "parser-fix" is taken, "slugify" is queued behind it. The orchestrator's
 * activity record says it is idle. The messenger ticks while parser-fix is held (phase 1), after it
 * closes (phase 2), and past R from the waiting line, after a second orchestrator session has taken
 * the position (phase 3).
 *
 * Bars: while a task is held the queue draws nothing; once none is held, one N10 for slugify to the
 * orchestrator from a tick at or after G of quiet, and one N3 `started` to the host human after G2;
 * the waiting line draws one N11 to Ada and one N12 to the orchestrator position.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ACTIVITY_FILE, DEFAULT_BOUNDS } from "../../src/messenger.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";
import { HOST_HUMAN, messengerRig, postedTs } from "./lib/messenger-rig.mjs";

const { G, G2, R } = DEFAULT_BOUNDS;

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S64",
  name: "queue-clock",
  checks: {
    "queued-stall-notice": {
      bar: "one N10 for the queued task to the orchestrator, from a tick at or after G of quiet since the last task closed, in its subject; one N3 started to the host human after G2",
      redLeg: "the orchestrator's activity record is busy and progressing (it is working)",
    },
    "active-task-quiet": {
      bar: "0 queue notices (N10, N3 started) from ticks while a task is held",
      redLeg: "the take claims work:parser-fix, not the task (so no task is held)",
    },
    "waiting-surfaced": {
      bar: "one N11 to the person the waiting line names, and one N12 to the orchestrator position after a new session takes it",
      redLeg: "the waiting is written in prose, not as the fixed line",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, HOST_HUMAN);
      const orch = await Agent.start(seat, { session: "s64-orch", bearer: "orchestrator/Opus", label: "desk.orchestrator", harness: "omp" });
      const rig = await messengerRig(seat);
      let files = 0;
      /** a post through the CLI with the flags the residents use; returns its id @param {string} text @param {string[]} flags */
      const post = async (text, flags) => {
        const file = path.join(seat.root, `s64-post-${++files}.txt`);
        await writeFile(file, text, "utf8");
        const r = await orch.ok(["post", seat.alias, "--file", file, "--json", ...flags]);
        await rm(file, { force: true });
        return String(JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}").id);
      };
      /** the orchestrator's own watch, as its record says @param {number} at the tick instant @param {number} since */
      const activity = async (at, since) => {
        const dir = path.join(seat.state, "sessions", orch.slug);
        await mkdir(dir, { recursive: true });
        const busy = ctx.red("queued-stall-notice");
        const iso = (/** @type {number} */ t) => new Date(t).toISOString();
        await writeFile(path.join(dir, ACTIVITY_FILE), JSON.stringify({ v: 1, type: "activity", session: orch.slug, position: "desk.orchestrator",
          turn: busy ? "busy" : "idle", since: iso(since), lastToolAt: busy ? iso(at - 60_000) : null, lastOutputAt: null, progress: 3,
          progressAt: busy ? iso(at - 60_000) : null, intervalMs: 2000, updatedAt: iso(at - 30_000) }), "utf8");
      };
      /** the notices one tick posted @param {number} at @param {number} since */
      const tick = async (at, since) => {
        await activity(at, since);
        return /** @type {string[]} */ ((await rig.tickAt(at)).posted.map((/** @type {any} */ p) => p.id));
      };
      const to = ["--to", HOST_HUMAN];

      // "faster" has no bar: taken and parked on Ada at once
      const c = await ada.post("Make the records faster.", { to: ["orchestrator"] });
      await post("queued faster, position 1; taking it", ["--thread", c.id, ...to, "--re", c.id, "--trailer", "task: faster", "--claim", "task:faster"]);
      const park = await post(ctx.red("waiting-surfaced") ? "I will wait for Ada to say which operation is slow." : "waiting: Ada; needs: the operation that is slow and the target",
        ["--thread", c.id, ...to, "--release", "task:faster"]);
      // "parser-fix" is taken; "slugify" queues behind it
      const a = await ada.post("Fix the parser.", { to: ["orchestrator"] });
      await post("queued parser-fix, position 1; taking it", ["--thread", a.id, ...to, "--re", a.id, "--trailer", "task: parser-fix",
        "--claim", ctx.red("active-task-quiet") ? "work:parser-fix" : "task:parser-fix"]);
      const b = await ada.post("Add slugify.", { to: ["orchestrator"] });
      const queued = await post("queued slugify, position 1", ["--thread", b.id, ...to, "--re", b.id, "--trailer", "task: slugify"]);

      // phase 1: a task is held, the orchestrator idle since the queueing, long past G2
      const tQueued = await postedTs(seat, queued);
      const phase1 = await tick(tQueued + G2 + 60_000, tQueued);

      // phase 2: the held task closes; the orchestrator goes quiet at the close
      const close = await post("closing parser-fix", ["--thread", a.id, ...to, "--release", "task:parser-fix", "--verdict", "pass", "--exhibit", "review 1"]);
      const tClose = await postedTs(seat, close);
      for (const o of [G - 1000, G + 1000, G2 + 1000, G2 + 60_000]) await tick(tClose + o, tClose);

      // phase 3: a second session takes the position, then the waiting line passes R
      await Agent.start(seat, { session: "s64-orch2", bearer: "orchestrator/Sonnet", label: "desk.orchestrator", harness: "omp" });
      const tPark = await postedTs(seat, park);
      for (const o of [R + 60_000, R + 120_000]) await tick(tPark + o, tClose);

      const notices = await rig.notices();
      const queue = notices.filter((n) => n.kind === "N10" || (n.kind === "N3" && n.fields.verb === "started"));
      const n10 = queue.filter((n) => n.kind === "N10" && n.fields.id === b.id);
      const n3 = queue.filter((n) => n.kind === "N3" && n.fields.id === b.id);
      ctx.check("queued-stall-notice", { n10: 1, to: "orchestrator", atG: true, inThread: true, n3: 1, n3To: HOST_HUMAN },
        { n10: n10.length, to: n10[0]?.to[0] ?? null, atG: n10.every((n) => n.at !== null && n.at - tClose >= G), inThread: n10.every((n) => n.thread === b.id),
          n3: n3.length, n3To: n3[0]?.to[0] ?? null }, { bounds: { G, G2 } });
      ctx.check("active-task-quiet", 0, queue.filter((n) => phase1.includes(n.id)).length);
      const n11 = notices.filter((n) => n.kind === "N11");
      const n12 = notices.filter((n) => n.kind === "N12");
      ctx.check("waiting-surfaced", { n11: 1, n11To: HOST_HUMAN, n12: 1, n12To: "orchestrator" },
        { n11: n11.length, n11To: n11[0]?.to[0] ?? null, n12: n12.length, n12To: n12[0]?.to[0] ?? null }, { bounds: { R } });
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
