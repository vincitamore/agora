// @ts-check
/**
 * S20 · unowned. A human opens a titled subject addressed to everyone; no position claims it and
 * no agent answers. A second titled subject is claimed (`msg:<root>`) by a position (the control).
 * An orchestrator position is stood on the seat. The messenger ticks just before Bo, just after,
 * and once more.
 *
 * Bars: exactly one N6 for the open subject, to the orchestrator, from a tick at or after Bo; the
 * claimed control draws none.
 */

import { DEFAULT_BOUNDS } from "../../src/messenger.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";
import { HOST_HUMAN, messengerRig, postedTs } from "./lib/messenger-rig.mjs";

const { Bo } = DEFAULT_BOUNDS;

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S20",
  name: "unowned",
  checks: {
    "one-n6-at-bo": {
      bar: "one N6 for the open subject, to the orchestrator, from a tick at or after Bo, in the subject's thread",
      redLeg: "a second titled subject is left open as well (the counted population moves)",
    },
    "claimed-control-quiet": {
      bar: "0 notices for the subject a position claimed",
      redLeg: "the claim names another message",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, HOST_HUMAN);
      const coding = await Agent.start(seat, { session: "s20-coding", bearer: "coding/Opus", label: "desk.coding", harness: "omp" });
      await Agent.start(seat, { session: "s20-orch", bearer: "orchestrator/Opus", label: "desk.orchestrator", harness: "omp" });
      const rig = await messengerRig(seat);
      const open = await ada.post("Who can own the release notes this week?", { to: ["*"] });
      await ada.title(open.id, "Release notes owner");
      const claimed = await ada.post("Someone should rotate the test keys.", { to: ["*"] });
      await ada.title(claimed.id, "Rotate test keys");
      await coding.post("Taking the key rotation.", { claim: `msg:${ctx.red("claimed-control-quiet") ? open.id : claimed.id}` });
      if (ctx.red("one-n6-at-bo")) {
        const second = await ada.post("And the changelog format?", { to: ["*"] });
        await ada.title(second.id, "Changelog format");
      }
      const t0 = await postedTs(seat, open.id);
      for (const o of [Bo - 1000, Bo + 1000, Bo + 60_000]) await rig.tickAt(t0 + o);
      const notices = await rig.notices();
      const n6 = notices.filter((n) => n.kind === "N6" && n.fields.id !== claimed.id);
      ctx.check("one-n6-at-bo", { count: 1, to: "orchestrator", atBo: true, inThread: true },
        { count: n6.length, to: n6[0]?.to[0] ?? null, atBo: n6.every((n) => n.at !== null && n.at - t0 >= Bo), inThread: n6.every((n) => n.thread === n.fields.id) }, { bounds: { Bo } });
      ctx.check("claimed-control-quiet", 0, notices.filter((n) => n.fields.id === claimed.id || n.re === claimed.id).length);
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
