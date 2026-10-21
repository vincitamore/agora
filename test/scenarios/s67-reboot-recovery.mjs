// @ts-check
/**
 * S67 · reboot recovery. The room's standing rows (the messenger, the orchestrator, coding) run
 * under the host. The seat reboots: every host session is dead, every run record is left. The
 * supervisor (`ensure`, the first act of `resident cycle --all`) is what is alive after a reboot:
 *
 *   1. while the seat service is still dark, two passes start nothing and say so once;
 *   2. once the service answers, one pass starts every standing position once, each with one N8
 *      line in the Room subject;
 *   3. a position that dies after every start is started three times within the hour, then held:
 *      its host human is told once, by an N8 line addressed to them, and starts stop.
 *
 * Bars: recovery needs no hand after a reboot; it never starts into a dark service; a crash loop is
 * bounded and reaches a person.
 */
import { rename } from "node:fs/promises";
import path from "node:path";
import { openSeat } from "./lib/seat.mjs";
import { openClient } from "./lib/participants.mjs";
import { grantRig, HOLDER } from "./lib/grant-rig.mjs";
import { HOST_HUMAN, MESSENGER_SESSION } from "./lib/messenger-rig.mjs";
import { readRoom } from "./lib/room.mjs";

const STANDING = [MESSENGER_SESSION, HOLDER, "main.coding"];

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S67",
  name: "reboot-recovery",
  checks: {
    "dark-service-starts-nothing": {
      bar: "with the seat service dark after the reboot, two passes start nothing and report the darkness once",
      redLeg: "the service is left up through the reboot, so the first pass starts the rows",
    },
    "reboot-restarts-every-standing": {
      bar: "once the service answers, one pass starts every standing position once, each with one N8 line (absent by host, path restart, outcome started) in the Room subject",
      redLeg: "the orchestrator row is on-demand, so the supervisor leaves it to a grant",
    },
    "restart-limit-holds": {
      bar: "a position that dies after every start is started 3 times within the hour, then its host human is told once and starts stop",
      redLeg: "the limit is raised to 10 starts, so the fourth death is started too and nobody is told",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const rig = await grantRig(seat, client, null, ctx.red("reboot-restarts-every-standing") ? { [HOLDER]: { tenure: "on-demand" } } : {});
      for (const p of STANDING) {
        const started = await rig.startRow(p);
        if (started.action !== "started") throw new Error(`${p} did not start: ${JSON.stringify(started)}`);
      }
      const pass = (/** @type {Record<string, unknown>} */ opts = {}) => rig.ensure({ staggerSeconds: 1, ...opts });
      // the reboot: every host session is dead, every run record is left
      for (const p of STANDING) await rig.die(p);

      // 1. the seat service is not back yet when the timer first runs: no descriptor names it (the
      //    service itself keeps running, so the seat stops it by its own pid at the end)
      const darkLeg = !ctx.red("dark-service-starts-nothing");
      const descriptor = path.join(seat.state, "native", "service.json");
      if (darkLeg) await rename(descriptor, `${descriptor}.away`);
      let dark;
      try { dark = [...(await pass()), ...(await pass())]; }
      finally { if (darkLeg) await rename(`${descriptor}.away`, descriptor); }
      ctx.check("dark-service-starts-nothing", { started: 0, darkReports: 1 }, {
        started: dark.filter((r) => r.action === "restarted").length,
        darkReports: dark.filter((r) => r.action === "dark").length,
      });
      // 2. the service answers: every standing position is started once
      await pass();
      const restarts = (await rig.n8()).filter((n) => n.path === "restart" && n.outcome === "started");
      ctx.check("reboot-restarts-every-standing", STANDING.map((p) => [p, 1, true]).sort(),
        STANDING.map((p) => [p, restarts.filter((n) => n.position === p).length, restarts.filter((n) => n.position === p).every((n) => n.inRoomSubject)]).sort());

      // 3. a crash loop on the orchestrator: it dies after every start
      const limit = ctx.red("restart-limit-holds") ? { restartLimit: { starts: 10 } } : {};
      if (!(await rig.running(HOLDER))) await rig.startRow(HOLDER);
      for (let i = 0; i < 4; i++) {
        await rig.die(HOLDER);
        await pass(limit);
      }
      const ledger = await rig.ledger();
      const held = (await rig.n8()).filter((n) => n.position === HOLDER && n.outcome === "held");
      const room = await readRoom(seat);
      const toHuman = room.messages.filter((m) => /outcome held\./.test(m.text) && new RegExp(`\\nto: ${HOST_HUMAN}\\n`).test(m.text)).length;
      ctx.check("restart-limit-holds", { starts: 3, told: 1, toHuman: 1, running: false }, {
        starts: ledger.filter((e) => e.ev === "start" && e.position === HOLDER && e.path === "restart").length,
        told: held.length,
        toHuman,
        running: await rig.running(HOLDER),
      });
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
