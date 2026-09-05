// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { AgoraError, redact } from "./core.mjs";
import { parseTrailers } from "./trailers.mjs";
import { decodeTransfer } from "./tailcat.mjs";
import { SLACK_IMAGE_MAX_BYTES, SLACK_IMAGE_MAX_PER_MESSAGE, SLACK_TEXT_MAX, encodeSlackText } from "./transports/slack.mjs";
import { githubFaceHalf } from "./transports/github.mjs";

/**
 * A native room is the canonical log; a face is a copy of one message on a transport where an
 * addressee lives. This module owns the face policy record, the append-only face record log, the
 * selection of which faces a message gets, the outbound sequence (a durable `pending` line, then
 * the call, then the outcome), the picture upload ladder, the reconciliation of a lost response,
 * the restart sweep of stale `pending` faces, and the inbound loop check with the origin stamp.
 *
 * The property everything here rests on is an ORDER, not a catch block: the native receipt
 * returns before any transport call is issued, so native success never fails because a face is
 * dark, and the `pending` line is durable before the call, so a lost response is reconciled
 * against the channel and never retried blind.
 *
 * Seams left for P1 (the seat service): `transportFor` (builds the face transport from the
 * config room the face aliases; the token is read only inside the existing transport code),
 * `lookupCursor` (a read of one native message by cursor, for the `addressed` selector),
 * `readBlob` (the verified bytes of a durable attachment from custody), `attestor` (the service
 * ref stamped on every origin), and the two call sites: `FaceRunner.face` after `store.append`
 * returns, and `FaceRunner.poll` in place of the bridged reader's bare read.
 */

/** A `pending` face younger than this may still be echoing; older, it is swept to `unknown`. */
export const FACE_SETTLE_MS = 30_000;
/** How far before `pendingAt` a reconciliation window starts: clock skew between us and Slack. */
export const FACE_RECONCILE_LOOKBACK_MS = 5_000;
/** Reposts after which a face stops trying and records `refused`. */
export const FACE_MAX_ATTEMPTS = 3;
/** The rider: Slack's per-message metadata event type this tool stamps on every faced post. */
export const FACE_RIDER_EVENT = "agora_face";

export const FACE_SELECTORS = Object.freeze(["always", "never", "addressed", "landing"]);
export const FACE_ATTACHMENT_MODES = Object.freeze(["none", "metadata", "pictures"]);
export const FACE_STATUSES = Object.freeze(["pending", "published", "refused", "unknown"]);

const SHA40 = /^[0-9a-f]{40}$/;
const POLICY_VERSION = 1;
/** Transports with an audience a face can reach. `local` is a file; `native` is the log itself. */
export const FACE_CAPABLE = new Set(["slack", "github"]);

/**
 * What the faces layer needs of a transport beyond the shared contract, keyed by transport name:
 * the wire rendering and its limit, whether the face takes a thread or an upload, the rider it
 * stamps (if any), and how to read a raw history item (its id, its author, its text) so a lost
 * response reconciles against the far side. Everything transport-specific lives in a half; the
 * runner reads the half and never the transport's name.
 * @typedef {object} FaceHalf
 * @property {string} transport
 * @property {number} textMax the far side's limit on one message, in the units `encode` produces
 * @property {(text: string) => string} encode what goes on the wire for a body (Slack escapes `&<>`; GitHub verbatim)
 * @property {(rendered: number) => string} tooLong the `too-long` reason
 * @property {boolean} threads whether a face can carry a thread; when not, a threaded native message refuses `thread:`
 * @property {string} noThread the `thread:` reason, in the transport's own words
 * @property {boolean} uploads whether an upload ladder exists; when not, `pictures` is the honest text form
 * @property {string} noUpload the reason on each image's refused picture row when there is no ladder
 * @property {(alias: string) => string} addHint the command that gives a room this face (the `no-such-face` reason)
 * @property {(originId: string) => Record<string, unknown>} postOptions the rider, as post options (Slack's `metadata`; nothing for GitHub)
 * @property {(oldestMs: number, latestMs: number) => Record<string, string>} window a history window in the transport's own terms
 * @property {(raw: any) => string} idOf the transport's message id of a raw history item
 * @property {(raw: any) => string | undefined} rider the origin id a raw item's rider carries, when the transport has one
 * @property {(raw: any, who: { id: string, name: string, botId?: string }) => boolean} ownAccount is this raw item from the seat's own account
 * @property {(raw: any) => string | undefined} textOf the wire text of a raw item, to digest against `payloadDigest`
 * @property {(raw: any) => string[]} fileIds the file ids a raw item shares, for a picture's echo
 * @property {(attachment: any, line: string) => string} pictureLine the `pictures` text form of one attachment when there is no ladder
 */

/** Is this raw Slack message from the seat's own bot account? @param {any} m @param {{ id: string, name: string, botId?: string }} who */
function slackOwnAccount(m, who) {
  if (!m) return false;
  if (m.user && m.user === who.id) return true;
  if (who.botId && m.bot_id === who.botId) return true;
  return (m.subtype === "bot_message" || Boolean(m.bot_id)) && typeof m.username === "string" && m.username === who.name;
}

/** @param {number} ms */
export function slackTs(ms) {
  const secs = Math.floor(ms / 1000);
  const frac = String(ms - secs * 1000).padStart(3, "0");
  return `${secs}.${frac}000`;
}

/** The Slack half, from the face code #32 put in `src/transports/slack.mjs`. @type {FaceHalf} */
const slackFaceHalf = Object.freeze({
  transport: "slack",
  textMax: SLACK_TEXT_MAX,
  encode: encodeSlackText,
  tooLong: (n) => `too-long: the slack face is ${n} rendered characters and the limit is ${SLACK_TEXT_MAX}; pass --split to chunk at line boundaries`,
  threads: true,
  noThread: "thread: this face takes no thread",
  uploads: true,
  noUpload: "picture not uploaded",
  addHint: (alias) => `agora room faces ${alias} --add slack --channel <id>`,
  postOptions: (originId) => ({ metadata: { event_type: FACE_RIDER_EVENT, event_payload: { origin: originId } } }),
  window: (oldestMs, latestMs) => ({ oldest: slackTs(oldestMs), latest: slackTs(latestMs) }),
  idOf: (raw) => String(raw?.ts),
  rider: (raw) => (raw?.metadata?.event_type === FACE_RIDER_EVENT && typeof raw.metadata?.event_payload?.origin === "string" ? raw.metadata.event_payload.origin : undefined),
  ownAccount: slackOwnAccount,
  textOf: (raw) => (typeof raw?.text === "string" ? raw.text : undefined),
  fileIds: (raw) => (Array.isArray(raw?.files) ? raw.files.map((/** @type {any} */ f) => String(f?.id)) : []),
  pictureLine: (_a, line) => line,
});

/** The face halves this build carries, by transport name. A transport with no half is `capability`-refused. */
export const FACE_HALVES = Object.freeze({ slack: slackFaceHalf, github: githubFaceHalf });
/** Transports whose face half is built: `agora room faces --add` admits these and the runner publishes to them. */
export const FACE_BUILT = Object.freeze(Object.keys(FACE_HALVES));
/** @param {string} transport @returns {FaceHalf | undefined} */
export function faceHalf(transport) { return Object.prototype.hasOwnProperty.call(FACE_HALVES, transport) ? FACE_HALVES[/** @type {'slack'|'github'} */ (transport)] : undefined; }

/** @typedef {'always'|'never'|'addressed'|'landing'} FaceSelector */
/** @typedef {'none'|'metadata'|'pictures'} FaceAttachmentMode */
/**
 * One face of a room: a transport, the config alias whose token it borrows, its target, and the
 * policy that selects which of this room's posts cross to it.
 * @typedef {{ transport: string, alias: string, target: Record<string, string>, enabled: boolean,
 *   post: { human: FaceSelector[], agent: FaceSelector[], system: FaceSelector[] },
 *   attachments: FaceAttachmentMode, backfill: null | Record<string, unknown> }} Face
 */
/** @typedef {{ version: 1, roomId: string, updatedAt: string | null, faces: Face[] }} FacePolicy */
/**
 * One line of `faces.jsonl`. The current state of a face is its last line, folded by
 * `(originId, transport, attachmentId)`; a `quarantine` list is a union across lines.
 * @typedef {{ originId: string, transport: string, status: 'pending'|'published'|'refused'|'unknown', at: string,
 *   cursor?: string, selector?: string, attempt?: number, pendingAt?: string, thread?: string,
 *   id?: string, ids?: string[], reason?: string, code?: string, via?: string, quarantine?: string[],
 *   payloadDigest?: string, part?: 'attachment', attachmentId?: string, fileId?: string, name?: string, withdrawnNatively?: boolean }} FaceRecord
 */
/** @typedef {{ transport: string, status: 'pending'|'published'|'refused'|'unknown', reason?: string, id?: string, attachmentId?: string }} FaceStatus */
/** @typedef {{ id: string, name: string, kind: 'human'|'agent'|'system'|'unknown', account?: { transport: string, id: string } }} Member */
/** @typedef {import('./transports/slack.mjs').SlackFaceTransport & { kind: string, room: string, read?: import('./core.mjs').Transport['read'] }} FaceTransport */

// ---------------------------------------------------------------------------------------------
// The policy record: <state>/native/rooms/<roomId>/faces.json
// ---------------------------------------------------------------------------------------------

/** @param {string} stateRoot @param {string} roomId */
function roomDir(stateRoot, roomId) {
  if (!/^[a-f0-9]{32}$/.test(roomId)) throw new AgoraError("native room id must be 32 lowercase hexadecimal characters");
  return path.join(path.resolve(stateRoot), "native", "rooms", roomId);
}
/** @param {string} stateRoot @param {string} roomId */
export function facePolicyPath(stateRoot, roomId) { return path.join(roomDir(stateRoot, roomId), "faces.json"); }
/** @param {string} stateRoot @param {string} roomId */
export function faceRecordsPath(stateRoot, roomId) { return path.join(roomDir(stateRoot, roomId), "faces.jsonl"); }

/**
 * Selectors are a LIST; `addressed+landing` is accepted as an input spelling so the ratified
 * text of the ruling is a valid command-line value. Unknown selectors are refused, never dropped.
 * @param {unknown} value @param {string} field @returns {FaceSelector[]}
 */
export function normalizeSelectors(value, field) {
  const list = typeof value === "string" ? value.split(/[+,]/).map((s) => s.trim()).filter(Boolean) : Array.isArray(value) ? value.map(String) : undefined;
  if (!list || !list.length) throw new AgoraError(`${field} needs one or more selectors from ${FACE_SELECTORS.join(", ")}`);
  for (const s of list) if (!FACE_SELECTORS.includes(/** @type {FaceSelector} */ (s))) throw new AgoraError(`${field}: ${JSON.stringify(s)} is not a selector (have: ${FACE_SELECTORS.join(", ")})`);
  return /** @type {FaceSelector[]} */ ([...new Set(list)]);
}

/** The defaults the partition table ratified: human always, agent addressed or landing, system never. @param {unknown} value @param {string} where @returns {Face} */
export function normalizeFace(value, where = "face") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgoraError(`${where} must be an object`);
  const f = /** @type {Record<string, any>} */ (value);
  if (typeof f.transport !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(f.transport)) throw new AgoraError(`${where} needs a transport name`);
  if (typeof f.alias !== "string" || !f.alias.trim()) throw new AgoraError(`${where} needs the alias of the config room whose token it borrows`);
  const target = f.target && typeof f.target === "object" && !Array.isArray(f.target) ? f.target : {};
  const post = f.post && typeof f.post === "object" ? f.post : {};
  const attachments = f.attachments ?? "metadata";
  if (!FACE_ATTACHMENT_MODES.includes(attachments)) throw new AgoraError(`${where}.attachments must be one of ${FACE_ATTACHMENT_MODES.join(", ")}`);
  return {
    transport: f.transport,
    alias: f.alias.trim(),
    target: Object.fromEntries(Object.entries(target).map(([k, v]) => [k, String(v)])),
    enabled: f.enabled !== false,
    post: {
      human: normalizeSelectors(post.human ?? ["always"], `${where}.post.human`),
      agent: normalizeSelectors(post.agent ?? ["addressed", "landing"], `${where}.post.agent`),
      system: normalizeSelectors(post.system ?? ["never"], `${where}.post.system`),
    },
    attachments,
    backfill: f.backfill ?? null,
  };
}

/** @param {unknown} value @param {string} roomId @returns {FacePolicy} */
export function normalizeFacePolicy(value, roomId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgoraError("face policy must be an object");
  const p = /** @type {Record<string, any>} */ (value);
  if (p.version !== undefined && p.version !== POLICY_VERSION) throw new AgoraError(`face policy version ${p.version} is not ${POLICY_VERSION}`);
  if (p.roomId !== undefined && p.roomId !== roomId) throw new AgoraError("face policy belongs to another room");
  const faces = Array.isArray(p.faces) ? p.faces.map((f, i) => normalizeFace(f, `faces[${i}]`)) : [];
  const seen = new Set();
  for (const f of faces) {
    if (seen.has(f.transport)) throw new AgoraError(`face policy names the ${f.transport} face twice`);
    seen.add(f.transport);
  }
  return { version: POLICY_VERSION, roomId, updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null, faces };
}

/** An absent record is a room with no faces: every post is native only and nothing refuses. @param {string} stateRoot @param {string} roomId */
export async function readFacePolicy(stateRoot, roomId) {
  let text;
  try { text = await readFile(facePolicyPath(stateRoot, roomId), "utf8"); }
  catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return /** @type {FacePolicy} */ ({ version: POLICY_VERSION, roomId, updatedAt: null, faces: [] });
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new AgoraError(`face policy for room ${roomId} is not valid JSON; fix or remove faces.json`); }
  return normalizeFacePolicy(parsed, roomId);
}

/**
 * Written only by the seat service, 0600, atomically: the same temp + rename + directory-sync
 * shape as the store's `writeDurableAtomic` (native-store.mjs), which is not exported.
 * @param {string} stateRoot @param {string} roomId @param {unknown} policy @param {{ now?: () => Date }} [deps]
 */
export async function writeFacePolicy(stateRoot, roomId, policy, { now = () => new Date() } = {}) {
  const normalized = normalizeFacePolicy(policy, roomId);
  normalized.updatedAt = now().toISOString();
  const file = facePolicyPath(stateRoot, roomId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(normalized, null, 2) + "\n", "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    if (process.platform !== "win32") {
      const dir = await open(path.dirname(file), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally {
    await rm(temp, { force: true });
  }
  return normalized;
}

// ---------------------------------------------------------------------------------------------
// The face record log: <state>/native/rooms/<roomId>/faces.jsonl, append-only
// ---------------------------------------------------------------------------------------------

/** @param {string} originId @param {string} transport @param {string} [attachmentId] */
export function faceKey(originId, transport, attachmentId) { return `${originId}\0${transport}\0${attachmentId ?? ""}`; }

/**
 * One O_APPEND write, ordered by the filesystem against every sibling's. A log rather than a map
 * for the ledger's own reason: the `pending` line must be durable before the network call, and a
 * read-modify-write of a map loses a concurrent line.
 * @param {string} stateRoot @param {string} roomId @param {FaceRecord} line
 */
export async function appendFaceRecord(stateRoot, roomId, line) {
  const file = faceRecordsPath(stateRoot, roomId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, JSON.stringify(line) + "\n", { encoding: "utf8", mode: 0o600 });
  return line;
}

/** @param {FaceRecord[]} lines @returns {Map<string, FaceRecord>} */
export function foldFaceRecords(lines) {
  /** @type {Map<string, FaceRecord>} */
  const byKey = new Map();
  for (const line of lines) {
    const key = faceKey(line.originId, line.transport, line.attachmentId);
    const prev = byKey.get(key);
    /** @type {FaceRecord} */
    const next = { ...(prev ?? {}), ...line };
    if (line.status === "pending") { delete next.id; delete next.ids; delete next.reason; delete next.code; delete next.via; }
    if (prev?.quarantine || line.quarantine) next.quarantine = [...new Set([...(prev?.quarantine ?? []), ...(line.quarantine ?? [])])];
    byKey.set(key, next);
  }
  return byKey;
}

/**
 * The face rows for one message (`agora faces <room> --for`), and every `unknown` row (`--unknown`):
 * reads over the folded log, never an aggregate.
 * @param {string} stateRoot @param {string} roomId @param {{ originId?: string, status?: FaceRecord['status'] }} [only]
 */
export async function listFaceRecords(stateRoot, roomId, only = {}) {
  const records = await readFaceRecords(stateRoot, roomId);
  return [...records.values()].filter((r) => (only.originId === undefined || r.originId === only.originId) && (only.status === undefined || r.status === only.status));
}

/** @param {string} stateRoot @param {string} roomId */
export async function readFaceRecords(stateRoot, roomId) {
  let text = "";
  try { text = await readFile(faceRecordsPath(stateRoot, roomId), "utf8"); }
  catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
  /** @type {FaceRecord[]} */
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); }
    catch { /* a torn last line from a killed writer is not a record; the next append lands after it */ }
  }
  return foldFaceRecords(lines);
}

// ---------------------------------------------------------------------------------------------
// Selection: every selector reads the poster's OWN outbound trailers, never content and never an
// incoming trailer. The value domain has no content mode, so that violation is unrepresentable.
// ---------------------------------------------------------------------------------------------

/** A landing line: a `verdict:` and at least one `exhibit:` whose value is a 40-hex sha. @param {string} text */
export function isLanding(text) {
  const { trailers } = parseTrailers(text);
  return trailers.some((t) => t.key === "verdict") && trailers.some((t) => t.key === "exhibit" && SHA40.test(t.value.trim()));
}

/**
 * Addressed to where the face lives: the poster's own `to:` names a member whose kind is human,
 * or the poster's own `re:` names a native cursor whose message is by a human or carries an
 * origin on this face's transport (a partner agent with no seat lives on the face).
 * @param {string} text @param {Face} face
 * @param {{ memberKind: (name: string) => string | undefined, lookupCursor: (cursor: string) => any }} ctx
 */
export function isAddressed(text, face, ctx) {
  const { trailers, to } = parseTrailers(text);
  if (to.some((name) => ctx.memberKind(name) === "human")) return true;
  for (const t of trailers) {
    if (t.key !== "re") continue;
    const m = ctx.lookupCursor(t.value.trim());
    if (!m) continue;
    if (m.author?.kind === "human") return true;
    if (m.origin?.source?.transport === face.transport || m.origin?.transport === face.transport) return true;
  }
  return false;
}

/** @param {import('./core.mjs').Message | { text: string, author: { kind: string } }} message @param {Face} face @param {Parameters<typeof isAddressed>[2]} ctx */
function selectorFor(message, face, ctx) {
  const kind = message.author.kind === "human" ? "human" : message.author.kind === "system" ? "system" : "agent";
  for (const s of face.post[kind]) {
    if (s === "never") return undefined;
    if (s === "always") return s;
    if (s === "addressed" && isAddressed(message.text, face, ctx)) return s;
    if (s === "landing" && isLanding(message.text)) return s;
  }
  return undefined;
}

/**
 * Which faces a message gets. `face: "none"` is the poster's `--no-face` and overrides every
 * selector; `face: [...]` is the poster's `--face` and names transports, each of which must be a
 * face of the room (else `no-such-face`) and on (else `disabled`).
 * @param {FacePolicy} policy @param {any} message @param {Parameters<typeof isAddressed>[2]} ctx
 * @param {{ face?: 'auto' | 'none' | string[], alias?: string }} [opts] `alias` is the name the caller typed for the native room, used in the refusal reasons
 * @returns {{ selected: { face: Face, selector: string }[], refusals: { transport: string, code: string, reason: string }[] }}
 */
export function selectFaces(policy, message, ctx, opts = {}) {
  const mode = opts.face ?? "auto";
  /** @type {{ face: Face, selector: string }[]} */
  const selected = [];
  /** @type {{ transport: string, code: string, reason: string }[]} */
  const refusals = [];
  if (mode === "none") return { selected, refusals };
  if (Array.isArray(mode)) {
    for (const transport of new Set(mode)) {
      const face = policy.faces.find((f) => f.transport === transport);
      const alias = opts.alias ?? policy.faces[0]?.alias ?? policy.roomId;
      if (!FACE_CAPABLE.has(transport)) refusals.push({ transport, code: "capability", reason: transport === "local"
        ? "capability: the local transport is an append-only NDJSON file with no audience to face to"
        : `capability: the ${transport} transport has no audience to face to` });
      else if (!face) refusals.push({ transport, code: "no-such-face", reason: `no-such-face: room ${alias} has no ${transport} face; set one with ${faceHalf(transport)?.addHint(alias) ?? `agora room faces ${alias} --add ${transport}`}` });
      else if (!face.enabled) refusals.push({ transport, code: "disabled", reason: `disabled: the ${transport} face of ${opts.alias ?? face.alias} is off; turn it on with agora room faces ${opts.alias ?? face.alias} --enable ${transport}` });
      else selected.push({ face, selector: "flag" });
    }
    return { selected, refusals };
  }
  for (const face of policy.faces) {
    if (!face.enabled) continue;
    const selector = selectorFor(message, face, ctx);
    if (selector) selected.push({ face, selector });
  }
  return { selected, refusals };
}

// ---------------------------------------------------------------------------------------------
// The face text: the body as posted, plus one metadata line per attachment, never a local path
// ---------------------------------------------------------------------------------------------

/** @param {{ kind: string, name: string, mimetype?: string, size?: number }} a */
export function attachmentLine(a) {
  return `${a.kind} ${a.name} (${a.mimetype ?? "unknown type"}, ${typeof a.size === "number" ? a.size : "unknown"} bytes)`;
}

/**
 * Attachment lines go after the body and before the trailer block, so the trailers and the
 * signature still parse on the far side. Attachment bytes are never inlined. Under `pictures` on
 * a half with no upload ladder, each image's line carries the half's honest text form (a link
 * when the attachment has a public one, else its digest) instead of a copy the face cannot make.
 * @param {{ text: string, attachments?: { kind: string, name: string, mimetype?: string, size?: number }[] }} message @param {FaceAttachmentMode} mode @param {FaceHalf} [half]
 */
export function faceText(message, mode, half) {
  const text = message.text;
  if (mode === "none" || !message.attachments?.length) return text;
  const lines = message.attachments.map((a) => (mode === "pictures" && half && !half.uploads && a.kind === "image" ? half.pictureLine(a, attachmentLine(a)) : attachmentLine(a))).join("\n");
  const { body } = parseTrailers(text);
  if (body !== text && text.startsWith(body)) return `${body}\n${lines}${text.slice(body.length)}`;
  return `${text.replace(/\s+$/, "")}\n${lines}`;
}

// ---------------------------------------------------------------------------------------------
// Classification of a call outcome
// ---------------------------------------------------------------------------------------------

/** @param {string} s @param {number} [max] */
function bounded(s, max = 300) {
  const r = redact(s).replace(/\s+/g, " ").trim();
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
}

/** The facts a transport's call error carries for a face (`SlackApiError`, `GitHubApiError`): read by shape, never by class. @param {unknown} e @returns {e is AgoraError & { answered: boolean, sent: boolean, status?: number, error?: string }} */
function carriesCallFacts(e) {
  return e instanceof AgoraError && typeof (/** @type {any} */ (e)).answered === "boolean" && typeof (/** @type {any} */ (e)).sent === "boolean";
}

/**
 * An answered refusal (`{ok:false}`, a non-429 4xx) is `refused`: the far side answered, nothing
 * landed. A failure before any request left is `refused` too, under `dark`. A link death after
 * send, a 5xx or a throttle is `unknown`: the request may have landed, and a retry blind to the
 * far side is the duplicate. The facts are read off the error by shape, so every transport half
 * that throws them is classified the same way.
 * @param {unknown} e @param {string} transport
 * @returns {{ status: 'refused' | 'unknown', code: string, reason: string }}
 */
export function classifyFaceFailure(e, transport) {
  if (carriesCallFacts(e)) {
    if (!e.sent) return { status: "refused", code: "dark", reason: `dark: the ${transport} face could not be reached` };
    if (e.answered) {
      const error = e.error ?? (e.status ? `http-${e.status}` : "answered");
      return { status: "refused", code: /^[a-z][a-z0-9-]{0,63}$/.test(error.replace(/_/g, "-")) ? error.replace(/_/g, "-") : "answered", reason: bounded(`answered: ${e.message}`) };
    }
    return { status: "unknown", code: "lost-response", reason: bounded(`unknown: ${e.message}; the request may have landed`) };
  }
  if (e instanceof AgoraError) return { status: "refused", code: "refused", reason: bounded(e.message) };
  return { status: "unknown", code: "lost-response", reason: bounded(`unknown: ${e instanceof Error ? e.message : String(e)}`) };
}

/** @param {string} originId @param {string} transport @param {string} [attachmentId] */
function publicationOperationId(originId, transport, attachmentId) {
  return createHash("sha256").update(originId).update("\0").update(transport).update("\0").update(attachmentId ?? "").digest("hex");
}

/**
 * The P3 `FacePublication` projection of a face record (src/protocol/outcomes.mjs), for the
 * receipt and for `faces --for`. A record is the seat's own; the DTO is what crosses a boundary.
 * @param {FaceRecord} r @param {string} roomId @param {string} sourceRoom
 */
export function toFacePublication(r, roomId, sourceRoom) {
  const faceId = r.attachmentId ? `${r.transport}-${r.attachmentId}` : r.transport;
  const base = { roomId, messageId: r.originId, faceId, sourceRoom, publicationOperationId: publicationOperationId(r.originId, r.transport, r.attachmentId) };
  const source = r.id ? { transport: r.transport, room: sourceRoom, id: r.id } : undefined;
  if (r.status === "published") return { ...base, status: r.status, source: source ?? { transport: r.transport, room: sourceRoom, id: r.fileId ?? "unknown" } };
  if (r.status === "refused") return { ...base, status: r.status, code: r.code ?? "refused" };
  if (r.status === "unknown") return { ...base, status: r.status, code: r.code ?? "lost-response", ...(source ? { source } : {}) };
  return { ...base, status: r.status };
}

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} FaceRunnerDeps
 * @property {string} stateRoot
 * @property {string} roomId
 * @property {(face: Face) => Promise<FaceTransport>} transportFor builds the face transport for a policy face; throws an AgoraError naming the missing token (createTransport's own wording) when the room is dark by configuration
 * @property {Member[]} [membership]
 * @property {(cursor: string) => any} [lookupCursor] one native message by cursor, or undefined
 * @property {(attachment: any) => Promise<Buffer>} [readBlob] the verified bytes of a durable attachment from custody
 * @property {{ serviceId: string, serviceBootId: string }} attestor stamped on every origin
 * @property {() => Date} [now]
 * @property {number} [settleMs]
 * @property {number} [lookbackMs]
 * @property {(line: string) => void} [warn] one bounded, redacted line per face outcome
 */

export class FaceRunner {
  /** @param {FaceRunnerDeps} deps */
  constructor(deps) {
    this.stateRoot = deps.stateRoot;
    this.roomId = deps.roomId;
    this.transportFor = deps.transportFor;
    this.membership = deps.membership ?? [];
    this.lookupCursor = deps.lookupCursor ?? (() => undefined);
    this.readBlob = deps.readBlob ?? (async () => { throw new AgoraError("no blob custody is wired to this runner"); });
    this.attestor = deps.attestor;
    this.now = deps.now ?? (() => new Date());
    this.settleMs = deps.settleMs ?? FACE_SETTLE_MS;
    this.lookbackMs = deps.lookbackMs ?? FACE_RECONCILE_LOOKBACK_MS;
    this.warn = deps.warn ?? ((line) => { process.stderr.write(`${line}\n`); });
    /** @type {Map<string, FaceTransport>} */
    this.transports = new Map();
    /** @type {Map<string, { id: string, name: string, botId?: string }>} */
    this.identities = new Map();
  }

  /** @returns {Parameters<typeof isAddressed>[2]} */
  #ctx() {
    return {
      memberKind: (name) => this.membership.find((m) => m.name === name || m.id === name)?.kind,
      lookupCursor: (cursor) => this.lookupCursor(cursor),
    };
  }

  /** @param {Face} face */
  async #transport(face) {
    const cached = this.transports.get(face.transport);
    if (cached) return cached;
    const t = await this.transportFor(face);
    this.transports.set(face.transport, t);
    return t;
  }

  /** The seat's own account on the face, cached once per transport per runner. @param {Face} face @param {FaceTransport} t */
  async #identity(face, t) {
    const cached = this.identities.get(face.transport);
    if (cached) return cached;
    const who = await t.whoami();
    this.identities.set(face.transport, who);
    return who;
  }

  /** @param {FaceRecord} line */
  async #append(line) {
    await appendFaceRecord(this.stateRoot, this.roomId, line);
    if (line.status !== "pending") this.warn(`face ${line.transport}${line.attachmentId ? ` picture ${line.name ?? line.attachmentId}` : ""} ${line.status}${line.reason ? `: ${bounded(line.reason)}` : line.id ? ` ${line.id}` : ""}`);
    return line;
  }

  records() { return readFaceRecords(this.stateRoot, this.roomId); }
  policy() { return readFacePolicy(this.stateRoot, this.roomId); }

  /**
   * Where on the face a reply lands: through the face record of its native parent, or through the
   * poster's own `re:` when the cursor it names is a message that arrived FROM this face (its
   * origin id is the thread) or one that was faced (its published id is). Never through text. A
   * parent with no face on this transport leaves the reply top-level.
   * @param {Map<string, FaceRecord>} records @param {Face} face @param {any} message
   */
  #faceThread(records, face, message) {
    if (message.thread) {
      const parent = records.get(faceKey(message.thread, face.transport));
      if (parent?.status === "published" && parent.id) return parent.id;
    }
    for (const t of parseTrailers(String(message.text ?? "")).trailers) {
      if (t.key !== "re") continue;
      const m = this.lookupCursor(t.value.trim());
      if (!m) continue;
      const source = m.origin?.source;
      if (source?.transport === face.transport && typeof source.id === "string") return source.id;
      const faced = m.id ? records.get(faceKey(String(m.id), face.transport)) : undefined;
      if (faced?.status === "published" && faced.id) return faced.id;
    }
    return undefined;
  }

  /**
   * Called by the service AFTER `store.append` returned its receipt. Returns the per-face status
   * list for that receipt before any transport call is issued (every line is `pending`, `refused`
   * by a pre-call check, or absent), and `settled`, the promise of the calls themselves.
   * @param {any} message the committed native message (id, cursor, text, author, thread?, attachments?)
   * @param {{ face?: 'auto' | 'none' | string[], alias?: string }} [opts] `alias` is the name the caller typed for the native room, for the refusal reasons
   * @returns {Promise<{ faces: FaceStatus[], settled: Promise<FaceStatus[]> }>}
   */
  async face(message, opts = {}) {
    const policy = await this.policy();
    const { selected, refusals } = selectFaces(policy, message, this.#ctx(), opts);
    const records = await this.records();
    const at = this.now().toISOString();
    /** @type {FaceStatus[]} */
    const faces = [];
    /** @type {{ face: Face, record: FaceRecord }[]} */
    const pending = [];
    for (const r of refusals) {
      await this.#append({ originId: message.id, cursor: message.cursor, transport: r.transport, status: "refused", code: r.code, reason: r.reason, attempt: 0, at });
      faces.push({ transport: r.transport, status: "refused", reason: r.reason });
    }
    for (const { face, selector } of selected) {
      const refusal = this.#precheck(face, message);
      if (refusal) {
        await this.#append({ originId: message.id, cursor: message.cursor, transport: face.transport, status: "refused", code: refusal.code, reason: refusal.reason, selector, attempt: 0, at });
        faces.push({ transport: face.transport, status: "refused", reason: refusal.reason });
        continue;
      }
      const half = /** @type {FaceHalf} */ (faceHalf(face.transport));
      const thread = half.threads ? this.#faceThread(records, face, message) : undefined;
      const text = faceText(message, face.attachments, half);
      const record = await this.#append({ originId: message.id, cursor: message.cursor, transport: face.transport, status: "pending", selector, attempt: 1, at, pendingAt: at,
        ...(thread ? { thread } : {}), payloadDigest: `sha256:${createHash("sha256").update(half.encode(text)).digest("hex")}` });
      pending.push({ face, record });
      faces.push({ transport: face.transport, status: "pending" });
    }
    const settled = (async () => {
      /** @type {FaceStatus[]} */
      const out = [];
      for (const { face, record } of pending) out.push(...(await this.#publish(face, message, record)));
      return out;
    })();
    return { faces, settled };
  }

  /** The refusals decided before any call: capability, thread, redacted, route, too-long. @param {Face} face @param {any} message */
  #precheck(face, message) {
    if (face.transport === "local") return { code: "capability", reason: "capability: the local transport is an append-only NDJSON file with no audience to face to" };
    const half = faceHalf(face.transport);
    if (!half) return { code: "capability", reason: `capability: the ${face.transport} face is not built in this unit` };
    // a threaded native message on a face with no threads: refused in the transport's own words, never flattened
    if (!half.threads && message.thread) return { code: "thread", reason: half.noThread };
    const text = faceText(message, face.attachments, half);
    if (redact(text) !== text) return { code: "redacted", reason: "redacted: the body carries a credential shape and a face is byte-identical or it is not sent" };
    if (decodeTransfer(message.text)?.kind === "offer") return { code: "route", reason: "route: the body carries a transfer route, which is an ACL-restricted address and a face is a broadcast surface" };
    const rendered = half.encode(text).length;
    if (rendered > half.textMax) return { code: "too-long", reason: half.tooLong(rendered) };
    return undefined;
  }

  /**
   * The call, after the durable `pending` line. One outcome line follows, whatever happens.
   * @param {Face} face @param {any} message @param {FaceRecord} record
   * @returns {Promise<FaceStatus[]>}
   */
  async #publish(face, message, record) {
    const at = () => this.now().toISOString();
    let transport;
    try { transport = await this.#transport(face); }
    catch (e) {
      const reason = `dark: ${bounded(e instanceof Error ? e.message : String(e))}`;
      await this.#append({ originId: record.originId, transport: face.transport, status: "refused", code: "dark", reason, attempt: record.attempt, at: at() });
      return [{ transport: face.transport, status: "refused", reason }];
    }
    const half = /** @type {FaceHalf} */ (faceHalf(face.transport));
    const text = faceText(message, face.attachments, half);
    let result;
    try {
      result = await transport.post(text, /** @type {any} */ ({ ...(record.thread ? { thread: record.thread } : {}), ...half.postOptions(record.originId) }));
    } catch (e) {
      const c = classifyFaceFailure(e, face.transport);
      await this.#append({ originId: record.originId, transport: face.transport, status: c.status, code: c.code, reason: c.reason, attempt: record.attempt, at: at(), ...(c.status === "unknown" ? { pendingAt: record.pendingAt } : {}) });
      return [{ transport: face.transport, status: c.status, reason: c.reason }];
    }
    await this.#append({ originId: record.originId, transport: face.transport, status: "published", id: result.id, ...(result.ids ? { ids: result.ids } : {}), attempt: record.attempt, at: at(), via: "response" });
    /** @type {FaceStatus[]} */
    const out = [{ transport: face.transport, status: "published", id: result.id }];
    if (face.attachments === "pictures") out.push(...(half.uploads ? await this.#pictures(face, message, transport, record.thread) : await this.#noUploads(face, message, half)));
    return out;
  }

  /**
   * `pictures` on a half with no upload ladder: the text already carries each image's honest form
   * (its link or its digest), and each image gets a refused picture row saying why no copy was
   * made, so `faces --for` never reads a picture as published that nobody uploaded.
   * @param {Face} face @param {any} message @param {FaceHalf} half
   * @returns {Promise<FaceStatus[]>}
   */
  async #noUploads(face, message, half) {
    /** @type {FaceStatus[]} */
    const out = [];
    for (const a of Array.isArray(message.attachments) ? message.attachments : []) {
      if (a.kind !== "image") continue;
      const reason = half.noUpload;
      await this.#append({ originId: message.id, transport: face.transport, part: "attachment", attachmentId: String(a.id), name: String(a.name), status: "refused", code: "capability", reason, attempt: 0, at: this.now().toISOString() });
      out.push({ transport: face.transport, status: "refused", reason, attachmentId: String(a.id) });
    }
    return out;
  }

  /**
   * The picture ladder, per image, bounded by W10's constants: bytes from custody, digest
   * re-checked, `files.getUploadURLExternal`, the bytes, then the one visible step,
   * `files.completeUploadExternal` into the channel, with a `pending` line durable before it.
   * A failure at any rung degrades that picture to the metadata line already in the text.
   * @param {Face} face @param {any} message @param {FaceTransport} transport @param {string | undefined} thread
   * @returns {Promise<FaceStatus[]>}
   */
  async #pictures(face, message, transport, thread) {
    /** @type {FaceStatus[]} */
    const out = [];
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    let index = 0;
    for (const a of attachments) {
      if (a.kind !== "image") continue;
      const at = this.now().toISOString();
      const base = { originId: message.id, transport: face.transport, part: /** @type {'attachment'} */ ("attachment"), attachmentId: String(a.id), name: String(a.name), ...(thread ? { thread } : {}) };
      /** @param {string} code @param {string} reason */
      const refuse = async (code, reason) => {
        await this.#append({ ...base, status: "refused", code, reason, attempt: 0, at });
        out.push({ transport: face.transport, status: "refused", reason, attachmentId: base.attachmentId });
      };
      if (index >= SLACK_IMAGE_MAX_PER_MESSAGE) { await refuse("bound", `picture not uploaded: more than ${SLACK_IMAGE_MAX_PER_MESSAGE} images on one message`); continue; }
      index++;
      if (typeof a.size === "number" && a.size > SLACK_IMAGE_MAX_BYTES) { await refuse("bound", `picture not uploaded: image exceeds the ${SLACK_IMAGE_MAX_BYTES}-byte limit`); continue; }
      if (typeof a.mimetype !== "string" || !a.mimetype.toLowerCase().startsWith("image/")) { await refuse("bound", `picture not uploaded: ${a.mimetype ?? "no mimetype"} is not an image type`); continue; }
      let bytes;
      try { bytes = await this.readBlob(a); }
      catch (e) { await refuse("blob", `picture not uploaded: ${bounded(e instanceof Error ? e.message : String(e))}`); continue; }
      if (bytes.length > SLACK_IMAGE_MAX_BYTES) { await refuse("bound", `picture not uploaded: image exceeds the ${SLACK_IMAGE_MAX_BYTES}-byte limit`); continue; }
      // the digest is re-checked against the bytes BEFORE any call, so a face never carries a copy the seat did not verify
      const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (actual !== String(a.digest)) { await refuse("digest", "picture not uploaded: image bytes do not match their digest"); continue; }
      let slot;
      try {
        slot = await transport.uploadUrl({ name: base.name, length: bytes.length });
        await transport.putUpload({ uploadUrl: slot.uploadUrl, bytes, mimetype: a.mimetype, digest: String(a.digest) });
      } catch (e) {
        // nothing is visible before completeUpload, so a failure here is a refusal, never unknown
        const c = classifyFaceFailure(e, face.transport);
        await refuse(c.code === "lost-response" ? "upload" : c.code, `picture not uploaded: ${c.reason}`);
        continue;
      }
      const pendingAt = this.now().toISOString();
      const record = await this.#append({ ...base, fileId: slot.fileId, status: "pending", attempt: 1, at: pendingAt, pendingAt });
      out.push(await this.#complete(face, transport, record));
    }
    return out;
  }

  /** The visible step of an upload and its outcome line. @param {Face} face @param {FaceTransport} transport @param {FaceRecord} record @returns {Promise<FaceStatus>} */
  async #complete(face, transport, record) {
    try {
      await transport.completeUpload({ fileId: String(record.fileId), title: String(record.name), thread: record.thread });
    } catch (e) {
      const c = classifyFaceFailure(e, face.transport);
      await this.#append({ originId: record.originId, transport: face.transport, part: "attachment", attachmentId: record.attachmentId, status: c.status, code: c.code, reason: `picture ${c.reason}`, attempt: record.attempt, at: this.now().toISOString(), ...(c.status === "unknown" ? { pendingAt: record.pendingAt } : {}) });
      return { transport: face.transport, status: c.status, reason: c.reason, attachmentId: record.attachmentId };
    }
    await this.#append({ originId: record.originId, transport: face.transport, part: "attachment", attachmentId: record.attachmentId, status: "published", attempt: record.attempt, at: this.now().toISOString(), via: "response" });
    return { transport: face.transport, status: "published", attachmentId: record.attachmentId };
  }

  /** Is this raw Slack message from the seat's own bot account? (The Slack half's rule, kept here by name.) @param {any} m @param {{ id: string, name: string, botId?: string }} who */
  static ownAccount(m, who) { return slackOwnAccount(m, who); }

  /**
   * Reconcile one `unknown` (or swept `pending`) face against the channel before any retry: a
   * bounded `conversations.history` over `[pendingAt - lookback, now]`. Found: `published`, zero
   * posts. Not found and the read succeeded: repost. Read failed: stay `unknown`, zero posts.
   * Ambiguous (no rider, byte-identical bodies): stay `unknown`, quarantine the candidates.
   * @param {Face} face @param {FaceRecord} record
   * @returns {Promise<{ outcome: 'published' | 'reposted' | 'read-failed' | 'ambiguous' | 'refused' | 'exhausted', record?: FaceRecord }>}
   */
  async reconcile(face, record) {
    const at = () => this.now().toISOString();
    const pendingAtMs = Date.parse(record.pendingAt ?? record.at);
    const nowMs = this.now().getTime();
    const half = /** @type {FaceHalf} */ (faceHalf(face.transport));
    let transport;
    let who;
    let hist;
    try {
      transport = await this.#transport(face);
      who = await this.#identity(face, transport);
      hist = await transport.history(/** @type {any} */ (half.window(Math.max(0, pendingAtMs - this.lookbackMs), nowMs)));
    } catch (e) {
      // a retry blind to the channel IS the duplicate; the face stays exactly as it was
      this.warn(`face ${face.transport} reconciliation read failed for ${record.originId.slice(0, 12)}: ${bounded(e instanceof Error ? e.message : String(e))}`);
      return { outcome: "read-failed" };
    }
    /** @type {any[]} */
    let candidates;
    let via;
    if (record.part === "attachment") {
      candidates = hist.messages.filter((m) => half.fileIds(m).includes(String(record.fileId)));
      via = "file-id";
      if (candidates.length > 1) candidates = [candidates[0]]; // one file id shares once; the first sighting is it
    } else {
      candidates = hist.messages.filter((m) => half.rider(m) === record.originId);
      via = "rider";
      if (!candidates.length && record.payloadDigest) {
        candidates = hist.messages.filter((m) => { const t = half.textOf(m); return half.ownAccount(m, who) && typeof t === "string" && `sha256:${createHash("sha256").update(t).digest("hex")}` === record.payloadDigest; });
        via = "payload";
      }
    }
    if (candidates.length === 1) {
      const line = await this.#append({ originId: record.originId, transport: face.transport, ...(record.part ? { part: record.part, attachmentId: record.attachmentId } : {}),
        status: "published", id: half.idOf(candidates[0]), attempt: record.attempt, at: at(), via });
      return { outcome: "published", record: line };
    }
    if (candidates.length > 1) {
      const quarantine = candidates.map((m) => half.idOf(m));
      const line = await this.#append({ originId: record.originId, transport: face.transport, status: "unknown", code: "ambiguous", attempt: record.attempt, at: at(), pendingAt: record.pendingAt,
        reason: `unknown: ${quarantine.length} byte-identical candidates from this seat inside the window and no rider; a human decides (agora faces --unknown)`, quarantine });
      return { outcome: "ambiguous", record: line };
    }
    // the read succeeded and the message is not there: the attempt never landed, so a repost is not a duplicate
    const attempt = (record.attempt ?? 1) + 1;
    if (attempt > FACE_MAX_ATTEMPTS) {
      const line = await this.#append({ originId: record.originId, transport: face.transport, ...(record.part ? { part: record.part, attachmentId: record.attachmentId } : {}),
        status: "refused", code: "exhausted", reason: `exhausted: ${FACE_MAX_ATTEMPTS} attempts and none confirmed on the channel`, attempt: record.attempt, at: at() });
      return { outcome: "exhausted", record: line };
    }
    if (record.part === "attachment") {
      const pending = await this.#append({ ...record, status: "pending", attempt, at: at(), pendingAt: at() });
      const status = await this.#complete(face, transport, pending);
      return { outcome: status.status === "published" ? "reposted" : status.status === "refused" ? "refused" : "read-failed" };
    }
    const message = this.lookupCursor(String(record.cursor));
    if (!message) {
      const line = await this.#append({ originId: record.originId, transport: face.transport, status: "refused", code: "no-source", reason: `refused: the native message at ${record.cursor} could not be read back for a repost`, attempt: record.attempt, at: at() });
      return { outcome: "refused", record: line };
    }
    const pending = await this.#append({ ...record, status: "pending", attempt, at: at(), pendingAt: at() });
    const [status] = await this.#publish(face, message, pending);
    return { outcome: status.status === "published" ? "reposted" : status.status === "refused" ? "refused" : "read-failed" };
  }

  /**
   * The restart sweep (F1) and the drain tick, one procedure: every `pending` face older than
   * the settle window is promoted to `unknown`; every `unknown` face older than the settle window
   * that is not already quarantined is reconciled. Returns `held: true` when any reconciliation
   * read failed, and the caller holds ingestion of this room for the tick.
   */
  async sweep() {
    const policy = await this.policy();
    const records = await this.records();
    const nowMs = this.now().getTime();
    let held = false;
    /** @type {{ key: string, outcome: string }[]} */
    const outcomes = [];
    for (const [key, r] of records) {
      const face = policy.faces.find((f) => f.transport === r.transport);
      if (!face) continue;
      const age = nowMs - Date.parse(r.pendingAt ?? r.at);
      if (r.status === "pending" && age > this.settleMs) {
        await this.#append({ originId: r.originId, transport: r.transport, ...(r.part ? { part: r.part, attachmentId: r.attachmentId } : {}),
          status: "unknown", code: "stale-pending", reason: "unknown: a pending face outlived the settle window (its writer died); reconciling before any ingestion", attempt: r.attempt, at: this.now().toISOString(), pendingAt: r.pendingAt ?? r.at });
        const { outcome } = await this.reconcile(face, { ...r, status: "unknown" });
        if (outcome === "read-failed") held = true;
        outcomes.push({ key, outcome });
      } else if (r.status === "unknown" && age > this.settleMs && !(r.quarantine?.length)) {
        const { outcome } = await this.reconcile(face, r);
        if (outcome === "read-failed") held = true;
        outcomes.push({ key, outcome });
      }
    }
    return { held, outcomes };
  }

  /**
   * The loop check, in order (fixture 07): 1. a rider origin id matching any face record; 2. a
   * ts equal to a published face id, or a file id equal to an uploaded picture's; 2c. a ts on a
   * quarantine list; 3. the seat's own account while a face is pending inside the settle window;
   * 4. anything else is foreign, whatever the author.
   * @param {import('./core.mjs').Message} m @param {Map<string, FaceRecord>} records @param {{ id: string, name: string, botId?: string }} who @param {string} transport
   * @returns {{ verdict: 'own', record: FaceRecord } | { verdict: 'quarantined' } | { verdict: 'held' } | { verdict: 'foreign' }}
   */
  classify(m, records, who, transport) {
    const raw = /** @type {any} */ (m.raw ?? {});
    const half = faceHalf(transport);
    const rider = half?.rider(raw);
    const list = [...records.values()].filter((r) => r.transport === transport);
    if (typeof rider === "string") {
      const r = list.find((x) => x.originId === rider && !x.part);
      if (r) return { verdict: "own", record: r };
    }
    const byTs = list.find((r) => r.status === "published" && (r.id === m.id || r.ids?.includes(m.id)));
    if (byTs) return { verdict: "own", record: byTs };
    const fileIds = new Set(half?.fileIds(raw) ?? []);
    if (fileIds.size) {
      const r = list.find((x) => x.part === "attachment" && x.fileId && fileIds.has(x.fileId));
      if (r) return { verdict: "own", record: r };
    }
    if (list.some((r) => r.quarantine?.includes(m.id))) return { verdict: "quarantined" };
    const nowMs = this.now().getTime();
    const pendingInside = list.some((r) => r.status === "pending" && nowMs - Date.parse(r.pendingAt ?? r.at) <= this.settleMs);
    if (pendingInside && half?.ownAccount(raw, who)) return { verdict: "held" };
    if (pendingInside && (m.author.id === who.id || (who.botId && m.author.id === who.botId))) return { verdict: "held" };
    return { verdict: "foreign" };
  }

  /**
   * The origin stamp, composed by the service from the transport's own fields, never a trailer:
   * P3's `OriginReference` (src/protocol/origin.mjs), ids the transport's and never re-stamped.
   * @param {import('./core.mjs').Message} m @param {string} transport @param {string} room
   */
  origin(m, transport, room) {
    // the transport's own timestamp, in the one spelling `OriginReference` accepts (GitHub says `Z` with no millis)
    const parsed = Date.parse(m.ts);
    const ts = Number.isFinite(parsed) ? new Date(parsed).toISOString() : m.ts;
    return { source: { transport, room, id: m.id }, ts, author: { id: m.author.id, name: m.author.name, kind: m.author.kind }, attestor: this.attestor };
  }

  /**
   * The bridged poll, in the order the property needs: sweep, then read, then classify and append.
   * Zero appends happen before the sweep completes; a failed reconciliation read holds the room
   * for the tick and no cursor moves. A `held` message withholds the cursor at the last ingested.
   * @param {Face} face
   * @param {{ read: () => Promise<import('./core.mjs').ReadResult>, appendForeign: (message: any) => Promise<unknown> }} io
   */
  async poll(face, { read, appendForeign }) {
    const swept = await this.sweep();
    if (swept.held) return { held: true, reason: "reconciliation-read-failed", ingested: [], notIngested: [], cursor: undefined };
    const transport = await this.#transport(face);
    const who = await this.#identity(face, transport);
    const messages = await read();
    if (messages.gap) return { held: true, reason: "gap", ingested: [], notIngested: [], cursor: undefined, gap: messages.gap };
    const records = await this.records();
    /** @type {any[]} */
    const ingested = [];
    /** @type {{ id: string, why: string }[]} */
    const notIngested = [];
    let cursor;
    for (const m of messages) {
      const v = this.classify(m, records, who, face.transport);
      if (v.verdict === "own") {
        if (v.record.status !== "published") {
          const line = await this.#append({ originId: v.record.originId, transport: face.transport, ...(v.record.part ? { part: v.record.part, attachmentId: v.record.attachmentId } : {}),
            status: "published", id: m.id, attempt: v.record.attempt, at: this.now().toISOString(), via: v.record.part ? "file-id" : "echo" });
          records.set(faceKey(line.originId, line.transport, line.attachmentId), { ...v.record, ...line });
        }
        notIngested.push({ id: m.id, why: `own face (${v.record.part ? "picture" : "rider or ts"} matched the face record)` });
        cursor = m.cursor;
        continue;
      }
      if (v.verdict === "quarantined") { notIngested.push({ id: m.id, why: "quarantined: an ambiguous face candidate a human must resolve" }); cursor = m.cursor; continue; }
      if (v.verdict === "held") return { held: true, reason: "own-account-while-pending", ingested, notIngested, cursor };
      const parentByTs = m.thread ? [...records.values()].find((r) => r.transport === face.transport && r.status === "published" && r.id === m.thread) : undefined;
      const native = {
        text: m.text, author: m.author, ...(m.signedAs ? { signedAs: m.signedAs } : {}),
        ...(parentByTs ? { thread: parentByTs.originId } : m.thread ? { threadTs: m.thread } : {}),
        origin: this.origin(m, face.transport, transport.room),
        account: { transport: face.transport, id: m.author.id }, key: "unverified",
        ...(m.attachments ? { attachments: m.attachments } : {}),
      };
      await appendForeign(native);
      ingested.push(native);
      cursor = m.cursor;
    }
    return { held: false, ingested, notIngested, cursor };
  }

  /** The face rows for one message (`agora faces <room> --for <cursor>`): a read, never an aggregate. @param {string} originId */
  async statusFor(originId) {
    const records = await this.records();
    return [...records.values()].filter((r) => r.originId === originId);
  }

  /** Everything a human should look at (`agora faces <room> --unknown`): rows, never a count. */
  async unknown() {
    const records = await this.records();
    return [...records.values()].filter((r) => r.status === "unknown");
  }
}
