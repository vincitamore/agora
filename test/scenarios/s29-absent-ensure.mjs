// @ts-check
/**
 * S29 · absent → ensure. The room's messenger row (harness `agora`) runs under the host. Its stream
 * dies (the host's handle is gone, its run record left). The supervisor (`ensure`, the first act of
 * `resident cycle --all`) restarts it and posts one N8 line in the Room subject; a second pass posts
 * nothing. Then the operator stops it by hand (`resident stop`): the run record goes, and the next
 * pass leaves it stopped.
 *
 * Bars: a death is restarted, with one N8 line (absent by host, path restart); a stop by the
 * operator's hand is left alone.
 */

import { openSeat } from "./lib/seat.mjs";
import { openClient } from "./lib/participants.mjs";
import { grantRig } from "./lib/grant-rig.mjs";
import { MESSENGER_SESSION } from "./lib/messenger-rig.mjs";

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S29",
  name: "absent-ensure",
  checks: {
    "restarted-after-death": {
      bar: "the messenger row whose host died is restarted by the next pass and holds its position again",
      redLeg: "the operator stopped it by hand instead (its run record removed), so there is nothing for the supervisor to repair",
    },
    "one-n8-for-restart": {
      bar: "exactly one N8 line for the restart (absent by host, path restart, outcome started), in the Room subject, after two passes",
      redLeg: "the stream dies again between the passes, so the second pass restarts it and posts a second line",
    },
    "operator-stop-left": {
      bar: "after a stop by the operator's hand the next pass leaves the row stopped",
      redLeg: "the stream dies instead of being stopped (its run record left), so the pass restarts it",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const rig = await grantRig(seat, client, null);
      const started = await rig.startRow(MESSENGER_SESSION);
      if (started.action !== "started") throw new Error(`the messenger row did not start: ${JSON.stringify(started)}`);

      if (ctx.red("restarted-after-death")) await rig.stopByHand(MESSENGER_SESSION);
      else await rig.die(MESSENGER_SESSION);
      const pass = await rig.ensure();
      const row = pass.find((r) => r.position === MESSENGER_SESSION);
      ctx.check("restarted-after-death", { action: "restarted", running: true }, { action: row?.action ?? null, running: await rig.running(MESSENGER_SESSION) });

      if (ctx.red("one-n8-for-restart")) await rig.die(MESSENGER_SESSION);
      await rig.ensure();
      const lines = (await rig.n8()).filter((n) => n.position === MESSENGER_SESSION);
      ctx.check("one-n8-for-restart", [{ verdict: "absent", attestor: "host", path: "restart", outcome: "started", inRoomSubject: true }],
        lines.map((n) => ({ verdict: n.verdict, attestor: n.attestor, path: n.path, outcome: n.outcome, inRoomSubject: n.inRoomSubject })));

      if (ctx.red("operator-stop-left")) await rig.die(MESSENGER_SESSION);
      else await rig.stopByHand(MESSENGER_SESSION);
      await rig.ensure();
      ctx.check("operator-stop-left", false, await rig.running(MESSENGER_SESSION));
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
