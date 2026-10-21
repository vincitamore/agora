// @ts-check
/**
 * S65 · queue-identity. A long-lived room reuses task names, parks tasks with the waiting form
 * written after other words, changes its orchestrator session, and answers the messenger's notices.
 * Ada's first "slugify" is taken and closed; a later subject reuses the name "slugify", and a newer
 * one queues "reports". The orchestrator's activity record says it is idle. Then "faster" is taken
 * and released with `Released: no bar. waiting: Ada; needs: …` on one line; a second orchestrator
 * session takes the position; the orchestrator answers the queue notice `to: messenger` and posts a
 * release with no verdict to coding.
 *
 * Bars: the queue notice (N10) names the subject that reused the name, never the newer one; the
 * inline waiting form draws one N11 to Ada; the new session gets one N13 listing the queued subjects;
 * a line to the messenger itself and a bare release draw no delivery notice (N2, N3 `taken`).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ACTIVITY_FILE, DEFAULT_BOUNDS } from "../../src/messenger.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";
import { HOST_HUMAN, messengerRig, postedTs } from "./lib/messenger-rig.mjs";

const { G, R, R2 } = DEFAULT_BOUNDS;

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S65",
  name: "queue-identity",
  checks: {
    "reused-name-head": {
      bar: "one N10 from the tick at G of quiet, naming the older subject that reused a closed task's name (not the newer subject behind it)",
      redLeg: "the subject that reuses the name carries no task: mark (so the newer subject is the head)",
    },
    "inline-waiting": {
      bar: "one N11 to Ada for the task released with `waiting: Ada; needs: …` after other words on the line",
      redLeg: "the waiting is written in prose, not as the form",
    },
    "arming-handover": {
      bar: "one N13 to the orchestrator position after a second session takes it, listing both queued subjects in queue order and no active task",
      redLeg: "no second session takes the position",
    },
    "no-self-clock": {
      bar: "0 delivery notices (N2, N3 taken) for a line addressed to the messenger answering its notice, and for a release with no verdict addressed to coding",
      redLeg: "both lines are written as plain requests to coding",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, HOST_HUMAN);
      const orch = await Agent.start(seat, { session: "s65-orch", bearer: "orchestrator/Opus", label: "desk.orchestrator", harness: "omp" });
      await Agent.start(seat, { session: "s65-coding", bearer: "coding/Opus", label: "desk.coding", harness: "omp" });
      const rig = await messengerRig(seat);
      let files = 0;
      /** a post through the CLI with the flags the residents use; returns its id @param {string} text @param {string[]} flags */
      const post = async (text, flags) => {
        const file = path.join(seat.root, `s65-post-${++files}.txt`);
        await writeFile(file, text, "utf8");
        const r = await orch.ok(["post", seat.alias, "--file", file, "--json", ...flags]);
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

      // the first slugify: taken and closed
      const a = await ada.post("Add slugify.", { to: ["orchestrator"] });
      await post("queued slugify, position 1; taking it", ["--thread", a.id, ...to, "--re", a.id, "--trailer", "task: slugify", "--claim", "task:slugify"]);
      await post("closing slugify", ["--thread", a.id, ...to, "--release", "task:slugify", "--verdict", "pass", "--exhibit", "review 1"]);
      // the name again, in a later subject; then a newer subject behind it
      const b = await ada.post("Add slugify for titles too.", { to: ["orchestrator"] });
      await post("queued slugify, position 1", ["--thread", b.id, ...to, "--re", b.id, ...(ctx.red("reused-name-head") ? [] : ["--trailer", "task: slugify"])]);
      const c = await ada.post("Make the reports smaller.", { to: ["orchestrator"] });
      const lastIntake = await post("queued reports, position 2", ["--thread", c.id, ...to, "--re", c.id, "--trailer", "task: reports"]);

      // phase 1: no task held, the orchestrator idle since the last intake, G later
      const tQueued = await postedTs(seat, lastIntake);
      const phase1 = await tick(tQueued + G + 60_000, tQueued);
      const notices1 = (await rig.notices()).filter((n) => phase1.includes(n.id));
      const n10 = notices1.filter((n) => n.kind === "N10");
      const named = n10[0]?.fields.id === b.id ? "reused-subject" : n10[0]?.fields.id === c.id ? "newer-subject" : null;
      ctx.check("reused-name-head", { n10: 1, names: "reused-subject" }, { n10: n10.length, names: named }, { bounds: { G } });

      // phase 2: "faster" is taken and parked with the waiting form after other words
      const d = await ada.post("Make the records faster.", { to: ["orchestrator"] });
      await post("queued faster; taking it", ["--thread", d.id, ...to, "--re", d.id, "--trailer", "task: faster", "--claim", "task:faster"]);
      const park = await post(ctx.red("inline-waiting") ? "Released: no bar yet; I will wait for Ada to say which records and how fast."
        : "Released: no bar. waiting: Ada; needs: which records, and how fast counts as faster.", ["--thread", d.id, ...to, "--release", "task:faster"]);
      const tPark = await postedTs(seat, park);
      await tick(tPark + R + 60_000, tPark);
      const n11 = (await rig.notices()).filter((n) => n.kind === "N11" && n.re === park);
      ctx.check("inline-waiting", { n11: 1, to: HOST_HUMAN }, { n11: n11.length, to: n11[0]?.to[0] ?? null }, { bounds: { R } });

      // phase 3: a second session takes the position
      if (!ctx.red("arming-handover")) await Agent.start(seat, { session: "s65-orch2", bearer: "orchestrator/Sonnet", label: "desk.orchestrator", harness: "omp" });
      const phase3 = await tick(tPark + R + 120_000, tPark);
      const n13 = (await rig.notices()).filter((n) => n.kind === "N13" && phase3.includes(n.id));
      /** the subjects by their part in the room, so the recording holds no run's ids @param {string | undefined} s */
      const named13 = (s) => s?.replaceAll(b.id, "<reused-subject>").replaceAll(c.id, "<newer-subject>") ?? null;
      ctx.check("arming-handover", { n13: 1, to: "orchestrator", queued: "task:slugify@<reused-subject>,task:reports@<newer-subject>", yours: "none", others: "none" },
        { n13: n13.length, to: n13[0]?.to[0] ?? null, queued: named13(n13[0]?.fields.queued), yours: n13[0]?.fields.yours ?? null, others: n13[0]?.fields.others ?? null });

      // phase 4: an answer to the queue notice, to the messenger; a release with no verdict, to coding
      const plain = ctx.red("no-self-clock");
      const answer = await post("Not started: slugify is next in queue order.", plain ? ["--thread", b.id, "--to", "coding"]
        : ["--thread", b.id, "--to", "messenger", "--re", String(n10[0]?.id ?? b.id)]);
      await post("holding the impl subject", ["--thread", d.id, "--claim", "work:records/impl"]);
      const released = await post("Released work:records/impl: the maker is done.", plain ? ["--thread", d.id, "--to", "coding"]
        : ["--thread", d.id, "--to", "coding", "--release", "work:records/impl"]);
      const tLast = await postedTs(seat, released);
      for (const o of [R + 60_000, R2 + 60_000]) await tick(tLast + o, tLast);
      const delivery = (await rig.notices()).filter((n) => (n.kind === "N2" && (n.fields.id === answer || n.fields.id === released))
        || (n.kind === "N3" && n.fields.verb === "taken" && (n.fields.id === answer || n.fields.id === released)));
      ctx.check("no-self-clock", 0, delivery.length, { bounds: { R, R2 } });
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
