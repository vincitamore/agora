// @ts-check
import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { FACE_DESCRIPTIVE_FIELDS, faceRecordsPath, foldFaceRecords, scrubFaceLine, withFaceLog } from "./faces.mjs";
import { faceInboundPath } from "./faces-inbound.mjs";
import { writeDurableAtomic } from "./native-store.mjs";

/**
 * A purge's scrub of the room's face records (docs/PURGE.md § Faces). The seat writes what its
 * faces did with each message beside the room: `faces.jsonl` (one row per copy and per act on it)
 * and `face-inbound.jsonl` (what crossed in from a face). A row about a purged message can name or
 * describe its attachments (a picture's file name; a crossing's file names and metadata lines,
 * which carry name, kind and size) and can fingerprint its text (a crossing's text digest). The
 * scrub takes those off every row of every purged message and keeps the rest: transport, channel,
 * status, the copy's ts or file id, the attachment id, the cursor and the mirror's act, which is
 * what the deletions, `facesOutOfReach` and the sweep read.
 *
 * Crash safety: each file is rewritten whole to a temp file, synced, and installed by one rename
 * (the store's `writeDurableAtomic`), so a crash leaves either the old file, which the next run
 * scrubs again, or the scrubbed one. A temp file a crash left behind is removed by the next run;
 * it never holds more than the scrubbed text. The scrub is idempotent: a file with nothing to take
 * is not rewritten. Writers in the seat service queue on the same file (`withFaceLog`), and a file
 * that grew while it was being rewritten (another process appending) is read again before the rename.
 *
 * It runs inside a purge, after the message log's rewrite and before custody collection, and when
 * the service opens a room a purge has touched, so a scrub a crash interrupted finishes there.
 */

/** How many times a file that keeps growing under the scrub is read again before giving up. */
const SCRUB_REREADS = 8;

/**
 * Where a test may stop a scrub, as a crash would: after a file's temp copy is written and synced
 * (`temp-written`), or after it is installed (`installed`).
 * @typedef {{ scrubStage?: (stage: 'temp-written' | 'installed', file: string) => void | Promise<void> }} ScrubHooks
 */

/**
 * The refusal codes after which a purge's delete of a copy is never attempted again: the face was
 * removed, cannot delete, the copy never landed, or the attempts ran out. A refusal the face
 * answered (a `cant_delete_message`) is not among them: a resent purge may still reach that copy.
 */
const SETTLED_DELETE_REFUSALS = new Set(["no-such-face", "capability", "no-copy", "exhausted"]);

/**
 * The text copies of purged messages whose deletion has settled, by `originId\0transport`: the copy
 * never landed (its own row refused), or a withdraw or purge deleted it (or found it already gone),
 * or a purge's delete of it was recorded out of reach with no attempt left. While a copy is pending,
 * unknown, or its delete is still to be attempted, its row keeps `payloadDigest`, by which a
 * reconciliation finds a copy that landed without its response; once settled the digest goes.
 * @param {any[]} lines @param {Set<string>} purged
 */
function settledCopies(lines, purged) {
  /** @type {Set<string>} */
  const settled = new Set();
  for (const r of foldFaceRecords(lines.filter((l) => l && typeof l === "object" && purged.has(l.originId))).values()) {
    if (r.attachmentId) continue;
    const key = `${r.originId}\0${r.transport}`;
    if (r.part !== "mirror") { if (r.status === "refused") settled.add(key); continue; }
    if ((r.act === "purge" || r.act === "withdraw") && r.status === "published") settled.add(key);
    else if (r.act === "purge" && r.status === "refused" && SETTLED_DELETE_REFUSALS.has(String(r.code))) settled.add(key);
  }
  return settled;
}

/** @param {any} line @param {Set<string>} purged @param {Set<string>} settled */
function scrubOutboundLine(line, purged, settled) {
  if (!line || typeof line !== "object" || !purged.has(line.originId)) return line;
  const digest = "payloadDigest" in line && !line.attachmentId && settled.has(`${line.originId}\0${line.transport}`);
  if (!digest && !FACE_DESCRIPTIVE_FIELDS.some((f) => f in line)) return line;
  const out = scrubFaceLine(line);
  if (digest) delete out.payloadDigest;
  return out;
}

/** @param {any} line @param {Set<string>} purged */
function scrubInboundLine(line, purged) {
  if (!line || typeof line !== "object" || line.kind !== "ingested" || typeof line.id !== "string" || !purged.has(line.id)) return line;
  if (!("fileLines" in line) && !("textDigest" in line) && !(Array.isArray(line.files) && line.files.some((/** @type {any} */ f) => f && ("name" in f || "reason" in f)))) return line;
  const { fileLines: _lines, textDigest: _digest, files, ...rest } = line;
  return { ...rest, ...(Array.isArray(files) ? { files: files.map((/** @type {any} */ f) => ({ copied: f?.copied === true, ...(typeof f?.attachmentId === "string" ? { attachmentId: f.attachmentId } : {}) })) } : {}) };
}

/**
 * The scrubbed text of one log, or undefined when it has nothing to take. A line that does not
 * parse (a torn last line a killed writer left) is not a record: it is kept unless it names a
 * purged message, in which case it goes.
 * @param {string} text @param {Set<string>} purged @param {(line: any, purged: Set<string>, settled: Set<string>) => any} scrubLine
 */
function scrubText(text, purged, scrubLine) {
  let changed = false;
  const out = [];
  const parts = text.split("\n");
  const tail = parts.pop() ?? "";
  /** @type {any[]} */
  const parsed = [];
  for (const raw of parts) { try { parsed.push(JSON.parse(raw)); } catch { /* not a record */ } }
  const settled = settledCopies(parsed, purged);
  for (const raw of parts) {
    if (!raw.trim()) { out.push(raw); continue; }
    let line;
    try { line = JSON.parse(raw); }
    catch {
      if ([...purged].some((id) => raw.includes(id))) { changed = true; continue; }
      out.push(raw);
      continue;
    }
    const next = scrubLine(line, purged, settled);
    if (next === line) out.push(raw);
    else { changed = true; out.push(JSON.stringify(next)); }
  }
  let rest = tail;
  if (tail && [...purged].some((id) => tail.includes(id))) { changed = true; rest = ""; }
  return changed ? out.map((l) => `${l}\n`).join("") + rest : undefined;
}

/**
 * @param {string} file @param {Set<string>} purged @param {(line: any, purged: Set<string>, settled: Set<string>) => any} scrubLine @param {ScrubHooks} hooks
 * @returns {Promise<boolean>} whether the file was rewritten
 */
async function scrubFile(file, purged, scrubLine, hooks) {
  await removeStaleTemps(file);
  return withFaceLog(file, async () => {
    for (let attempt = 0; attempt < SCRUB_REREADS; attempt++) {
      let text;
      try { text = await readFile(file, "utf8"); }
      catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return false; throw e; }
      const next = scrubText(text, purged, scrubLine);
      if (next === undefined) return false;
      // another process (the CLI) may append between this read and the rename: read again if it did
      if ((await stat(file)).size !== Buffer.byteLength(text, "utf8")) continue;
      await writeDurableAtomic(file, next, hooks.scrubStage ? { rename: async (from, to) => {
        await hooks.scrubStage?.("temp-written", file);
        await rename(from, to);
      } } : {});
      await hooks.scrubStage?.("installed", file);
      return true;
    }
    throw new Error(`the face record log ${path.basename(file)} kept growing while a purge scrubbed it; the next purge or open of the room finishes the scrub`);
  });
}

/** Remove the temp copies a killed scrub left beside a log (`<file>.tmp-<pid>-<uuid>`). @param {string} file */
async function removeStaleTemps(file) {
  let names;
  try { names = await readdir(path.dirname(file)); }
  catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return; throw e; }
  const prefix = `${path.basename(file)}.tmp-`;
  const own = `${prefix}${process.pid}-`;
  // a temp of this process may be another scrub's in flight; the queue on the file orders those
  for (const name of names) if (name.startsWith(prefix) && !name.startsWith(own)) await rm(path.join(path.dirname(file), name), { force: true });
}

/**
 * Take every field that names or describes a purged message's attachments, or fingerprints its
 * text, off the room's face records. Idempotent; safe to run again after a crash.
 * @param {string} stateRoot @param {string} roomId @param {Iterable<string>} purgedIds the ids every purge in the room took
 * @param {{ hooks?: ScrubHooks }} [options]
 * @returns {Promise<{ rewritten: string[] }>} the files it rewrote, by base name
 */
export async function scrubFaceRecords(stateRoot, roomId, purgedIds, options = {}) {
  const purged = new Set(purgedIds);
  /** @type {string[]} */
  const rewritten = [];
  if (!purged.size) return { rewritten };
  const hooks = options.hooks ?? {};
  for (const [file, scrubLine] of /** @type {const} */ ([[faceRecordsPath(stateRoot, roomId), scrubOutboundLine], [faceInboundPath(stateRoot, roomId), scrubInboundLine]]))
    if (await scrubFile(file, purged, scrubLine, hooks)) rewritten.push(path.basename(file));
  return { rewritten };
}
