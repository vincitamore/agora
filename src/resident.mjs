// @ts-check
/**
 * Residents: a standing session bound to one room and one subject, stood up from a profile,
 * that survives a restart by inheriting its predecessor's positions.
 *
 * Three things live here. (1) The prompt render: a profile plus the shipped room-mechanics
 * block, so a resident carries the resident-sized discipline instead of a full skill. (2) The
 * cycle guard: a resident whose last inference is older than the harness prompt-cache TTL and
 * whose context is above a floor pays a cold read of that whole context on its next wake, while
 * a successor pays only its orientation floor; the guard measures both from the harness's own
 * transcript and, when both hold, writes an inherit marker and (optionally) restarts the unit.
 * (3) The marker: `<state>/residents/<slug>/inherit.json` names the predecessor session; the
 * successor's arming step consumes it through `agora resident inherit <slug>`, which calls the
 * same `inheritSession` as `session --inherit`.
 *
 * Idle is measured from the last ASSISTANT message, never from the transcript's mtime: hooks and
 * monitors append to the file without an inference. A harness whose transcript this module cannot
 * read reports `unsupported`, never a guess.
 */
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { AgoraError, EXIT, writeFileAtomic } from "./core.mjs";
import { listRecords } from "./session.mjs";

export const RESIDENT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DEFAULT_IDLE_SECONDS = 3900; // a one-hour prompt-cache TTL plus a margin
export const DEFAULT_MIN_CONTEXT = 150_000;
export const ROOM_MECHANICS_DOC = "docs/resident-room-mechanics.md";

/** @param {string} slug */
export function assertResidentSlug(slug) {
  if (!RESIDENT_SLUG_RE.test(slug)) throw new AgoraError(`a resident slug is lower-case letters, digits, . _ - (${RESIDENT_SLUG_RE}); ${JSON.stringify(slug)} is not one`, EXIT.usage);
  return slug;
}

/** @param {string} stateRoot @param {string} slug */
export function residentDir(stateRoot, slug) {
  return path.join(stateRoot, "residents", assertResidentSlug(slug));
}

/** @param {string} stateRoot @param {string} slug */
export function inheritMarkerPath(stateRoot, slug) {
  return path.join(residentDir(stateRoot, slug), "inherit.json");
}

/**
 * The profile text with the shipped room-mechanics block appended: one source for the block,
 * rendered per launch. A profile that already carries the block's heading is returned as is.
 * @param {string} profile @param {string} block
 */
export function renderResidentPrompt(profile, block) {
  const heading = block.split("\n")[0].trim();
  if (heading && profile.includes(heading)) return profile;
  const body = profile.endsWith("\n") ? profile : profile + "\n";
  return `${body}\n${block.endsWith("\n") ? block : block + "\n"}`;
}

/**
 * The Claude Code transcript for a session record, when the record came from that harness:
 * `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`. The uuid is what follows the harness
 * prefix in the session slug; the project directory is found by listing, never guessed from cwd.
 * @param {{ slug: string, source?: string }} rec
 * @param {{ home?: string }} [deps]
 * @returns {{ status: 'found', harness: 'claude-code', file: string } | { status: 'unsupported', reason: string }}
 */
export function transcriptFor(rec, deps = {}) {
  if (rec.source !== "CLAUDE_CODE_SESSION_ID" || !rec.slug.startsWith("claude-code-"))
    return { status: "unsupported", reason: `context measurement reads Claude Code transcripts only; ${rec.slug} came from ${rec.source ?? "an unknown source"}` };
  const uuid = rec.slug.slice("claude-code-".length);
  const projects = path.join(deps.home ?? homedir(), ".claude", "projects");
  if (!existsSync(projects)) return { status: "unsupported", reason: `no transcripts under ${projects}` };
  for (const dir of readdirSync(projects)) {
    const file = path.join(projects, dir, `${uuid}.jsonl`);
    if (existsSync(file)) return { status: "found", harness: "claude-code", file };
  }
  return { status: "unsupported", reason: `no transcript ${uuid}.jsonl under ${projects}` };
}

/**
 * Last inference and current context from a Claude Code transcript: the newest assistant
 * message's usage, context = input + cache read + cache creation (what the next request re-reads).
 * Streams the file; a transcript is append-only and can be large.
 * @param {string} file
 * @returns {Promise<{ lastInference: string, context: number, uncached: number, cacheRead: number, cacheWrite: number } | null>}
 */
export async function measureClaudeTranscript(file) {
  /** @type {{ lastInference: string, context: number, uncached: number, cacheRead: number, cacheWrite: number } | null} */
  let last = null;
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"assistant"')) continue;
    /** @type {any} */
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "assistant" || typeof o.timestamp !== "string") continue;
    const u = o.message?.usage;
    if (!u || typeof u !== "object") continue;
    const n = (/** @type {unknown} */ v) => (Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : 0);
    const uncached = n(u.input_tokens), cacheRead = n(u.cache_read_input_tokens), cacheWrite = n(u.cache_creation_input_tokens);
    last = { lastInference: o.timestamp, context: uncached + cacheRead + cacheWrite, uncached, cacheRead, cacheWrite };
  }
  return last;
}

/**
 * The verdict for one resident, pure given its inputs. `sessions` are the seat's records with
 * liveness; the resident's session is the newest live record whose bearer ends in `/<slug>`.
 * @param {object} a
 * @param {string} a.slug
 * @param {Array<{ slug: string, state: string, record?: any }>} a.sessions
 * @param {(rec: any) => Promise<{ status: 'measured', lastInference: string, context: number, file: string } | { status: 'unsupported', reason: string }>} a.measure
 * @param {Date} [a.now]
 * @param {number} [a.idleSeconds]
 * @param {number} [a.minContext]
 */
export async function cycleVerdict({ slug, sessions, measure, now = new Date(), idleSeconds = DEFAULT_IDLE_SECONDS, minContext = DEFAULT_MIN_CONTEXT }) {
  assertResidentSlug(slug);
  const live = sessions.filter((s) => s.state === "live" && s.record && typeof s.record.bearer === "string" && s.record.bearer.endsWith("/" + slug));
  /** @type {Record<string, unknown>} */
  const row = { type: "resident", resident: slug };
  if (!live.length) return { ...row, action: "none", reason: "no live session signs as this resident" };
  live.sort((a, b) => String(b.record.startedAt ?? "").localeCompare(String(a.record.startedAt ?? "")));
  const s = live[0];
  row.session = s.slug;
  row.bearer = s.record.bearer;
  const m = await measure({ slug: s.slug, ...s.record });
  if (m.status !== "measured") return { ...row, action: "none", reason: m.reason };
  const idle = Math.floor((now.getTime() - new Date(m.lastInference).getTime()) / 1000);
  Object.assign(row, { lastInference: m.lastInference, idleSeconds: idle, context: m.context, transcript: m.file });
  if (!Number.isFinite(idle)) return { ...row, action: "none", reason: "the last inference carries no readable timestamp" };
  if (idle < idleSeconds) return { ...row, action: "none", reason: `warm or working: idle ${idle}s < ${idleSeconds}s` };
  if (m.context < minContext) return { ...row, action: "none", reason: `small: context ${m.context} < ${minContext}` };
  return { ...row, action: "cycle", reason: `cold ${idle}s and context ${m.context} >= ${minContext}` };
}

/** The default measurement: the harness transcript, or unsupported by name.
 * @param {{ home?: string }} [deps] */
export function transcriptMeasure(deps = {}) {
  return async (/** @type {any} */ rec) => {
    const t = transcriptFor(rec, deps);
    if (t.status !== "found") return t;
    const m = await measureClaudeTranscript(t.file);
    if (!m) return { status: /** @type {const} */ ("unsupported"), reason: `${t.file} holds no assistant usage yet` };
    return { status: /** @type {const} */ ("measured"), ...m, file: t.file };
  };
}

/**
 * Plan one resident's cycle against the seat's live records.
 * @param {string} stateRoot @param {string} slug
 * @param {{ now?: Date, idleSeconds?: number, minContext?: number, home?: string, kill?: (pid: number, sig: 0) => void, boot?: number }} [opts]
 */
export async function planCycle(stateRoot, slug, opts = {}) {
  const sessions = await listRecords(stateRoot, { kill: opts.kill, boot: opts.boot });
  return cycleVerdict({ slug, sessions, measure: transcriptMeasure({ home: opts.home }), now: opts.now, idleSeconds: opts.idleSeconds, minContext: opts.minContext });
}

/**
 * The marker a successor consumes. Written whole and atomically; a second write replaces the
 * first (the newest predecessor is the one to inherit from).
 * @param {string} stateRoot @param {string} slug
 * @param {{ from: string, context?: number, lastInference?: string, by?: string }} fields
 */
export async function writeInheritMarker(stateRoot, slug, fields) {
  const file = inheritMarkerPath(stateRoot, slug);
  const rec = { type: "resident-inherit", slug, from: fields.from, at: new Date().toISOString(), context: fields.context ?? null, lastInference: fields.lastInference ?? null, by: fields.by ?? "cycle" };
  await writeFileAtomic(file, JSON.stringify(rec) + "\n");
  return { file, ...rec };
}

/** @param {string} stateRoot @param {string} slug
 * @returns {Promise<{ file: string, slug: string, from: string, at: string, context: number | null, lastInference: string | null, by: string } | null>} */
export async function readInheritMarker(stateRoot, slug) {
  const file = inheritMarkerPath(stateRoot, slug);
  try {
    const rec = JSON.parse(await readFile(file, "utf8"));
    if (rec?.type !== "resident-inherit" || typeof rec.from !== "string") throw new AgoraError(`${file} is not a resident inherit marker; remove it by hand`, EXIT.error);
    return { file, ...rec };
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
}

/** @param {string} stateRoot @param {string} slug */
export async function removeInheritMarker(stateRoot, slug) {
  await rm(inheritMarkerPath(stateRoot, slug), { force: true });
}

/**
 * The resident slugs named by the config (`residents: { <slug>: { restart?: string } }`).
 * Read only; the config is never written.
 * @param {any} cfg
 */
export function configuredResidents(cfg) {
  const table = cfg?.residents;
  if (!table || typeof table !== "object" || Array.isArray(table)) return {};
  /** @type {Record<string, { restart?: string }>} */
  const out = {};
  for (const [slug, v] of Object.entries(table)) {
    assertResidentSlug(slug);
    if (v && typeof v === "object" && !Array.isArray(v)) out[slug] = { restart: typeof (/** @type {any} */ (v)).restart === "string" ? (/** @type {any} */ (v)).restart : undefined };
    else out[slug] = {};
  }
  return out;
}

/** `{slug}` in a restart template is the resident. @param {string} template @param {string} slug */
export function restartCommand(template, slug) {
  return template.replaceAll("{slug}", assertResidentSlug(slug));
}
