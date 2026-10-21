// @ts-check
/**
 * S68 · claim-on-arming. A maker at `main.coding`, an omp session signing `coding/Sonnet`, takes a
 * unit (`claim: fix/impl`) and dies holding it (a crash, a kill, a reboot). A new session takes the
 * position and starts reading the room past the claim, as an inherited cursor does: nothing it reads
 * says the unit is its own, and the lease runs on for an hour. The messenger ticks once.
 *
 * Bars: the tick posts one N14 to the position naming the claim it holds, and the successor's own
 * `watch --wake mine` delivers it, so it resumes without a nudge; further ticks post nothing more for
 * that arming.
 */

import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";
import { HOST_HUMAN, messengerRig } from "./lib/messenger-rig.mjs";
import { parseNotice } from "../../src/messenger.mjs";

const POSITION = "main.coding";

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S68",
  name: "claim-on-arming",
  checks: {
    "claim-handed-on-arming": {
      bar: "after the maker holding work:fix/impl dies and a new session takes its position, one tick posts one N14 to the position naming the claim, and the successor's watch --wake mine delivers it",
      redLeg: "the maker released its claim before it died, so the position holds nothing",
    },
    "once-per-arming": {
      bar: "a second tick posts no second N14: one line per arming",
      redLeg: "a third session takes the position between the ticks (a new arming)",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, HOST_HUMAN);
      const rig = await messengerRig(seat);
      const pred = await Agent.start(seat, { session: "s68-coding-a", bearer: "coding/Sonnet", label: POSITION, harness: "omp" });
      const ask = await ada.post("Please fix the median test.", { to: [POSITION] });
      await pred.watchOnce({ wake: "mine" });
      await pred.post("Taking fix/impl.", { thread: ask.id, claim: "fix/impl" });
      if (ctx.red("claim-handed-on-arming")) await pred.ok(["post", seat.alias, "--json", "--thread", ask.id, "--release", "fix/impl", "--", "Released fix/impl."]);
      await pred.stopHarness(); // it dies holding the claim

      // the successor: a new session at the position, reading from past the claim
      const succ = await Agent.start(seat, { session: "s68-coding-b", bearer: "coding/Sonnet", label: POSITION, harness: "omp" });
      await succ.ok(["cursor", seat.alias, "--now"]);
      const first = await rig.tickAt(Date.now() + 1000);
      const delivered = await succ.watchOnce({ wake: "mine" });
      const handed = delivered.messages.map((m) => parseNotice(m.text)).filter((n) => n?.kind === "N14");
      const posted = (await rig.notices()).filter((n) => n.kind === "N14");
      /** the ask by its part in the room, so the recording holds no run's ids @param {string | undefined} s */
      const named = (s) => s?.replaceAll(ask.id, "<ask>") ?? null;
      ctx.check("claim-handed-on-arming", { n14: 1, to: POSITION, claims: "work:fix/impl@<ask>", byFirstTick: true, delivered: 1 },
        { n14: posted.length, to: posted[0]?.to[0] ?? null, claims: named(posted[0]?.fields.claims), byFirstTick: posted.every((n) => first.posted.some((/** @type {any} */ p) => p.id === n.id)), delivered: handed.length });

      if (ctx.red("once-per-arming")) await Agent.start(seat, { session: "s68-coding-c", bearer: "coding/Sonnet", label: POSITION, harness: "omp" });
      await rig.tickAt(Date.now() + 2000);
      ctx.check("once-per-arming", 1, (await rig.notices()).filter((n) => n.kind === "N14").length);
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
