// @ts-check
/**
 * S07 · model-swap. `coding/Argon` holds a claim in an open thread; the human and the orchestrator
 * address `to: coding`. Mid-thread the model changes, in two arms, each on its own seat:
 *
 *   in-place  the same session re-registers as `coding/Sonnet`;
 *   relaunch  the harness stops and a new session inherits the old one's positions and registers
 *             `coding/Sonnet` (what a swap is when the model is chosen at launch).
 *
 * Then the orchestrator's watch sweeps the seat (where the tool announces departures), the human
 * asks again with `to: coding`, the new bearer's `watch --wake mine` reads, and `resident cycle
 * coding` looks for the resident. One principal: both sessions are on the host seat; the seat axis
 * (who holds the account) is the two-principal arm, not run here.
 *
 * Today: a relaunch with a new bearer string reads as a departure (src/session.mjs `departures`
 * compares bearer strings), nothing in the room says a swap happened, `to: coding` reaches the
 * role-first bearer, and the cycle matches `/<slug>` suffixes or a label, so `coding/Sonnet` with
 * no label is not found.
 */

import { DEPART_GRACE_MINUTES } from "../../src/session.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, behaviours, openClient } from "./lib/participants.mjs";
import { bodyOf, readRoom } from "./lib/room.mjs";

const ARMS = /** @type {const} */ (["in-place", "relaunch"]);
const OLD = "coding/Argon";
const NEW = "coding/Sonnet";

/** @type {Record<string, { bar: string, redLeg: string }>} */
const checks = {};
for (const arm of ARMS) {
  checks[`${arm}:departure-lines`] = {
    bar: "0 departure lines after the swap",
    redLeg: arm === "in-place" ? "the swap is a relaunch instead: the old harness stops and a new session registers the new bearer"
      : "the relaunch keeps the old bearer (a plain restart, no model change)",
  };
  checks[`${arm}:swap-line`] = {
    bar: "exactly one line in the room names the old and the new bearer as a swap (a departure line does not count)",
    redLeg: "the swapped agent posts its own swap line naming both bearers",
  };
  checks[`${arm}:to-role-reaches-new-bearer`] = {
    bar: "the next `to: coding` is delivered to the new bearer's `watch --wake mine`",
    redLeg: "the new bearer is registered model-first (Sonnet/coding)",
  };
  checks[`${arm}:cycle-match`] = {
    bar: "`resident cycle coding` finds the swapped session",
    redLeg: "the swap registers with `--label coding`",
  };
}

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S07",
  name: "model-swap",
  checks,
  async run(ctx) {
    for (const arm of ARMS) {
      if (ctx.only && !ctx.only.startsWith(`${arm}:`)) continue;
      await runArm(ctx, arm);
    }
  },
};

/** @param {import("./lib/scenarios.mjs").ScenarioContext} ctx @param {typeof ARMS[number]} arm */
async function runArm(ctx, arm) {
  const red = (/** @type {string} */ name) => ctx.red(`${arm}:${name}`);
  const seat = await openSeat();
  /** @type {any} */
  let client;
  try {
    client = await openClient(seat);
    const ada = new Human(client, seat.alias, "Ada");
    const orchestrator = await Agent.start(seat, { session: "s07-orch", bearer: "orchestrator/Opus", harness: "omp" });
    const coding = await Agent.start(seat, { session: "s07-coding-1", bearer: OLD, harness: "omp" });
    const question = await ada.post("Please fix the parser fixture.", { to: ["coding"] });
    await ada.title(question.id, "Parser fixture");
    await orchestrator.watchOnce({ fromStart: true });
    await coding.watchOnce({ fromStart: true, wake: "mine" });
    await coding.post("Taking it.", { thread: question.id, claim: "parser-fixture" });

    const relaunch = arm === "relaunch" || red("departure-lines");
    let bearer = red("to-role-reaches-new-bearer") ? "Sonnet/coding" : NEW;
    if (arm === "relaunch" && red("departure-lines")) bearer = OLD;
    const label = red("cycle-match") ? { label: "coding" } : {};
    const swapped = relaunch
      ? await behaviours.modelSwapRelaunch(coding, { session: "s07-coding-2", bearer, graceMinutes: DEPART_GRACE_MINUTES, ...label })
      : (await behaviours.modelSwapInPlace(coding, bearer, label), coding);
    ctx.log(`${arm}: ${OLD} -> ${bearer} (${relaunch ? "relaunch" : "in place"})`);
    if (red("swap-line")) await swapped.post(`Model swap: ${OLD} is now ${bearer}; the claim and this thread carry on.`, { thread: question.id });

    // the room learns of the seat's sessions where the tool announces them: a watch's sweep
    await orchestrator.watchOnce();
    const again = await ada.post("Any progress on the fixture?", { to: ["coding"], thread: question.id });
    const delivered = await swapped.watchOnce({ wake: "mine" });
    const cycle = await seat.cli(["resident", "cycle", "coding", "--dry-run", "--json"]);
    const row = JSON.parse(cycle.stdout.trim().split(/\r?\n/).pop() || "{}");
    const room = await readRoom(seat);

    const departures = room.messages.filter((m) => room.isDeparture(m));
    const swapLines = room.messages.filter((m) => !room.isDeparture(m) && bodyOf(m).includes(OLD) && bodyOf(m).includes(bearer) && OLD !== bearer);
    const bounds = { DEPART_GRACE_MINUTES };
    ctx.check(`${arm}:departure-lines`, 0, departures.length, { bounds });
    ctx.check(`${arm}:swap-line`, 1, swapLines.length);
    ctx.check(`${arm}:to-role-reaches-new-bearer`, true, delivered.messages.some((m) => m.id === again.id), { note: `new bearer ${bearer}` });
    ctx.check(`${arm}:cycle-match`, true, row.session === swapped.slug, { note: String(row.reason ?? row.action ?? "") });
  } finally {
    client?.close();
    await seat.close();
  }
}
