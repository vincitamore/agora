// @ts-check
/**
 * S01 · retired-name. A session posts under one name, then renames itself mid-work (the same
 * session re-registers under a new bearer; its position stays). A human then addresses the old
 * name three times. Two more legs ride on the same seat. Before the messenger's first tick the room
 * already holds two lines to a name nobody holds; the first tick records the messenger's starting
 * point (the start less a look-back L of one second here), and one more such line follows it. And a
 * second session holding `main.dummy` is addressed twice by position, answers one, and then its
 * process ends. The messenger ticks once more.
 *
 * Bars: one N5 pointer per incident, in the addressed message's own thread, classed `retired`; each
 * names the position that holds the old name's session now (read from the posted ledger: the
 * session that posted under the old name). No pointer for a line that was there before the first
 * start, one for the line after it. No pointer for either line to `main.dummy`: one was answered,
 * and both were posted while their holder lived. The post-time sender warning the compass also
 * bars is the matcher's unit and is not counted here.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, behaviours, openClient } from "./lib/participants.mjs";
import { HOST_HUMAN, messengerRig } from "./lib/messenger-rig.mjs";

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S01",
  name: "retired-name",
  checks: {
    "pointer-per-incident": {
      bar: "one N5 per message addressed to the retired name, in that message's thread, classed retired",
      redLeg: "a fourth message addresses the retired name (the counted population moves)",
    },
    "nearest-is-holder": {
      bar: "every pointer names the position the renamed session holds now",
      redLeg: "the renamed session's posted ledger is lost, so nothing ties the old name to it",
    },
    "first-start-bounded": {
      bar: "the first start raises no pointer for the lines older than its look-back, and one for the line after it",
      redLeg: "the look-back is ten minutes, so the first start reaches the older lines",
    },
    "quiet-after-holder-ends": {
      bar: "no pointer for a line answered by its position's session, nor for one posted while that session lived, once it has ended",
      redLeg: "the position's session had ended before both lines were posted",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, HOST_HUMAN);
      const worker = await Agent.start(seat, { session: "s01-worker", bearer: "builder/Opus", label: "desk.coding", harness: "omp" });
      await worker.post("Starting on the importer.");
      await behaviours.renameMidThread(worker, "coding/Opus");
      if (ctx.red("nearest-is-holder")) await rm(path.join(seat.state, "sessions", worker.slug, "posted.jsonl"), { force: true });
      const dummy = await Agent.start(seat, { session: "s01-dummy", bearer: "probe/Opus", label: "main.dummy", harness: "omp" });
      const rig = await messengerRig(seat, { bounds: ctx.red("first-start-bounded") ? "L=10m" : "L=1s" });
      // the room's history before the messenger's first start: two lines to a name nobody holds
      const old = [(await ada.post("Who has the old ticket?", { to: ["nobody"] })).id, (await ada.post("Anyone?", { to: ["nobody"] })).id];
      await new Promise((r) => setTimeout(r, 1500));
      await rig.tickAt(Date.now());
      const asks = ["Is the importer done?", "Did it handle the empty file?", "Can you post the timing?", ...(ctx.red("pointer-per-incident") ? ["And the log?"] : [])];
      /** @type {string[]} */
      const ids = [];
      for (const text of asks) ids.push((await ada.post(text, { to: ["builder"] })).id);
      const after = (await ada.post("And the new ticket?", { to: ["nobody"] })).id;
      // two lines to a position: answered and unanswered while its session lives, then it ends
      const ended = ctx.red("quiet-after-holder-ends");
      if (ended) await dummy.stopHarness();
      const answered = await ada.post("Can you rerun the probe?", { to: ["main.dummy"] });
      const unanswered = await ada.post("And log the result?", { to: ["main.dummy"] });
      if (!ended) {
        await dummy.post("Rerun done.", { thread: answered.id });
        await dummy.stopHarness();
      }
      await rig.tickAt(Date.now());
      const notices = await rig.notices();
      const n5 = notices.filter((n) => n.kind === "N5" && n.fields.addr === "builder");
      ctx.check("pointer-per-incident", { pointers: 3, inItsThread: 3, retired: 3 },
        { pointers: n5.length, inItsThread: n5.filter((n) => ids.includes(String(n.re)) && n.thread === n.re).length, retired: n5.filter((n) => n.fields.kind === "retired").length });
      ctx.check("nearest-is-holder", { named: 3, of: 3, nearest: "desk.coding" },
        { named: n5.filter((n) => n.fields.nearest === "desk.coding").length, of: n5.length, nearest: n5[0]?.fields.nearest ?? null });
      const nobody = notices.filter((n) => n.kind === "N5" && n.fields.addr === "nobody");
      ctx.check("first-start-bounded", { old: 0, after: 1 },
        { old: nobody.filter((n) => old.includes(String(n.re))).length, after: nobody.filter((n) => n.re === after).length });
      ctx.check("quiet-after-holder-ends", 0, notices.filter((n) => n.kind === "N5" && (n.re === answered.id || n.re === unanswered.id)).length);
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
