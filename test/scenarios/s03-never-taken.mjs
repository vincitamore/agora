// @ts-check
/**
 * S03 · never-taken. A human addresses a question to a position on this seat and nobody takes it;
 * a second question to the same position is answered in its thread (the control). A third line to
 * the position is itself a reply inside a titled subject, and the position later posts in that
 * subject without citing it (the in-subject control: native threads are one level, so a reply's
 * own thread can never be answered into). The messenger ticks at fixed instants around its bounds
 * (`--at`, so the clock runs at its configured value): just before R, inside [R, R+I] twice, just
 * after R2, and once more after it.
 *
 * Bars: exactly one N2 to the addressee, posted by a tick inside [R, R+I]; exactly one N3 naming
 * the host human, at or after R2; the answered control and the in-subject control draw nothing.
 * Counted from the room.
 */

import { DEFAULT_BOUNDS } from "../../src/messenger.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";
import { HOST_HUMAN, messengerRig, postedTs } from "./lib/messenger-rig.mjs";

const { R, R2, I } = DEFAULT_BOUNDS;

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S03",
  name: "never-taken",
  checks: {
    "one-n2-in-window": {
      bar: "one N2 to the addressee for the untaken question, posted by a tick in [R, R+I]",
      redLeg: "the ticks inside the window are skipped; the first tick after R is at R+3I (a messenger that was down)",
    },
    "one-n3-at-r2": {
      bar: "one N3 for the untaken question, to the host human, from a tick at or after R2",
      redLeg: "a second question to the same position is never taken either (the counted population moves)",
    },
    "taken-control-quiet": {
      bar: "0 notices for the question its addressee answered in its thread",
      redLeg: "the control is answered by another position, not its addressee",
    },
    "in-subject-taken-quiet": {
      bar: "0 notices for a line posted as a reply in a subject when its addressee later posts in that subject",
      redLeg: "the later post in the subject is another position's, not the addressee's",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, HOST_HUMAN);
      const coding = await Agent.start(seat, { session: "s03-coding", bearer: "coding/Opus", label: "desk.coding", harness: "omp" });
      const review = await Agent.start(seat, { session: "s03-review", bearer: "review/Argon", label: "desk.review", harness: "omp" });
      const rig = await messengerRig(seat);
      const q = await ada.post("The parser test fails on the new fixture. Can you look?", { to: ["coding"] });
      await ada.title(q.id, "Parser test failure");
      const control = await ada.post("Is the lint config current?", { to: ["coding"] });
      await (ctx.red("taken-control-quiet") ? review : coding).post("Checked: it is current.", { thread: control.id });
      const release = await ada.post("Release checklist for this week.", { to: ["*"] });
      await ada.title(release.id, "Release checklist");
      const inner = await ada.post("Can you cut the build for it?", { to: ["coding"], thread: release.id });
      await (ctx.red("in-subject-taken-quiet") ? review : coding).post("Build cut.", { thread: release.id });
      const extra = ctx.red("one-n3-at-r2") ? await ada.post("And the docs build, can you check it?", { to: ["coding"] }) : undefined;
      const t0 = await postedTs(seat, q.id);
      const offsets = ctx.red("one-n2-in-window") ? [R - 1000, R + 3 * I, R2 + 1000, R2 + I] : [R - 1000, R + I / 2, R + I, R2 + 1000, R2 + I];
      for (const o of offsets) await rig.tickAt(t0 + o);

      const notices = await rig.notices();
      const forQ = notices.filter((n) => n.fields.id === q.id || n.re === q.id);
      const n2 = forQ.filter((n) => n.kind === "N2");
      ctx.check("one-n2-in-window", { count: 1, inWindow: true, to: "coding", inThread: true },
        { count: n2.length, inWindow: n2.every((n) => n.at !== null && n.at - t0 >= R && n.at - t0 <= R + I), to: n2[0]?.to[0] ?? null, inThread: n2.every((n) => n.thread === q.id) },
        { bounds: { R, I } });
      const n3 = notices.filter((n) => n.kind === "N3" && n.fields.verb === "taken");
      /** @type {Map<string, number>} */
      const ts = new Map([[q.id, t0]]);
      if (extra) ts.set(extra.id, await postedTs(seat, extra.id));
      ctx.check("one-n3-at-r2", { count: 1, atR2: true, to: HOST_HUMAN, position: "desk.coding" },
        { count: n3.length, atR2: n3.every((n) => n.at !== null && n.at - (ts.get(n.fields.id) ?? Infinity) >= R2), to: n3[0]?.to[0] ?? null, position: n3[0]?.fields.position ?? null },
        { bounds: { R2 }, ...(extra ? { note: "two untaken questions" } : {}) });
      const forControl = notices.filter((n) => n.fields.id === control.id || n.re === control.id);
      ctx.check("taken-control-quiet", 0, forControl.length);
      const forInner = notices.filter((n) => n.fields.id === inner.id || n.re === inner.id);
      ctx.check("in-subject-taken-quiet", 0, forInner.length);
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
