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
 * same `inheritSession` as `session --inherit`; the agora-room extension and plugin run that verb
 * themselves before their first read. (4) The succeed request,
 * `<state>/residents/<slug>/succeed.json`: a resident asks to be handed to a fresh session (at a
 * task's close, past its working size), and the cycle honours it once the session's turn has ended.
 *
 * A live watch is either an armed record (`watch --stream`, `--until-new`) whose pid answers, or a
 * harness-owned watch's activity record (`<state>/sessions/<key>/activity.json`) whose heartbeat is
 * fresh: the agora-room extension and plugin poll the room from inside the harness and write no
 * armed record, so their heartbeat is the evidence that a quiet resident is listening.
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
import { ACTIVITY_FILE, DEFAULT_BOUNDS, parseActivity } from "./messenger.mjs";
import { armedAlive, inheritSession, listArmed, listRecords, positionOf } from "./session.mjs";
import { readCarryEvidence } from "./carry-check.mjs";

export const RESIDENT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DEFAULT_IDLE_SECONDS = 3900; // a one-hour prompt-cache TTL plus a margin
export const DEFAULT_MIN_CONTEXT = 150_000;
export const DEFAULT_MAX_CONTEXT = 400_000; // past this, cycle even warm, between turns
export const DEFAULT_DEAF_SECONDS = 900; // no live watch and no inference for this long: deaf
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
 * @returns {{ status: 'found', harness: 'claude-code' | 'omp', file: string } | { status: 'unsupported', reason: string }}
 */
export function transcriptFor(rec, deps = {}) {
  const home = deps.home ?? homedir();
  if ((rec.source === "OMP_SESSION_ID" || rec.source === "AGORA_SESSION (OMP_SESSION_ID)") && rec.slug.startsWith("omp-")) {
    const uuid = rec.slug.slice("omp-".length);
    const sessions = path.join(home, ".omp", "agent", "sessions");
    if (!existsSync(sessions)) return { status: "unsupported", reason: `no transcripts under ${sessions}` };
    for (const dir of readdirSync(sessions)) {
      const bucket = path.join(sessions, dir);
      let entries;
      try { entries = readdirSync(bucket); } catch { continue; }
      for (const name of entries) {
        if (name === `${uuid}.jsonl` || name.endsWith(`_${uuid}.jsonl`)) {
          return { status: "found", harness: "omp", file: path.join(bucket, name) };
        }
      }
    }
    return { status: "unsupported", reason: `no transcript *_${uuid}.jsonl under ${sessions}` };
  }
  if ((rec.source !== "CLAUDE_CODE_SESSION_ID" && rec.source !== "AGORA_SESSION (CLAUDE_CODE_SESSION_ID)") || !rec.slug.startsWith("claude-code-"))
    return { status: "unsupported", reason: `context measurement reads Claude Code or OMP transcripts only; ${rec.slug} came from ${rec.source ?? "an unknown source"}` };
  const uuid = rec.slug.slice("claude-code-".length);
  const projects = path.join(home, ".claude", "projects");
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
    // A harness-written entry is not an inference: Claude Code logs an API error (529, spend limit)
    // as model "<synthetic>" with all-zero usage. Taking it as the newest reading measured two
    // 700K residents as context 0 for three days, so the guard called them small and never cycled.
    if (o.message?.model === "<synthetic>") continue;
    const n = (/** @type {unknown} */ v) => (Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : 0);
    const uncached = n(u.input_tokens), cacheRead = n(u.cache_read_input_tokens), cacheWrite = n(u.cache_creation_input_tokens);
    if (uncached + cacheRead + cacheWrite + n(u.output_tokens) === 0) continue;
    last = { lastInference: o.timestamp, context: uncached + cacheRead + cacheWrite, uncached, cacheRead, cacheWrite };
  }
  return last;
}

/**
 * Last inference and current context from an OMP transcript (`~/.omp/agent/sessions/<bucket>/<ts>_<uuid>.jsonl`):
 * the newest assistant message's usage, context = input + cacheRead + cacheWrite (input is exclusive in OMP).
 * @param {string} file
 * @returns {Promise<{ lastInference: string, context: number, uncached: number, cacheRead: number, cacheWrite: number } | null>}
 */
export async function measureOmpTranscript(file) {
  /** @type {{ lastInference: string, context: number, uncached: number, cacheRead: number, cacheWrite: number } | null} */
  let last = null;
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"assistant"')) continue;
    /** @type {any} */
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "message" || o?.message?.role !== "assistant" || typeof o.timestamp !== "string") continue;
    const u = o.message?.usage;
    if (!u || typeof u !== "object") continue;
    if (o.message?.model === "<synthetic>" || o.message?.stopReason === "aborted") continue;
    const n = (/** @type {unknown} */ v) => (Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : 0);
    const uncached = n(u.input ?? u.input_tokens);
    const cacheRead = n(u.cacheRead ?? u.cache_read_input_tokens);
    const cacheWrite = n(u.cacheWrite ?? u.cache_creation_input_tokens);
    const output = n(u.output ?? u.output_tokens);
    if (uncached + cacheRead + cacheWrite + output === 0) continue;
    last = { lastInference: o.timestamp, context: uncached + cacheRead + cacheWrite, uncached, cacheRead, cacheWrite };
  }
  return last;
}

/**
 * Where the session's turn stands, from its transcript's last conversational entry: an assistant
 * message that called no tool ends a turn; anything after it (a delivered line, a prompt, a tool's
 * result) or an assistant message that called a tool means a turn is running. Null when the
 * transcript holds no such entry. A harness error entry (Claude Code's `<synthetic>`) ends the turn
 * it broke.
 * @param {string} file @param {'claude-code' | 'omp'} harness
 * @returns {Promise<{ at: string, turnEnded: boolean } | null>}
 */
export async function turnState(file, harness) {
  /** @type {{ at: string, turnEnded: boolean } | null} */
  let last = null;
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    /** @type {any} */
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (typeof o?.timestamp !== "string") continue;
    if (harness === "omp") {
      if (o.type !== "message" || typeof o.message?.role !== "string") continue;
      last = { at: o.timestamp, turnEnded: o.message.role === "assistant" && o.message.stopReason !== "toolUse" };
    } else {
      if (o.type === "user") last = { at: o.timestamp, turnEnded: false };
      else if (o.type === "assistant") {
        const content = Array.isArray(o.message?.content) ? o.message.content : [];
        last = { at: o.timestamp, turnEnded: !content.some((/** @type {any} */ c) => c?.type === "tool_use") };
      }
    }
  }
  return last;
}

/**
 * The turn of the newest live session holding `position` on this seat: `none` when no live session
 * holds it, `unsupported` when its transcript cannot be read.
 * @param {string} stateRoot @param {string} position
 * @param {{ home?: string, kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 * @returns {Promise<{ status: 'none' } | { status: 'unsupported', reason: string, session: string } | { status: 'read', session: string, startedAt: string | null, at: string, turnEnded: boolean }>}
 */
export async function positionTurn(stateRoot, position, deps = {}) {
  const live = (await listRecords(stateRoot, { kill: deps.kill, boot: deps.boot })).filter((s) => s.state === "live" && matchesResidentRecord(s.record, position));
  if (!live.length) return { status: "none" };
  live.sort((a, b) => String(b.record?.startedAt ?? "").localeCompare(String(a.record?.startedAt ?? "")));
  const s = live[0];
  const t = transcriptFor({ slug: s.slug, source: s.record?.source }, { home: deps.home });
  if (t.status !== "found") return { status: "unsupported", reason: t.reason, session: s.slug };
  const turn = await turnState(t.file, t.harness);
  if (!turn) return { status: "unsupported", reason: `${t.file} holds no conversational entry yet`, session: s.slug };
  return { status: "read", session: s.slug, startedAt: s.record?.startedAt ?? null, ...turn };
}

/**
 * Does a session record belong to resident `slug`? A record that holds a position (`session
 * --label`, or AGORA_LABEL from the launcher) belongs to the resident of that position and to no
 * other, whatever its bearer says: `coding/Opus` labelled `desk.coding` is `desk.coding`, and the
 * bearer can change with the model while the position stays. A record without a position is
 * matched as it always was: by the `/<slug>` bearer suffix (`Opus/code-review`), or by a label
 * equal to the slug.
 * @param {any} record
 * @param {string} slug
 */
export function matchesResidentRecord(record, slug) {
  if (!record || typeof record.bearer !== "string") return false;
  const position = positionOf(record);
  if (position !== undefined) return position === slug;
  return record.bearer.endsWith("/" + slug) || record.label === slug;
}

/**
 * The verdict for one resident, pure given its inputs. `sessions` are the seat's records with
 * liveness; the resident's session is the newest live record matching `slug` (`matchesResidentRecord`: its position, else its `/<slug>` bearer suffix).
 * @param {object} a
 * @param {string} a.slug
 * @param {Array<{ slug: string, state: string, record?: any }>} a.sessions
 * @param {(rec: any) => Promise<{ status: 'measured', lastInference: string, context: number, file: string } | { status: 'unsupported', reason: string }>} a.measure
 * @param {Date} [a.now]
 * @param {number} [a.idleSeconds]
 * @param {number} [a.minContext]
 * @param {number} [a.maxContext] cycle past this even warm, once idle past `deafSeconds`
 * @param {number} [a.deafSeconds] the grace a resident with no live watch gets before it is deaf
 * @param {number} [a.watching] live watches the session holds (armed records whose pid answers, plus a fresh harness-owned watch heartbeat); absent = not measured, no deaf verdict
 * @param {string | null} [a.activityAt] the heartbeat of the session's harness-owned watch, when it keeps an activity record
 * @param {{ at: string, turn: Awaited<ReturnType<typeof positionTurn>>, held?: Array<{ subject: string, at: string }> }} [a.succeed] a pending succeed request, the session's turn, and the claims it took after the request and still holds
 */
export async function cycleVerdict({ slug, sessions, measure, now = new Date(), idleSeconds = DEFAULT_IDLE_SECONDS, minContext = DEFAULT_MIN_CONTEXT, maxContext = DEFAULT_MAX_CONTEXT, deafSeconds = DEFAULT_DEAF_SECONDS, watching, activityAt, succeed }) {
  assertResidentSlug(slug);
  const live = sessions.filter((s) => s.state === "live" && matchesResidentRecord(s.record, slug));
  /** @type {Record<string, unknown>} */
  const row = { type: "resident", resident: slug };
  if (!live.length) return { ...row, action: "none", reason: "no live session signs as this resident" };
  live.sort((a, b) => String(b.record.startedAt ?? "").localeCompare(String(a.record.startedAt ?? "")));
  const s = live[0];
  row.session = s.slug;
  row.bearer = s.record.bearer;
  const m = await measure({ slug: s.slug, ...s.record });
  // Succeed: the resident asked to be handed to a fresh session. Honoured only between turns, so no
  // tool call, child job or delivery in flight is cut off, and never while the session holds a claim
  // it took after the request (it asked at a close and then took the next task: mid-task, however
  // idle its turn); a request older than the session that holds the position now was already honoured.
  if (succeed) {
    row.succeed = succeed.at;
    if (m.status === "measured") Object.assign(row, { lastInference: m.lastInference, context: m.context, transcript: m.file });
    if (s.record.startedAt && Date.parse(succeed.at) < Date.parse(s.record.startedAt))
      return { ...row, action: "none", stale: true, reason: `the succeed request of ${succeed.at} predates this session (started ${s.record.startedAt}): it was honoured` };
    const t = succeed.turn;
    if (succeed.held?.length)
      return { ...row, action: "none", reason: `succeed requested ${succeed.at}; waits while this session holds ${succeed.held.map((h) => `${h.subject}, claimed ${h.at}`).join("; ")} after the request` };
    if (t.status !== "read") return { ...row, action: "none", reason: `succeed requested ${succeed.at}; its turn cannot be read (${t.status === "unsupported" ? t.reason : "no live session"}), so it waits` };
    if (!t.turnEnded) return { ...row, action: "none", reason: `succeed requested ${succeed.at}; waits for the running turn to end` };
    return { ...row, action: "cycle", reason: `succeed: requested ${succeed.at}; the turn ended ${Math.max(0, Math.floor((now.getTime() - Date.parse(t.at)) / 1000))}s ago` };
  }
  if (m.status !== "measured") return { ...row, action: "none", reason: m.reason };
  const idle = Math.floor((now.getTime() - new Date(m.lastInference).getTime()) / 1000);
  Object.assign(row, { lastInference: m.lastInference, idleSeconds: idle, context: m.context, transcript: m.file });
  if (!Number.isFinite(idle)) return { ...row, action: "none", reason: "the last inference carries no readable timestamp" };
  if (typeof watching === "number") row.watching = watching;
  if (activityAt !== undefined) row.activityAt = activityAt;
  // Deaf: no live watch and not working. A resident whose watches died (an API error on the turn
  // that should have re-armed them) never wakes again, so size and warmth are beside the point.
  if (watching === 0 && idle >= deafSeconds) return { ...row, action: "cycle", reason: `deaf: no live watch and idle ${idle}s >= ${deafSeconds}s` };
  // Ceiling: every wake re-reads the whole context, so past this a successor at the orientation
  // floor is cheaper even warm. Only between turns (idle past the deaf grace), never mid-work.
  if (m.context >= maxContext && idle >= deafSeconds) return { ...row, action: "cycle", reason: `ceiling: context ${m.context} >= ${maxContext} and idle ${idle}s >= ${deafSeconds}s` };
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
    const m = t.harness === "omp" ? await measureOmpTranscript(t.file) : await measureClaudeTranscript(t.file);
    if (!m) return { status: /** @type {const} */ ("unsupported"), reason: `${t.file} holds no assistant usage yet` };
    return { status: /** @type {const} */ ("measured"), ...m, file: t.file };
  };
}

/**
 * The watch evidence for one session: its armed records whose pid answers, and its harness-owned
 * watch's heartbeat. The agora-room extension and plugin rewrite the session's activity record on
 * their poll tick at least every heartbeat, whether or not anything arrived; a record refreshed
 * within the messenger's silent bound (the larger of D and three of the watch's own intervals) is
 * a watch that is polling. A resident that is quiet with such a watch is listening, not deaf.
 * @param {string} stateRoot @param {string} session
 * @param {{ now?: number, kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 * @returns {Promise<{ armed: number, activityAt: string | null, heard: boolean }>}
 */
export async function watchEvidence(stateRoot, session, deps = {}) {
  const now = deps.now ?? Date.now();
  const armed = (await listArmed(stateRoot)).filter((a) => a.slug === session && armedAlive(a.armed, deps)).length;
  let text;
  try { text = await readFile(path.join(stateRoot, "sessions", session, ACTIVITY_FILE), "utf8"); } catch { return { armed, activityAt: null, heard: false }; }
  const a = parseActivity(text, session);
  if (!a) return { armed, activityAt: null, heard: false };
  const silent = Math.max(DEFAULT_BOUNDS.D, 3 * (a.intervalMs ?? 0));
  return { armed, activityAt: new Date(a.updatedAt).toISOString(), heard: now - a.updatedAt <= silent };
}

/**
 * Plan one resident's cycle against the seat's live records.
 * @param {string} stateRoot @param {string} slug
 * @param {{ now?: Date, idleSeconds?: number, minContext?: number, maxContext?: number, deafSeconds?: number, home?: string, kill?: (pid: number, sig: 0) => void, boot?: number }} [opts]
 */
export async function planCycle(stateRoot, slug, opts = {}) {
  const deps = { kill: opts.kill, boot: opts.boot };
  const sessions = await listRecords(stateRoot, deps);
  // The live watches of the session the verdict will measure (the newest live one for this slug).
  const live = sessions.filter((s) => s.state === "live" && matchesResidentRecord(s.record, slug));
  live.sort((a, b) => String(b.record?.startedAt ?? "").localeCompare(String(a.record?.startedAt ?? "")));
  const ev = live.length ? await watchEvidence(stateRoot, live[0].slug, { ...deps, now: (opts.now ?? new Date()).getTime() }) : undefined;
  const watching = ev ? ev.armed + (ev.heard ? 1 : 0) : undefined;
  const request = await readSucceedRequest(stateRoot, slug);
  const succeed = request ? { at: request.at, turn: await positionTurn(stateRoot, slug, { home: opts.home, ...deps }), held: live.length ? await claimsSince(live[0].dir, request.at) : [] } : undefined;
  return cycleVerdict({ slug, sessions, measure: transcriptMeasure({ home: opts.home }), now: opts.now, idleSeconds: opts.idleSeconds, minContext: opts.minContext, maxContext: opts.maxContext, deafSeconds: opts.deafSeconds, watching, activityAt: ev?.activityAt, succeed });
}

/**
 * The claims a session took after `since` and has not released, from its own carry evidence (every
 * `claim:` and `release:` trailer it posted is captured there at the post), oldest first.
 * @param {string} dir the session's directory @param {string} since an ISO instant
 * @returns {Promise<Array<{ subject: string, at: string }>>}
 */
export async function claimsSince(dir, since) {
  const from = Date.parse(since);
  const events = (await readCarryEvidence(dir)).events.filter((e) => e.kind === "claim" || e.kind === "release").sort((a, b) => a.at.localeCompare(b.at));
  /** @type {Map<string, string>} */
  const open = new Map();
  for (const e of events) {
    const subject = String(e.subject);
    if (e.kind === "release") open.delete(subject);
    else if (Date.parse(e.at) > from && !open.has(subject)) open.set(subject, e.at);
  }
  return [...open].map(([subject, at]) => ({ subject, at }));
}

/** @param {string} stateRoot @param {string} slug */
export function succeedRequestPath(stateRoot, slug) {
  return path.join(residentDir(stateRoot, slug), "succeed.json");
}

/**
 * Ask the cycle to hand `slug` to a fresh session at its next tick between turns. A second request
 * replaces the first.
 * @param {string} stateRoot @param {string} slug @param {{ by: string, now?: Date }} fields
 */
export async function writeSucceedRequest(stateRoot, slug, fields) {
  const file = succeedRequestPath(stateRoot, slug);
  const rec = { type: "resident-succeed", slug, at: (fields.now ?? new Date()).toISOString(), by: fields.by };
  await writeFileAtomic(file, JSON.stringify(rec) + "\n");
  return { file, ...rec };
}

/** @param {string} stateRoot @param {string} slug
 * @returns {Promise<{ file: string, slug: string, at: string, by: string } | null>} */
export async function readSucceedRequest(stateRoot, slug) {
  const file = succeedRequestPath(stateRoot, slug);
  try {
    const rec = JSON.parse(await readFile(file, "utf8"));
    if (rec?.type !== "resident-succeed" || typeof rec.at !== "string") throw new AgoraError(`${file} is not a resident succeed request; remove it by hand`, EXIT.error);
    return { file, ...rec };
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
}

/** @param {string} stateRoot @param {string} slug */
export async function removeSucceedRequest(stateRoot, slug) {
  await rm(succeedRequestPath(stateRoot, slug), { force: true });
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
 * A start at a position whose last session is gone is a succession: the new session takes that
 * session's place, whatever model it runs. Writes the marker naming the newest session that held
 * `slug` on this seat and is not live, unless a marker is already pending whose predecessor still
 * has state here (a cycle's, or an earlier start's whose successor never consumed it: that
 * predecessor still holds what there is to inherit). Null when no session ever held the position.
 * @param {string} stateRoot @param {string} slug
 * @param {{ by?: string, kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 */
export async function markSuccession(stateRoot, slug, deps = {}) {
  const pending = await readInheritMarker(stateRoot, slug);
  if (pending && existsSync(path.join(stateRoot, "sessions", pending.from))) return { written: false, ...pending };
  const held = (await listRecords(stateRoot, deps)).filter((s) => s.state !== "live" && s.record && positionOf(s.record) === slug);
  if (!held.length) return null;
  held.sort((a, b) => String(b.record?.startedAt ?? "").localeCompare(String(a.record?.startedAt ?? "")));
  return { written: true, ...(await writeInheritMarker(stateRoot, slug, { from: held[0].slug, by: deps.by ?? "start" })) };
}

/**
 * `agora resident inherit <slug>`: consume the position's marker and take the predecessor's place
 * (its cursors, follow set and posted ledger, through `inheritSession`; the open claims and the
 * owed list are derived from that ledger by `carry`).
 *
 * A session that started after the marker was written is the successor the marker names. Any
 * position it already holds in a room it took since it started (a harness-owned watch reads the
 * room at its head before the arming sequence runs), so the predecessor's position replaces it
 * there: the messages between the two are the predecessor's unread, and the successor owes them.
 * A session older than the marker keeps `inheritSession`'s refusal unless `force`.
 * @param {string} stateRoot @param {string} slug @param {{ slug: string, source?: string }} session
 * @param {{ record?: { startedAt?: string } | null, force?: boolean, dryRun?: boolean }} [opts]
 */
export async function inheritResident(stateRoot, slug, session, opts = {}) {
  assertResidentSlug(slug);
  const marker = await readInheritMarker(stateRoot, slug);
  if (!marker) {
    // the extension or plugin consumed it before the arming sequence asked: say so, by name
    let prior = null;
    try { prior = JSON.parse(await readFile(path.join(stateRoot, "sessions", session.slug, "carry-inherited.json"), "utf8")); } catch { /* none */ }
    if (prior?.to === session.slug && typeof prior.from === "string") return { type: "resident-inherit", resident: slug, inherited: false, reason: "already", from: prior.from };
    return { type: "resident-inherit", resident: slug, inherited: false, reason: "no marker" };
  }
  if (marker.from === session.slug) {
    await removeInheritMarker(stateRoot, slug);
    throw new AgoraError(`the marker for ${slug} names this session (${session.slug}) as the predecessor; removed it. The successor runs inherit, not the session that was cycled.`, EXIT.usage);
  }
  if (!existsSync(path.join(stateRoot, "sessions", marker.from))) {
    await removeInheritMarker(stateRoot, slug);
    return { type: "resident-inherit", resident: slug, inherited: false, reason: "predecessor-gone", from: marker.from };
  }
  const startedAt = opts.record?.startedAt;
  const successor = typeof startedAt === "string" && Date.parse(startedAt) >= Date.parse(marker.at);
  const plan = await inheritSession(stateRoot, marker.from, /** @type {any} */ (session), { force: Boolean(opts.force) || successor, dryRun: opts.dryRun });
  if (!plan.dryRun) await removeInheritMarker(stateRoot, slug);
  return { type: "resident-inherit", resident: slug, inherited: !plan.dryRun, successor, marker: { at: marker.at, context: marker.context, lastInference: marker.lastInference, by: marker.by }, ...plan };
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
