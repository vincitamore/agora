// @ts-check
/**
 * S14 · subjects. A pinned Room subject and a titled question; four scripted agents answer the
 * question with `--re` only, `--thread` only, both, and neither; a session on the seat goes dark so
 * the tool posts its own room-business line (the departure). Counted from the room as `read --json`
 * returns it, and from each post's own stderr.
 *
 * Today: a `--re` reply on a native room lands top level (bin/agora.mjs: `--re` is a trailer, never a
 * thread there), nothing warns about it, a reply with neither flag is a new untitled root, and the
 * departure line lands wherever the sweeping watch was armed (top level for a room watch).
 */

import { DEPART_GRACE_MINUTES } from "../../src/session.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, ageSessionRecord, behaviours, openClient } from "./lib/participants.mjs";
import { readRoom } from "./lib/room.mjs";

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S14",
  name: "subjects",
  checks: {
    "re-replies-in-thread": {
      bar: "every reply posted with --re lands in the cited message's thread",
      redLeg: "the --re-only participant also passes --thread with the cited root (the fix, done by hand)",
    },
    "thread-replies-in-thread": {
      bar: "every reply posted with --thread lands in that thread (the control)",
      redLeg: "the --thread-only participant names the Room subject instead of the question (a wrong thread)",
    },
    "toplevel-re-warned": {
      bar: "every top-level post carrying re: draws a WARNING on the poster's stderr",
      redLeg: "a second participant also replies top level with re: (the counted population moves)",
    },
    "untitled-roots": {
      bar: "0 top-level messages without a title",
      redLeg: "the agents title their own top-level posts",
    },
    "room-business-in-room-subject": {
      bar: "every line the tool posts as room business (the departure line) lands in the Room subject's thread",
      redLeg: "the departing session and the sweeping watch are both armed on the Room subject's thread",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, "Ada");
      const room = await ada.post("Room subject: this room's own business (arrivals, departures, swaps).");
      await ada.title(room.id, "Room");
      await ada.pin(room.id);
      const question = await ada.post("The parser test fails on the new fixture. Can someone look?", { to: ["coding"] });
      await ada.title(question.id, "Parser test failure");

      const coding = await Agent.start(seat, { session: "s14-coding", bearer: "coding/Opus" });
      const review = await Agent.start(seat, { session: "s14-review", bearer: "review/Sonnet" });
      const docs = await Agent.start(seat, { session: "s14-docs", bearer: "docs/Haiku" });
      const messenger = await Agent.start(seat, { session: "s14-messenger", bearer: "messenger/Haiku" });
      const watcher = await Agent.start(seat, { session: "s14-watch", bearer: "watch/Haiku", harness: "omp" });
      const roomThread = ctx.red("room-business-in-room-subject") ? room.id : undefined;
      // the departing session holds a position in the room (or, in the red leg, in the Room thread)
      await watcher.watchOnce({ fromStart: true, ...(roomThread ? { thread: roomThread } : {}) });

      /** @type {Array<{ id: string, by: string, flags: { re: boolean, thread: boolean }, warnings: string[] }>} */
      const posts = [];
      const reOnly = ctx.red("re-replies-in-thread")
        ? await coding.post("The fixture predates the grammar change; regenerating it.", { re: question.id, thread: question.id })
        : await behaviours.replyTopLevelWithRe(coding, question.id, "The fixture predates the grammar change; regenerating it.");
      posts.push({ id: reOnly.id, by: coding.bearer, flags: { re: true, thread: ctx.red("re-replies-in-thread") }, warnings: reOnly.warnings });
      const threadTarget = ctx.red("thread-replies-in-thread") ? room.id : question.id;
      const threadOnly = await review.post("Reviewed the regeneration plan; fine by me.", { thread: threadTarget });
      posts.push({ id: threadOnly.id, by: review.bearer, flags: { re: false, thread: true }, warnings: threadOnly.warnings });
      const both = await docs.post("Noting the fixture rule in the testing guide.", { re: question.id, thread: question.id });
      posts.push({ id: both.id, by: docs.bearer, flags: { re: true, thread: true }, warnings: both.warnings });
      const neither = await messenger.post("Noted: parser fixture being regenerated.");
      posts.push({ id: neither.id, by: messenger.bearer, flags: { re: false, thread: false }, warnings: neither.warnings });
      if (ctx.red("toplevel-re-warned")) {
        const second = await behaviours.replyTopLevelWithRe(messenger, question.id, "Routing done.");
        posts.push({ id: second.id, by: messenger.bearer, flags: { re: true, thread: false }, warnings: second.warnings });
      }
      if (ctx.red("untitled-roots")) {
        await coding.title(reOnly.id, "Fixture regeneration");
        await messenger.title(neither.id, "Routing note");
      }

      // the departure: the watcher's harness stops and its record ages past the grace; the
      // messenger's watch sweeps the seat and posts the tool's own line
      await watcher.stopHarness();
      await ageSessionRecord(seat, watcher.slug, DEPART_GRACE_MINUTES + 1);
      await messenger.watchOnce({ fromStart: true, ...(roomThread ? { thread: roomThread } : {}) });

      const r = await readRoom(seat);
      const byId = r.byId;
      const reReplies = posts.filter((p) => p.flags.re);
      const landedIn = (/** @type {string} */ id, /** @type {string} */ root) => byId.get(id)?.thread === root;
      ctx.check("re-replies-in-thread", { inThread: reReplies.length, of: reReplies.length },
        { inThread: reReplies.filter((p) => landedIn(p.id, question.id)).length, of: reReplies.length });
      const threadReplies = posts.filter((p) => p.flags.thread);
      ctx.check("thread-replies-in-thread", { inThread: threadReplies.length, of: threadReplies.length },
        { inThread: threadReplies.filter((p) => landedIn(p.id, question.id)).length, of: threadReplies.length });
      const topRe = r.topLevel().filter((m) => r.re(m) !== undefined);
      const warned = topRe.filter((m) => (posts.find((p) => p.id === m.id)?.warnings ?? []).length > 0);
      ctx.check("toplevel-re-warned", { warned: topRe.length, of: topRe.length }, { warned: warned.length, of: topRe.length });
      const untitled = r.topLevel().filter((m) => !r.titles.has(m.id));
      ctx.check("untitled-roots", 0, untitled.length, { note: `${r.topLevel().length} top-level messages` });
      // at least one: a run whose departure never fired has not exercised the bar
      const business = r.messages.filter((m) => r.isDeparture(m));
      ctx.check("room-business-in-room-subject", { inRoomSubject: Math.max(1, business.length), of: Math.max(1, business.length) },
        { inRoomSubject: business.filter((m) => m.thread === room.id).length, of: business.length },
        { bounds: { DEPART_GRACE_MINUTES } });
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
