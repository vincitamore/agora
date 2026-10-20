// @ts-check
/**
 * S01 · retired-name. A session posts under one name, then renames itself mid-work (the same
 * session re-registers under a new bearer; its position stays). A human then addresses the old
 * name three times. The messenger ticks once.
 *
 * Bars: one N5 pointer per incident, in the addressed message's own thread, classed `retired`; each
 * names the position that holds the old name's session now (read from the posted ledger: the
 * session that posted under the old name). The post-time sender warning the compass also bars is
 * the matcher's unit and is not counted here.
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
      const rig = await messengerRig(seat);
      const asks = ["Is the importer done?", "Did it handle the empty file?", "Can you post the timing?", ...(ctx.red("pointer-per-incident") ? ["And the log?"] : [])];
      /** @type {string[]} */
      const ids = [];
      for (const text of asks) ids.push((await ada.post(text, { to: ["builder"] })).id);
      await rig.tickAt(Date.now());
      const n5 = (await rig.notices()).filter((n) => n.kind === "N5" && n.fields.addr === "builder");
      ctx.check("pointer-per-incident", { pointers: 3, inItsThread: 3, retired: 3 },
        { pointers: n5.length, inItsThread: n5.filter((n) => ids.includes(String(n.re)) && n.thread === n.re).length, retired: n5.filter((n) => n.fields.kind === "retired").length });
      ctx.check("nearest-is-holder", { named: 3, of: 3, nearest: "desk.coding" },
        { named: n5.filter((n) => n.fields.nearest === "desk.coding").length, of: n5.length, nearest: n5[0]?.fields.nearest ?? null });
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
