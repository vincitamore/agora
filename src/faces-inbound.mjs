// @ts-check
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AgoraError, redact } from "./core.mjs";
import { attachmentLine, readFaceRecords, slackTs } from "./faces.mjs";
import { AUTHOR_REF_PATTERN } from "./protocol/common.mjs";
import { detectAttachmentType } from "./protocol/attachment.mjs";
import { parseTrailers } from "./trailers.mjs";
import { SLACK_IMAGE_MAX_BYTES, SLACK_IMAGE_MAX_PER_MESSAGE, validateThread } from "./transports/slack.mjs";

/**
 * The inbound half of a face: a person's reply in a faced thread on the transport becomes a native
 * append in that thread. The outbound half (src/faces.mjs) puts a native message on the face; this
 * module brings the answers back.
 *
 * What crosses, and how it is stamped:
 * - Replies in a thread whose root this seat faced, or whose root crossed in. A top-level message
 *   on the channel crosses only on a face that opted in (`agora room faces <room> --inbound
 *   top-level`, kept as a `mode` line here, never in the shared config): there a person's new
 *   top-level message in the face's channel, from any author but this seat's own account, becomes
 *   a native top-level post, and its Slack thread joins the thread map, so the replies under it
 *   cross into that native thread. The channel is read from the position the opt-in recorded, so
 *   switching it on never back-fills the channel's history. Without the opt-in (`threads`, the
 *   default) the top level is not read: the room's own messages are answered on the face, and the
 *   channel is not mirrored.
 * - The origin is stamped by the service, never by a trailer: the connection declares the client
 *   name `<transport>-face` (`slack-face`), which the service records as `via`; the author is the
 *   transport's person by name, kind `human` (a bot that is not this seat arrives as `agent`), and
 *   the transport's user id as `author.ref`.
 * - The loop check is the outbound runner's own (`FaceRunner.classify`, through `FaceRunner.poll`):
 *   a rider naming a face record, a ts or file id this seat published, a quarantined candidate, or
 *   this seat's account while a face is still pending. A copy this seat faced never comes back in.
 * - The thread map, transport ts to native root, is persisted in `face-inbound.jsonl` beside the
 *   face record log, with the per-thread read position and one line per ingested message, so a
 *   restarted seat resumes where it stopped and nothing is appended twice: the operation id of
 *   every append derives from the room, the transport, the channel and the message's ts, so a
 *   replay after a crash is the host's duplicate, never a second message.
 * - A reply that crossed and is then edited on the transport becomes an `edit` annotation on its
 *   native copy, and one deleted there becomes a `withdraw`, both signed by the same author stamp
 *   (the face's client acting for that person). Each tick reads the whole of a thread that has
 *   crossed replies: a changed text (against the digest kept per crossing) is an edit; a
 *   `tombstone` subtype, a hidden message, or a ts missing from a read that reached the end of the
 *   thread is a delete. An absence from a read cut short at its page cap deletes nothing. Every
 *   annotation's operation id derives from the room, the channel, the ts and the edit, so a replay
 *   after a restart is the host's duplicate.
 * - Files are downloaded into the room's custody under the caps a reader's `--files` keeps: at most
 *   eight per message, 20 MiB each. An image is what its bytes prove: a file the transport calls an
 *   image whose bytes are not one is not copied. A file that is not copied keeps a metadata line in
 *   the text with the reason; its bytes are never inlined and its private URL is never written.
 *
 * Seams for the seat service: `client` (an `agora/client` connected with `clientName:
 * inboundVia(transport)`), `runner` (the room's `FaceRunner`, whose `transportFor` builds the face
 * transport), and the call site `FaceInbound.poll` on the service's bridge tick.
 */

/** One file's cap, the same as a reader's `--files`. */
export const INBOUND_FILE_MAX_BYTES = SLACK_IMAGE_MAX_BYTES;
/** Files per message that cross into custody; the rest stay metadata lines. */
export const INBOUND_FILES_PER_MESSAGE = SLACK_IMAGE_MAX_PER_MESSAGE;
/** A faced thread is read while its root, or its last crossing, is younger than this. */
export const INBOUND_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many threads are read per tick, the most recently active first. */
export const INBOUND_MAX_THREADS = 64;
/** What a face takes in: replies in its threads (the default), or also the channel's top level. */
export const INBOUND_MODES = Object.freeze(["threads", "top-level"]);
/** @typedef {'threads' | 'top-level'} InboundMode */

const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const AUTHOR_NAME_MAX = 120;

/** The client name an inbound connection declares, which the service stamps as `via`. @param {string} transport */
export function inboundVia(transport) { return `${transport}-face`; }

/**
 * Did this native message arrive from that face? The outbound runner asks before it faces a
 * message, so a person's reply never goes back out as a copy of itself. Read from `via`, which the
 * service stamps from the connection, never from the text.
 * @param {{ via?: unknown }} message @param {string} transport
 */
export function arrivedFromFace(message, transport) { return message?.via === inboundVia(transport); }

/** @param {string} stateRoot @param {string} roomId */
export function faceInboundPath(stateRoot, roomId) {
  if (!/^[a-f0-9]{32}$/.test(roomId)) throw new AgoraError("native room id must be 32 lowercase hexadecimal characters");
  return path.join(path.resolve(stateRoot), "native", "rooms", roomId, "face-inbound.jsonl");
}

/**
 * The operation id of one crossing: fixed by the room, the transport, the channel and the
 * transport's message id, so a second attempt at the same message is the host's duplicate.
 * @param {string} roomId @param {string} transport @param {string} channel @param {string} id
 */
export function inboundOperationId(roomId, transport, channel, id) {
  return createHash("sha256").update("agora-face-inbound\0").update(roomId).update("\0").update(transport).update("\0").update(channel).update("\0").update(id).digest("hex");
}

/**
 * The operation id of an edit or a withdraw of a crossed reply: fixed by the room, the channel,
 * the ts, the act and, for an edit, the transport's edit stamp (its `edited.ts`, else the digest
 * of the new text), so the same edit seen again is the host's duplicate and a later edit is new.
 * @param {string} roomId @param {string} transport @param {string} channel @param {string} id @param {'edit' | 'withdraw'} act @param {string} [edit]
 */
export function inboundAnnotationId(roomId, transport, channel, id, act, edit = "") {
  return createHash("sha256").update("agora-face-inbound-annotation\0").update(roomId).update("\0").update(transport).update("\0").update(channel).update("\0").update(id)
    .update("\0").update(act).update("\0").update(edit).digest("hex");
}

/** @param {string} text */
const textDigest = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/**
 * One line of `face-inbound.jsonl`.
 * - `thread`: the map, a transport thread ts to the native root id.
 * - `cursor`: how far one thread has been read.
 * - `ingested`: one transport message and what it became (`id`, `cursor`), or why it was not appended;
 *   a top-level crossing carries `top: true` and the empty `thread`.
 * - `mode`: the face's inbound mode from here on; the last line for a transport and channel holds.
 *   The top level's read position is the `cursor` line whose `thread` is empty.
 * @typedef {{ kind: 'thread', transport: string, channel: string, ts: string, root: string, at: string }
 *   | { kind: 'cursor', transport: string, channel: string, thread: string, cursor: string, at: string }
 *   | { kind: 'mode', transport: string, channel: string, inbound: InboundMode, at: string }
 *   | { kind: 'ingested', transport: string, channel: string, ts: string, thread: string, at: string, id?: string, cursor?: string, top?: boolean,
 *       duplicate?: boolean, skipped?: string, files?: { name: string, copied: boolean, attachmentId?: string, reason?: string }[],
 *       textDigest?: string, fileLines?: string[], author?: { kind: 'human' | 'agent', name: string, ref?: string } }
 *   | { kind: 'edited', transport: string, channel: string, ts: string, textDigest: string, editedTs?: string, annotation: string, duplicate?: boolean, at: string }
 *   | { kind: 'withdrawn', transport: string, channel: string, ts: string, why: string, annotation?: string, duplicate?: boolean, at: string }} InboundLine
 */

/** @param {string} transport @param {string} channel @param {string} ts */
const lineKey = (transport, channel, ts) => `${transport}\0${channel}\0${ts}`;

/** @param {string} stateRoot @param {string} roomId @param {InboundLine} line */
export async function appendInboundLine(stateRoot, roomId, line) {
  const file = faceInboundPath(stateRoot, roomId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, JSON.stringify(line) + "\n", { encoding: "utf8", mode: 0o600 });
  return line;
}

/**
 * The folded inbound log: the thread map (both directions), each thread's read position and last
 * activity, and every crossing by transport ts.
 * @param {string} stateRoot @param {string} roomId
 */
export async function readInbound(stateRoot, roomId) {
  let text = "";
  try { text = await readFile(faceInboundPath(stateRoot, roomId), "utf8"); }
  catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
  /** @type {Map<string, { root: string, at: string }>} */
  const threads = new Map();
  /** @type {Map<string, string>} */
  const cursors = new Map();
  /** @type {Map<string, string>} */
  const active = new Map();
  /** @type {Map<string, InboundLine & { kind: 'ingested' }>} */
  const ingested = new Map();
  /** The current state of each crossing: its native id, the digest of its last text, withdrawn, and `top` for a top-level one. @type {Map<string, { ts: string, thread: string, id: string, top: boolean, textDigest?: string, fileLines: string[], author?: { kind: 'human' | 'agent', name: string, ref?: string }, withdrawn: boolean }>} */
  const crossed = new Map();
  /** Each face's inbound mode, by transport and channel; absent is `threads`. @type {Map<string, InboundMode>} */
  const modes = new Map();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    /** @type {InboundLine} */
    let line;
    try { line = JSON.parse(raw); }
    catch { continue; /* a torn last line from a killed writer is not a record */ }
    if (line.kind === "thread") { if (!threads.has(lineKey(line.transport, line.channel, line.ts))) threads.set(lineKey(line.transport, line.channel, line.ts), { root: line.root, at: line.at }); }
    else if (line.kind === "cursor") { cursors.set(lineKey(line.transport, line.channel, line.thread), line.cursor); active.set(lineKey(line.transport, line.channel, line.thread), line.at); }
    else if (line.kind === "ingested") {
      const key = lineKey(line.transport, line.channel, line.ts);
      ingested.set(key, line);
      active.set(lineKey(line.transport, line.channel, line.thread), line.at);
      if (line.id) crossed.set(key, { ts: line.ts, thread: line.thread, id: line.id, top: line.top === true, textDigest: line.textDigest, fileLines: line.fileLines ?? [], author: line.author, withdrawn: false });
    }
    else if (line.kind === "mode") { if (INBOUND_MODES.includes(line.inbound)) modes.set(modeKey(line.transport, line.channel), line.inbound); }
    else if (line.kind === "edited") { const c = crossed.get(lineKey(line.transport, line.channel, line.ts)); if (c) c.textDigest = line.textDigest; }
    else if (line.kind === "withdrawn") { const c = crossed.get(lineKey(line.transport, line.channel, line.ts)); if (c) c.withdrawn = true; }
  }
  return { threads, cursors, active, ingested, crossed, modes };
}

/** @param {string} transport @param {string} channel */
const modeKey = (transport, channel) => `${transport}\0${channel}`;

/**
 * A face's inbound mode: `top-level` when it opted into the channel's top level, else `threads`.
 * @param {string} stateRoot @param {string} roomId @param {{ transport: string, target: Record<string, string> }} face
 * @returns {Promise<InboundMode>}
 */
export async function inboundModeOf(stateRoot, roomId, face) {
  const { modes } = await readInbound(stateRoot, roomId);
  return modes.get(modeKey(face.transport, String(face.target.channel ?? ""))) ?? "threads";
}

/**
 * Set a face's inbound mode. Switching to `top-level` records the channel's read position as now,
 * so the first read takes what arrives after the opt-in and never back-fills the channel. Only a
 * Slack face has an inbound half; any other refuses by name, and an unknown mode refuses with the
 * modes there are. Setting the mode it already has writes nothing.
 * @param {string} stateRoot @param {string} roomId @param {{ transport: string, target: Record<string, string> }} face @param {string} mode @param {{ now?: () => Date }} [deps]
 * @returns {Promise<{ inbound: InboundMode, changed: boolean }>}
 */
export async function setInboundMode(stateRoot, roomId, face, mode, { now = () => new Date() } = {}) {
  if (!INBOUND_MODES.includes(mode)) throw new AgoraError(`--inbound ${JSON.stringify(mode)} is not a mode (have: ${INBOUND_MODES.join(", ")})`);
  const inbound = /** @type {InboundMode} */ (mode);
  if (face.transport !== "slack" && inbound !== "threads") throw new AgoraError(`--inbound ${inbound}: the ${face.transport} face has no inbound half; only a slack face takes the channel's top level`);
  if ((await inboundModeOf(stateRoot, roomId, face)) === inbound) return { inbound, changed: false };
  const channel = String(face.target.channel ?? "");
  const at = now();
  if (inbound === "top-level")
    await appendInboundLine(stateRoot, roomId, { kind: "cursor", transport: face.transport, channel, thread: "", cursor: slackTs(at.getTime()), at: at.toISOString() });
  await appendInboundLine(stateRoot, roomId, { kind: "mode", transport: face.transport, channel, inbound, at: at.toISOString() });
  return { inbound, changed: true };
}

/**
 * The thread map for one face: every transport thread ts this room can be answered in, to its
 * native root. Built from the face record log (a top-level message this seat published is a thread
 * root on the face) and the persisted map, which keeps a pairing once a reply has crossed in it.
 * @param {string} stateRoot @param {string} roomId @param {{ transport: string, target: Record<string, string> }} face
 * @returns {Promise<Map<string, { root: string, at: string }>>}
 */
export async function readThreadMap(stateRoot, roomId, face) {
  const channel = String(face.target.channel ?? "");
  /** @type {Map<string, { root: string, at: string }>} */
  const map = new Map();
  for (const r of (await readFaceRecords(stateRoot, roomId)).values()) {
    // a face carried in a transport thread is a reply there, not a root; a picture is a file share
    if (r.transport !== face.transport || r.part || r.thread || r.status !== "published" || !r.id) continue;
    if (validateThread(r.id) !== undefined) continue;
    map.set(r.id, { root: r.originId, at: r.at });
  }
  const { threads } = await readInbound(stateRoot, roomId);
  for (const [key, v] of threads) {
    const [transport, ch, ts] = key.split("\0");
    if (transport === face.transport && ch === channel && !map.has(ts)) map.set(ts, v);
  }
  return map;
}

/**
 * The transport thread of a native root, the reverse of the map: where an outbound reply under
 * that root lands. Undefined when the root has no thread on the face.
 * @param {string} stateRoot @param {string} roomId @param {{ transport: string, target: Record<string, string> }} face @param {string} root
 */
export async function faceThreadOf(stateRoot, roomId, face, root) {
  for (const [ts, v] of await readThreadMap(stateRoot, roomId, face)) if (v.root === root) return ts;
  return undefined;
}

/** @param {string} s @param {number} [max] */
function bounded(s, max = 200) {
  const r = redact(s).replace(/\s+/g, " ").trim();
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
}

/**
 * Metadata lines go after the body and before a trailer block, so the person's own trailers (if
 * any) still parse where they wrote them.
 * @param {string} text @param {string[]} lines
 */
function withLines(text, lines) {
  if (!lines.length) return text;
  const block = lines.join("\n");
  if (!text.trim()) return block;
  const { body } = parseTrailers(text);
  if (body !== text && text.startsWith(body)) return `${body.replace(/\s+$/, "")}\n${block}${text.slice(body.length)}`;
  return `${text.replace(/\s+$/, "")}\n${block}`;
}

/**
 * @typedef {object} FaceInboundDeps
 * @property {string} stateRoot
 * @property {string} roomId
 * @property {import('./faces.mjs').FaceRunner} runner the room's outbound runner: its loop check, its sweep and its `transportFor`
 * @property {Pick<import('./client.mjs').Client, 'append' | 'upload' | 'annotate'> & { clientName?: string }} client connected with `clientName: inboundVia(transport)`
 * @property {import('./client.mjs').RoomRef} [room] how the client names the room; `{ roomId }` when absent
 * @property {() => Date} [now]
 * @property {number} [activeMs]
 * @property {number} [maxThreads]
 * @property {number} [fileMax]
 * @property {number} [filesPerMessage]
 * @property {(line: string) => void} [warn]
 */

/** This seat's own account on each face transport, asked once per transport object. @type {WeakMap<object, Promise<{ id: string, name: string, botId?: string }>>} */
const identities = new WeakMap();
/** @param {any} transport @returns {Promise<{ id: string, name: string, botId?: string }>} */
function ownIdentity(transport) {
  const known = identities.get(transport);
  if (known) return known;
  /** @type {Promise<{ id: string, name: string, botId?: string }>} */
  const asked = transport.whoami();
  identities.set(transport, asked);
  asked.catch(() => identities.delete(transport));
  return asked;
}

export class FaceInbound {
  /** @param {FaceInboundDeps} deps */
  constructor(deps) {
    this.stateRoot = deps.stateRoot;
    this.roomId = deps.roomId;
    this.runner = deps.runner;
    this.client = deps.client;
    this.room = deps.room ?? { roomId: deps.roomId };
    this.now = deps.now ?? (() => new Date());
    this.activeMs = deps.activeMs ?? INBOUND_ACTIVE_MS;
    this.maxThreads = deps.maxThreads ?? INBOUND_MAX_THREADS;
    this.fileMax = deps.fileMax ?? INBOUND_FILE_MAX_BYTES;
    this.filesPerMessage = deps.filesPerMessage ?? INBOUND_FILES_PER_MESSAGE;
    this.warn = deps.warn ?? ((line) => { process.stderr.write(`${line}\n`); });
  }

  /**
   * The threads read this tick: every mapped thread whose root, or last crossing, is inside the
   * active window, the most recent first, at most `maxThreads`.
   * @param {import('./faces.mjs').Face} face
   * @returns {Promise<{ ts: string, root: string, since: string }[]>}
   */
  async threads(face) {
    const channel = String(face.target.channel ?? "");
    const map = await readThreadMap(this.stateRoot, this.roomId, face);
    const { cursors, active } = await readInbound(this.stateRoot, this.roomId);
    const nowMs = this.now().getTime();
    const rows = [];
    for (const [ts, { root, at }] of map) {
      const key = lineKey(face.transport, channel, ts);
      const last = Math.max(Date.parse(at) || 0, Date.parse(active.get(key) ?? "") || 0);
      if (nowMs - last > this.activeMs) continue;
      rows.push({ ts, root, since: cursors.get(key) ?? ts, last });
    }
    rows.sort((a, b) => b.last - a.last);
    return rows.slice(0, this.maxThreads).map(({ ts, root, since }) => ({ ts, root, since }));
  }

  /**
   * One tick for one face. On a face that opted into the top level, the channel is read first,
   * after its saved position, so a question that crossed this tick has its thread mapped before the
   * threads are read. Then each active thread is read after its saved position. Every read goes
   * through the runner's poll (sweep first, then the loop check), and every foreign message is
   * appended. A read that is held (a pending face of ours inside the settle window, a failed
   * reconciliation, a gap) keeps its position and is read again next tick.
   * @param {import('./faces.mjs').Face} face
   */
  async poll(face) {
    if (face.transport !== "slack") throw new AgoraError(`the ${face.transport} face has no inbound half`);
    if (!face.enabled) return { threads: [] };
    const channel = String(face.target.channel ?? "");
    const transport = /** @type {any} */ (await this.runner.transportFor(face));
    if (typeof transport.inbound !== "function") throw new AgoraError(`the ${face.transport} face transport has no inbound read`);
    /** @type {{ held: boolean, reason?: string, ingested: number, notIngested: { id: string, why: string }[], gap?: unknown } | undefined} */
    let topLevel;
    if ((await inboundModeOf(this.stateRoot, this.roomId, face)) === "top-level") {
      topLevel = await this.#topLevel(face, channel, transport);
      // a sweep that could not read the channel holds the whole face for the tick
      if (topLevel.held && topLevel.reason === "reconciliation-read-failed") return { threads: [], topLevel };
    }
    /** @type {{ ts: string, root: string, held: boolean, reason?: string, ingested: number, notIngested: { id: string, why: string }[], edited: string[], withdrawn: string[], covered?: boolean }[]} */
    const out = [];
    for (const t of await this.threads(face)) {
      const result = await this.runner.poll(face, {
        read: () => transport.inbound({ thread: t.ts, since: t.since }),
        appendForeign: (native) => this.#cross(face, channel, t, native),
      });
      if (result.cursor && result.cursor !== t.since)
        await appendInboundLine(this.stateRoot, this.roomId, { kind: "cursor", transport: face.transport, channel, thread: t.ts, cursor: result.cursor, at: this.now().toISOString() });
      // a sweep that could not read the channel holds every thread of this face for the tick
      if (result.held && result.reason === "reconciliation-read-failed") {
        out.push({ ts: t.ts, root: t.root, held: true, reason: result.reason, ingested: 0, notIngested: result.notIngested, edited: [], withdrawn: [] });
        break;
      }
      const mirrored = await this.#mirror(face, channel, transport, t);
      out.push({ ts: t.ts, root: t.root, held: result.held, ...(result.reason ? { reason: result.reason } : {}), ingested: result.ingested.length, notIngested: result.notIngested, ...mirrored });
    }
    return { threads: out, ...(topLevel ? { topLevel } : {}) };
  }

  /**
   * The channel's top level after its saved position, through the runner's poll: the loop check
   * keeps this seat's faced copies out by rider, published ts or pending account, and `#crossTop`
   * keeps out everything else this seat's own account wrote there. A read the page cap cut short is
   * a gap: nothing crosses and the position stays.
   * @param {import('./faces.mjs').Face} face @param {string} channel @param {any} transport
   */
  async #topLevel(face, channel, transport) {
    if (typeof transport.inboundChannel !== "function") throw new AgoraError(`the ${face.transport} face transport has no top-level inbound read`);
    const since = (await readInbound(this.stateRoot, this.roomId)).cursors.get(lineKey(face.transport, channel, ""));
    // the opt-in records the position; without one there is nothing to read after, and nothing is inferred
    if (!since) return { held: true, reason: "no-position", ingested: 0, notIngested: [] };
    const who = await ownIdentity(transport);
    /** @type {{ id: string, why: string }[]} */
    const skipped = [];
    const result = await this.runner.poll(face, {
      read: () => transport.inboundChannel({ since }),
      appendForeign: async (native) => {
        const why = await this.#crossTop(face, channel, native, who);
        if (why) skipped.push({ id: String(native.origin?.source?.id ?? ""), why });
      },
    });
    if (result.cursor && result.cursor !== since)
      await appendInboundLine(this.stateRoot, this.roomId, { kind: "cursor", transport: face.transport, channel, thread: "", cursor: result.cursor, at: this.now().toISOString() });
    return { held: result.held, ...(result.reason ? { reason: result.reason } : {}), ...(result.gap ? { gap: result.gap } : {}),
      ingested: result.ingested.length - skipped.length, notIngested: [...result.notIngested, ...skipped] };
  }

  /**
   * One foreign top-level message, from the runner's poll, onto the native room as a top-level
   * post, and its transport thread into the thread map under the new native root. Returns why it
   * did not cross, or undefined when it did.
   * @param {import('./faces.mjs').Face} face @param {string} channel @param {any} native @param {{ id: string, botId?: string }} who
   * @returns {Promise<string | undefined>}
   */
  async #crossTop(face, channel, native, who) {
    const at = () => this.now().toISOString();
    const ts = String(native.origin?.source?.id ?? "");
    if (validateThread(ts) !== undefined) throw new AgoraError("an inbound top-level message carries no transport ts");
    const base = { kind: /** @type {const} */ ("ingested"), transport: face.transport, channel, ts, thread: "", top: true };
    const authorId = String(native.author?.id ?? "");
    const skip = native.author?.kind === "system" ? "a platform event, not speech"
      : authorId && (authorId === who.id || (who.botId !== undefined && authorId === who.botId)) ? "this seat's own account: what it writes on the face is not a question for the room" : undefined;
    if (skip) {
      await appendInboundLine(this.stateRoot, this.roomId, { ...base, at: at(), skipped: skip });
      return skip;
    }
    const { request, files, lines, slackText } = await this.#request(face, channel, ts, native);
    const receipt = await this.#append(request);
    await appendInboundLine(this.stateRoot, this.roomId, { kind: "thread", transport: face.transport, channel, ts, root: receipt.id, at: at() });
    await appendInboundLine(this.stateRoot, this.roomId, { ...base, at: at(), id: receipt.id, cursor: receipt.cursor, ...(receipt.duplicate ? { duplicate: true } : {}), ...(files.length ? { files } : {}),
      textDigest: textDigest(slackText), fileLines: lines, author: request.author });
    return undefined;
  }

  /**
   * One foreign reply, from the runner's poll, onto the native room.
   * @param {import('./faces.mjs').Face} face @param {string} channel @param {{ ts: string, root: string }} t @param {any} native
   */
  async #cross(face, channel, t, native) {
    const at = () => this.now().toISOString();
    const ts = String(native.origin?.source?.id ?? "");
    if (validateThread(ts) !== undefined) throw new AgoraError("an inbound reply carries no transport ts");
    const { threads } = await readInbound(this.stateRoot, this.roomId);
    if (!threads.has(lineKey(face.transport, channel, t.ts)))
      await appendInboundLine(this.stateRoot, this.roomId, { kind: "thread", transport: face.transport, channel, ts: t.ts, root: t.root, at: at() });
    const base = { kind: /** @type {const} */ ("ingested"), transport: face.transport, channel, ts, thread: t.ts };
    if (native.author?.kind === "system") {
      await appendInboundLine(this.stateRoot, this.roomId, { ...base, at: at(), skipped: "a platform event, not speech" });
      return;
    }
    const { request, files, lines, slackText } = await this.#request(face, channel, ts, native, t.root);
    const receipt = await this.#append(request);
    await appendInboundLine(this.stateRoot, this.roomId, { ...base, at: at(), id: receipt.id, cursor: receipt.cursor, ...(receipt.duplicate ? { duplicate: true } : {}), ...(files.length ? { files } : {}),
      textDigest: textDigest(slackText), fileLines: lines, author: request.author });
  }

  /**
   * The append for one crossing: the person's words with a metadata line per file not copied, the
   * author stamp (kind human, or agent for a bot that is not this seat; the transport's user id as
   * `author.ref`), the files in custody, and the operation id fixed by the transport ts.
   * @param {import('./faces.mjs').Face} face @param {string} channel @param {string} ts @param {any} native @param {string} [thread]
   */
  async #request(face, channel, ts, native, thread) {
    const { refs, files, lines } = await this.#files(Array.isArray(native.attachments) ? native.attachments : []);
    const slackText = String(native.text ?? "");
    const name = String(native.author?.name ?? "").trim().slice(0, AUTHOR_NAME_MAX) || String(native.author?.id ?? "unknown");
    const ref = typeof native.author?.id === "string" && AUTHOR_REF_PATTERN.test(native.author.id) ? native.author.id : undefined;
    const request = {
      text: withLines(slackText, lines),
      author: { kind: /** @type {'human'|'agent'} */ (native.author?.kind === "human" ? "human" : "agent"), name, ...(ref ? { ref } : {}) },
      ...(thread ? { thread } : {}),
      operationId: inboundOperationId(this.roomId, face.transport, channel, ts),
      ...(refs.length ? { attachments: refs } : {}),
    };
    return { request, files, lines, slackText };
  }

  /**
   * An append whose acceptance is unknown is resent once under the same operation id: the host
   * returns the original receipt if it had committed, and appends once if it had not.
   * @param {any} request
   */
  async #append(request) {
    try { return await this.client.append(this.room, request); }
    catch (e) {
      if (/** @type {any} */ (e)?.outcome !== "unknown-acceptance") throw e;
      return await this.client.append(this.room, request);
    }
  }

  /**
   * Edits and deletes of this thread's crossings, onto their native copies: its crossed replies,
   * and its root when the root itself crossed in from the top level. Reads the whole thread only
   * when something in it has crossed. A changed text is an `edit`; a tombstone, a hidden message,
   * a ts missing from a complete read, or a thread Slack says is gone is a `withdraw`; a missing ts
   * on a read cut short at its page cap is nothing.
   * @param {import('./faces.mjs').Face} face @param {string} channel @param {any} transport @param {{ ts: string }} t
   * @returns {Promise<{ edited: string[], withdrawn: string[], covered?: boolean }>}
   */
  async #mirror(face, channel, transport, t) {
    const { crossed } = await readInbound(this.stateRoot, this.roomId);
    const mine = [...crossed.values()].filter((c) => (c.top ? c.ts === t.ts : c.thread === t.ts) && !c.withdrawn && c.author);
    if (!mine.length || typeof transport.inboundThread !== "function") return { edited: [], withdrawn: [] };
    const survey = await transport.inboundThread({ thread: t.ts });
    /** @type {Map<string, { ts: string, text: string, subtype?: string, hidden?: boolean, editedTs?: string }>} */
    const byTs = new Map(survey.messages.map((/** @type {any} */ m) => [m.ts, m]));
    /** @type {string[]} */
    const edited = [];
    /** @type {string[]} */
    const withdrawn = [];
    for (const c of mine) {
      // a top-level crossing is the thread's parent: the survey carries it as `root`, never among the replies
      const m = c.top ? survey.root : byTs.get(c.ts);
      const author = /** @type {{ kind: 'human' | 'agent', name: string, ref?: string }} */ (c.author);
      const base = { transport: face.transport, channel, ts: c.ts };
      const gone = m ? (m.subtype === "tombstone" || m.hidden === true ? "deleted on the transport" : undefined)
        : survey.missing ? "the thread is gone on the transport"
        : survey.complete && !c.top ? "missing from a read that reached the end of the thread" : undefined;
      if (gone) {
        const receipt = await this.#annotate({ act: "withdraw", target: c.id, author, operationId: inboundAnnotationId(this.roomId, face.transport, channel, c.ts, "withdraw") });
        await appendInboundLine(this.stateRoot, this.roomId, { kind: "withdrawn", ...base, why: receipt.refused ? `${gone}; ${receipt.refused}` : gone, ...(receipt.id ? { annotation: receipt.id } : {}), ...(receipt.duplicate ? { duplicate: true } : {}), at: this.now().toISOString() });
        withdrawn.push(c.ts);
        continue;
      }
      if (!m) continue; // absent from a read cut short: not known to be gone
      const digest = textDigest(m.text);
      if (digest === c.textDigest) continue;
      const receipt = await this.#annotate({ act: "edit", target: c.id, text: withLines(m.text, c.fileLines), author,
        operationId: inboundAnnotationId(this.roomId, face.transport, channel, c.ts, "edit", m.editedTs ?? digest) });
      if (receipt.refused) {
        // the native copy was withdrawn or purged meanwhile: nothing more is annotated on it
        await appendInboundLine(this.stateRoot, this.roomId, { kind: "withdrawn", ...base, why: receipt.refused, at: this.now().toISOString() });
        continue;
      }
      await appendInboundLine(this.stateRoot, this.roomId, { kind: "edited", ...base, textDigest: digest, ...(m.editedTs ? { editedTs: m.editedTs } : {}), annotation: String(receipt.id), ...(receipt.duplicate ? { duplicate: true } : {}), at: this.now().toISOString() });
      edited.push(c.ts);
    }
    return { edited, withdrawn, covered: survey.complete };
  }

  /**
   * One annotation through the face's client, resent once under the same id when its acceptance
   * is unknown. A target already withdrawn or purged is reported, not thrown.
   * @param {import('./client.mjs').AnnotateRequest} request
   * @returns {Promise<{ id?: string, duplicate?: boolean, refused?: string }>}
   */
  async #annotate(request) {
    const annotate = /** @type {any} */ (this.client).annotate;
    if (typeof annotate !== "function") throw new AgoraError("the inbound client cannot annotate");
    const once = () => annotate.call(this.client, this.room, request);
    try {
      try { return await once(); }
      catch (e) { if (/** @type {any} */ (e)?.outcome !== "unknown-acceptance") throw e; return await once(); }
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      if (code === "annotation-target-withdrawn" || code === "annotation-target-purged") return { refused: `the native copy is ${code === "annotation-target-withdrawn" ? "withdrawn" : "purged"}` };
      throw e;
    }
  }

  /**
   * The files of one reply into custody, bounded; each one not copied keeps a metadata line.
   * @param {any[]} attachments
   */
  async #files(attachments) {
    /** @type {import('./protocol/attachment.mjs').WireAttachment[]} */
    const refs = [];
    /** @type {{ name: string, copied: boolean, attachmentId?: string, reason?: string }[]} */
    const files = [];
    /** @type {string[]} */
    const lines = [];
    let index = 0;
    for (const a of attachments) {
      const name = String(a?.name ?? "attachment");
      /** @param {string} reason */
      const skip = (reason) => { files.push({ name, copied: false, reason }); lines.push(`${attachmentLine(a)} not copied: ${reason}`); };
      if (index >= this.filesPerMessage) { skip(`more than ${this.filesPerMessage} files on one message`); continue; }
      index++;
      if (typeof a?.size === "number" && a.size > this.fileMax) { skip(`the file exceeds the ${this.fileMax}-byte limit`); continue; }
      if (typeof a?.download !== "function") { skip("the transport offers no download for it"); continue; }
      /** @type {Buffer} */
      let bytes;
      try { bytes = await a.download(this.fileMax); }
      catch (e) { skip(bounded(e instanceof Error ? e.message : String(e))); continue; }
      const proved = detectAttachmentType(bytes.subarray(0, 12));
      const declaredImage = a.kind === "image" || String(a.mimetype ?? "").startsWith("image/");
      // an image is what its bytes prove; a claimed image that is not one does not cross as a file either
      if (declaredImage && proved.kind !== "image") { skip("the bytes are not the image the transport named"); continue; }
      const upload = {
        bytes, name: name.slice(0, 200) || "attachment",
        ...(typeof a.mimetype === "string" && MIME_RE.test(a.mimetype) ? { mimetype: a.mimetype } : {}),
        ...(proved.kind === "image" && Number.isSafeInteger(a.width) && a.width > 0 ? { width: a.width } : {}),
        ...(proved.kind === "image" && Number.isSafeInteger(a.height) && a.height > 0 ? { height: a.height } : {}),
      };
      try {
        const ref = await this.client.upload(this.room, upload);
        refs.push(ref);
        files.push({ name, copied: true, attachmentId: ref.id });
      } catch (e) {
        skip(`custody refused it (${bounded(e instanceof Error ? e.message : String(e))})`);
      }
    }
    return { refs, files, lines };
  }
}

/**
 * The seat service's inbound tick: the `onTick` the daemon hands `NativeFaceWiring`, which runs it
 * per faced room after that room's sweep with the room's own `FaceRunner`. For each enabled Slack
 * face it runs `FaceInbound.poll` through that runner (never a second runner per room, which would
 * get around the one-sweep-at-a-time rule) and one `agora/client` connected to this seat's service
 * as `slack-face`, so the service stamps `via` on every crossing and the outbound side never faces
 * a crossing back out. The client is connected on the first tick that needs it, kept across ticks,
 * and dropped after a failed poll so the next tick connects afresh; `close` releases it.
 * @param {{ connect: (options: { state: string, clientName: string }) => Promise<any>, warn?: (line: string) => void, now?: () => Date }} deps
 */
export function slackInboundTick({ connect, warn = (line) => { process.stderr.write(`${redact(line)}\n`); }, now }) {
  /** @type {Promise<any> | undefined} */
  let connecting;
  /** @type {string | undefined} */
  let connectedRoot;
  const drop = async () => {
    const c = connecting;
    connecting = undefined;
    connectedRoot = undefined;
    if (c) { try { (await c).close(); } catch { /* a client that never connected has nothing to close */ } }
  };
  /** @param {string} root */
  const client = (root) => {
    if (!connecting || connectedRoot !== root) {
      connectedRoot = root;
      connecting = connect({ state: root, clientName: inboundVia("slack") });
      connecting.catch(() => { connecting = undefined; connectedRoot = undefined; });
    }
    return connecting;
  };
  /** @param {{ root: string, roomId: string, runner: import('./faces.mjs').FaceRunner, faces: import('./faces.mjs').Face[] }} tick */
  const onTick = async ({ root, roomId, runner, faces }) => {
    /** @type {any[]} */
    const results = [];
    for (const face of faces) {
      if (face.transport !== "slack" || !face.enabled) continue;
      try {
        const c = await client(root);
        results.push(await new FaceInbound({ stateRoot: root, roomId, runner, client: c, warn, ...(now ? { now } : {}) }).poll(face));
      } catch (e) {
        warn(`agora: inbound slack face of ${roomId} not polled: ${e instanceof Error ? e.message : String(e)}`);
        await drop();
      }
    }
    return results;
  };
  return { onTick, close: drop };
}
