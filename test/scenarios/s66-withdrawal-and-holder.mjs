// @ts-check
/**
 * S66 · withdrawal-and-holder. Ada withdraws two requests and the orchestrator position changes
 * session with a task held. "tidier" is taken and then released by its holder with a `withdrawn:`
 * trailer and no verdict (there was no work to judge). "trim" is taken and parked on Ada, who
 * withdraws it in its subject with a `withdrawn:` line. "pad" is taken, and a second orchestrator
 * session takes the position while the first one's claim stands. The orchestrator's activity record
 * says it is idle.
 *
 * Bars: neither withdrawn task is queued again, so no queue notice (N10) and no waiting notice (N11)
 * follows either; the new session's N13 names pad as the position's own (`active and yours`) and
 * nothing as held by others.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ACTIVITY_FILE, DEFAULT_BOUNDS } from "../../src/messenger.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";
import { HOST_HUMAN, messengerRig, postedTs } from "./lib/messenger-rig.mjs";

const { G, R } = DEFAULT_BOUNDS;

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S66",
  name: "withdrawal-and-holder",
  checks: {
    "release-withdrawal": {
      bar: "0 N10 for a task its holder released with a `withdrawn:` trailer and no verdict, from a tick at G of the orchestrator's quiet",
      redLeg: "the release carries no withdrawn trailer (so it hands the task back to the queue)",
    },
    "person-withdrawal": {
      bar: "0 N10 and 0 N11 for a parked task the person withdrew in its subject with a `withdrawn:` line, from a tick past R from the waiting line",
      redLeg: "the person's withdrawal is written in prose (so it is an answer, which hands the task back to the queue)",
    },
    "handover-names-holder": {
      bar: "one N13 to the orchestrator position after a second session takes it, naming the task the first session holds as `active and yours` and none as held by others",
      redLeg: "the task was claimed by another bearer (a rig), not the orchestrator position",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, HOST_HUMAN);
      const orch = await Agent.start(seat, { session: "s66-orch", bearer: "orchestrator/Opus", label: "desk.orchestrator", harness: "omp" });
      const rigAgent = await Agent.start(seat, { session: "s66-rig", bearer: "rig/Opus", harness: "omp" });
      const rig = await messengerRig(seat);
      let files = 0;
      /** a post through the CLI with the flags the residents use; returns its id @param {Agent} who @param {string} text @param {string[]} flags */
      const post = async (who, text, flags) => {
        const file = path.join(seat.root, `s66-post-${++files}.txt`);
        await writeFile(file, text, "utf8");
        const r = await who.ok(["post", seat.alias, "--file", file, "--json", ...flags]);
        await rm(file, { force: true });
        return String(JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}").id);
      };
      /** the orchestrator's own watch: idle since `since` @param {number} at @param {number} since */
      const tick = async (at, since) => {
        const dir = path.join(seat.state, "sessions", orch.slug);
        await mkdir(dir, { recursive: true });
        const iso = (/** @type {number} */ t) => new Date(t).toISOString();
        await writeFile(path.join(dir, ACTIVITY_FILE), JSON.stringify({ v: 1, type: "activity", session: orch.slug, position: "desk.orchestrator",
          turn: "idle", since: iso(since), lastToolAt: null, lastOutputAt: null, progress: 3, progressAt: null, intervalMs: 2000, updatedAt: iso(at - 30_000) }), "utf8");
        return /** @type {string[]} */ ((await rig.tickAt(at)).posted.map((/** @type {any} */ p) => p.id));
      };
      const to = ["--to", HOST_HUMAN];

      // tidier: taken, then released by its holder as withdrawn, with no verdict
      const a = await ada.post("Make the output tidier.", { to: ["orchestrator"] });
      await post(orch, "queued tidier, position 1; taking it", ["--thread", a.id, ...to, "--re", a.id, "--trailer", "task: tidier", "--claim", "task:tidier"]);
      const closed = await post(orch, "tidier closed: Ada withdrew it; no bar was set and there was no work to judge.",
        ["--thread", a.id, ...to, "--release", "task:tidier", ...(ctx.red("release-withdrawal") ? [] : ["--trailer", "withdrawn: Ada; no bar set, no work done"])]);
      const tClosed = await postedTs(seat, closed);
      const phase1 = await tick(tClosed + G + 60_000, tClosed);
      const n10a = (await rig.notices()).filter((n) => n.kind === "N10" && phase1.includes(n.id) && n.fields.id === a.id);
      ctx.check("release-withdrawal", 0, n10a.length, { bounds: { G } });

      // tidier is closed with a verdict before trim begins, whatever the fold made of the withdrawal,
      // so each later check reads only its own task at the head of the queue
      await post(orch, "recording the close of tidier", ["--thread", a.id, ...to, "--release", "task:tidier", "--verdict", "pass", "--exhibit", "withdrawn by Ada, nothing to judge"]);
      // trim: taken, parked on Ada, withdrawn by Ada in its subject
      const b = await ada.post("Trim the report.", { to: ["orchestrator"] });
      await post(orch, "queued trim; taking it", ["--thread", b.id, ...to, "--re", b.id, "--trailer", "task: trim", "--claim", "task:trim"]);
      const park = await post(orch, "Released: no bar yet.", ["--thread", b.id, ...to, "--release", "task:trim", "--trailer", "waiting: Ada; needs: which report, and how short"]);
      const withdraw = await ada.post(ctx.red("person-withdrawal") ? "Not needed any more; please close it without a bar." : "Withdrawn: not needed any more; please close it without a bar.",
        { thread: b.id, to: ["orchestrator"], re: park });
      const tPark = await postedTs(seat, park);
      const tWithdraw = await postedTs(seat, withdraw.id);
      const phase2 = await tick(tPark + R + 60_000, tWithdraw);
      const after2 = (await rig.notices()).filter((n) => phase2.includes(n.id));
      ctx.check("person-withdrawal", { n10: 0, n11: 0 }, { n10: after2.filter((n) => n.kind === "N10" && n.fields.id === b.id).length, n11: after2.filter((n) => n.kind === "N11" && n.re === park).length },
        { bounds: { G, R } });

      // pad: taken by the position (or, red, by a rig); then a second session takes the position
      const c = await ada.post("Pad the numbers.", { to: ["orchestrator"] });
      await post(orch, "queued pad, position 1", ["--thread", c.id, ...to, "--re", c.id, "--trailer", "task: pad"]);
      await post(ctx.red("handover-names-holder") ? rigAgent : orch, "taking pad", ["--thread", c.id, ...to, "--claim", "task:pad"]);
      await Agent.start(seat, { session: "s66-orch2", bearer: "orchestrator/Sonnet", label: "desk.orchestrator", harness: "omp" });
      const phase3 = await tick(tPark + R + 120_000, tWithdraw);
      const n13 = (await rig.notices()).filter((n) => n.kind === "N13" && phase3.includes(n.id));
      /** the subject by its part in the room, so the recording holds no run's ids @param {string | undefined} s */
      const named13 = (s) => s?.replaceAll(c.id, "<pad-subject>") ?? null;
      ctx.check("handover-names-holder", { n13: 1, to: "orchestrator", yours: "task:pad@<pad-subject>", others: "none" },
        { n13: n13.length, to: n13[0]?.to[0] ?? null, yours: named13(n13[0]?.fields.yours), others: named13(n13[0]?.fields.others) });
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
