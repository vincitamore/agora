// @ts-check
// What the Tern agora pane needs from agora, decided in plain JavaScript so `node --test` reaches it:
// the pane's own settings, one view of a room (subjects with unread marks, the board, who spoke,
// the configured rooms and their faces, this seat's sessions, service and residents), and one post.
// Nothing here knows Tern: host.luau asks through bridge.mjs and draws the answer.
//
// The plugin is linked from an agora checkout, so it reads with the checkout's own modules (one
// version of the protocol for the CLI and the pane) and runs the checkout's CLI for the verbs it
// does not do in process.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, redact, sign, stateDir } from "../../../src/core.mjs";
import { attachmentLines, decorate, trailerLine } from "../../../src/render.mjs";
import { ClientError, connect, foldAnnotations } from "../../../src/client.mjs";
import { armedAlive, listArmed, listRecords } from "../../../src/session.mjs";
import { localTransport } from "../../../src/transports/local.mjs";
import { readServiceDescriptor } from "../../../src/wake/subscriber.mjs";
import { parseTrailers, withTrailers } from "../../../src/trailers.mjs";
import { configuredResidents, matchesResidentRecord } from "../../../src/resident.mjs";
import { ago, bodyText, buildSubjects, jsonLines, parseCommand, parseList, postArgs, subjectMeta, subjectTitle } from "../../claude/agora-room/hooks/lib.js";

/** The pane's own settings in the environment. Their own names, so a Tern daemon started from an agent's shell never hands the pane that agent's bearer. */
export const ENV = Object.freeze({
  rooms: "AGORA_TERN_ROOMS",
  room: "AGORA_TERN_ROOM",
  config: "AGORA_TERN_CONFIG",
  postCommand: "AGORA_TERN_POST_CMD",
  intervalMs: "AGORA_TERN_INTERVAL_MS",
});
/** The settings file in the plugin's data folder. */
export const DATA_FILE = "agora.json";
/** The session key every CLI child of the pane runs under. */
export const SESSION_KEY = "tern-agora-pane";
export const DEFAULT_INTERVAL_MS = 25000;
export const MIN_INTERVAL_MS = 5000;
export const MAX_INTERVAL_MS = 600000;
/** Messages read per room (the Claude pane reads the same window), the longest body sent to the pane, and how long a read of a rate-limited remote room is reused. */
export const READ_WINDOW = 200;
export const REMOTE_READ_LIMIT = 35;
export const BODY_MAX = 6000;
export const REMOTE_CACHE_MS = 90000;
export const TIMEOUT_MS = 20000;
/** Variables of the daemon's environment that never reach a CLI child: the pane names its own session, and posts as the person. */
const SCRUBBED = Object.freeze(["AGORA_ACTOR", "AGORA_SESSION", "AGORA_LABEL"]);
const ROOM_RE = /^[A-Za-z0-9][^\s\u0000-\u001f]{0,127}$/;
const HUMAN_FILE = path.join("native", "human.json");
const HUMAN_NAME_MAX = 64;

const here = path.dirname(fileURLToPath(import.meta.url));
/** The agora checkout this plugin is linked from: plugins/tern/agora/../../.. */
export const CHECKOUT = path.resolve(here, "..", "..", "..");
/** The checkout's CLI, run with the node that runs the bridge (`agora` on PATH is a .cmd shim on Windows, which a child run without a shell cannot start). */
export const CLI = Object.freeze([process.execPath, path.join(CHECKOUT, "bin", "agora.mjs")]);

/** @param {unknown} v */
const isSet = (v) => v !== undefined && v !== null && !(typeof v === "string" && !v.trim());
/** @param {unknown[]} vs */
const first = (...vs) => vs.find(isSet);
/** @param {string} s @param {number} n */
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** @param {unknown} e */
const said = (e) => redact(e instanceof Error ? e.message : String(e));
/** `YYYY-MM-DD HH:MM:SS` from an ISO time, for tables. @param {unknown} ts */
const shortTs = (ts) => String(ts ?? "").replace("T", " ").slice(0, 19);

// ---- settings ----

/**
 * @typedef {{
 *   rooms: string[], room: string | null, config: string | null,
 *   post: { command: string[] | null, env: Record<string, string> },
 *   intervalMs: number, problems: string[],
 * }} PaneConfig
 */

/**
 * The pane's settings. Precedence, highest first: the environment (`AGORA_TERN_*`), the data file
 * (`agora.json` in the plugin's data folder), the defaults. Each setting is taken whole from the
 * first layer that sets it, and an empty value does not shadow a lower layer.
 *
 * - `rooms`: which configured rooms the pane offers, in this order (default: every room in the agora config);
 * - `room`: the room it opens on (default: the first offered native room, else the first room);
 * - `config`: the agora config it reads (default: agora's own lookup, `AGORA_CONFIG` then `~/.agora/config.json`);
 * - `post.command` / `post.env`: when set, posts go through this agora command with these variables
 *   (a member seat's human posts with their own config: `["agora", "--config", "<their config>"]`);
 *   when not, a native or local room is posted to in process as the seat's human, any other through the checkout's CLI;
 * - `intervalMs`: how often an open pane reads its room again.
 * @param {{ env?: Record<string, string | undefined>, file?: Record<string, any> | null }} layers
 * @returns {PaneConfig}
 */
export function resolvePaneConfig({ env = {}, file = null } = {}) {
  const f = file ?? {};
  /** @type {string[]} */
  const problems = [];
  const asked = parseList(first(env[ENV.rooms], f.rooms));
  const rooms = asked.filter((r) => ROOM_RE.test(r));
  for (const r of asked) if (!ROOM_RE.test(r)) problems.push(`room ${JSON.stringify(r)} is not a room alias`);
  const roomRaw = first(env[ENV.room], f.room);
  const room = roomRaw === undefined ? null : String(roomRaw).trim();
  if (room !== null && !ROOM_RE.test(room)) problems.push(`room ${JSON.stringify(room)} is not a room alias`);
  const configRaw = first(env[ENV.config], f.config);
  const post = f.post && typeof f.post === "object" && !Array.isArray(f.post) ? f.post : {};
  const command = parseCommand(first(env[ENV.postCommand], post.command)) ?? null;
  /** @type {Record<string, string>} */
  const postEnv = {};
  if (post.env && typeof post.env === "object") for (const [k, v] of Object.entries(post.env)) if (typeof v === "string") postEnv[k] = v;
  if (Object.keys(postEnv).length && !command) problems.push("post.env is set without post.command; it applies only to a post command");
  let intervalMs = Number(first(env[ENV.intervalMs], f.intervalMs) ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(intervalMs)) {
    problems.push(`intervalMs is not a number; using ${DEFAULT_INTERVAL_MS}`);
    intervalMs = DEFAULT_INTERVAL_MS;
  }
  intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(intervalMs)));
  return {
    rooms,
    room: room !== null && ROOM_RE.test(room) ? room : null,
    config: configRaw === undefined ? null : String(configRaw),
    post: { command, env: postEnv },
    intervalMs,
    problems,
  };
}

/** The data file's JSON, or null when there is none; an unreadable one is a problem, never a crash. @param {string | null | undefined} file @returns {{ file: Record<string, any> | null, problem: string | null }} */
export function readDataFile(file) {
  if (!file || !existsSync(file)) return { file: null, problem: null };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return { file: null, problem: `${path.basename(file)} must hold one JSON object` };
    return { file: j, problem: null };
  } catch (err) {
    return { file: null, problem: `${path.basename(file)} is not valid JSON: ${cut(said(err), 120)}` };
  }
}

/** The environment of every CLI child: the daemon's own, minus any bearer or session it carries, plus `extra`. @param {Record<string, string | undefined>} base @param {Record<string, string>} [extra] */
export function childEnv(base, extra = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SCRUBBED.includes(k)) env[k] = v;
  return { ...env, AGORA_SESSION: SESSION_KEY, ...extra };
}

/** @typedef {(argv: string[], opts?: { env?: Record<string, string>, timeoutMs?: number }) => Promise<{ code: number | string | null, stdout: string, stderr: string }>} Run */

/** A child process as a function: no shell, a bound on the wait, the child killed by its own pid when it lapses. @type {Run} */
export const runProcess = (argv, opts = {}) => new Promise((resolve) => {
  const [exe, ...args] = argv;
  execFile(/** @type {string} */ (exe), args, { env: opts.env, timeout: opts.timeoutMs ?? TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: false }, (err, stdout, stderr) => {
    const e = /** @type {any} */ (err);
    resolve({ code: err ? (e.code ?? (e.killed ? "timeout" : 1)) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
});

/** What a failed child said, for one line of the pane. @param {string} verb @param {{ code: unknown, stderr: string }} r */
function failure(verb, r) {
  const last = r.stderr.trim().split("\n").filter(Boolean).pop() ?? "";
  return `agora ${verb} failed (${String(r.code)})${last ? `: ${cut(redact(last), 200)}` : ""}`;
}

// ---- the seat's human (the record `agora tui` keeps) ----

/** @param {string} stateRoot @returns {{ name: string, kind: "human", needsName: boolean }} */
export function readHuman(stateRoot) {
  try {
    const rec = JSON.parse(readFileSync(path.join(stateRoot, HUMAN_FILE), "utf8"));
    if (rec && typeof rec.name === "string" && rec.name.trim()) return { name: rec.name.trim(), kind: "human", needsName: false };
  } catch { /* no record yet */ }
  return { name: "", kind: "human", needsName: true };
}

/** Why a string is not a name here, or null. @param {string} n */
export function nameProblem(n) {
  if (!n) return "a name is needed";
  if (n.length > HUMAN_NAME_MAX) return `a name is at most ${HUMAN_NAME_MAX} characters`;
  if (/[\r\n]/.test(n)) return "a name is one line";
  if (/^(--|\u2014|\u2013)/.test(n)) return "a name does not start with a signature dash";
  return null;
}

/** @param {string} stateRoot @param {string} raw */
export function writeHuman(stateRoot, raw) {
  const n = String(raw ?? "").trim();
  const problem = nameProblem(n);
  if (problem) throw new Error(problem);
  const f = path.join(stateRoot, HUMAN_FILE);
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify({ name: n, kind: "human", created: new Date().toISOString() }) + "\n", { encoding: "utf8", mode: 0o600 });
  return { name: n, kind: /** @type {const} */ ("human") };
}

// ---- seat state read directly ----

/** @param {number} pid */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e)?.code === "EPERM";
  }
}

/** The seat service as its descriptor says, and whether its process is alive. @param {string} stateRoot */
export function inspectService(stateRoot) {
  try {
    const raw = JSON.parse(readFileSync(path.join(stateRoot, "native", "service.json"), "utf8"));
    const pid = Number(raw.pid) || 0;
    return {
      present: true,
      pid,
      pidAlive: pidAlive(pid),
      seatLabel: String(raw.seatLabel || ""),
      accountId: String(raw.accountId || ""),
      startedAt: shortTs(raw.startedAt),
      build: raw.build ? `${raw.build.version || "0.1.0"}+${raw.build.git ? String(raw.build.git).slice(0, 8) : raw.build.source || ""}` : "unknown",
    };
  } catch {
    return { present: false, pid: 0, pidAlive: false, seatLabel: "", accountId: "", startedAt: "", build: "none" };
  }
}

/** A native room's committed boundary and outbound faces, from the seat's store. @param {string} stateRoot @param {string} roomId */
export function inspectNativeRoom(stateRoot, roomId) {
  const dir = path.join(stateRoot, "native", "rooms", roomId);
  const out = { roomId, sequence: 0, epoch: "", digest: "", faces: /** @type {any[]} */ ([]) };
  try {
    const c = JSON.parse(readFileSync(path.join(dir, "committed.json"), "utf8"));
    out.sequence = Number(c.sequence) || 0;
    out.epoch = String(c.epoch || "");
    out.digest = String(c.digest || "").slice(0, 24);
  } catch { /* not committed yet */ }
  try {
    const fc = JSON.parse(readFileSync(path.join(dir, "faces.json"), "utf8"));
    if (Array.isArray(fc.faces)) {
      out.faces = fc.faces.map((/** @type {any} */ f) => ({
        transport: String(f.transport || ""),
        alias: String(f.alias || ""),
        target: String(f.target?.channel || f.target?.repo || ""),
        enabled: Boolean(f.enabled),
        human: Array.isArray(f.post?.human) ? f.post.human.join("+") : "",
        agent: Array.isArray(f.post?.agent) ? f.post.agent.join("+") : "",
        attachments: String(f.attachments || "metadata"),
      }));
    }
  } catch { /* no faces */ }
  return out;
}

/** Every configured room, never a token: only where its credential comes from. @param {any} cfg @param {string} stateRoot */
export function roomRows(cfg, stateRoot) {
  return Object.entries(cfg.rooms ?? {}).map(([alias, r]) => {
    const room = /** @type {any} */ (r);
    const tokenKind = room.tokenFile ? "file" : room.tokenEnv ? "env" : room.transport === "github" || room.transport === "github-events" ? "gh" : "none";
    const target = String(room.roomId || room.channel || (room.repo ? `${room.repo}${room.issue ? `#${room.issue}` : ""}` : "") || room.path || room.descriptor || "");
    return {
      alias,
      transport: String(room.transport || ""),
      target,
      tokenKind,
      note: typeof room.note === "string" ? room.note : "",
      nativeMeta: room.transport === "native" && room.roomId ? inspectNativeRoom(stateRoot, String(room.roomId)) : null,
    };
  });
}

/** The rooms the pane offers: the configured ones the settings name, in their order, else all. @param {ReturnType<typeof roomRows>} rows @param {PaneConfig} pc */
export function offeredRooms(rows, pc) {
  if (!pc.rooms.length) return rows;
  return pc.rooms.map((a) => rows.find((r) => r.alias === a)).filter((r) => r !== undefined);
}

/** The room to open when none was asked for. @param {ReturnType<typeof roomRows>} offered @param {PaneConfig} pc */
export function defaultRoom(offered, pc) {
  if (pc.room && offered.some((r) => r.alias === pc.room)) return pc.room;
  return offered.find((r) => r.transport === "native")?.alias ?? offered[0]?.alias ?? null;
}

// ---- messages ----

/** Which kind of seat an author account is on: `member` (an `m-` account), `host` (this seat's own account), or "" when it cannot be told. @param {unknown} authorId @param {string} hostAccountId */
export function seatKindOf(authorId, hostAccountId) {
  const id = String(authorId || "");
  if (id.startsWith("m-")) return "member";
  if (hostAccountId && id === hostAccountId) return "host";
  return "";
}

/** @typedef {ReturnType<typeof formatMessage>} PaneMessage */

/** One message as the pane shows it, everything rendered passed through `redact`. @param {any} m @param {string} hostAccountId */
export function formatMessage(m, hostAccountId) {
  const d = /** @type {any} */ (decorate(m));
  const text = redact(String(m.text || ""));
  const trailers = Array.isArray(d.trailers) ? d.trailers.map((/** @type {any} */ t) => ({ key: String(t.key), value: redact(String(t.value)) })) : [];
  const author = { id: String(m.author?.id || ""), name: String(m.author?.name || "unknown"), kind: String(m.author?.kind || "agent") };
  const signedAs = m.signedAs ? String(m.signedAs) : null;
  const titleText = typeof m.title === "string" ? m.title : typeof m.title?.text === "string" ? m.title.text : null;
  const body = bodyText({ text, signedAs, from: author.name, trailers });
  return {
    id: String(m.id || ""),
    thread: m.thread && String(m.thread) !== String(m.id) ? String(m.thread) : null,
    author,
    signedAs,
    speaker: signedAs && signedAs !== author.name ? `${author.name} as ${signedAs}` : author.name,
    seat: seatKindOf(author.id, hostAccountId),
    ts: shortTs(m.ts),
    rawTs: String(m.ts || ""),
    cursor: String(m.cursor ?? ""),
    derived: redact(trailerLine(d).replace(/\n$/, "").trim()),
    title: titleText === null ? null : redact(titleText),
    body: cut(body, BODY_MAX),
    attachmentText: redact(attachmentLines(d).replace(/^\n/, "")),
    trailers,
    to: Array.isArray(d.to) ? d.to.map(String) : [],
  };
}

/**
 * Bearers a reply in `threadId` is addressed to when the person picks no one: the root's author
 * when it is an agent, plus every other agent on the root author's seat who spoke in the thread (a
 * desk that was renamed keeps its old and new names reachable). Without a `to:` a reply wakes no
 * `--wake mine` watch, and a whole-room watcher cannot tell whom it was for. Humans and the sender
 * are never addressed; a human-authored root addresses nobody.
 * @param {PaneMessage[]} messages @param {string} threadId @param {string | null} sender @param {string} hostAccountId
 */
export function pickAddressees(messages, threadId, sender, hostAccountId) {
  const root = messages.find((m) => m.id === threadId);
  if (!root || root.author.kind === "human") return [];
  const rootSeat = seatKindOf(root.author.id, hostAccountId);
  /** @type {string[]} */
  const names = [];
  for (const m of messages) {
    if (m.id !== threadId && m.thread !== threadId) continue;
    if (m.author.kind === "human") continue;
    if (seatKindOf(m.author.id, hostAccountId) !== rootSeat) continue;
    const name = String(m.signedAs || m.author.name || "").trim();
    if (!name || name === sender || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * The room's subjects, newest activity first, each with its conversation oldest first: the fold
 * the Claude pane uses (a first open marks nothing unread; your own posts never are), plus whom a
 * reply would be addressed to when the person picks no one.
 * @param {PaneMessage[]} messages ascending
 * @param {{ room: string, self: string | null, seen?: Record<string, string>, baselineId?: string | null, hostAccountId: string, now: number }} o
 */
export function subjectsOf(messages, { room, self, seen = {}, baselineId = null, hostAccountId, now }) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const msgs = messages.map((m) => ({ room, id: m.id, thread: m.thread, from: m.author.name, text: m.body, cursor: m.cursor, ts: m.rawTs || null, to: m.to, title: m.title, signedAs: m.signedAs }));
  return buildSubjects(msgs, { self, seen, baselineId }).map((s) => ({
    id: s.id,
    title: s.title,
    fullTitle: subjectTitle(s.messages.find((m) => m.id === s.id) ?? /** @type {any} */ (s.messages[0]), 400),
    rootInWindow: s.rootInWindow,
    rootFrom: s.rootFrom,
    lastFrom: s.lastFrom,
    count: s.count,
    replies: s.rootInWindow ? s.count - 1 : s.count,
    unread: s.unread,
    latestId: s.latestId,
    latestTs: shortTs(s.latestTs),
    age: ago(s.latestTs, now),
    meta: subjectMeta(s, now),
    autoTo: pickAddressees(messages, s.id, self, hostAccountId),
    messages: s.messages.map((x) => {
      const m = /** @type {PaneMessage} */ (byId.get(x.id));
      return {
        id: m.id,
        from: m.speaker,
        kind: m.author.kind,
        seat: m.seat,
        age: ago(m.rawTs || null, now),
        ts: m.ts,
        to: m.to,
        body: m.body,
        derived: m.derived,
        attachmentText: m.attachmentText,
        cursor: m.cursor,
        mine: self !== null && (m.author.name === self || m.signedAs === self),
      };
    }),
  }));
}

/** Seat-origin words for a speaker. */
const ORIGIN_LABEL = Object.freeze({ member: "member seat", host: "this seat", "": "" });

/**
 * Claims, verdicts and the room's speakers from the messages read. `watching` is true only when a
 * session on this seat with that bearer has a live watch armed on this room: nothing here says
 * whether anyone is live elsewhere, and a speaker's kind never implies presence.
 * @param {PaneMessage[]} messages @param {Set<string>} watchingBearers
 */
export function boardOf(messages, watchingBearers) {
  /** @type {Map<string, any>} */
  const claims = new Map();
  /** @type {any[]} */
  const verdicts = [];
  const withdrawn = new Set();
  /** @type {Map<string, any>} */
  const who = new Map();
  for (const m of messages) for (const t of m.trailers) if (t.key === "withdraws") withdrawn.add(t.value.trim());
  messages.forEach((m, at) => {
    const gone = withdrawn.has(m.id) || withdrawn.has(m.cursor);
    const w = who.get(m.speaker) ?? { speaker: m.speaker, authorName: m.author.name, kind: m.author.kind, origin: ORIGIN_LABEL[/** @type {"member" | "host" | ""} */ (m.seat)] ?? "", count: 0, watching: false };
    w.count++;
    w.kind = m.author.kind;
    w.lastTs = m.ts;
    w.lastCursor = m.cursor;
    w.order = at;
    who.set(m.speaker, w);
    let verdict = "";
    let because = "";
    /** @type {string[]} */
    const exhibits = [];
    for (const t of m.trailers) {
      if (t.key === "claim") claims.set(t.value, { subject: t.value, holder: m.speaker, status: gone ? "withdrawn" : "held", cursor: m.cursor, ts: m.ts, messageId: m.id });
      else if (t.key === "release") claims.set(t.value, { subject: t.value, holder: m.speaker, status: "released", cursor: m.cursor, ts: m.ts, messageId: m.id });
      else if (t.key === "verdict") verdict = t.value;
      else if (t.key === "exhibit") exhibits.push(t.value);
      else if (t.key === "because") because = t.value;
    }
    if (verdict) verdicts.push({ verdict, exhibit: exhibits.join(" · "), because, author: m.speaker, status: gone ? "withdrawn" : "standing", cursor: m.cursor, ts: m.ts, messageId: m.id });
  });
  for (const w of who.values()) w.watching = w.kind !== "human" && (watchingBearers.has(w.speaker) || watchingBearers.has(w.authorName));
  return {
    claims: [...claims.values()].reverse(),
    verdicts: verdicts.reverse(),
    who: [...who.values()].sort((a, b) => b.order - a.order),
  };
}

/** This seat's sessions, live first, with the watches each holds armed. @param {string} stateRoot */
export async function seatSessions(stateRoot) {
  /** @type {Map<string, any[]>} */
  const armedBySlug = new Map();
  try {
    for (const { slug, key, armed } of await listArmed(stateRoot)) {
      if (!armedAlive(armed)) continue;
      const a = /** @type {any} */ (armed);
      const list = armedBySlug.get(slug) ?? [];
      list.push({ key, room: String(a.room || ""), thread: a.thread ? String(a.thread) : "", mode: a.mode || "poll", wake: a.wake || "all", pid: a.pid || 0 });
      armedBySlug.set(slug, list);
    }
  } catch { /* no watches */ }
  const records = await listRecords(stateRoot);
  const sessions = records.map((r) => {
    const rec = /** @type {any} */ (r.record);
    const rooms = Array.isArray(/** @type {any} */ (r).rooms) ? /** @type {string[]} */ (/** @type {any} */ (r).rooms) : [];
    return {
      slug: String(r.slug || ""),
      record: rec,
      bearer: String(rec?.bearer || "(unregistered)"),
      label: String(rec?.label || ""),
      pid: Number(rec?.pid) || 0,
      state: r.state === "live" ? "live" : r.state === "gone" ? "dark" : "unknown",
      lastSeen: shortTs(rec?.lastSeen).slice(0, 16),
      rooms: rooms.filter((x) => !x.includes("#")),
      threadCount: rooms.filter((x) => x.includes("#")).length,
      armed: armedBySlug.get(String(r.slug || "")) ?? [],
    };
  });
  const order = { live: 0, unknown: 1, dark: 2 };
  sessions.sort((a, b) => order[/** @type {"live" | "unknown" | "dark"} */ (a.state)] - order[/** @type {"live" | "unknown" | "dark"} */ (b.state)] || b.lastSeen.localeCompare(a.lastSeen));
  return sessions;
}

/**
 * The config's residents table, each with the live sessions that hold it (by position, the way
 * `agora resident cycle` matches them), or once as idle when none does.
 * @param {any} cfg @param {Awaited<ReturnType<typeof seatSessions>>} sessions
 */
export function residentRows(cfg, sessions) {
  /** @type {any[]} */
  const out = [];
  for (const [slug, entry] of Object.entries(configuredResidents(cfg))) {
    const base = { slug, restart: entry.restart ? "set" : "" };
    const live = sessions.filter((s) => s.state === "live" && matchesResidentRecord(s.record, slug));
    if (!live.length) out.push({ ...base, state: "idle", bearer: "", label: "", lastSeen: "" });
    for (const s of live) out.push({ ...base, state: "live", bearer: s.bearer, label: s.label, lastSeen: s.lastSeen });
  }
  return out;
}

// ---- reading a room ----

/** @param {string} p @returns {any} */
function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * The messages of one room, oldest first, and how far they reach. A native room is read through
 * the seat service and a local room from its file; any other room through the CLI, a rate-limited
 * remote one (Slack, GitHub) reused for `REMOTE_CACHE_MS` unless `refreshRemote`.
 * @param {{ cfg: any, stateRoot: string, alias: string, human: { name: string }, dataDir: string | null, refreshRemote: boolean, cliArgs: string[], run: Run, env: Record<string, string> }} o
 */
async function readRoom({ cfg, stateRoot, alias, human, dataDir, refreshRemote, cliArgs, run, env }) {
  const rc = cfg.rooms[alias];
  const now = new Date().toISOString();
  /** @type {{ messages: any[], annotations: any[], fault: { kind: string, reason: string } | null, horizon: Record<string, string> }} */
  const out = { messages: [], annotations: [], fault: null, horizon: { oldestTs: "", oldestCursor: "", readTo: "", readAt: shortTs(now), source: `${rc.transport} room` } };
  const edges = () => {
    out.horizon.oldestTs = shortTs(out.messages[0]?.ts);
    out.horizon.oldestCursor = String(out.messages[0]?.cursor ?? "");
    if (!out.horizon.readTo) out.horizon.readTo = String(out.messages[out.messages.length - 1]?.cursor ?? "");
  };
  if (rc.transport === "native") {
    try {
      const c = await connect({ state: stateRoot, clientName: "tern-agora" });
      try {
        const r = /** @type {any} */ (await c.read({ roomId: rc.roomId }, { limit: READ_WINDOW }));
        out.messages = r.messages ?? [];
        out.annotations = r.annotations ?? [];
        out.horizon.readTo = String(r.through ?? "");
        out.horizon.source = `seat service ${/** @type {any} */ (c).seat?.label || "local"}`;
      } finally {
        c.close();
      }
    } catch (e) {
      const kind = e instanceof ClientError && /** @type {any} */ (e).outcome === "refused" ? "refused" : "dark";
      out.fault = { kind, reason: said(e) };
      out.horizon.source = `seat service (${kind})`;
    }
  } else if (rc.transport === "local") {
    try {
      const t = localTransport({ transport: "local", path: rc.path }, { actor: { name: human.name || "human", kind: "human" } });
      out.messages = await t.read({ limit: READ_WINDOW });
      out.horizon.source = "local file";
    } catch (e) {
      out.fault = { kind: "refused", reason: said(e) };
    }
  } else {
    const rateLimited = rc.transport !== "native-remote";
    const cacheFile = dataDir && rateLimited ? path.join(dataDir, `room-${alias.replace(/[^A-Za-z0-9._-]/g, "_")}.json`) : null;
    if (cacheFile && !refreshRemote && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < REMOTE_CACHE_MS) {
      const cached = readJson(cacheFile);
      if (cached && Array.isArray(cached.messages)) {
        out.messages = cached.messages;
        out.horizon = { ...out.horizon, ...cached.horizon, source: `${cached.horizon?.source ?? rc.transport} (reused)` };
        edges();
        return out;
      }
    }
    const r = await run([...cliArgs, "read", alias, "--limit", String(rateLimited ? REMOTE_READ_LIMIT : READ_WINDOW), "--json"], { env });
    if (r.code !== 0) {
      out.fault = { kind: "refused", reason: failure("read", r) };
    } else {
      out.messages = jsonLines(r.stdout).filter((j) => j && j.type === "message");
      out.horizon.source = `${rc.transport} (${rc.channel || rc.repo || rc.descriptor || alias})`;
      if (cacheFile) {
        try {
          mkdirSync(path.dirname(cacheFile), { recursive: true });
          writeFileSync(cacheFile, JSON.stringify({ messages: out.messages, horizon: out.horizon }));
        } catch { /* the cache is an optimisation */ }
      }
    }
  }
  edges();
  return out;
}

/**
 * Everything the pane draws for one room. `input` is what the pane keeps between reads: the last
 * message seen in each subject, the baseline (the newest message the first time the room was
 * opened), and the name the pane posts as when a post command decides it.
 * @param {{ pc: PaneConfig, room?: string | null, input?: any, dataDir?: string | null, refreshRemote?: boolean, env?: Record<string, string | undefined>, run?: Run, now?: number }} o
 */
export async function loadView({ pc, room = null, input = {}, dataDir = null, refreshRemote = false, env = process.env, run = runProcess, now = Date.now() }) {
  const cfg = /** @type {any} */ (await loadConfig(pc.config ?? undefined));
  const stateRoot = stateDir(cfg);
  const all = roomRows(cfg, stateRoot);
  const offered = offeredRooms(all, pc);
  const alias = room && offered.some((r) => r.alias === room) ? room : defaultRoom(offered, pc);
  const problems = [...pc.problems];
  if (room && alias !== room) problems.push(`room ${JSON.stringify(room)} is not one the pane offers; showing ${alias ?? "none"}`);
  const service = inspectService(stateRoot);
  const human = readHuman(stateRoot);
  const sessions = await seatSessions(stateRoot);
  const residents = residentRows(cfg, sessions);
  const cliArgs = configCli(pc);
  const cliEnv = childEnv(env);
  const base = {
    ok: true,
    generatedAt: shortTs(new Date(now).toISOString()),
    rooms: offered,
    human,
    service,
    posting: postingLabel(pc, alias ? cfg.rooms[alias] : null),
    sessions: {
      counts: {
        live: sessions.filter((s) => s.state === "live").length,
        dark: sessions.filter((s) => s.state === "dark").length,
        unknown: sessions.filter((s) => s.state === "unknown").length,
        armed: sessions.reduce((n, s) => n + s.armed.length, 0),
      },
      items: sessions.slice(0, 45).map(({ record: _r, ...s }) => s),
    },
    residents,
    problems,
  };
  if (!alias) return { ...base, room: null, transport: "", fault: { kind: "refused", reason: "the agora config has no room the pane offers" }, horizon: {}, subjects: [], board: { claims: [], verdicts: [], who: [] }, watching: [], self: null, baselineId: null, hasBaseline: false, newest: null };

  const read = await readRoom({ cfg, stateRoot, alias, human, dataDir, refreshRemote, cliArgs, run, env: cliEnv });
  /** @type {Map<string, string>} */
  const titleById = new Map();
  if (read.annotations.length) {
    for (const m of /** @type {any[]} */ (foldAnnotations(read.messages, read.annotations))) if (m.title && typeof m.title.text === "string") titleById.set(String(m.id), m.title.text);
  }
  const messages = read.messages.map((m) => formatMessage(titleById.has(String(m.id)) ? { ...m, title: titleById.get(String(m.id)) } : m, service.accountId));

  let self = pc.post.command ? (typeof input.self === "string" && input.self ? input.self : null) : human.name || null;
  if (pc.post.command && self === null) {
    const me = await run([...pc.post.command, "whoami", alias, "--json"], { env: childEnv(env, pc.post.env) });
    if (me.code === 0) self = jsonLines(me.stdout)[0]?.name ?? null;
  }
  const newest = messages.length ? messages[messages.length - 1].id : null;
  const hasBaseline = input.hasBaseline === true;
  const baselineId = hasBaseline ? (input.baselineId ?? null) : newest;
  const seen = input.seen && typeof input.seen === "object" ? input.seen : {};
  const watching = [];
  for (const s of sessions) for (const a of s.armed) if (a.room === alias) watching.push({ bearer: s.bearer, session: s.slug, state: s.state, mode: a.mode, wake: a.wake, thread: a.thread, pid: a.pid });

  return {
    ...base,
    room: alias,
    transport: String(cfg.rooms[alias].transport || ""),
    fault: read.fault,
    horizon: read.horizon,
    self,
    baselineId,
    hasBaseline: true,
    newest,
    windowSize: messages.length,
    subjects: subjectsOf(messages, { room: alias, self, seen, baselineId, hostAccountId: service.accountId, now }),
    board: boardOf(messages, new Set(watching.map((w) => w.bearer))),
    watching,
  };
}

/** The checkout's CLI, with the pane's config when one is set. @param {PaneConfig} pc */
function configCli(pc) {
  return pc.config ? [...CLI, "--config", pc.config] : [...CLI];
}

/** How a post from the pane travels, in words for the compose card. @param {PaneConfig} pc @param {any} rc */
export function postingLabel(pc, rc) {
  if (pc.post.command) return { via: "command", detail: "through the configured post command" };
  if (!rc) return { via: "none", detail: "" };
  if (rc.transport === "native") return { via: "native", detail: "as this seat's human, through the seat service" };
  if (rc.transport === "local") return { via: "local", detail: "as this seat's human, to the room's file" };
  return { via: "cli", detail: `through the agora CLI (${rc.transport})` };
}

// ---- posting ----

/**
 * One post from the pane, signed as the person: the room and thread are exactly what the compose
 * card stated, and `to` what it said the post is addressed to. A `to:` line typed in the text wins.
 * @param {{ pc: PaneConfig, room: string, text: string, thread?: string | null, to?: string[], env?: Record<string, string | undefined>, run?: Run }} o
 */
export async function postFromPane({ pc, room, text, thread = null, to = [], env = process.env, run = runProcess }) {
  const body = String(text ?? "").replace(/\s+$/, "");
  if (!body.trim()) return { ok: false, error: "nothing to post: the draft is empty" };
  if (redact(body) !== body) return { ok: false, error: "refused: the draft carries a credential shape" };
  const cfg = /** @type {any} */ (await loadConfig(pc.config ?? undefined));
  const offered = offeredRooms(roomRows(cfg, stateDir(cfg)), pc);
  if (!offered.some((r) => r.alias === room)) return { ok: false, error: `room ${JSON.stringify(room)} is not one the pane offers` };
  const stateRoot = stateDir(cfg);
  const typedTo = parseTrailers(body).to;
  const addressees = typedTo.length ? [] : to.filter(Boolean);

  if (pc.post.command) return cliPost({ argv: pc.post.command, env: childEnv(env, pc.post.env), room, body, thread, addressees, typedTo, run });

  const rc = cfg.rooms[room];
  const human = readHuman(stateRoot);
  if (!human.name) return { ok: false, error: "no name yet: set your name first (palette: Agora: set your name)" };
  try {
    const nonce = String((/** @type {any} */ (await readServiceDescriptor(stateRoot)))?.nonce ?? "");
    if (nonce.length >= 8 && body.includes(nonce)) return { ok: false, error: "refused: the draft carries the seat service nonce" };
  } catch { /* no service descriptor */ }
  const actor = { name: human.name, kind: /** @type {const} */ ("human") };
  // the trailer block goes above the signature (the signature is the last line, or the post reads as unsigned)
  const signed = sign(addressees.length ? withTrailers(body, addressees.map((a) => ({ key: "to", value: a }))) : body, actor);
  try {
    if (rc.transport === "native") {
      const c = await connect({ state: stateRoot, clientName: "tern-agora" });
      try {
        const receipt = /** @type {any} */ (await c.append({ roomId: rc.roomId }, { text: signed, author: actor, operationId: randomUUID().replaceAll("-", ""), ...(thread ? { thread } : {}) }));
        return { ok: true, receipt: { id: receipt.id ?? null, cursor: receipt.cursor ?? null, thread }, to: addressees.length ? addressees : typedTo };
      } finally {
        c.close();
      }
    }
    if (rc.transport === "local") {
      const t = localTransport({ transport: "local", path: rc.path }, { actor });
      const receipt = /** @type {any} */ (await t.post(signed, thread ? { thread } : {}));
      return { ok: true, receipt: { id: receipt.id ?? null, cursor: receipt.cursor ?? null, thread }, to: addressees.length ? addressees : typedTo };
    }
  } catch (e) {
    return { ok: false, error: said(e) };
  }
  return cliPost({ argv: [...configCli(pc)], env: childEnv(env), room, body, thread, addressees, typedTo, run, as: human.name });
}

/** @param {{ argv: string[], env: Record<string, string>, room: string, body: string, thread: string | null, addressees: string[], typedTo: string[], run: Run, as?: string }} o */
async function cliPost({ argv, env, room, body, thread, addressees, typedTo, run, as }) {
  const built = postArgs({ room, text: body, thread, to: addressees });
  if (!built.ok) return { ok: false, error: built.error };
  const tail = as ? [...built.args.slice(0, -2), "--as", as, ...built.args.slice(-2)] : built.args;
  const r = await run([...argv, ...tail], { env });
  if (r.code !== 0) return { ok: false, error: failure("post", r) };
  const lines = jsonLines(r.stdout);
  const receipt = lines.find((j) => j.id && j.cursor !== undefined) ?? lines[0] ?? null;
  return { ok: true, receipt: receipt ? { id: receipt.id ?? null, cursor: receipt.cursor ?? null, thread: receipt.thread ?? thread } : null, to: addressees.length ? addressees : typedTo };
}

// ---- seat actions ----

/** The seat verbs the pane's buttons run, each one CLI call. */
export const SEAT_ACTIONS = Object.freeze({
  "service-start": ["service", "start", "--json"],
  "service-stop": ["service", "stop", "--json"],
  "resident-cycle-dry": ["resident", "cycle", "--all", "--dry-run", "--json"],
  "prune-sessions-dry": ["session", "--prune", "--dry-run", "--json"],
});

// ---- the bridge ----

/**
 * The bridge's verbs, each one JSON-able object and never a throw: the pane shows `error`.
 * `config` what the pane is set up with; `rooms` the rooms it offers; `view` one room; `post` one
 * post; `set-name` the seat's human; and the seat actions.
 * @param {string} verb
 * @param {{ env?: Record<string, string | undefined>, file?: string | null, dataDir?: string | null, room?: string | null, thread?: string | null, to?: string[], refreshRemote?: boolean, input?: any, run?: Run, now?: number }} o
 */
export async function handle(verb, { env = process.env, file = null, dataDir = null, room = null, thread = null, to = [], refreshRemote = false, input = {}, run = runProcess, now = Date.now() } = {}) {
  const { file: data, problem } = readDataFile(file);
  const pc = resolvePaneConfig({ env, file: data });
  if (problem) pc.problems.push(problem);
  try {
    if (verb === "config") return { ok: true, rooms: pc.rooms, room: pc.room, config: pc.config, postCommand: pc.post.command, intervalMs: pc.intervalMs, problems: pc.problems };
    if (verb === "rooms") {
      const cfg = /** @type {any} */ (await loadConfig(pc.config ?? undefined));
      const offered = offeredRooms(roomRows(cfg, stateDir(cfg)), pc);
      return { ok: true, rooms: offered.map(({ nativeMeta: _n, ...r }) => r), room: defaultRoom(offered, pc), problems: pc.problems };
    }
    if (verb === "view") return await loadView({ pc, room, input, dataDir, refreshRemote, env, run, now });
    if (verb === "post") return await postFromPane({ pc, room: String(room ?? ""), text: String(input?.text ?? ""), thread, to, env, run });
    if (verb === "set-name") {
      const cfg = /** @type {any} */ (await loadConfig(pc.config ?? undefined));
      return { ok: true, human: writeHuman(stateDir(cfg), String(input?.name ?? "")) };
    }
    const action = /** @type {Record<string, readonly string[]>} */ (SEAT_ACTIONS)[verb];
    if (action) {
      const r = await run([...configCli(pc), ...action], { env: childEnv(env) });
      const out = redact(`${r.stdout}\n${r.stderr}`.trim());
      return r.code === 0 ? { ok: true, output: cut(out, 4000) } : { ok: false, error: failure(verb, r), output: cut(out, 4000) };
    }
    return { ok: false, error: `unknown verb ${JSON.stringify(verb)} (config, rooms, view, post, set-name, ${Object.keys(SEAT_ACTIONS).join(", ")})` };
  } catch (e) {
    return { ok: false, error: said(e) };
  }
}
