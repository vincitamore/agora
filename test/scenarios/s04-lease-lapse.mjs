// @ts-check
/**
 * S04 · lease-lapse. A position on this seat claims a subject with a short lease and then goes
 * quiet; a second claim by the same position is answered with its release (the control). The
 * release trailer frees the board claim at once (`agora board --json` read right after it shows the
 * subject free, not held). The board read after the leases run out shows the first lease lapsed,
 * attributed to the bearer whose post carried the claim; the messenger ticks just before expiry + I,
 * just after it, and once more.
 *
 * Bars: the board names the lapse and its holder; the release frees its claim on the board; exactly
 * one N4 to the holder from a tick within I of the grace; the released control draws none. The renew
 * control of the compass's bar has no CLI verb yet (the CLI never renews a lease), so it is not
 * exercised here.
 */

import { DEFAULT_BOUNDS } from "../../src/messenger.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent } from "./lib/participants.mjs";
import { messengerRig } from "./lib/messenger-rig.mjs";

const { I } = DEFAULT_BOUNDS;
const LEASE_SECONDS = 2;

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S04",
  name: "lease-lapse",
  checks: {
    "board-shows-lapse": {
      bar: "agora board lists the untouched claim as lapsed, held by the bearer whose post carried it",
      redLeg: "the claim is taken with a ten-minute lease, so it is still held when the board is read",
    },
    "one-n4-within-i": {
      bar: "one N4 to the holder for the lapsed lease, from a tick in [expiry + I, expiry + 2I]",
      redLeg: "the ticks inside the window are skipped; the first tick after the grace is at expiry + 4I",
    },
    "release-control-quiet": {
      bar: "0 notices for the claim its holder released by trailer",
      redLeg: "the release names another subject",
    },
    "release-frees-board": {
      bar: "a post carrying `release: fixture` from the claim's holder leaves work:fixture free on the board at once",
      redLeg: "the release names another subject, so work:fixture is still held right after the post",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    try {
      const coding = await Agent.start(seat, { session: "s04-coding", bearer: "coding/Opus", label: "desk.coding", harness: "omp" });
      const rig = await messengerRig(seat);
      const long = ctx.red("board-shows-lapse");
      await coding.ok(["post", seat.alias, "Taking the parser fix.", "--claim", "parser", "--lease", String(long ? 600 : LEASE_SECONDS), "--json"]);
      await coding.ok(["post", seat.alias, "Taking the fixture refresh.", "--claim", "fixture", "--lease", String(LEASE_SECONDS), "--json"]);
      const otherSubject = ctx.red("release-control-quiet") || ctx.red("release-frees-board");
      await coding.ok(["post", seat.alias, "Fixture refreshed.", "--release", otherSubject ? "fixtures" : "fixture", "--json"]);
      const afterRelease = await seat.cli(["board", seat.alias, "--json"]);
      if (afterRelease.code !== 0) throw new Error(`board exited ${afterRelease.code}: ${afterRelease.stderr}`);
      const fixture = afterRelease.stdout.split(/\r?\n/).filter((l) => l.includes('"board-subject"')).map((l) => JSON.parse(l)).find((s) => s.subject === "work:fixture");
      ctx.check("release-frees-board", "free", fixture?.holder ? "held" : fixture?.lapsed ? "lapsed" : fixture ? "free" : "absent");
      // the leases run on the host's own clock: wait them out once, then read the board
      await new Promise((r) => setTimeout(r, LEASE_SECONDS * 1000 + 500));
      const board = await seat.cli(["board", seat.alias, "--json"]);
      if (board.code !== 0) throw new Error(`board exited ${board.code}: ${board.stderr}`);
      const subjects = board.stdout.split(/\r?\n/).filter((l) => l.includes('"board-subject"')).map((l) => JSON.parse(l));
      const parser = subjects.find((s) => s.subject === "work:parser");
      ctx.check("board-shows-lapse", { state: "lapsed", by: "coding/Opus" },
        { state: parser?.holder ? "held" : parser?.lapsed ? "lapsed" : "absent", by: parser?.claimedBy?.bearer ?? null });
      const expiry = Date.parse((parser?.lapsed ?? parser?.holder)?.expiresAt ?? "");
      const offsets = ctx.red("one-n4-within-i") ? [I - 1000, 4 * I] : [I - 1000, I + 1000, I + 30_000, 2 * I];
      for (const o of offsets) await rig.tickAt(expiry + o);
      const notices = await rig.notices();
      const n4 = notices.filter((n) => n.kind === "N4" && n.fields.subject === "work:parser");
      ctx.check("one-n4-within-i", { count: 1, inWindow: true, to: "coding/Opus" },
        { count: n4.length, inWindow: n4.every((n) => n.at !== null && n.at - expiry >= I && n.at - expiry <= 2 * I), to: n4[0]?.to[0] ?? null }, { bounds: { I } });
      ctx.check("release-control-quiet", 0, notices.filter((n) => n.fields.subject === "work:fixture" || n.fields.id === "work:fixture").length);
    } finally {
      await seat.close();
    }
  },
};
