// @ts-check
/**
 * S62 · revoke. The orchestrator's grant stood a second coding position up (`main.coding-2`). The
 * operator removes the grant from the manifest while the position is in a turn. The supervisor
 * (`ensure`) holds it while the turn runs, stops it once its turn has ended past the grace, and posts
 * one N8 line for the stop in the Room subject. A want made after the removal is refused.
 *
 * Bars: held while working (never cut mid-turn); stopped at idle with one N8 line naming the
 * revocation; the record keeps want, start, ending, stop and end; no want is admitted without a grant.
 */

import { openSeat } from "./lib/seat.mjs";
import { openClient } from "./lib/participants.mjs";
import { grantRig } from "./lib/grant-rig.mjs";

const GRANT = { roles: "open", models: ["haiku"], maxLive: 1, maxHours: 8 };
const GRACE_SECONDS = 5;

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S62",
  name: "revoke",
  checks: {
    "held-while-working": {
      bar: "with the grant removed and a turn running, the granted position is held, not stopped",
      redLeg: "the position's turn ended a minute ago, so the first pass after the removal stops it at once",
    },
    "stopped-at-idle": {
      bar: "once its turn has ended past the grace, the position is stopped, with one N8 line (revoked by manifest, path grant, outcome stopped) in the Room subject",
      redLeg: "the operator puts the grant back before the pass, so nothing is revoked and the position keeps running",
    },
    "record-kept": {
      bar: "the ledger keeps want, start, ending (revoked), stop, end for the want",
      redLeg: "the orchestrator releases the want (unwant) instead of the operator removing the grant",
    },
    "refused-without-grant": {
      bar: "a want made after the removal is refused: its holder holds no grant",
      redLeg: "the grant is put back before the want, so it is admitted",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const rig = await grantRig(seat, client, GRANT);
      const w = await rig.want("main.coding");
      if (!w.ok) throw new Error(`the want was refused: ${/** @type {any} */ (w).reason}`);
      const position = w.want.position;
      await rig.ensure();
      if (!(await rig.running(position))) throw new Error(`${position} did not start`);

      rig.turns[position] = ctx.red("held-while-working")
        ? { status: "read", at: new Date(Date.now() - 60_000).toISOString(), turnEnded: true }
        : { status: "read", at: new Date().toISOString(), turnEnded: false };
      if (ctx.red("record-kept")) await rig.unwant(position);
      else await rig.setGrant(null);
      const working = await rig.ensure({ graceSeconds: GRACE_SECONDS });
      const row = working.find((r) => r.position === position);
      ctx.check("held-while-working", { action: "held", running: true }, { action: row?.action ?? null, running: await rig.running(position) }, { bounds: { GRACE_SECONDS } });

      rig.turns[position] = { status: "read", at: new Date(Date.now() - (GRACE_SECONDS + 5) * 1000).toISOString(), turnEnded: true };
      if (ctx.red("stopped-at-idle")) await rig.setGrant(GRANT);
      await rig.ensure({ graceSeconds: GRACE_SECONDS });
      const lines = (await rig.n8()).filter((n) => n.position === position && n.path === "grant" && n.outcome !== "started");
      ctx.check("stopped-at-idle", { running: false, lines: [{ verdict: "revoked", attestor: "manifest", outcome: "stopped", inRoomSubject: true }] },
        { running: await rig.running(position), lines: lines.map((n) => ({ verdict: n.verdict, attestor: n.attestor, outcome: n.outcome, inRoomSubject: n.inRoomSubject })) },
        { bounds: { GRACE_SECONDS } });

      const evs = (await rig.ledger()).filter((e) => e.id === w.want.id).map((e) => (e.ev === "ending" ? `ending:${e.why}` : e.ev));
      ctx.check("record-kept", ["want", "start", "ending:revoked", "stop", "end"], evs);

      if (ctx.red("refused-without-grant")) await rig.setGrant(GRANT);
      const after = await rig.want("main.coding");
      ctx.check("refused-without-grant", "no grant", after.ok ? "admitted" : /holds no grant/.test(/** @type {any} */ (after).reason) ? "no grant" : /** @type {any} */ (after).reason);
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
