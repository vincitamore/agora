// @ts-check
/**
 * Files: `POST /chat/upload` through the host's scans and the size caps into the room's custody,
 * `GET /chat/file/:id` streamed from custody with the stated headers, and `GET /chat/thumb/:digest`.
 *
 * Upload. The body is the file's bytes; `X-File-Name` names it (percent-encoded, so any name
 * travels in a header), `Content-Type` is the browser's word for it (custody records the type its
 * own bytes prove for an image). Optional `X-Image-Width` / `X-Image-Height` are the image's size
 * as the browser measured it. Over 25 MiB is 413 `TOO_LARGE` before custody is asked. A file whose
 * bytes are UTF-8 text is first given to the host's `scanText` (a refusal there refuses the
 * upload, so a secret the composer would refuse in words is refused in a file too), then every
 * file to `scanUpload`; either refusal is 422 `UPLOAD_REFUSED { reason }`, and a scan that throws
 * refuses with `reason: "scan-failed"`. Then `agora/client`'s `upload`: the answer is
 * `{ attachment, thumb? }`, the room's `WireAttachment` to post with, and the thumbnail's URL when
 * the kit already holds one for those bytes.
 *
 * Thumbnail. The same route with `X-Thumb-For: sha256:<hex>` stores the body (a PNG, JPEG, GIF or
 * WebP of at most 256 KiB, by its bytes) as the thumbnail of the attachment with that digest. Only
 * the person who uploaded that attachment through this kit may give its thumbnail, within an hour
 * of the upload; the answer is `{ thumb }`.
 *
 * Serving. A file or a thumbnail is served only while a message the index holds carries it and
 * still has its words (not withdrawn, not purged), and only to a person the host lets read that
 * message's thread; the uploader may also fetch their own upload before it is posted. Anything
 * else is 404, the same answer as bytes that do not exist. An image is served as its recorded
 * raster type; anything else (an SVG included: its bytes do not prove an image) as
 * `application/octet-stream` with `Content-Disposition: attachment`, so the browser saves it and
 * never renders it. Every answer carries `X-Content-Type-Options: nosniff`, `Cache-Control:
 * private` and a sandboxing `Content-Security-Policy`.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { asFault } from "./room.mjs";

/** One attachment, at most (the room's own limit). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** One thumbnail, at most. */
export const THUMB_MAX_BYTES = 256 * 1024;
/** A text file larger than this is not given to `scanText` (only to `scanUpload`). */
const TEXT_SCAN_MAX_BYTES = 1024 * 1024;
/** How long an upload not yet posted stays the uploader's to fetch and to give a thumbnail. */
const PENDING_MS = 60 * 60 * 1000;
const PENDING_MAX = 2000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{16,128}$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
/** The image types a browser is given as themselves; every other file is a download. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * Uploads not yet posted, by attachment id: who uploaded it, its digest and name, and when.
 * Module-level and bounded: one kit per process is the normal case, and the key carries the person.
 * @type {Map<string, { person: string, id: string, digest: string, name: string, at: number }>}
 */
const pending = new Map();

/** @param {string} person @param {{ id: string, digest: string, name: string }} a */
function remember(person, a) {
  pending.set(`${person}\0${a.id}`, { person, id: a.id, digest: a.digest, name: a.name, at: Date.now() });
  while (pending.size > PENDING_MAX) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

/** @param {string} person @param {(p: { id: string, digest: string }) => boolean} match */
function pendingFor(person, match) {
  const now = Date.now();
  for (const [key, p] of pending) {
    if (now - p.at > PENDING_MS) { pending.delete(key); continue; }
    if (p.person === person && match(p)) return p;
  }
  return null;
}

/**
 * The type a picture's bytes prove, or null.
 * @param {Uint8Array} b
 * @returns {string | null}
 */
export function rasterType(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** The bytes as text when they are UTF-8 text (no NUL), else null. @param {Uint8Array} bytes */
function asText(bytes) {
  if (bytes.byteLength > TEXT_SCAN_MAX_BYTES || bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

/**
 * The body, refused past `max` without reading the rest.
 * @param {Request} req @param {number} max
 * @returns {Promise<Uint8Array | 'too-large'>}
 */
async function readBody(req, max) {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return "too-large";
  if (!req.body) return new Uint8Array(0);
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return "too-large";
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** An image's side as the browser measured it. @param {string | null} v */
function side(v) {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * One statement, prepared, run and finalized. The kit's ad hoc queries never go through the query
 * cache: on Windows a statement the cache still holds keeps kit.sqlite open after the store closes
 * (measured: the purge path's lookups left the file busy until the process exited).
 * @template T
 * @param {import("bun:sqlite").Database} db @param {string} sql @param {(st: import("bun:sqlite").Statement<any>) => T} fn
 * @returns {T}
 */
export function once(db, sql, fn) {
  const st = db.prepare(sql);
  try { return fn(st); } finally { st.finalize(); }
}

/** The URL a thumbnail is served at. @param {string} digest */
export const thumbUrl = (digest) => `/chat/thumb/${encodeURIComponent(digest)}`;

/** `filename*` for a Content-Disposition. @param {string} name */
function dispositionName(name) {
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** @param {import("./room.mjs").Fault} f @param {import("./index.mjs").ChatKit} kit */
function custodyFault(f, kit) {
  if (f.outcome === "refused") {
    if (f.code === "attachment-too-large" || f.code === "attachment-quota") return kit.fail(413, "TOO_LARGE", `The room did not take the file (${f.code}).`, { refusal: f.code });
    return kit.fail(409, "ROOM_REFUSED", `The room refused the file (${f.code}).`, { refusal: f.code });
  }
  return kit.fail(503, "ROOM_DARK", "The room is unreachable right now. Nothing was uploaded; try again in a moment.");
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit
 * @returns {Promise<Response>}
 */
export async function handleUpload(req, person, kit) {
  if (!kit.hooks.authorize(person, "upload", {})) return kit.fail(403, "FORBIDDEN", "You cannot upload here.");
  const thumbFor = req.headers.get("x-thumb-for");
  if (thumbFor !== null) return putThumb(req, person, kit, thumbFor);

  let name = req.headers.get("x-file-name") ?? "";
  try { name = decodeURIComponent(name); } catch { return kit.fail(400, "BAD_REQUEST", "X-File-Name is percent-encoded."); }
  // eslint-disable-next-line no-control-regex
  if (!name.trim() || Buffer.byteLength(name, "utf8") > 255 || /[\x00-\x1f\x7f]/.test(name) || /[\\/]/.test(name)) return kit.fail(400, "BAD_REQUEST", "X-File-Name is the file's name: 1 to 255 bytes, no path or control characters.");
  const declaredType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const mimetype = MIME.test(declaredType) ? declaredType : undefined;
  const width = side(req.headers.get("x-image-width"));
  const height = side(req.headers.get("x-image-height"));
  if (width === null || height === null) return kit.fail(400, "BAD_REQUEST", "X-Image-Width and X-Image-Height are whole numbers from 1 to 65535.");

  const bytes = await readBody(req, UPLOAD_MAX_BYTES);
  if (bytes === "too-large") return kit.fail(413, "TOO_LARGE", `A file is at most ${UPLOAD_MAX_BYTES} bytes.`);
  if (!bytes.byteLength) return kit.fail(400, "BAD_REQUEST", "The body is the file's bytes, and it is empty.");

  const text = asText(bytes);
  try {
    if (text !== null) {
      const scan = kit.hooks.scanText(text) ?? {};
      if (scan.refuse) return kit.fail(422, "UPLOAD_REFUSED", "The file was not uploaded.", { reason: scan.refuse });
    }
    const verdict = await kit.hooks.scanUpload({ name, mimetype: mimetype ?? "application/octet-stream", bytes });
    if (!verdict || verdict.ok !== true) return kit.fail(422, "UPLOAD_REFUSED", "The file was not uploaded.", { reason: (verdict && "reason" in verdict && typeof verdict.reason === "string" && verdict.reason) || "refused" });
  } catch (e) {
    kit.log(`chat: the host's upload scan threw: ${e instanceof Error ? e.message : String(e)}`);
    return kit.fail(422, "UPLOAD_REFUSED", "The file could not be checked, so it was not uploaded.", { reason: "scan-failed" });
  }

  const isImage = rasterType(bytes) !== null;
  /** @type {Record<string, any>} */
  let attachment;
  try {
    attachment = await kit.room.upload({ bytes, name, ...(mimetype ? { mimetype } : {}),
      ...(isImage && width !== undefined && height !== undefined ? { width, height } : {}) });
  } catch (e) {
    const f = asFault(e);
    kit.log(`chat: an upload was not taken: ${f.outcome} (${f.code})`);
    return custodyFault(f, kit);
  }
  remember(person.id, { id: attachment.id, digest: attachment.digest, name });
  const thumb = kit.store.thumb(attachment.digest);
  return kit.json(200, { ok: true, data: { attachment, ...(thumb ? { thumb: thumbUrl(attachment.digest) } : {}) } });
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit @param {string} digest
 */
async function putThumb(req, person, kit, digest) {
  if (!DIGEST.test(digest)) return kit.fail(400, "BAD_REQUEST", "X-Thumb-For is an attachment's digest (sha256:<hex>).");
  if (!pendingFor(person.id, (p) => p.digest === digest)) return kit.fail(404, "NOT_FOUND", "There is no upload of yours with that digest to give a thumbnail.");
  const bytes = await readBody(req, THUMB_MAX_BYTES);
  if (bytes === "too-large") return kit.fail(413, "TOO_LARGE", `A thumbnail is at most ${THUMB_MAX_BYTES} bytes.`);
  if (!rasterType(bytes)) return kit.fail(422, "UPLOAD_REFUSED", "A thumbnail is a PNG, JPEG, GIF or WebP.", { reason: "thumb-not-an-image" });
  const file = path.join(kit.store.thumbsDir, digest.slice("sha256:".length));
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes, { mode: 0o600 });
  try { await rename(temp, file); }
  catch (e) { await unlink(temp).catch(() => undefined); throw e; }
  kit.store.putThumb(digest, file);
  return kit.json(200, { ok: true, data: { thumb: thumbUrl(digest) } });
}

/**
 * A message the index holds that carries this file and still has its words, or null.
 * @param {import("./index.mjs").ChatKit} kit @param {string} column @param {string[]} values
 * @returns {{ message: string, thread: string | null, name: string } | null}
 */
function carrier(kit, column, values) {
  return /** @type {any} */ (once(kit.store.db, `select f.message as message, m.thread as thread, f.name as name
    from message_files f join messages m on m.id = f.message
    where ${column} and m.withdrawn = 0 and json_extract(m.json, '$.purged') is null order by m.seq limit 1`, (st) => st.get(...values)));
}

/** @param {Record<string, string>} more */
const fileHeaders = (more) => ({ "x-content-type-options": "nosniff", "cache-control": "private", "content-security-policy": SANDBOX, ...more });

/**
 * @param {Request} req @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit
 * @returns {Promise<Response>}
 */
export async function handleFile(req, person, kit) {
  const url = new URL(req.url);
  let id = "";
  try { id = decodeURIComponent(url.pathname.split("/")[3] ?? ""); } catch { /* not an id */ }
  const digest = url.searchParams.get("digest") ?? "";
  if (!ATTACHMENT_ID.test(id) || !DIGEST.test(digest)) return kit.fail(400, "BAD_REQUEST", "A file is /chat/file/<attachment id>?digest=sha256:<hex>.");
  const notFound = () => kit.fail(404, "NOT_FOUND", "There is no such file.");
  const held = carrier(kit, "f.attachment = ? and f.digest = ?", [id, digest]);
  /** @type {string} */
  let name;
  if (held) {
    if (!kit.hooks.authorize(person, "read", { thread: held.thread ?? held.message })) return notFound();
    name = held.name;
  } else {
    const mine = pendingFor(person.id, (p) => p.id === id && p.digest === digest);
    if (!mine) return notFound();
    name = mine.name;
  }
  /** @type {Record<string, any>} */
  let got;
  try { got = await kit.room.attachment({ id, digest }); }
  catch (e) {
    const f = asFault(e);
    if (f.outcome === "refused") return notFound();
    return kit.fail(503, "ROOM_DARK", "The room is unreachable right now.");
  }
  const image = got.kind === "image" && RASTER.has(got.mimetype);
  return new Response(/** @type {ReadableStream<Uint8Array>} */ (got.stream), {
    status: 200,
    headers: fileHeaders({
      "content-type": image ? got.mimetype : "application/octet-stream",
      "content-length": String(got.size),
      "content-disposition": `${image ? "inline" : "attachment"}; ${dispositionName(name)}`,
    }),
  });
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit
 * @returns {Promise<Response>}
 */
export async function handleThumb(req, person, kit) {
  const url = new URL(req.url);
  let digest = "";
  try { digest = decodeURIComponent(url.pathname.split("/")[3] ?? ""); } catch { /* not a digest */ }
  if (!DIGEST.test(digest)) return kit.fail(400, "BAD_REQUEST", "A thumbnail is /chat/thumb/sha256:<hex>.");
  const notFound = () => kit.fail(404, "NOT_FOUND", "There is no such thumbnail.");
  const held = carrier(kit, "f.digest = ?", [digest]);
  if (held) {
    if (!kit.hooks.authorize(person, "read", { thread: held.thread ?? held.message })) return notFound();
  } else if (!pendingFor(person.id, (p) => p.digest === digest)) return notFound();
  const file = kit.store.thumb(digest);
  if (!file) return notFound();
  /** @type {Uint8Array} */
  let bytes;
  try { bytes = new Uint8Array(await readFile(file)); } catch { return notFound(); }
  const type = rasterType(bytes);
  if (!type) return notFound();
  return new Response(/** @type {BodyInit} */ (/** @type {unknown} */ (bytes)), { status: 200, headers: fileHeaders({ "content-type": type, "content-length": String(bytes.byteLength) }) });
}

/**
 * After a purge: forget these digests' pending uploads, and remove their thumbnails where no
 * message with its words still carries them. Never throws.
 * @param {import("./store.mjs").KitStore} store @param {readonly string[]} digests @param {(line: string) => void} log
 */
export function dropThumbsUnreferenced(store, digests, log) {
  // a purge of a posted file also ends its uploader's own access to it
  for (const [key, p] of pending) if (digests.includes(p.digest)) pending.delete(key);
  for (const digest of digests) {
    try {
      const live = once(store.db, `select 1 from message_files f join messages m on m.id = f.message
        where f.digest = ? and m.withdrawn = 0 and json_extract(m.json, '$.purged') is null limit 1`, (st) => st.get(digest));
      if (live) continue;
      const file = store.thumb(digest);
      store.db.run("delete from thumbs where digest = ?", digest);
      if (file) { try { unlinkSync(file); } catch { /* already gone */ } }
    } catch (e) {
      log(`chat: a thumbnail was not removed (${digest}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
