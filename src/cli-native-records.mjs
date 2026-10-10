// @ts-check
/**
 * The native record verbs: attachments, annotations and purge on a native room (docs/PURGE.md lists
 * them; docs/ATTACHMENTS.md and docs/ANNOTATIONS.md are the records they write).
 *
 *   agora post <room> --attach <path> [--attach <path> ...]
 *   agora attachment get <room> <attachment id> --out <path>
 *   agora edit <room> <message id> (--stdin | --text "...")
 *   agora withdraw <room> <message id>
 *   agora pin <room> <message id>
 *   agora unpin <room> <message id>
 *   agora room purge <room> (--message <id> ... | --thread <root id>) --reason "..."
 *
 * The CLI dispatches every one of them here: `nativeRecordVerb` names the verb a command line is,
 * `nativeRecordArgumentRefusal` refuses its arguments before any config is read, `runNativeRecordVerb`
 * runs it once config, session and bearer are resolved, and `prepareAttachments` turns `post --attach`
 * paths into the references the post carries.
 *
 * Each verb talks to this seat's service through agora/client (src/client.mjs), as the configured
 * bearer, with no client name: what the CLI posts is the seat's, so an edit or a withdraw from the
 * CLI answers for a message the CLI (any session on this seat) posted. A refusal is printed with its
 * code and exits 1; nothing here adds an exit code (0, 1, 2 and 42 are the CLI's contract).
 */

import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AgoraError, EXIT, resolvePath, sign } from "./core.mjs";
import { ClientError, connect } from "./client.mjs";
import { validateNativeThread } from "./transports/native.mjs";

/** @typedef {'attachment-get' | 'edit' | 'withdraw' | 'pin' | 'unpin' | 'room-purge'} NativeRecordVerb */

/** Every native record verb, as `nativeRecordVerb` names them. `post --attach` is a post option. */
export const NATIVE_RECORD_VERBS = Object.freeze(/** @type {const} */ (["attachment-get", "edit", "withdraw", "pin", "unpin", "room-purge"]));

const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const AUTHOR_KINDS = new Set(["human", "agent", "system"]);

/**
 * A declared type for a file the bytes do not prove, by its extension. Custody records the kind
 * the bytes prove whatever is declared (docs/ATTACHMENTS.md), so this only names a file's type for
 * a reader; an unknown extension declares nothing and custody records `application/octet-stream`.
 */
const DECLARED_TYPES = Object.freeze(/** @type {Record<string, string>} */ ({
  ".pdf": "application/pdf", ".txt": "text/plain", ".log": "text/plain", ".csv": "text/csv", ".json": "application/json",
  ".md": "text/markdown", ".xml": "application/xml", ".zip": "application/zip",
  ".vsdx": "application/vnd.ms-visio.drawing.main+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}));

/**
 * Which native record verb this command line is, if any.
 * @param {string} verb @param {string | undefined} sub the second positional
 * @returns {NativeRecordVerb | undefined}
 */
export function nativeRecordVerb(verb, sub) {
  if (verb === "attachment") return "attachment-get";
  if (verb === "edit" || verb === "withdraw" || verb === "pin" || verb === "unpin") return verb;
  if (verb === "room" && sub === "purge") return "room-purge";
  return undefined;
}

/** @param {unknown} value @returns {string[]} */
const list = (value) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String);

/**
 * The arguments refusal for a native record verb, checked before config loads; undefined when the
 * arguments are well formed.
 * @param {{ verb: string, roomAlias: string | undefined, rest: string[], values: Record<string, unknown> }} context
 * @returns {string | undefined}
 */
export function nativeRecordArgumentRefusal(context) {
  const { verb, roomAlias, rest, values } = context;
  const name = nativeRecordVerb(verb, roomAlias);
  if (name === "attachment-get") {
    if (roomAlias !== "get") return "agora attachment takes get: agora attachment get <room> <attachment id> --out <path>";
    if (rest.length !== 2) return "agora attachment get takes a room and an attachment id: agora attachment get <room> <attachment id> --out <path>";
    if (!ID_RE.test(rest[1])) return "an attachment id is 16-128 letters, digits, _ or - (the id read --json prints)";
    if (values.out === undefined || !String(values.out).trim()) return "agora attachment get needs --out <path>: where the verified bytes are written";
    return undefined;
  }
  if (name === "room-purge") {
    if (rest.length !== 1) return "agora room purge takes one room: agora room purge <room> (--message <id> ... | --thread <root id>) --reason \"...\"";
    const messages = list(values.message);
    if (!messages.length && values.thread === undefined) return "agora room purge needs --message <id> (repeatable) or --thread <root id>";
    if (messages.length && values.thread !== undefined) return "agora room purge takes --message or --thread, not both: a thread purge already takes its root and every reply";
    for (const id of messages) if (!ID_RE.test(id)) return `--message ${JSON.stringify(id)} is not a message id (the id read --json prints)`;
    if (new Set(messages).size !== messages.length) return "--message names each message once";
    if (values.thread !== undefined) {
      const why = validateNativeThread(String(values.thread));
      if (why) return `--thread: ${why}`;
    }
    if (values.reason === undefined || !String(values.reason).trim()) return "agora room purge needs --reason \"...\": why, recorded on the purge record";
    if (String(values.reason).length > 1000) return "--reason is at most 1000 characters";
    return undefined;
  }
  if (name === "edit" || name === "withdraw" || name === "pin" || name === "unpin") {
    if (roomAlias === undefined || rest.length !== 1) return `agora ${name} takes a room and a message id: agora ${name} <room> <message id>`;
    if (!ID_RE.test(rest[0])) return `${JSON.stringify(rest[0])} is not a message id (the id read --json prints)`;
    if (name === "edit") {
      const text = values.text !== undefined, stdin = values.stdin === true;
      if (text === stdin) return "agora edit takes the new text from exactly one of --text \"...\" and --stdin";
    } else if (values.text !== undefined || values.stdin === true) {
      return `agora ${name} carries no text; only an edit does`;
    }
    return undefined;
  }
  return undefined;
}

/**
 * What the CLI hands a native record verb once config, session and bearer are resolved.
 * @typedef {{
 *   name: NativeRecordVerb,
 *   sub: string | undefined,
 *   rest: string[],
 *   values: Record<string, unknown>,
 *   cfg: import("./core.mjs").Config,
 *   stateRoot: string,
 *   sessionDir: string,
 *   bearer: { name: string, source: string },
 *   json: boolean,
 *   readStdin?: () => Promise<string>,
 * }} NativeRecordContext
 */

/**
 * The configured native room an alias names, or a usage refusal: these verbs act on this seat's own
 * native rooms (a native-remote member route admits neither annotations nor purge).
 * @param {import("./core.mjs").Config} cfg @param {string} alias @param {string} label
 */
function nativeRoom(cfg, alias, label) {
  const room = cfg.rooms[alias];
  if (!room) throw new AgoraError(`no room "${alias}" in ${/** @type {any} */ (cfg).path ?? "the config"} (have: ${Object.keys(cfg.rooms).join(", ")})`, EXIT.usage);
  if (room.transport !== "native")
    throw new AgoraError(`${label} belongs to a native room on this seat; "${alias}" is a ${room.transport} room`, EXIT.usage);
  return room;
}

/** The client's outcome, as the CLI prints it: the code first, so a caller can match on it. @param {unknown} e */
function asCliError(e) {
  if (e instanceof ClientError) {
    const message = e.message.startsWith(`${e.code}:`) ? e.message : `${e.code}: ${e.message}`;
    return new AgoraError(`${message}${e.outcome === "unknown-acceptance" && e.operationId ? ` (acceptance unknown; operation ${e.operationId})` : ""}`, EXIT.error);
  }
  return e;
}

/** @param {import("./core.mjs").Config} cfg @param {string} stateRoot */
async function client(cfg, stateRoot) {
  try { return await connect({ state: stateRoot, ...(/** @type {any} */ (cfg).path ? { config: /** @type {any} */ (cfg).path } : {}) }); }
  catch (e) { throw asCliError(e); }
}

/** The author this CLI writes as: the bearer, with the configured actor's kind. @param {import("./core.mjs").Config} cfg @param {string} name */
function author(cfg, name) {
  const kind = AUTHOR_KINDS.has(/** @type {string} */ (cfg.actor?.kind)) ? /** @type {'human' | 'agent' | 'system'} */ (cfg.actor.kind) : "agent";
  return { kind, name };
}

/**
 * Run one native record verb; resolves with the exit code.
 * @param {NativeRecordContext} context
 * @returns {Promise<number>}
 */
export async function runNativeRecordVerb(context) {
  const refusal = nativeRecordArgumentRefusal({ verb: context.name === "attachment-get" ? "attachment" : context.name === "room-purge" ? "room" : context.name,
    roomAlias: context.sub, rest: context.rest, values: context.values });
  if (refusal !== undefined) throw new AgoraError(refusal, EXIT.usage);
  if (context.name === "attachment-get") return attachmentGet(context);
  if (context.name === "room-purge") return roomPurge(context);
  return annotate(context);
}

/** @param {NativeRecordContext} context */
async function annotate(context) {
  const act = /** @type {'edit' | 'withdraw' | 'pin' | 'unpin'} */ (context.name);
  const alias = /** @type {string} */ (context.sub);
  const target = context.rest[0];
  nativeRoom(context.cfg, alias, `agora ${act}`);
  /** @type {string | undefined} */
  let text;
  if (act === "edit") {
    const raw = context.values.stdin === true ? await (context.readStdin ?? readAllStdin)() : String(context.values.text);
    if (!raw.trim()) throw new AgoraError("agora edit needs a non-empty text", EXIT.usage);
    // an edit is signed as a post is, so the folded text still says who wrote it
    text = context.cfg.sign !== false && !context.values["no-sign"] ? sign(raw, { ...context.cfg.actor, name: context.bearer.name }) : raw.replace(/\s+$/, "");
  }
  const app = await client(context.cfg, context.stateRoot);
  try {
    const receipt = await app.annotate(alias, { act, target, ...(text !== undefined ? { text } : {}), author: author(context.cfg, context.bearer.name) });
    if (context.json) console.log(JSON.stringify({ type: "annotation", alias, act, target, id: receipt.id, cursor: receipt.cursor, duplicate: receipt.duplicate }));
    else console.log(`${act} of ${target} in ${alias} at ${receipt.cursor}${receipt.duplicate ? " (already recorded)" : ""}`);
    return EXIT.ok;
  } catch (e) { throw asCliError(e); }
  finally { app.close(); }
}

/** @param {NativeRecordContext} context */
async function roomPurge(context) {
  const alias = context.rest[0];
  nativeRoom(context.cfg, alias, "agora room purge");
  const targets = list(context.values.message);
  const thread = context.values.thread === undefined ? undefined : String(context.values.thread);
  const app = await client(context.cfg, context.stateRoot);
  try {
    const receipt = await app.purge(alias, { ...(targets.length ? { targets } : {}), ...(thread !== undefined ? { thread } : {}),
      reason: String(context.values.reason).trim(), author: author(context.cfg, context.bearer.name) });
    if (context.json) {
      console.log(JSON.stringify({ type: "purge", alias, id: receipt.id, cursor: receipt.cursor, duplicate: receipt.duplicate,
        purged: receipt.purged, blobsRemoved: receipt.blobsRemoved, facesOutOfReach: receipt.facesOutOfReach }));
    } else {
      console.log(`purge in ${alias} at ${receipt.cursor}: ${receipt.purged.length} message${receipt.purged.length === 1 ? "" : "s"} lost their text, ${receipt.blobsRemoved} attachment blob${receipt.blobsRemoved === 1 ? "" : "s"} removed`);
      for (const id of receipt.purged) console.log(`  ${id}`);
      for (const f of receipt.facesOutOfReach) console.log(`  out of reach: a copy on ${f.transport} ${f.channel} at ${f.ts}`);
    }
    return EXIT.ok;
  } catch (e) { throw asCliError(e); }
  finally { app.close(); }
}

/**
 * Find an attachment's digest by its id: the id derives from the room and the digest, so it is
 * found by reading the room forward until a message names it.
 * @param {Awaited<ReturnType<typeof connect>>} app @param {string} alias @param {string} id
 * @returns {Promise<import("./protocol/attachment.mjs").WireAttachment | undefined>}
 */
async function findAttachment(app, alias, id) {
  const newest = await app.read(alias, { limit: 1 });
  const epoch = newest.through.split(":")[0];
  const end = Number(newest.through.split(":")[1]);
  let since = `${epoch}:0`;
  while (Number(since.split(":")[1]) < end) {
    const page = await app.read(alias, { since, limit: 1000 });
    for (const m of page.messages) {
      const hit = /** @type {any[]} */ (m.attachments ?? []).find((a) => a?.id === id);
      if (hit) return hit;
    }
    if (page.through === since) break;
    since = page.through;
  }
  return undefined;
}

/** @param {NativeRecordContext} context */
async function attachmentGet(context) {
  const alias = context.rest[0];
  const id = context.rest[1];
  nativeRoom(context.cfg, alias, "agora attachment get");
  const out = resolvePath(String(context.values.out));
  const app = await client(context.cfg, context.stateRoot);
  try {
    const ref = await findAttachment(app, alias, id);
    if (!ref) throw new AgoraError(`attachment-unknown: no message in ${alias} names attachment ${id}`, EXIT.error);
    const got = await app.attachment(alias, { id: ref.id, digest: ref.digest });
    // never overwrites: the destination is created here or the verb refuses
    let handle;
    try { handle = await open(out, "wx", 0o600); }
    catch (e) {
      if (/** @type {any} */ (e)?.code === "EEXIST") throw new AgoraError(`${out} already exists; agora attachment get never overwrites`, EXIT.error);
      throw e;
    }
    let written = 0;
    try {
      for await (const part of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (got.stream))) {
        await handle.write(part);
        written += part.length;
      }
      await handle.sync();
    } catch (e) {
      // the stream refuses before its last chunk when the bytes do not hash to the digest: no
      // partial file is left behind under the name asked for
      await handle.close().catch(() => {});
      await rm(out, { force: true });
      throw e;
    }
    await handle.close();
    if (context.json) console.log(JSON.stringify({ type: "attachment", alias, id: ref.id, name: ref.name, digest: ref.digest, kind: got.kind, mimetype: got.mimetype, size: written, path: out }));
    else console.log(`${ref.name} (${got.kind}, ${got.mimetype}, ${written} bytes) verified against ${ref.digest} and written to ${out}`);
    return EXIT.ok;
  } catch (e) { throw asCliError(e); }
  finally { app.close(); }
}

async function readAllStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * An image's width and height read from its header bytes, for PNG, JPEG, GIF and WebP (the kinds
 * custody calls an image); undefined when the bytes are not one of them or the header does not say.
 * Nothing past the header is decoded.
 * @param {Uint8Array} input @returns {{ width: number, height: number } | undefined}
 */
export function imageDimensions(input) {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  /** @param {number} width @param {number} height */
  const sized = (width, height) => Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? { width, height } : undefined;
  // PNG: the signature, then the IHDR chunk's width and height, big-endian
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString("latin1", 12, 16) === "IHDR")
    return sized(b.readUInt32BE(16), b.readUInt32BE(20));
  // GIF: the logical screen's width and height, little-endian
  if (b.length >= 10 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a"))
    return sized(b.readUInt16LE(6), b.readUInt16LE(8));
  // WebP: RIFF....WEBP, then a lossy, lossless or extended first chunk
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return sized(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (chunk === "VP8L" && b[20] === 0x2f) return sized(1 + (b[21] | ((b[22] & 0x3f) << 8)), 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)));
    if (chunk === "VP8X") return sized(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    return undefined;
  }
  // JPEG: walk the segments to the first start-of-frame, whose height and width are big-endian
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 3 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      // markers that carry no length
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      const length = b.readUInt16BE(i + 2);
      if (length < 2) return undefined;
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return i + 9 <= b.length ? sized(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)) : undefined;
      i += 2 + length;
    }
  }
  return undefined;
}

/**
 * `post --attach`: upload each path into the room's custody and resolve with the references the
 * post carries, in the order given. The kind is what the bytes prove; a file's declared type comes
 * from its extension where one is known, and an image carries the width and height its header says.
 * @param {{ roomAlias: string, room: Record<string, any>, cfg: import("./core.mjs").Config, stateRoot: string, paths: string[] }} context
 * @returns {Promise<import("./protocol/attachment.mjs").WireAttachment[]>}
 */
export async function prepareAttachments(context) {
  if (context.room.transport !== "native") throw new AgoraError(`--attach belongs to a native room; "${context.roomAlias}" is a ${context.room.transport} room`, EXIT.usage);
  /** @type {Array<{ file: string, bytes: Buffer }>} */
  const files = [];
  for (const given of context.paths) {
    const file = resolvePath(given);
    let bytes;
    try { bytes = await readFile(file); }
    catch (e) { throw new AgoraError(`--attach ${given}: ${e instanceof Error ? e.message : String(e)}; nothing was posted`, EXIT.error); }
    files.push({ file, bytes });
  }
  const app = await client(context.cfg, context.stateRoot);
  try {
    /** @type {import("./protocol/attachment.mjs").WireAttachment[]} */
    const refs = [];
    for (const { file, bytes } of files) {
      const declared = DECLARED_TYPES[path.extname(file).toLowerCase()];
      const dimensions = imageDimensions(bytes);
      refs.push(await app.upload(context.roomAlias, { bytes, name: path.basename(file).slice(0, 255), ...(declared ? { mimetype: declared } : {}),
        ...(dimensions ?? {}) }));
    }
    return refs;
  } catch (e) { throw asCliError(e); }
  finally { app.close(); }
}
