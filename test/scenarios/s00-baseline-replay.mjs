// @ts-check
/**
 * S00 · baseline replay. A message fixture is replayed, in order, through scripted participants on
 * a real seat: each agent session posts through the CLI under the bearer it holds at that line
 * (renames included), each person through `agora/client`. Then, for every bearer any session
 * held, one reader session registered as that bearer runs `watch --once` from the start under
 * each wake mode (all, addressed, mine), and the room is read back. Per message: who woke under
 * each mode (a session present at that line, other than the author, holding the bearer whose reader
 * was handed the message), which addresses matched nobody, which replies cite a message from top
 * level, which top-level messages have no title, which human lines two agents answered.
 *
 * The in-repo fixture (fixtures/baseline-synthetic.jsonl) is synthetic and neutral; it reproduces the
 * classes on purpose and its recording pins today's counts. A private export is replayed with
 * `--fixture <path> --from read-json` (or AGORA_SCENARIO_FIXTURE): measured, never recorded, and
 * printed as counts only. A failure that reproduces here, with scripts, belongs to the tool; one that
 * appears only with models belongs to the agents.
 */

import path from "node:path";
import { SCENARIOS_DIR } from "./lib/observe.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";
import { readRoom } from "./lib/room.mjs";
import { answeredTwice, classifyAddress, fromReadJson, loadFixture, timeline, toBearer, variations } from "./lib/fixture.mjs";

const FIXTURE = "fixtures/baseline-synthetic.jsonl";
const MODES = /** @type {const} */ (["all", "addressed", "mine"]);
/** Readers registered at once; each is a handful of CLI calls. */
const READER_CONCURRENCY = 4;

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S00",
  name: "baseline replay",
  fixtureName: FIXTURE,
  ownsRun: (args) => !args.fixture,
  checks: {
    "unmatched-addresses": { bar: "0 addresses that name nobody present (no retired bearer, no half-name, no unknown)", redLeg: "every unmatched address is dropped from its post" },
    "toplevel-re-replies": { bar: "0 top-level messages that cite another with re:", redLeg: "every reply that cites a message is posted in that message's thread" },
    "untitled-roots": { bar: "0 top-level messages without a title", redLeg: "every top-level message is titled by its author" },
    "human-pings-answered-twice": { bar: "0 human messages answered by two or more agents", redLeg: "only the first agent to answer each human message posts its answer" },
    "wake-table": { bar: "who woke, per message and wake mode, equals the recorded baseline", redLeg: "one more message, to everyone, at the end of the fixture" },
  },
  async run(ctx) {
    /** @type {import("./lib/fixture.mjs").FixtureLine[]} */
    let lines;
    const own = !ctx.args.fixture;
    if (!ctx.args.fixture) lines = await loadFixture(path.join(SCENARIOS_DIR, FIXTURE));
    else if (ctx.args.from === "read-json") {
      const converted = await fromReadJson(ctx.args.fixture);
      lines = converted.lines;
      ctx.log(`converted: ${JSON.stringify(converted.notes)}`);
    } else if (ctx.args.from === undefined) lines = await loadFixture(ctx.args.fixture);
    else throw new Error(`--from takes read-json, or nothing for the scenario format; got ${ctx.args.from}`);

    if (ctx.red("unmatched-addresses")) lines = variations.dropUnmatched(lines);
    if (ctx.red("toplevel-re-replies")) lines = variations.threadReReplies(lines);
    if (ctx.red("untitled-roots")) lines = variations.titleRoots(lines);
    if (ctx.red("human-pings-answered-twice")) lines = variations.firstAnswerOnly(lines);
    if (ctx.red("wake-table")) lines = variations.oneMore(lines);

    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const replay = await replayLines(seat, client, lines);
      ctx.log(`replayed ${replay.order.length} messages through ${replay.sessions} sessions and ${replay.humans} people; ${replay.dangling} references named a message the replay does not hold`);
      const room = await readRoom(seat);
      if (room.messages.length !== replay.order.length) throw new Error(`the room holds ${room.messages.length} messages, the replay posted ${replay.order.length}`);
      const t = timeline(lines);
      const bearers = t.bearers.map(toBearer);
      const handed = await readersHanded(seat, [...new Set(bearers)], room.messages.length);

      // per message, from the room as read back, aligned with the script by position
      /** @type {Record<string, { wakes: number, silent: number, crowdedHumanLines: number }>} */
      const modes = {};
      for (const mode of MODES) modes[mode] = { wakes: 0, silent: 0, crowdedHumanLines: 0 };
      let addressedUnheard = 0;
      const unmatched = { count: 0, retired: 0, halfName: 0, unknown: 0 };
      /** @type {Array<Record<string, unknown>>} */
      const rows = [];
      room.messages.forEach((m, k) => {
        const at = t.messages[k];
        const present = new Map([...at.holding].map(([s, b]) => [s, toBearer(b)]));
        const author = at.session;
        /** @type {Record<string, string[]>} */
        const woke = {};
        for (const mode of MODES) {
          woke[mode] = [...present].filter(([s, b]) => s !== author && handed.get(b)?.[mode].has(m.id)).map(([, b]) => b).sort();
          modes[mode].wakes += woke[mode].length;
          if (!woke[mode].length) modes[mode].silent++;
          if (m.author.kind === "human" && woke[mode].length >= 2) modes[mode].crowdedHumanLines++;
        }
        const to = m.to ?? [];
        const held = new Set([...at.held].map(toBearer));
        const classes = to.map((a) => classifyAddress(a, present.values(), held, t.humans));
        for (const c of classes) if (c !== "matched") { unmatched.count++; unmatched[c]++; }
        if (to.length && !woke.mine.length && !to.some((a) => [...t.humans].some((h) => h.toLowerCase() === a.trim().toLowerCase()))) addressedUnheard++;
        rows.push({ n: k + 1, author: m.signedAs ?? m.author.name, ...(to.length ? { to } : {}), ...(m.thread ? { inThread: true } : {}), woke });
      });
      const renames = [...new Set(lines.flatMap((l) => (l.event === "register" ? [l.session] : l.kind === "agent" ? [l.session ?? l.author] : [])))]
        .filter((s) => new Set(lines.filter((l) => (l.event === "register" ? l.session : l.kind === "agent" ? (l.session ?? l.author) : null) === s).map((l) => l.author)).size > 1).length;

      ctx.check("unmatched-addresses", { count: 0, retired: 0, halfName: 0, unknown: 0 }, unmatched,
        { note: "classified with the tool's matchesAddress against the bearers the script's sessions held at each line" });
      ctx.check("toplevel-re-replies", 0, room.topLevel().filter((m) => room.re(m) !== undefined).length);
      ctx.check("untitled-roots", 0, room.topLevel().filter((m) => !room.titles.has(m.id)).length, { note: `${room.topLevel().length} top-level messages` });
      const answered = answeredTwice(room.messages.map((m) => {
        const re = room.re(m);
        return { id: m.id, kind: m.author.kind === "human" ? "human" : "agent", author: m.signedAs ?? m.author.name, ...(m.thread ? { thread: m.thread } : {}), ...(re ? { re } : {}) };
      }));
      ctx.check("human-pings-answered-twice", 0, answered.count);
      const table = {
        messages: room.messages.length,
        humanLines: room.messages.filter((m) => m.author.kind === "human").length,
        humanLinesInThreads: room.messages.filter((m) => m.author.kind === "human" && m.thread).length,
        renames,
        modes,
        addressedUnheard,
        ...(own || ctx.args.detail ? { rows } : {}),
      };
      ctx.check("wake-table", ctx.baseline("wake-table", table), table);
    } finally {
      client?.close();
      await seat.close();
    }
  },
};

/**
 * Post every line, in order. Labels resolve to the ids the room returned; a label the replay does
 * not hold (a dropped or never-exported message) is left off the post and counted.
 * @param {import("./lib/seat.mjs").Seat} seat @param {any} client @param {import("./lib/fixture.mjs").FixtureLine[]} lines
 */
async function replayLines(seat, client, lines) {
  /** @type {Map<string, Agent>} */
  const agents = new Map();
  /** @type {Map<string, Human>} */
  const humans = new Map();
  /** @type {Map<string, { id: string, root: string }>} */
  const posted = new Map();
  /** @type {string[]} */
  const order = [];
  let dangling = 0;
  /** @param {string} session @param {string} author */
  const agentFor = async (session, author) => {
    const bearer = toBearer(author);
    let agent = agents.get(session);
    if (!agent) {
      agent = await Agent.start(seat, { session: `s00-a${agents.size + 1}`, bearer });
      agents.set(session, agent);
    } else if (agent.bearer !== bearer) await agent.register(bearer);
    return agent;
  };
  for (const l of lines) {
    if (l.event === "register") { await agentFor(l.session, l.author); continue; }
    const re = l.re === undefined ? undefined : posted.get(l.re)?.id;
    const thread = l.thread === undefined ? undefined : posted.get(l.thread)?.root;
    if (l.re !== undefined && re === undefined) dangling++;
    if (l.thread !== undefined && thread === undefined) dangling++;
    const opts = { ...(l.to ? { to: l.to } : {}), ...(re ? { re } : {}), ...(thread ? { thread } : {}) };
    /** @type {{ id: string }} */
    let receipt;
    if (l.kind === "human") {
      let human = humans.get(l.author);
      if (!human) { human = new Human(client, seat.alias, l.author); humans.set(l.author, human); }
      receipt = await human.post(l.text, opts);
      if (l.title) await human.title(receipt.id, l.title);
    } else {
      const agent = await agentFor(l.session ?? l.author, l.author);
      receipt = await agent.post(l.text, opts);
      if (l.title) await agent.title(receipt.id, l.title);
    }
    if (l.id !== undefined) posted.set(l.id, { id: receipt.id, root: thread ?? receipt.id });
    order.push(receipt.id);
  }
  return { order, dangling, sessions: agents.size, humans: humans.size };
}

/**
 * For each bearer, a reader session registered as it reads the whole room under each wake mode
 * with the real CLI watch, from the start, poll after poll until every message is accounted for.
 * @param {import("./lib/seat.mjs").Seat} seat @param {string[]} bearers @param {number} total
 */
async function readersHanded(seat, bearers, total) {
  /** @type {Map<string, Record<string, Set<string>>>} */
  const out = new Map();
  let k = 0;
  const queue = [...bearers];
  const worker = async () => {
    for (let bearer = queue.shift(); bearer !== undefined; bearer = queue.shift()) {
      const reader = await Agent.start(seat, { session: `s00-r${++k}`, bearer });
      /** @type {Record<string, Set<string>>} */
      const sets = {};
      for (const mode of MODES) {
        const ids = new Set();
        let seen = 0;
        for (let i = 0; i < 20 && seen < total; i++) {
          const w = await reader.watchOnce({ wake: mode, fromStart: i === 0 });
          for (const m of w.messages) ids.add(m.id);
          const step = Number(w.result.delivered) + Number(w.result.skipped) + Number(w.result.filtered);
          if (!step) break;
          seen += step;
        }
        if (seen < total) throw new Error(`the ${bearer} reader accounted for ${seen} of ${total} messages under --wake ${mode}`);
        sets[mode] = ids;
      }
      out.set(bearer, sets);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READER_CONCURRENCY, bearers.length) }, worker));
  return out;
}
