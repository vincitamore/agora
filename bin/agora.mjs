#!/usr/bin/env node
// @ts-check
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  AgoraError,
  EXIT,
  cursorKey,
  fragilePath,
  loadConfig,
  resolvePath,
  redact,
  roomInterval,
  roomNumber,
  roomPollBudget,
  roomThreadInterval,
  sign,
  stateDir,
  writeCursor,
} from "../src/core.mjs";
import { TRANSPORTS, createTransport, tokenSource } from "../src/transports/index.mjs";
import { watch } from "../src/watch.mjs";
import {
  ageHours,
  appendPosted,
  claimDeparture,
  departureLine,
  departures,
  etagCache,
  harnessPid,
  identityLine,
  listArmed,
  listRecords,
  pidAlive,
  readArmed,
  readCursorSeeded,
  readPosted,
  readRecord,
  removeArmed,
  removeSession,
  resolveBearer,
  resolveSession,
  sessionDir,
  touchRecord,
  writeArmed,
  writeRecord,
} from "../src/session.mjs";
import { FOLLOW_CAP, FOLLOW_IDLE_MINUTES, dropFollow, followThreads, readFollow, rootsOf, threadsOf } from "../src/follow.mjs";
import { formatTrailers, matchesAddress, parseTrailers } from "../src/trailers.mjs";
import { queueCodex } from "../src/codex.mjs";
import { clearWatchMode, touchWatchMode, watchModeSentinel } from "../src/harness.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const SCHEMA = {
  name: "agora",
  version,
  description: "One room, many transports: local agents read and post in shared conversations.",
  config: "AGORA_CONFIG, ./agora.json, or ~/.agora/config.json; state under AGORA_STATE or ~/.agora/state, in sessions/<session>/; the session key from AGORA_SESSION, else the first set variable in session.from, else default; the bearer from --as, AGORA_ACTOR, or actor.name",
  exit: { ok: 0, error: 1, usage: 2, fired: 42 },
  global: { "--config <path>": "config file", "--json": "machine-readable output (NDJSON for messages)", "--as <bearer>": "sign this call as this bearer (a path like Grace or Grace/watch)" },
  transports: TRANSPORTS,
  verbs: {
    rooms: { args: [], options: {}, does: "list configured rooms" },
    whoami: { args: ["<room>"], options: {}, does: "the identity this side posts as, per the transport" },
    read: {
      args: ["<room>"],
      options: { "--thread <id>": "a thread inside the room", "--since <cursor>": "only what came after", "--limit <n>": "cap (default transport)" },
      does: "print messages ascending; never touches the saved cursor",
    },
    post: {
      args: ["<room>", "[text]"],
      options: {
        "--thread <id>": "reply in a thread",
        "--file <path>": "text from a file",
        "--stdin": "text from stdin",
        "--no-sign": "omit the signature line",
        "--trailer <key: value>": "one trailer line, repeatable (the primitive under the rest)",
        "--to <addr>": "address a bearer, a seat or *, repeatable",
        "--re <id>": "the message this answers",
        "--claim <subject>": "announce you are working on it, repeatable",
        "--release <subject>": "hand it back, repeatable",
        "--verdict <line>": "a settled result; needs at least one --exhibit",
        "--exhibit <locator>": "what settles it, repeatable",
        "--because <text>": "the reasoning behind it",
      },
      does: "post one message signed as this session's bearer, with any trailers in a block above the signature; prints id and cursor",
    },
    watch: {
      args: ["<room>"],
      options: {
        "--thread <id>": "watch one thread",
        "--follow": "also read the threads this session has posted in, at the slower thread interval",
        "--once": "one poll, then exit",
        "--stream": "keep delivering until --for elapses",
        "--interval <s>": "seconds between room polls (default: the room's interval, else 15)",
        "--thread-interval <s>": "seconds between reads of one followed thread (default: the room's threadInterval, else 60)",
        "--for <s>": "give up after this many seconds (default: never)",
        "--all": "deliver this side's own posts too (skipped by default)",
        "--wake <all|addressed|mine>": "what wakes this watch: everything (default); everything except messages addressed to someone else; only messages addressed to you, your model, the seat, or everyone. Filtered messages still advance the cursor and still show in read",
        "--codex-queue": "queue each delivery into this Codex Desktop task through `codex queue` (requires CODEX_THREAD_ID or CODEX_SESSION_ID)",
      },
      does: "deliver new messages since this session's saved cursor and advance it after delivery, skipping what this session posted; exit 42 when something arrived, 0 when nothing did; always ends with one watch-result line. On each poll, a session on this seat that has gone dark is announced to the room once, by whichever watch notices first",
    },
    cursor: {
      args: ["<room>"],
      options: { "--thread <id>": "", "--reset": "forget (next watch reads from the start)", "--now": "skip to the latest message", "--set <cursor>": "set explicitly" },
      does: "show or move this session's saved cursor",
    },
    who: {
      args: ["<room>"],
      options: { "--limit <n>": "how many recent messages to read back (default 200)", "--thread <id>": "" },
      does: "who has spoken in the room and when, from a bounded read that never touches a cursor, merged with whether each of this seat's sessions is still running; the horizon it read to is printed with it",
    },
    session: {
      args: [],
      options: { "--as <bearer>": "register this session as this bearer (idempotent)", "--label <name>": "a human label for the record", "--list": "every session with state here, with liveness", "--prune": "remove sessions whose process is gone and whose last write is older than session.staleAfterHours", "--dry-run": "with --prune: name them, remove nothing", "--forget": "remove this session's record and state" },
      does: "this session's record: who it is, written once, read on every later call",
    },
    join: {
      args: ["<room>"],
      options: { "--as <bearer>": "register this session as this bearer", "--label <name>": "", "--limit <n>": "how many recent messages to show (default 20)" },
      does: "register, start this session's cursor at the latest message, and show the recent messages: session --as, cursor --now, read, in one call",
    },
    doctor: { args: [], options: { "--offline": "skip the identity check" }, does: "config, token presence per room, identity per room, this session and bearer and where each came from" },
    schema: { args: [], options: { "--json": "" }, does: "this description" },
  },
};

const OPTIONS = /** @type {const} */ ({
  config: { type: "string" },
  as: { type: "string" },
  json: { type: "boolean", default: false },
  thread: { type: "string" },
  since: { type: "string" },
  limit: { type: "string" },
  file: { type: "string" },
  trailer: { type: "string", multiple: true },
  to: { type: "string", multiple: true },
  re: { type: "string" },
  claim: { type: "string", multiple: true },
  release: { type: "string", multiple: true },
  verdict: { type: "string" },
  exhibit: { type: "string", multiple: true },
  because: { type: "string" },
  stdin: { type: "boolean", default: false },
  "no-sign": { type: "boolean", default: false },
  follow: { type: "boolean", default: false },
  "thread-interval": { type: "string" },
  once: { type: "boolean", default: false },
  stream: { type: "boolean", default: false },
  all: { type: "boolean", default: false },
  wake: { type: "string" },
  "codex-queue": { type: "boolean", default: false },
  interval: { type: "string" },
  for: { type: "string" },
  reset: { type: "boolean", default: false },
  now: { type: "boolean", default: false },
  set: { type: "string" },
  offline: { type: "boolean", default: false },
  label: { type: "string" },
  list: { type: "boolean", default: false },
  prune: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  forget: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
});

/** @param {import('../src/session.mjs').SessionRecord} rec @param {'live' | 'gone' | 'unknown' | 'unregistered'} state */
function recordLine(rec, state) {
  const age = ageHours(rec);
  const seen = age < 1 ? `${Math.round(age * 60)}m ago` : age < 48 ? `${Math.round(age)}h ago` : `${Math.round(age / 24)}d ago`;
  return `${rec.bearer.padEnd(18)} ${rec.slug.padEnd(30)} ${state.padEnd(6)} pid ${String(rec.pid ?? "-").padEnd(7)} seen ${seen}${rec.label ? `  "${rec.label}"` : ""}`;
}

/** @param {string} s */
const indent = (s) => s.split(/\r?\n/).map((l) => `    ${l}`).join("\n");

/**
 * A message with its trailer block read off it. The text is never rewritten: the block stays in
 * the body it was posted in, and this only says what is in there.
 * @param {import('../src/core.mjs').Message} m
 */
function decorate(m) {
  const { trailers, to } = parseTrailers(m.text);
  return {
    ...m,
    ...(to.length ? { to } : {}),
    ...(trailers.length ? { trailers } : {}),
  };
}

/** The one derived line above a body: what the trailers say, in the emitter's order. @param {ReturnType<typeof decorate>} m */
function trailerLine(m) {
  if (!m.trailers?.length) return "";
  /** @type {string[]} */
  const parts = [];
  if (m.to?.length) parts.push(`to ${m.to.join(", ")}`);
  for (const t of formatTrailers(m.trailers).split("\n")) {
    const at = t.indexOf(": ");
    const key = t.slice(0, at);
    if (key === "to") continue;
    parts.push(`${key} ${t.slice(at + 2)}`);
  }
  return parts.length ? `  → ${parts.join(" · ")}\n` : "";
}

/** @param {ReturnType<typeof decorate>} m */
function human(m) {
  const who = m.signedAs && m.signedAs !== m.author.name ? `${m.author.name} as ${m.signedAs}` : m.author.name;
  const where = m.thread ? `  thread ${m.thread}` : "";
  return `[${m.ts}] ${who} (${m.author.kind})${where}  cursor ${m.cursor}\n${trailerLine(m)}${indent(m.text)}`;
}

/** @param {import('../src/core.mjs').Message[]} msgs @param {boolean} json */
function printMessages(msgs, json) {
  for (const m of msgs) {
    const { raw: _raw, ...rest } = decorate(m);
    console.log(json ? JSON.stringify(rest) : human(rest) + "\n");
  }
}

/** @param {string | undefined} s @param {string} what @param {number} [fallback] */
function num(s, what, fallback) {
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new AgoraError(`--${what} must be a non-negative number`, EXIT.usage);
  return n;
}

/**
 * Reads a minute this seat is spending, per transport: every registered watch whose process is
 * still there, at its own room interval, plus one read per followed thread at its thread interval.
 * A registration whose pid is gone is a leftover from a killed process and counts for nothing.
 * @param {import('../src/core.mjs').Config} cfg @param {string} stateRoot
 * @returns {Promise<Map<string, { rate: number, budget: number, watches: number }>>}
 */
async function pollRates(cfg, stateRoot) {
  /** @type {Map<string, { rate: number, budget: number, watches: number }>} */
  const out = new Map();
  for (const { dir, key, armed } of await listArmed(stateRoot)) {
    if (!pidAlive(armed.pid)) continue;
    const room = cfg.rooms[armed.room];
    if (!room) continue;
    const followed = armed.follow ? Object.keys((await readFollow(dir, key)).threads).length : 0;
    const rate = 60 / roomInterval(room, armed.interval) + followed * (60 / roomThreadInterval(room, armed.threadInterval));
    const budget = roomPollBudget(room);
    const prev = out.get(room.transport) ?? { rate: 0, budget, watches: 0 };
    out.set(room.transport, { rate: prev.rate + rate, budget: Math.max(prev.budget, budget), watches: prev.watches + 1 });
  }
  return out;
}

/**
 * The trailer entries a `post` call asked for: `--trailer` is the primitive and the named flags are
 * sugar on it. Nothing is inferred -- `--thread` does not emit a `re:`, because a reply in a thread
 * and a reply to a message are different claims and only the author knows which was meant.
 * @param {Record<string, unknown>} values
 * @returns {import('../src/trailers.mjs').Trailer[]}
 */
function trailerEntries(values) {
  /** @type {import('../src/trailers.mjs').Trailer[]} */
  const out = [];
  for (const raw of /** @type {string[]} */ (values.trailer ?? [])) {
    const at = raw.indexOf(":");
    const key = at < 0 ? "" : raw.slice(0, at).trim().toLowerCase();
    const value = at < 0 ? "" : raw.slice(at + 1).trim();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(key) || !value || value.length > 200)
      throw new AgoraError(`--trailer takes "<key>: <value>" (a lower-case key of up to 24 characters, a value of up to 200)`, EXIT.usage);
    out.push({ key, value });
  }
  for (const key of ["to", "re", "claim", "release", "verdict", "exhibit", "because"]) {
    const v = values[key];
    for (const value of Array.isArray(v) ? v : v === undefined ? [] : [String(v)]) out.push({ key, value: String(value).trim() });
  }
  return out;
}

function usage() {
  const lines = [`agora ${version}: ${SCHEMA.description}`, "", "usage: agora <verb> [args] [options]", ""];
  for (const [verb, v] of Object.entries(SCHEMA.verbs)) {
    lines.push(`  ${verb} ${v.args.join(" ")}`.padEnd(28) + v.does);
    for (const [opt, doc] of Object.entries(v.options)) lines.push(`      ${opt.padEnd(20)} ${doc}`);
  }
  lines.push("", "global: --config <path>   --json", `config: ${SCHEMA.config}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [verb, roomAlias, ...rest] = positionals;
  if (!verb || values.help) {
    console.log(usage());
    return verb ? EXIT.ok : EXIT.usage;
  }
  if (verb === "schema") {
    console.log(values.json ? JSON.stringify(SCHEMA, null, 2) : usage());
    return EXIT.ok;
  }

  const cfg = await loadConfig(values.config);
  const json = Boolean(values.json);
  const session = resolveSession(cfg, process.env, (line) => console.error(`agora: ${line}`));
  const stateRoot = stateDir(cfg);
  const sdir = sessionDir(stateRoot, session);
  const record = verb === "session" || verb === "join" ? await readRecord(sdir) : await touchRecord(sdir);
  const bearer = resolveBearer(cfg, { as: values.as, env: process.env, record });
  cfg.actor = { ...cfg.actor, name: bearer.name }; // one string: the signature, the local transport's identity
  const identity = () => identityLine(bearer, session, stateRoot).then((l) => console.error(l));

  /** Register this session: write the record with the bearer given, and say so (on stderr when stdout carries messages). */
  async function register(toStderr = false) {
    if (values.as === undefined) throw new AgoraError(`${verb} needs --as <bearer> (a path like Grace or Grace/watch)`, EXIT.usage);
    const rec = await writeRecord(sdir, session, { bearer: bearer.name, label: values.label, ...harnessPid(cfg, process.env) });
    const line = `registered ${rec.bearer} as session ${session.slug} (from ${session.source})${rec.pid ? `  pid ${rec.pid} from ${rec.pidSource}` : "  no harness pid found; liveness unknown"}`;
    if (toStderr) console.error(`agora: ${line}`);
    else if (json) console.log(JSON.stringify({ ...rec, dir: sdir }));
    else console.log(line);
    return rec;
  }

  /**
   * Note activity on threads in a room's follow set and return the set, oldest activity first.
   * An eviction is announced: a thread that leaves the set stops reaching this session.
   * @param {string} dir @param {string} alias @param {import('../src/core.mjs').RoomConfig} r @param {string[]} ids
   */
  async function follow(dir, alias, r, ids) {
    const cap = roomNumber(r, "followCap", FOLLOW_CAP);
    const res = await followThreads(dir, cursorKey(alias), ids, {
      cap,
      idleMinutes: roomNumber(r, "followIdleMinutes", FOLLOW_IDLE_MINUTES),
    });
    for (const id of res.evicted)
      console.error(`agora: no longer following thread ${id} in ${alias}; the set holds ${cap}, oldest activity first`);
    return res.threads;
  }

  if (verb === "session") {
    if (values.list) {
      const rows = await listRecords(stateRoot);
      for (const r of rows) {
        if (json) console.log(JSON.stringify({ slug: r.slug, state: r.state, ...(r.record ?? {}), here: r.slug === session.slug }));
        else console.log(`${r.slug === session.slug ? "*" : " "} ${r.record ? recordLine(r.record, r.state) : `${"(unregistered)".padEnd(18)} ${r.slug.padEnd(30)} ${r.state}`}`);
      }
      if (!rows.length && !json) console.log("no sessions have state here");
      return EXIT.ok;
    }
    if (values.prune) {
      const stale = cfg.session?.staleAfterHours ?? 48;
      const rows = (await listRecords(stateRoot)).filter((r) => r.slug !== session.slug && r.record && r.state === "gone" && ageHours(r.record) > stale);
      for (const r of rows) {
        if (!values["dry-run"]) await removeSession(r.dir);
        console.log(json ? JSON.stringify({ slug: r.slug, removed: !values["dry-run"] }) : `${values["dry-run"] ? "would remove" : "removed"} ${r.slug} (${r.record?.bearer}, gone, last seen ${Math.round(ageHours(/** @type {any} */ (r.record)))}h ago)`);
      }
      if (!rows.length && !json) console.log(`nothing to prune (gone and last seen more than ${stale}h ago)`);
      return EXIT.ok;
    }
    if (values.forget) {
      await removeSession(sdir);
      console.log(json ? JSON.stringify({ slug: session.slug, removed: true }) : `forgot session ${session.slug}: its record, cursors and ledger are gone`);
      return EXIT.ok;
    }
    await register();
    await identity();
    return EXIT.ok;
  }

  if (verb === "rooms") {
    for (const [alias, room] of Object.entries(cfg.rooms)) {
      const where = room.transport === "github" ? `${room.repo}#${room.issue}` : room.transport === "github-events" ? `${room.repo ?? (room.org ? `org:${room.org}` : `user:${room.user}`)} events${Array.isArray(room.events) ? ` [${room.events.join(", ")}]` : ""}${Array.isArray(room.refs) ? ` refs ${room.refs.join(", ")}` : ""}` : room.transport === "slack" ? String(room.channel) : String(room.path ?? "");
      const note = typeof room.note === "string" ? room.note : undefined;
      if (json) console.log(JSON.stringify({ alias, transport: room.transport, room: where, ...(note ? { note } : {}) }));
      else {
        console.log(`${alias.padEnd(16)} ${room.transport.padEnd(8)} ${where}`);
        if (note) console.log(`${"".padEnd(16)} note: ${note}`);
      }
    }
    return EXIT.ok;
  }

  if (verb === "doctor") {
    let bad = 0;
    for (const [alias, room] of Object.entries(cfg.rooms)) {
      /** @type {Record<string, unknown>} */
      const report = { alias, transport: room.transport, token: await tokenSource(room) };
      if (typeof room.note === "string") report.note = room.note;
      if (room.transport === "local" && typeof room.path === "string") {
        const why = fragilePath(room.path) ?? fragilePath(resolvePath(room.path));
        if (why) report.warning = `this room's file sits behind ${why}: a local room there loses lines silently, because every surviving line still parses and every id is still unique. Every writer must reach it through the same native filesystem.`;
      }
      if (report.token === "missing" && TRANSPORTS[/** @type {keyof typeof TRANSPORTS} */ (room.transport)]?.needsToken) bad++;
      if (!values.offline && report.token !== "missing") {
        try {
          const t = await createTransport(alias, room, cfg);
          report.identity = await t.whoami();
        } catch (e) {
          report.error = redact(e instanceof Error ? e.message : String(e));
          bad++;
        }
      }
      if (json) console.log(JSON.stringify(report));
      else {
        console.log(`${alias.padEnd(16)} ${String(report.transport).padEnd(8)} token=${report.token}` + (report.identity ? `  as ${/** @type {any} */ (report.identity).name}` : "") + (report.error ? `  ERROR ${report.error}` : ""));
        if (report.note) console.log(`${"".padEnd(16)} note: ${report.note}`);
        if (report.warning) console.log(`${"".padEnd(16)} WARNING ${report.warning}`);
      }
    }
    if (!json) {
      console.log(`config  ${cfg.path}\nstate   ${sdir}\nsession ${session.slug} (from ${session.source})${record ? "" : "  (unregistered: run `agora session --as <bearer>`)"}\nbearer  ${bearer.name} (${cfg.actor.kind}, from ${bearer.source})`);
      const rows = await listRecords(stateRoot);
      if (rows.length) {
        console.log("\nsessions with state here");
        for (const r of rows) console.log(`${r.slug === session.slug ? "*" : " "} ${r.record ? recordLine(r.record, r.state) : `${"(unregistered)".padEnd(18)} ${r.slug.padEnd(30)} ${r.state}`}`);
        const live = rows.filter((r) => r.record && r.state !== "gone");
        const byBearer = new Map();
        for (const r of live) byBearer.set(r.record?.bearer, (byBearer.get(r.record?.bearer) ?? 0) + 1);
        for (const [b, n] of byBearer) if (n > 1) console.log(`WARNING ${n} live sessions carry the bearer ${b}; the room cannot tell them apart. Give each a role segment (${b}/watch, ${b}/review).`);
        if (cfg.sign === false && live.length > 1) console.log(`WARNING signing is off and ${live.length} sessions are live: no line in the room can be attributed to a bearer.`);
      }
    }
    for (const [kind, r] of await pollRates(cfg, stateRoot)) {
      const rate = Math.round(r.rate * 10) / 10;
      const over = rate > r.budget;
      if (json) console.log(JSON.stringify({ type: "poll-rate", transport: kind, rate, budget: r.budget, watches: r.watches, over }));
      else {
        console.log(`\nseat poll rate  ~${rate} reads/min on ${kind} (budget ${r.budget}, ${r.watches} watch${r.watches === 1 ? "" : "es"})`);
        if (over) console.log(`WARNING this seat reads ${kind} ~${rate} times a minute against a budget of ${r.budget}; raise the intervals or follow fewer threads.`);
      }
    }
    return bad ? EXIT.error : EXIT.ok;
  }

  if (!roomAlias) throw new AgoraError(`${verb} needs a room (one of: ${Object.keys(cfg.rooms).join(", ")})`, EXIT.usage);
  const room = cfg.rooms[roomAlias];
  if (!room) throw new AgoraError(`no room "${roomAlias}" (have: ${Object.keys(cfg.rooms).join(", ")})`, EXIT.usage);
  const transport = await createTransport(roomAlias, room, cfg, { cache: etagCache(sdir) });
  const thread = values.thread;
  if (thread && !transport.threads) throw new AgoraError(`${transport.kind} rooms have no threads`, EXIT.usage);

  switch (verb) {
    case "join": {
      await register(true);
      const key = cursorKey(roomAlias, thread);
      const msgs = await transport.read({ thread });
      await writeCursor(sdir, key, msgs.length ? msgs[msgs.length - 1].cursor : undefined);
      await identity();
      console.error(`agora: ${key} cursor set to ${msgs.length ? msgs[msgs.length - 1].cursor : "the start (the room is empty)"}; the recent messages follow`);
      printMessages(msgs.slice(-(num(values.limit, "limit", 20) ?? 20)), json);
      return EXIT.ok;
    }
    case "who": {
      const limit = num(values.limit, "limit", 200) ?? 200;
      const msgs = await transport.read({ thread, limit });
      /** @type {Map<string, { last: string, count: number, kind: string }>} */
      const seen = new Map();
      for (const m of msgs) {
        const name = m.signedAs ?? m.author.name;
        const prev = seen.get(name);
        seen.set(name, { last: m.ts, count: (prev?.count ?? 0) + 1, kind: m.signedAs ? "signed" : m.author.kind });
      }
      const local = await listRecords(stateRoot);
      /** @param {string} name */
      const here = (name) => local.filter((r) => r.record?.bearer === name);
      const rows = [...seen.entries()].sort((a, b) => (a[1].last < b[1].last ? 1 : a[1].last > b[1].last ? -1 : 0));
      for (const [name, r] of rows) {
        const mine = here(name);
        const state = mine.length ? mine.map((x) => x.state).join("/") : "";
        if (json) console.log(JSON.stringify({ type: "who", name, last: r.last, count: r.count, kind: r.kind, ...(mine.length ? { here: mine.map((x) => ({ session: x.slug, state: x.state, lastSeen: x.record?.lastSeen })) } : {}) }));
        else console.log(`${name.padEnd(20)} last spoke ${r.last}  (${r.count} message${r.count === 1 ? "" : "s"}, ${r.kind})${state ? `  here: ${state}` : ""}`);
      }
      const horizon = msgs.length ? `read ${msgs.length} messages back to ${msgs[0].ts}` : "read 0 messages";
      if (json) console.log(JSON.stringify({ type: "who-horizon", messages: msgs.length, oldest: msgs[0]?.ts ?? null, newest: msgs.at(-1)?.ts ?? null }));
      else console.log(`\n${horizon}; a bearer whose last line is older than your patience is unanswered: re-address, or ask the human`);
      return EXIT.ok;
    }
    case "whoami": {
      const me = await transport.whoami();
      console.log(json ? JSON.stringify({ ...me, transport: transport.kind, room: transport.room }) : `${me.name} (${me.id}) on ${transport.kind} ${transport.room}`);
      return EXIT.ok;
    }
    case "read": {
      const msgs = await transport.read({ thread, since: values.since, limit: num(values.limit, "limit") });
      printMessages(msgs, json);
      return EXIT.ok;
    }
    case "post": {
      const entries = trailerEntries(values);
      if (entries.some((t) => t.key === "verdict") && !entries.some((t) => t.key === "exhibit"))
        throw new AgoraError(`--verdict needs at least one --exhibit: a claim is settled by an exhibit, not by agreement`, EXIT.usage);
      let text = rest.join(" ");
      if (values.file) text = await readFile(values.file, "utf8");
      else if (values.stdin || text === "-") text = await readStdin();
      if (!text.trim()) throw new AgoraError(`nothing to post (give text, --file, or --stdin)`, EXIT.usage);
      if (entries.length) text = `${text.replace(/\s+$/, "")}\n\n${formatTrailers(entries)}`;
      const signIt = cfg.sign !== false && !values["no-sign"];
      const body = signIt ? sign(text, cfg.actor) : text;
      await identity();
      const r = await transport.post(body, { thread });
      await appendPosted(sdir, r.id);
      if (thread) await follow(sdir, roomAlias, room, [thread]);
      // an answer with re: joins the thread under the message it answers: that is where the
      // humans reply, and a channel-history read never shows it
      else if (values.re && transport.threads) await follow(sdir, roomAlias, room, [String(values.re)]);
      console.log(json ? JSON.stringify({ ...r, room: transport.room, thread }) : `posted ${r.id}${r.url ? `  ${r.url}` : ""}  cursor ${r.cursor}`);
      return EXIT.ok;
    }
    case "watch": {
      if (values.follow && thread)
        throw new AgoraError(`--follow watches the room and the threads this session posted in; it cannot be combined with --thread`, EXIT.usage);
      const mode = values.once ? "once" : values.stream ? "stream" : "until-new";
      const key = cursorKey(roomAlias, thread);
      const interval = roomInterval(room, num(values.interval, "interval"));
      const threadInterval = roomThreadInterval(room, num(values["thread-interval"], "thread-interval"));
      await identity();
      const seeded = await readCursorSeeded(sdir, stateRoot, key);
      if (seeded.seeded) console.error(`agora: no position saved for this session yet; seeded from the shared ${key}.cursor (${seeded.cursor})`);
      else if (seeded.cursor === undefined) console.error(`agora: no position saved for ${key}; reading from the start (run \`agora cursor ${roomAlias}${thread ? ` --thread ${thread}` : ""} --now\` to start from the latest message)`);

      const held = await readArmed(sdir, key);
      if (held && pidAlive(held.pid)) console.error(`agora: another watch holds this cursor (pid ${held.pid}); two watches on one key double-deliver`);
      // Under Claude Code a persistent watch would otherwise turn every delivery into a
      // maintenance-checklist turn; the stop hook honours a sentinel beside the transcript
      // while the watch runs. Touched on every poll (the hook treats it stale after 12 h),
      // removed with the armed record. Only written beside an existing transcript.
      const watchMode = watchModeSentinel(process.env, process.cwd());
      if (await touchWatchMode(watchMode)) console.error(`agora: watch-mode sentinel ${watchMode?.sentinel} (the stop hook stays quiet while this watch runs)`);
      await writeArmed(sdir, key, {
        room: roomAlias,
        thread,
        interval,
        threadInterval,
        follow: values.follow,
        pid: process.pid,
        ...(harnessPid(cfg, process.env).pid !== undefined ? { harnessPid: harnessPid(cfg, process.env).pid } : {}),
        since: seeded.cursor ?? null,
        startedAt: new Date().toISOString(),
      });

      /** @type {import('../src/watch.mjs').FollowedThreads | undefined} */
      const threads = values.follow
        ? {
            ids: () => follow(sdir, roomAlias, room, []),
            key: (id) => cursorKey(roomAlias, id),
            cursor: async (id) => (await readCursorSeeded(sdir, stateRoot, cursorKey(roomAlias, id))).cursor,
            interval: threadInterval,
            // what woke this session roots a followed thread: the answers to it land there
            note: async (msgs) => void (await follow(sdir, roomAlias, room, transport.threads ? rootsOf(msgs) : threadsOf(msgs))),
            drop: async (id) => { await dropFollow(sdir, cursorKey(roomAlias), id); },
          }
        : undefined;

      const wakeMode = values.wake ?? "all";
      if (!["all", "addressed", "mine"].includes(wakeMode)) throw new AgoraError(`--wake takes all, addressed, or mine`, EXIT.usage);
      /** @type {{ id?: string, name?: string } | undefined} */
      let seat;
      if (wakeMode !== "all") {
        try {
          seat = await transport.whoami();
        } catch {
          seat = undefined; // a feed or an offline transport: bearer addressing still works
        }
      }
      /** The reader's own choice of what wakes it; never automatic. @type {((m: import('../src/core.mjs').Message) => boolean) | undefined} */
      const wakeRule = wakeMode === "all" ? undefined : (m) => {
        const to = parseTrailers(m.text).to;
        const forMe = to.some((a) => matchesAddress(a, bearer.name, seat));
        return wakeMode === "mine" ? forMe : to.length === 0 || forMe;
      };

      /** A session on this seat that went dark is announced to this room once; whichever watch notices first speaks. */
      const sweep = async () => {
        await touchWatchMode(watchMode).catch(() => undefined);
        const gone = await departures(stateRoot, { selfSlug: session.slug, roomKey: key, staleHours: cfg.session?.staleAfterHours ?? 48 });
        for (const d of gone) {
          if (!(await claimDeparture(d.dir, key, session.slug))) continue;
          const records = (await listRecords(stateRoot)).filter((r) => r.record && r.slug !== d.slug);
          const live = records.filter((r) => r.state === "live").map((r) => /** @type {any} */ (r.record).bearer);
          // a session this process cannot probe (another harness, another OS user) is named, never dropped
          // named with its last write, and only inside the stale horizon: a record quiet for days is pruned, not listed
          const staleHours = cfg.session?.staleAfterHours ?? 48;
          const seenUnknown = new Set();
          const unknown = records
            .filter((r) => r.state === "unknown" && ageHours(/** @type {any} */ (r.record)) <= staleHours && !live.includes(/** @type {any} */ (r.record).bearer))
            .map((r) => ({ bearer: /** @type {any} */ (r.record).bearer, lastSeen: /** @type {any} */ (r.record).lastSeen }))
            .filter((u) => !seenUnknown.has(u.bearer) && seenUnknown.add(u.bearer));
          const text = departureLine(d.record, [...new Set(live)], unknown);
          try {
            const r = await transport.post(cfg.sign !== false ? sign(text, cfg.actor) : text, { thread });
            await appendPosted(sdir, r.id);
            console.error(`agora: announced to ${roomAlias}: ${text}`);
          } catch (e) {
            console.error(redact(`agora: could not announce ${d.record.bearer}'s departure to ${roomAlias}: ${e instanceof Error ? e.message : String(e)}`));
          }
        }
      };

      let result;
      try {
        result = await watch(transport, {
          stateDir: sdir,
          key,
          thread,
          cursor: seeded.cursor,
          mode,
          own: values.all ? undefined : () => readPosted(sdir),
          wake: wakeRule,
          interval,
          forSeconds: num(values.for, "for", 0),
          threads,
          sweep,
          onBatch: async (msgs) => {
            printMessages(msgs, json);
            if (values["codex-queue"]) await queueCodex(roomAlias, msgs);
          },
        });
      } finally {
        await removeArmed(sdir, key); // a thrown delivery must not leave the key registered
        await clearWatchMode(watchMode).catch(() => undefined);
      }
      const exit = result.fired && mode !== "stream" ? EXIT.fired : EXIT.ok;
      if (!json && !result.fired) console.error(`nothing new after ${result.polls} poll${result.polls === 1 ? "" : "s"}${result.skipped ? ` (${result.skipped} of our own skipped)` : ""}${result.filtered ? ` (${result.filtered} not for us, still readable)` : ""}`);
      // one machine-readable line, fired or not: an exit code does not survive a wrapper
      const line = JSON.stringify({
        type: "watch-result",
        room: roomAlias,
        session: session.slug,
        bearer: bearer.name,
        fired: result.fired,
        delivered: result.delivered,
        skipped: result.skipped,
        filtered: result.filtered,
        polls: result.polls,
        cursor: result.cursor ?? null,
        threads: result.threads,
        exit,
      });
      if (json) console.log(line);
      else console.error(line);
      return exit;
    }
    case "cursor": {
      const key = cursorKey(roomAlias, thread);
      if (values.reset) await writeCursor(sdir, key, undefined);
      else if (values.set) await writeCursor(sdir, key, values.set);
      else if (values.now) {
        const msgs = await transport.read({ thread });
        await writeCursor(sdir, key, msgs.length ? msgs[msgs.length - 1].cursor : undefined);
      }
      const seeded = await readCursorSeeded(sdir, stateRoot, key);
      const cur = seeded.cursor;
      const note = seeded.seeded ? " (seeded from the shared cursor)" : "";
      console.log(json ? JSON.stringify({ room: roomAlias, thread, cursor: cur ?? null, session: session.slug }) : `${key}: ${cur ?? "(none: next watch reads from the start)"}${note}`);
      return EXIT.ok;
    }
    default:
      throw new AgoraError(`unknown verb "${verb}"\n\n${usage()}`, EXIT.usage);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    const code = e instanceof AgoraError ? e.exitCode : EXIT.error;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(redact(`agora: ${msg}`));
    process.exit(code);
  },
);
