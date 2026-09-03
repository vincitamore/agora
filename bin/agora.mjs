#!/usr/bin/env node
// @ts-check
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  AgoraError,
  EXIT,
  cursorKey,
  loadConfig,
  redact,
  sign,
  stateDir,
  writeCursor,
} from "../src/core.mjs";
import { TRANSPORTS, createTransport, tokenSource } from "../src/transports/index.mjs";
import { watch } from "../src/watch.mjs";
import {
  ageHours,
  appendPosted,
  harnessPid,
  identityLine,
  listRecords,
  readCursorSeeded,
  readPosted,
  readRecord,
  removeSession,
  resolveBearer,
  resolveSession,
  sessionDir,
  touchRecord,
  writeRecord,
} from "../src/session.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const SCHEMA = {
  name: "agora",
  version,
  description: "One room, many transports: local agents read and post in shared conversations.",
  config: "AGORA_CONFIG, ./agora.json, or ~/.agora/config.json; state under AGORA_STATE or ~/.agora/state, in sessions/<session>/; the session key from AGORA_SESSION, else the first set variable in session.from, else default; the bearer from --as, AGORA_ACTOR, or actor.name",
  exit: { ok: 0, error: 1, usage: 2, fired: 42 },
  global: { "--config <path>": "config file", "--json": "machine-readable output (NDJSON for messages)", "--as <bearer>": "sign this call as this bearer (a path like Fable or Fable/watch)" },
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
      options: { "--thread <id>": "reply in a thread", "--file <path>": "text from a file", "--stdin": "text from stdin", "--no-sign": "omit the signature line" },
      does: "post one message signed as the configured actor; prints id and cursor",
    },
    watch: {
      args: ["<room>"],
      options: {
        "--thread <id>": "watch one thread",
        "--once": "one poll, then exit",
        "--stream": "keep delivering until --for elapses",
        "--interval <s>": "seconds between polls (default 15)",
        "--for <s>": "give up after this many seconds (default: never)",
        "--all": "deliver this side's own posts too (skipped by default)",
      },
      does: "deliver new messages since this session's saved cursor and advance it after delivery, skipping what this session posted; exit 42 when something arrived, 0 when nothing did",
    },
    cursor: {
      args: ["<room>"],
      options: { "--thread <id>": "", "--reset": "forget (next watch reads from the start)", "--now": "skip to the latest message", "--set <cursor>": "set explicitly" },
      does: "show or move this session's saved cursor",
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
  stdin: { type: "boolean", default: false },
  "no-sign": { type: "boolean", default: false },
  once: { type: "boolean", default: false },
  stream: { type: "boolean", default: false },
  all: { type: "boolean", default: false },
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

/** @param {import('../src/core.mjs').Message} m */
function human(m) {
  const who = m.signedAs && m.signedAs !== m.author.name ? `${m.author.name} as ${m.signedAs}` : m.author.name;
  const where = m.thread ? `  thread ${m.thread}` : "";
  return `[${m.ts}] ${who} (${m.author.kind})${where}  cursor ${m.cursor}\n${indent(m.text)}`;
}

/** @param {import('../src/core.mjs').Message[]} msgs @param {boolean} json */
function printMessages(msgs, json) {
  for (const m of msgs) {
    const { raw: _raw, ...rest } = m;
    console.log(json ? JSON.stringify(rest) : human(m) + "\n");
  }
}

/** @param {string | undefined} s @param {string} what @param {number} [fallback] */
function num(s, what, fallback) {
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new AgoraError(`--${what} must be a non-negative number`, EXIT.usage);
  return n;
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
    if (values.as === undefined) throw new AgoraError(`${verb} needs --as <bearer> (a path like Fable or Fable/watch)`, EXIT.usage);
    const rec = await writeRecord(sdir, session, { bearer: bearer.name, label: values.label, ...harnessPid(cfg, process.env) });
    const line = `registered ${rec.bearer} as session ${session.slug} (from ${session.source})${rec.pid ? `  pid ${rec.pid} from ${rec.pidSource}` : "  no harness pid found; liveness unknown"}`;
    if (toStderr) console.error(`agora: ${line}`);
    else if (json) console.log(JSON.stringify({ ...rec, dir: sdir }));
    else console.log(line);
    return rec;
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
      const where = room.transport === "github" ? `${room.repo}#${room.issue}` : room.transport === "slack" ? String(room.channel) : String(room.path ?? "");
      console.log(json ? JSON.stringify({ alias, transport: room.transport, room: where }) : `${alias.padEnd(16)} ${room.transport.padEnd(8)} ${where}`);
    }
    return EXIT.ok;
  }

  if (verb === "doctor") {
    let bad = 0;
    for (const [alias, room] of Object.entries(cfg.rooms)) {
      /** @type {Record<string, unknown>} */
      const report = { alias, transport: room.transport, token: await tokenSource(room) };
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
      console.log(json ? JSON.stringify(report) : `${alias.padEnd(16)} ${String(report.transport).padEnd(8)} token=${report.token}` + (report.identity ? `  as ${/** @type {any} */ (report.identity).name}` : "") + (report.error ? `  ERROR ${report.error}` : ""));
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
    return bad ? EXIT.error : EXIT.ok;
  }

  if (!roomAlias) throw new AgoraError(`${verb} needs a room (one of: ${Object.keys(cfg.rooms).join(", ")})`, EXIT.usage);
  const room = cfg.rooms[roomAlias];
  if (!room) throw new AgoraError(`no room "${roomAlias}" (have: ${Object.keys(cfg.rooms).join(", ")})`, EXIT.usage);
  const transport = await createTransport(roomAlias, room, cfg);
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
      let text = rest.join(" ");
      if (values.file) text = await readFile(values.file, "utf8");
      else if (values.stdin || text === "-") text = await readStdin();
      if (!text.trim()) throw new AgoraError(`nothing to post (give text, --file, or --stdin)`, EXIT.usage);
      const signIt = cfg.sign !== false && !values["no-sign"];
      const body = signIt ? sign(text, cfg.actor) : text;
      await identity();
      const r = await transport.post(body, { thread });
      await appendPosted(sdir, r.id);
      console.log(json ? JSON.stringify({ ...r, room: transport.room, thread }) : `posted ${r.id}${r.url ? `  ${r.url}` : ""}  cursor ${r.cursor}`);
      return EXIT.ok;
    }
    case "watch": {
      const mode = values.once ? "once" : values.stream ? "stream" : "until-new";
      const key = cursorKey(roomAlias, thread);
      await identity();
      const seeded = await readCursorSeeded(sdir, stateRoot, key);
      if (seeded.seeded) console.error(`agora: no position saved for this session yet; seeded from the shared ${key}.cursor (${seeded.cursor})`);
      else if (seeded.cursor === undefined) console.error(`agora: no position saved for ${key}; reading from the start (run \`agora cursor ${roomAlias}${thread ? ` --thread ${thread}` : ""} --now\` to start from the latest message)`);
      const result = await watch(transport, {
        stateDir: sdir,
        key,
        thread,
        cursor: seeded.cursor,
        mode,
        own: values.all ? undefined : () => readPosted(sdir),
        interval: num(values.interval, "interval", 15),
        forSeconds: num(values.for, "for", 0),
        onBatch: (msgs) => printMessages(msgs, json),
      });
      if (!json && !result.fired) console.error(`nothing new after ${result.polls} poll${result.polls === 1 ? "" : "s"}${result.skipped ? ` (${result.skipped} of our own skipped)` : ""}`);
      return result.fired && mode !== "stream" ? EXIT.fired : EXIT.ok;
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
