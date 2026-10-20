// @ts-check
/**
 * S23 · succession. A resident `coding`, registered in the unlabelled shape older arming sequences
 * document (`<Model>/<slug>`: `Opus/coding`, no `--label`), whose Claude Code transcript
 * (fabricated, in the seat's fake home) is cold and large, holds a live armed watch, an open claim,
 * and a last post after its watch stopped. `resident cycle coding` judges it; a successor session
 * runs `resident inherit`, registers the same bearer, and reads the room. Keeping this resident
 * unlabelled pins that an unlabelled resident's succession is unchanged by position keys. A second
 * resident, `review`, is registered role-first (`review/Opus`, the grammar `to: <role>` reaches)
 * with its position as the session label (`--label review`), and the cycle is asked to find it.
 *
 * Every bound runs at its configured value: the cycle's defaults (DEFAULT_IDLE_SECONDS,
 * DEFAULT_MIN_CONTEXT, DEFAULT_MAX_CONTEXT, DEFAULT_DEAF_SECONDS) are not overridden, the transcript
 * is built against them, and the departure grace (DEPART_GRACE_MINUTES) is passed by ageing the
 * predecessor's record rather than by a flag.
 *
 * Today: the mechanics hold (verdict, marker, cursors, ledger, no departure), and the cycle finds
 * the role-first resident by its position (src/resident.mjs `matchesResidentRecord`). Without the
 * label (the red leg) it is not found: an unlabelled record is matched by a `/<slug>` bearer suffix.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DEAF_SECONDS, DEFAULT_IDLE_SECONDS, DEFAULT_MAX_CONTEXT, DEFAULT_MIN_CONTEXT, inheritMarkerPath } from "../../src/resident.mjs";
import { DEPART_GRACE_MINUTES } from "../../src/session.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, ageSessionRecord, openClient } from "./lib/participants.mjs";
import { readRoom } from "./lib/room.mjs";

const PREDECESSOR = "5c0a1b2c-1111-4222-8333-444455550001";
const SUCCESSOR = "5c0a1b2c-1111-4222-8333-444455550002";
const REVIEWER = "5c0a1b2c-1111-4222-8333-444455550003";
const BOUNDS = { DEFAULT_IDLE_SECONDS, DEFAULT_MIN_CONTEXT, DEFAULT_MAX_CONTEXT, DEFAULT_DEAF_SECONDS, DEPART_GRACE_MINUTES };
/** Large: past the minimum, short of the ceiling, so only the cold-and-large rule can cycle it. */
const CONTEXT_CACHE_READ = DEFAULT_MIN_CONTEXT + 50_000;

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S23",
  name: "succession",
  checks: {
    "verdict-cold-and-large": { bar: "the cycle cycles the resident, for the cold-and-large reason", redLeg: "the transcript's last inference is a minute old (warm)" },
    "marker-written-then-consumed": { bar: "the cycle writes the inherit marker and the successor's inherit consumes it", redLeg: "the successor skips `resident inherit`" },
    "cursors-equal": { bar: "the successor's saved cursor equals the predecessor's", redLeg: "the successor runs `cursor --now` after inheriting" },
    "own-posts-echoed": { bar: "0 of the predecessor's own posts are delivered to the successor", redLeg: "the inherited posted ledger is lost (removed after the inherit)" },
    "departure-lines": { bar: "0 departure lines for the succession", redLeg: "the successor registers another bearer (Sonnet/coding)" },
    "name-match-role-first": { bar: "the cycle finds a resident registered role-first (review/Opus) by its position label", redLeg: "the resident registers without its position label (the unlabelled shape)" },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, "Ada");
      const now = Date.now();
      const cold = new Date(now - (DEFAULT_IDLE_SECONDS + 3600) * 1000).toISOString();
      const warm = new Date(now - 60_000).toISOString();
      await writeTranscript(seat.home, PREDECESSOR, ctx.red("verdict-cold-and-large") ? warm : cold);
      await writeTranscript(seat.home, REVIEWER, cold);

      const pred = await Agent.start(seat, { session: PREDECESSOR, bearer: "Opus/coding", harness: "claude" });
      await ada.post("Room open for the week.");
      const stream = pred.armStream({ forSeconds: 120 });
      await until(() => stream.output().stderr.includes("subscribed to"), "the predecessor's watch subscribes");
      const ask = await ada.post("Please regenerate the parser fixture.", { to: ["Opus/coding"] });
      await until(() => stream.output().stdout.includes(ask.id), "the predecessor's watch delivers the request");
      // a watch does not advance past a post of its own that it skipped, so both of the
      // predecessor's posts sit after its saved cursor: the ledger is what keeps them from the successor
      const taking = await pred.post("Taking it.", { thread: ask.id, claim: "parser-fixture" });

      const cycled = await seat.cli(["resident", "cycle", "coding", "--json"]);
      const row = JSON.parse(cycled.stdout.trim().split(/\r?\n/).pop() || "{}");
      const marker = inheritMarkerPath(seat.state, "coding");
      const written = existsSync(marker);
      ctx.check("verdict-cold-and-large", { action: "cycle", reason: "cold" }, { action: row.action, reason: String(row.reason ?? "").split(" ")[0] },
        { bounds: BOUNDS, note: String(row.reason ?? "") });

      // the restart: the watch and the harness stop, after one last post
      await seat.kill(stream.pid);
      const last = await pred.post("Handing over: the fixture is regenerated, the review is pending.", { thread: ask.id });
      const predCursor = await pred.savedCursor();
      await pred.stopHarness();
      await ageSessionRecord(seat, pred.slug, DEPART_GRACE_MINUTES + 1);

      const succ = new Agent(seat, { session: SUCCESSOR, bearer: "Opus/coding", harness: "claude", harnessPid: await seat.spawnHarness() });
      if (!ctx.red("marker-written-then-consumed")) await succ.ok(["resident", "inherit", "coding", "--json"]);
      if (ctx.red("own-posts-echoed")) await rm(path.join(seat.state, "sessions", succ.slug, "posted.jsonl"), { force: true });
      await succ.register(ctx.red("departure-lines") ? "Sonnet/coding" : "Opus/coding");
      if (ctx.red("cursors-equal")) await succ.ok(["cursor", seat.alias, "--now"]);
      ctx.check("marker-written-then-consumed", { written: true, consumed: true }, { written, consumed: written && !existsSync(marker) });
      const succCursor = await succ.savedCursor();
      ctx.check("cursors-equal", true, predCursor !== null && succCursor === predCursor);

      await ada.post("Is the review done?", { to: ["Opus/coding"], thread: ask.id });
      const delivered = await succ.watchOnce();
      const own = new Set([taking.id, last.id]);
      ctx.check("own-posts-echoed", 0, delivered.messages.filter((m) => own.has(m.id)).length);
      const room = await readRoom(seat);
      ctx.check("departure-lines", 0, room.messages.filter((m) => room.isDeparture(m)).length, { bounds: { DEPART_GRACE_MINUTES } });

      const reviewer = await Agent.start(seat, { session: REVIEWER, bearer: "review/Opus", harness: "claude", ...(ctx.red("name-match-role-first") ? {} : { label: "review" }) });
      const found = await seat.cli(["resident", "cycle", "review", "--dry-run", "--json"]);
      const frow = JSON.parse(found.stdout.trim().split(/\r?\n/).pop() || "{}");
      ctx.check("name-match-role-first", true, frow.session === reviewer.slug, { note: String(frow.reason ?? frow.action ?? "") });
    } finally {
      client?.close();
      await seat.close();
    }
  },
};

/**
 * A Claude Code transcript in the seat's fake home: the first user line, then one assistant turn
 * whose usage makes the context, then a hook line the harness appends without an inference.
 * @param {string} home @param {string} uuid @param {string} lastInference
 */
async function writeTranscript(home, uuid, lastInference) {
  const dir = path.join(home, ".claude", "projects", "-work-tree");
  await mkdir(dir, { recursive: true });
  const lines = [
    { type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "You are the resident." } },
    { type: "assistant", timestamp: lastInference, message: { role: "assistant", usage: { input_tokens: 3, cache_read_input_tokens: CONTEXT_CACHE_READ, cache_creation_input_tokens: 500, output_tokens: 5 } } },
    { type: "progress", timestamp: lastInference, data: { hook: "stop" } },
  ];
  await writeFile(path.join(dir, `${uuid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

/**
 * Wait for a condition the real processes bring about, polling; bounded, and named when it fails.
 * @param {() => boolean | Promise<boolean>} condition @param {string} what @param {number} [ms]
 */
async function until(condition, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${ms} ms waiting until ${what}`);
}
