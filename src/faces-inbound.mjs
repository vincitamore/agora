// @ts-check
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AgoraError, redact } from "./core.mjs";
import { attachmentLine, readFaceRecords } from "./faces.mjs";
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
 * - Only replies in a thread whose root this seat faced. A top-level message on the channel is not
 *   ingested: a native room is not a mirror of the channel, and a face is where the room's own
 *   messages are answered.
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
 * One line of `face-inbound.jsonl`.
 * - `thread`: the map, a transport thread ts to the native root id.
 * - `cursor`: how far one thread has been read.
 * - `ingested`: one transport message and what it became (`id`, `cursor`), or why it was not appended.
 * @typedef {{ kind: 'thread', transport: string, channel: string, ts: string, root: string, at: string }
 *   | { kind: 'cursor', transport: string, channel: string, thread: string, cursor: string, at: string }
 *   | { kind: 'ingested', transport: string, channel: string, ts: string, thread: string, at: string, id?: string, cursor?: string,
 *       duplicate?: boolean, skipped?: string, files?: { name: string, copied: boolean, attachmentId?: string, reason?: string }[] }} InboundLine
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
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    /** @type {InboundLine} */
    let line;
    try { line = JSON.parse(raw); }
    catch { continue; /* a torn last line from a killed writer is not a record */ }
    if (line.kind === "thread") { if (!threads.has(lineKey(line.transport, line.channel, line.ts))) threads.set(lineKey(line.transport, line.channel, line.ts), { root: line.root, at: line.at }); }
    else if (line.kind === "cursor") { cursors.set(lineKey(line.transport, line.channel, line.thread), line.cursor); active.set(lineKey(line.transport, line.channel, line.thread), line.at); }
    else if (line.kind === "ingested") { ingested.set(lineKey(line.transport, line.channel, line.ts), line); active.set(lineKey(line.transport, line.channel, line.thread), line.at); }
  }
  return { threads, cursors, active, ingested };
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
 * @property {Pick<import('./client.mjs').Client, 'append' | 'upload'> & { clientName?: string }} client connected with `clientName: inboundVia(transport)`
 * @property {import('./client.mjs').RoomRef} [room] how the client names the room; `{ roomId }` when absent
 * @property {() => Date} [now]
 * @property {number} [activeMs]
 * @property {number} [maxThreads]
 * @property {number} [fileMax]
 * @property {number} [filesPerMessage]
 * @property {(line: string) => void} [warn]
 */

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
   * One tick for one face: read each active thread after its saved position, through the runner's
   * poll (sweep first, then the loop check), and append every foreign reply. A thread whose read is
   * held (a pending face of ours inside the settle window, a failed reconciliation, a gap) keeps
   * its position and is read again next tick.
   * @param {import('./faces.mjs').Face} face
   */
  async poll(face) {
    if (face.transport !== "slack") throw new AgoraError(`the ${face.transport} face has no inbound half`);
    if (!face.enabled) return { threads: [] };
    const channel = String(face.target.channel ?? "");
    const transport = /** @type {any} */ (await this.runner.transportFor(face));
    if (typeof transport.inbound !== "function") throw new AgoraError(`the ${face.transport} face transport has no inbound read`);
    /** @type {{ ts: string, root: string, held: boolean, reason?: string, ingested: number, notIngested: { id: string, why: string }[] }[]} */
    const out = [];
    for (const t of await this.threads(face)) {
      const result = await this.runner.poll(face, {
        read: () => transport.inbound({ thread: t.ts, since: t.since }),
        appendForeign: (native) => this.#cross(face, channel, t, native),
      });
      if (result.cursor && result.cursor !== t.since)
        await appendInboundLine(this.stateRoot, this.roomId, { kind: "cursor", transport: face.transport, channel, thread: t.ts, cursor: result.cursor, at: this.now().toISOString() });
      out.push({ ts: t.ts, root: t.root, held: result.held, ...(result.reason ? { reason: result.reason } : {}), ingested: result.ingested.length, notIngested: result.notIngested });
      // a sweep that could not read the channel holds every thread of this face for the tick
      if (result.held && result.reason === "reconciliation-read-failed") break;
    }
    return { threads: out };
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
    const { refs, files, lines } = await this.#files(Array.isArray(native.attachments) ? native.attachments : []);
    const name = String(native.author?.name ?? "").trim().slice(0, AUTHOR_NAME_MAX) || String(native.author?.id ?? "unknown");
    const ref = typeof native.author?.id === "string" && AUTHOR_REF_PATTERN.test(native.author.id) ? native.author.id : undefined;
    const request = {
      text: withLines(String(native.text ?? ""), lines),
      author: { kind: /** @type {'human'|'agent'} */ (native.author?.kind === "human" ? "human" : "agent"), name, ...(ref ? { ref } : {}) },
      thread: t.root,
      operationId: inboundOperationId(this.roomId, face.transport, channel, ts),
      ...(refs.length ? { attachments: refs } : {}),
    };
    let receipt;
    try { receipt = await this.client.append(this.room, request); }
    catch (e) {
      // an append whose acceptance is unknown is resent once under the same operation id: the host
      // returns the original receipt if it had committed, and appends once if it had not
      if (/** @type {any} */ (e)?.outcome !== "unknown-acceptance") throw e;
      receipt = await this.client.append(this.room, request);
    }
    await appendInboundLine(this.stateRoot, this.roomId, { ...base, at: at(), id: receipt.id, cursor: receipt.cursor, ...(receipt.duplicate ? { duplicate: true } : {}), ...(files.length ? { files } : {}) });
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
