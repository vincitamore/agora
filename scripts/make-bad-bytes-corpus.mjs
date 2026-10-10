#!/usr/bin/env node
// Writes test/fixtures/native-store-bad/: one GOOD native room the reopen path must accept
// (messages, board records, a checkpointed boundary), and one damaged copy per case, each a
// named edit of that good room (a truncated last frame, a length header that overruns, a
// checksum that no longer matches, a payload that is not JSON, a manifest field gone or wrong,
// a boundary that ends inside a frame or names a foreign epoch or disagrees with the log, a
// writer lock naming a dead endpoint or unparseable; and, behind a re-sealed frame, one edit per
// field the scan validates: record, message, board and boundary fields, a reply's via and
// author ref among them). Every case carries an EXPECT.json naming
// what `NativeRoomStore.open` must say, so the test opens the committed bytes offline and the
// bytes stay traceable to the edit that made them.
//
//   node scripts/make-bad-bytes-corpus.mjs            (re)write the corpus
//   node scripts/make-bad-bytes-corpus.mjs --check    exit 1 when the committed corpus differs
//
// The good room is written by the store itself under a fixed clock and fixed ids, so the bytes
// are reproducible; the writer lock is rewritten to a dead endpoint (the store's own lock names
// a live port on the writing machine).

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeRoomStore } from "../src/native-store.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "test", "fixtures", "native-store-bad");
export const HOST = "a0e7ad17c2dee02fc4cee4fcd6a04a9a";
export const ROOM = "c0c0a5e5c0c0a5e5c0c0a5e5c0c0a5e5"; // synthetic: no seat room has this id
const DEAD_LOCK = JSON.stringify({ host: "127.0.0.1", port: 1, pid: 1, identity: "corpus" }) + "\n";

/** the byte offset of the last frame's header, the file size and the bytes */
/** @param {string} frames */
function lastFrame(frames) {
  const bytes = readFileSync(frames);
  let pos = 0, last = 0;
  while (pos + 4 <= bytes.length) { last = pos; const len = bytes.readUInt32BE(pos); pos += 4 + len + 32; }
  return { last, size: bytes.length, bytes };
}
/** @param {string} p @param {(o: any) => void} f */
function editJson(p, f) { const o = JSON.parse(readFileSync(p, "utf8")); f(o); writeFileSync(p, JSON.stringify(o, null, 2) + "\n"); }
/** @param {string} p @param {number} at @param {Buffer} buf */
function patchBytes(p, at, buf) { const b = readFileSync(p); buf.copy(b, at); writeFileSync(p, b); }

/**
 * Replace the last frame's payload with `text` (valid JSON that is not a record) and re-seal the
 * frame, so the record check, not the checksum or the parser, is what refuses.
 * @param {Paths} p @param {string} text
 */
function replaceLastPayload({ frames, boundary }, text) {
  const { last, bytes } = lastFrame(frames); const len = bytes.readUInt32BE(last); const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(4); header.writeUInt32BE(payload.length, 0);
  writeFileSync(frames, Buffer.concat([bytes.subarray(0, last), header, payload, createHash("sha256").update(payload).digest()]));
  editJson(boundary, (o) => { o.end = o.end + (payload.length - len); });
}

/**
 * Edit the record inside frame `index` (0-based) as JSON and re-seal the frame: a fresh length
 * header and checksum, so the scan accepts the bytes and the edit reaches the field validation
 * behind them. The boundary's end moves by the size delta; its digest is left alone, so a case
 * that edits the last record keeps the boundary agreeing with the record it acknowledges.
 * @param {Paths} p @param {number} index @param {(record: any) => void} f
 */
function editRecord({ frames, boundary }, index, f) {
  const bytes = readFileSync(frames);
  const parts = [];
  let pos = 0;
  while (pos + 4 <= bytes.length) { const len = bytes.readUInt32BE(pos); parts.push(bytes.subarray(pos, pos + 4 + len + 32)); pos += 4 + len + 32; }
  const frame = parts[index];
  const record = JSON.parse(frame.subarray(4, 4 + frame.readUInt32BE(0)).toString("utf8"));
  f(record);
  const payload = Buffer.from(JSON.stringify(record), "utf8");
  const header = Buffer.alloc(4); header.writeUInt32BE(payload.length, 0);
  parts[index] = Buffer.concat([header, payload, createHash("sha256").update(payload).digest()]);
  const next = Buffer.concat(parts);
  writeFileSync(frames, next);
  editJson(boundary, (o) => { o.end = o.end + (next.length - bytes.length); });
}

/** The record inside frame `index` (0-based), as JSON. @param {Paths} p @param {number} index */
function readRecord({ frames }, index) {
  const bytes = readFileSync(frames);
  let pos = 0;
  for (let i = 0; i < index; i++) pos += 4 + bytes.readUInt32BE(pos) + 32;
  return JSON.parse(bytes.subarray(pos + 4, pos + 4 + bytes.readUInt32BE(pos)).toString("utf8"));
}

/**
 * each case: a named edit of a good room and what open must say (null: opens); `base` names the
 * room it edits, the version 1 room when absent
 * @typedef {{ dir: string, frames: string, manifest: string, boundary: string, lock: string }} Paths
 * @typedef {{ base?: "purge", expect: string | null, edit: (p: Paths) => void }} Case
 * @type {Record<string, Case>}
 */
export const CASES = {
  "truncated-last-frame": { expect: "truncated below its acknowledged", edit: ({ frames }) => { const { size } = lastFrame(frames); writeFileSync(frames, readFileSync(frames).subarray(0, size - 5)); } },
  "length-header-overruns": { expect: "declares an invalid", edit: ({ frames }) => { const { last } = lastFrame(frames); const b = Buffer.alloc(4); b.writeUInt32BE(0x7fffffff, 0); patchBytes(frames, last, b); } },
  "checksum-mismatch": { expect: "checksum mismatch at offset", edit: ({ frames }) => { const { last, bytes } = lastFrame(frames); const len = bytes.readUInt32BE(last); patchBytes(frames, last + 4 + len, Buffer.from([bytes[last + 4 + len] ^ 0xff])); } },
  "payload-not-json": { expect: "invalid UTF-8 or JSON at offset", edit: ({ frames }) => { const { last, bytes } = lastFrame(frames); const len = bytes.readUInt32BE(last); const payload = Buffer.alloc(len, 0xff); patchBytes(frames, last + 4, payload); patchBytes(frames, last + 4 + len, createHash("sha256").update(payload).digest()); } },
  "manifest-host-missing": { expect: "manifest is invalid", edit: ({ manifest }) => editJson(manifest, (o) => { delete o.hostAccountId; }) },
  "manifest-record-limit-zero": { expect: "manifest is invalid", edit: ({ manifest }) => editJson(manifest, (o) => { o.recordLimit = 0; }) },
  "manifest-room-mismatch": { expect: "manifest is invalid", edit: ({ manifest }) => editJson(manifest, (o) => { o.roomId = "0".repeat(32); }) },
  "manifest-not-json": { expect: "has no valid manifest", edit: ({ manifest }) => writeFileSync(manifest, "{not json") },
  "boundary-ends-inside-frame": { expect: "ends inside a record", edit: ({ boundary }) => editJson(boundary, (o) => { o.end = o.end - 2; }) },
  "boundary-sequence-negative": { expect: "committed boundary is invalid", edit: ({ boundary }) => editJson(boundary, (o) => { o.sequence = -1; }) },
  "boundary-digest-disagrees": { expect: "does not match its acknowledged sequence/digest boundary", edit: ({ boundary }) => editJson(boundary, (o) => { o.digest = "sha256:" + "0".repeat(64); }) },
  "boundary-foreign-epoch": { expect: "committed boundary is invalid", edit: ({ boundary }) => editJson(boundary, (o) => { o.epoch = "0".repeat(32); }) },
  "log-sequence-gap": { expect: "sequence gap", edit: ({ frames, boundary }) => {
    // drop the second frame, keep the boundary's end honest: the scan reads a record at sequence 3 where it expects 2
    const { bytes } = lastFrame(frames); const len1 = bytes.readUInt32BE(0); const f1 = 4 + len1 + 32; const len2 = bytes.readUInt32BE(f1); const f2 = 4 + len2 + 32;
    writeFileSync(frames, Buffer.concat([bytes.subarray(0, f1), bytes.subarray(f1 + f2)]));
    editJson(boundary, (o) => { o.end = o.end - f2; });
  } },
  "lock-unparseable": { expect: "writer lock", edit: ({ lock }) => writeFileSync(lock, "not json") },
  "lock-dead-endpoint": { expect: null, edit: () => {} },
  // wave 2: the fields the scan validates behind a well-formed frame. Frame 3 is the board claim,
  // frame 4 the last top-level chat message, frame 5 a reply in frame 0's thread that an app client
  // submitted (it carries via and author.ref); each edit re-seals its frame so the checksum passes
  // and the field check is what refuses.
  "record-not-object": { expect: "record for another room or protocol version", edit: (p) => replaceLastPayload(p, JSON.stringify("not a record")) },
  "record-null": { expect: "record for another room or protocol version", edit: (p) => replaceLastPayload(p, "null") },
  "record-foreign-room": { expect: "record for another room or protocol version", edit: (p) => editRecord(p, 4, (r) => { r.roomId = "0".repeat(32); }) },
  "record-foreign-epoch": { expect: "record for another room or protocol version", edit: (p) => editRecord(p, 4, (r) => { r.epoch = "0".repeat(32); }) },
  "record-wrong-version": { expect: "record for another room or protocol version", edit: (p) => editRecord(p, 4, (r) => { r.version = 999; }) },
  "record-payload-digest-malformed": { expect: "invalid payload digest", edit: (p) => editRecord(p, 4, (r) => { r.payloadDigest = "sha256:short"; }) },
  "record-account-id-malformed": { expect: "record account id must be", edit: (p) => editRecord(p, 4, (r) => { r.accountId = "zz"; }) },
  "record-operation-id-malformed": { expect: "operation id must be", edit: (p) => editRecord(p, 4, (r) => { r.operationId = "x"; }) },
  "record-digest-malformed": { expect: "record digest mismatch", edit: (p) => editRecord(p, 4, (r) => { r.recordDigest = "sha256:short"; }) },
  "record-digest-wrong": { expect: "record digest mismatch", edit: (p) => { const d = "sha256:" + "1".repeat(64); editRecord(p, 4, (r) => { r.recordDigest = d; }); editJson(p.boundary, (o) => { o.digest = d; }); } },
  "message-missing": { expect: "message identity does not match", edit: (p) => editRecord(p, 4, (r) => { delete r.message; }) },
  "message-id-mismatch": { expect: "message identity does not match", edit: (p) => editRecord(p, 4, (r) => { r.message.id = "f".repeat(64); }) },
  "message-author-mismatch": { expect: "message identity does not match", edit: (p) => editRecord(p, 4, (r) => { r.message.author.id = "b".repeat(32); }) },
  "message-room-mismatch": { expect: "message identity does not match", edit: (p) => editRecord(p, 4, (r) => { r.message.room = "0".repeat(32); }) },
  "message-cursor-mismatch": { expect: "message identity does not match", edit: (p) => editRecord(p, 4, (r) => { r.message.cursor = r.message.cursor.replace(/:\d+$/, ":99"); }) },
  "board-id-mismatch": { expect: "board identity does not match", edit: (p) => editRecord(p, 3, (r) => { r.boardId = "f".repeat(64); }) },
  "board-cursor-mismatch": { expect: "board identity does not match", edit: (p) => editRecord(p, 3, (r) => { r.cursor = r.cursor.replace(/:\d+$/, ":99"); }) },
  "board-carries-message": { expect: "board record must not carry a chat message", edit: (p) => editRecord(p, 3, (r) => { r.message = { id: "x" }; }) },
  "board-payload-invalid": { expect: "board record is invalid", edit: (p) => editRecord(p, 3, (r) => { r.board = { action: "dance" }; }) },
  "boundary-not-json": { expect: "committed boundary", edit: ({ boundary }) => writeFileSync(boundary, "{not json") },
  "boundary-wrong-version": { expect: "committed boundary is invalid", edit: ({ boundary }) => editJson(boundary, (o) => { o.version = 2; }) },
  "boundary-foreign-room": { expect: "committed boundary is invalid", edit: ({ boundary }) => editJson(boundary, (o) => { o.roomId = "0".repeat(32); }) },
  "boundary-sequence-fractional": { expect: "committed boundary is invalid", edit: ({ boundary }) => editJson(boundary, (o) => { o.sequence = 4.5; }) },
  "boundary-sequence-past-limit": { expect: "committed boundary is invalid", edit: ({ boundary, manifest }) => editJson(manifest, (o) => { o.recordLimit = JSON.parse(readFileSync(boundary, "utf8")).sequence - 1; }) },
  "boundary-sequence-at-limit": { expect: null, edit: ({ boundary, manifest }) => editJson(manifest, (o) => { o.recordLimit = JSON.parse(readFileSync(boundary, "utf8")).sequence; }) },
  "boundary-end-negative": { expect: "committed boundary is invalid", edit: ({ boundary }) => editJson(boundary, (o) => { o.end = -1; }) },
  "boundary-end-fractional": { expect: "committed boundary is invalid", edit: ({ boundary }) => editJson(boundary, (o) => { o.end = o.end - 0.5; }) },
  "boundary-digest-malformed": { expect: "committed boundary is invalid", edit: ({ boundary }) => editJson(boundary, (o) => { o.digest = "sha256:short"; }) },
  "boundary-ends-after-header": { expect: "ends inside a record", edit: ({ frames, boundary }) => { const { last } = lastFrame(frames); editJson(boundary, (o) => { o.end = last + 4; }); } },
  "record-one-byte": { expect: "record for another room or protocol version", edit: (p) => replaceLastPayload(p, "1") },
  "boundary-ends-inside-header": { expect: "ends inside a header", edit: ({ frames, boundary }) => { const { last } = lastFrame(frames); editJson(boundary, (o) => { o.end = last + 2; }); } },
  "message-via-malformed": { expect: "carries an invalid via", edit: (p) => editRecord(p, 5, (r) => { r.message.via = "Not A Client"; }) },
  "message-author-ref-malformed": { expect: "carries an invalid author ref", edit: (p) => editRecord(p, 5, (r) => { r.message.author.ref = "has space"; }) },
  "message-author-ref-without-via": { expect: "carries an author ref without a via", edit: (p) => editRecord(p, 5, (r) => { delete r.message.via; }) },
  "boundary-ends-at-frame": { expect: null, edit: ({ frames, boundary }) => {
    // the boundary acknowledges the first three frames: the rest stay on disk unacknowledged, and open accepts it
    const { last, bytes } = lastFrame(frames); const len1 = bytes.readUInt32BE(0); const f1 = 4 + len1 + 32; const len2 = bytes.readUInt32BE(f1); const f2 = 4 + len2 + 32; const len3 = bytes.readUInt32BE(f1 + f2); const f3 = 4 + len3 + 32;
    const digest3 = JSON.parse(bytes.subarray(f1 + f2 + 4, f1 + f2 + 4 + len3).toString("utf8")).recordDigest;
    void last; editJson(boundary, (o) => { o.end = f1 + f2 + f3; o.sequence = 3; o.digest = digest3; });
  } },
  // wave 3: a version 2 room that a purge rewrote (base "purge"; purgeRoom writes it). Frame 0 is a
  // thread root whose text and edit the purge took, 1 a message it left (pinned), 2 the root's
  // reply, 3 a message it took by target, 4 the pin, 5 the edit, 6 the purge (targets [3], thread 0,
  // submitted through a client connection, so it carries via and by.ref). Each case is one field of
  // the stored purge record, or one marker or annotation the purge's scan checks.
  "good-purge": { base: "purge", expect: null, edit: () => {} },
  "purge-carries-board": { base: "purge", expect: "carries a message, a board act or an annotation", edit: (p) => editRecord(p, 6, (r) => { r.board = { action: "claim", subject: "work:x" }; }) },
  "purge-null": { base: "purge", expect: "does not match its committed position", edit: (p) => editRecord(p, 6, (r) => { r.purge = null; }) },
  "purge-id-mismatch": { base: "purge", expect: "does not match its committed position", edit: (p) => editRecord(p, 6, (r) => { r.purge.id = "f".repeat(64); }) },
  "purge-cursor-mismatch": { base: "purge", expect: "does not match its committed position", edit: (p) => editRecord(p, 6, (r) => { r.purge.cursor = r.purge.cursor.replace(/:\d+$/, ":99"); }) },
  "purge-ts-not-string": { base: "purge", expect: "does not match its committed position", edit: (p) => editRecord(p, 6, (r) => { r.purge.ts = 5; }) },
  // a number whose decimal form is a valid id: only the type check refuses it
  "purge-target-number": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.targets = [1234567890123456]; }) },
  // an id of exactly 16 characters has a valid shape, so what refuses it is that the log never held it
  "purge-target-sixteen": { base: "purge", expect: "names a message the log did not hold", edit: (p) => editRecord(p, 6, (r) => { r.purge.targets = ["a".repeat(16)]; }) },
  "purge-target-too-long": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.targets = ["a".repeat(129)]; }) },
  "purge-target-malformed": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.targets = ["short"]; }) },
  "purge-targets-not-list": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.targets = "x"; }) },
  "purge-target-unknown": { base: "purge", expect: "names a message the log did not hold", edit: (p) => editRecord(p, 6, (r) => { r.purge.targets = ["b".repeat(64)]; }) },
  "purge-thread-malformed": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.thread = "short"; }) },
  "purge-thread-unknown": { base: "purge", expect: "names a message the log did not hold", edit: (p) => editRecord(p, 6, (r) => { r.purge.thread = "b".repeat(64); }) },
  "purge-thread-is-reply": { base: "purge", expect: "names a message the log did not hold", edit: (p) => editRecord(p, 6, (r) => { r.purge.thread = r.purge.purged[1]; }) },
  "purge-names-nothing": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.targets = []; delete r.purge.thread; }) },
  "purge-reason-not-string": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.reason = 5; }) },
  "purge-reason-empty": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.reason = ""; }) },
  "purge-by-missing": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { delete r.purge.by; }) },
  "purge-by-name-not-string": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.by.name = 5; }) },
  // a number whose decimal form matches the ref pattern: only the type check refuses it
  "purge-by-ref-number": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.by.ref = 12345; }) },
  "purge-by-ref-malformed": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.by.ref = "has space"; }) },
  "purge-by-ref-without-via": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { delete r.purge.via; }) },
  // `true` reads as "true", which matches the client-name pattern: only the type check refuses it
  "purge-via-boolean": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.via = true; }) },
  "purge-via-malformed": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.via = "Not A Client"; }) },
  "purge-list-not-list": { base: "purge", expect: "is not a purge", edit: (p) => editRecord(p, 6, (r) => { r.purge.purged = "x"; }) },
  "purge-list-short": { base: "purge", expect: "lists messages its targets and thread do not name", edit: (p) => editRecord(p, 6, (r) => { r.purge.purged.pop(); }) },
  // a marker is outside the record digest, so the scan's end check is what holds it
  "marker-names-other-purge": { base: "purge", expect: "has no text and no purge names it", edit: (p) => { const purge = readRecord(p, 6).purge; editRecord(p, 1, (r) => { delete r.message.text; r.message.purged = { at: purge.ts, purge: purge.id }; }); } },
  "marker-wrong-time": { base: "purge", expect: "has no text and no purge names it", edit: (p) => editRecord(p, 0, (r) => { r.message.purged.at = "2000-01-01T00:00:00.000Z"; }) },
  "annotation-carries-board": { base: "purge", expect: "carries a message, a board act or a purge", edit: (p) => editRecord(p, 4, (r) => { r.board = { action: "claim", subject: "work:x" }; }) },
  "pin-carries-marker": { base: "purge", expect: "carries a text on a pin", edit: (p) => { const purge = readRecord(p, 6).purge; editRecord(p, 4, (r) => { r.annotation.purged = { at: purge.ts, purge: purge.id }; }); } },
};

/** write the good room under a fixed clock and return its directory */
async function goodRoom() {
  const root = await mkdtemp(join(tmpdir(), "agora-corpus-"));
  let tick = Date.UTC(2026, 8, 18, 12, 0, 0);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, hostAccountId: HOST, epoch: "9f97cbaedb3b45d5a9807816a2c6fa5a", now: () => new Date((tick += 1000)) });
  const first = await store.append({ operationId: "operation_00000001", authorName: "Peer", text: "message 1" }, { accountId: HOST });
  for (let i = 2; i <= 3; i++) await store.append({ operationId: `operation_${String(i).padStart(8, "0")}`, authorName: "Peer", text: `message ${i}` }, { accountId: HOST });
  await store.append({ kind: "board", operationId: "operation_board_00000001", payload: { action: "claim", subject: "work:x" } }, { accountId: HOST });
  await store.append({ operationId: "operation_00000004", authorName: "Peer", text: "message 4", thread: undefined }, { accountId: HOST });
  // a reply in message 1's thread, submitted through a local connection that declared a client name
  await store.append({ operationId: "operation_00000005", authorName: "Peer", authorKind: "human", text: "message 5", thread: first.id, authorRef: "person-1" }, { accountId: HOST, via: "corpus-client" });
  await store.close();
  return { root, dir: join(root, "native", "rooms", ROOM) };
}

/** write the version 2 room a purge rewrote, under a fixed clock; its frames are listed above CASES' wave 3 */
async function purgeRoom() {
  const root = await mkdtemp(join(tmpdir(), "agora-corpus-purge-"));
  let tick = Date.UTC(2026, 8, 18, 12, 0, 0);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, hostAccountId: HOST, epoch: "9f97cbaedb3b45d5a9807816a2c6fa5a", logVersion: 2, now: () => new Date((tick += 1000)) });
  const local = { accountId: HOST };
  const post = (/** @type {string} */ n, /** @type {Record<string, unknown>} */ extra = {}) =>
    /** @type {Promise<any>} */ (store.append({ operationId: `purge_room_op_000${n}`, authorName: "Peer", authorKind: "human", text: `message ${n}`, ...extra }, local));
  const note = (/** @type {string} */ n, /** @type {Record<string, unknown>} */ annotation) =>
    store.append(/** @type {any} */ ({ kind: "annotation", operationId: `purge_room_note_00${n}`, authorName: "Peer", authorKind: "human", annotation }), local);
  const root1 = await post("1");
  const kept = await post("2");
  await post("3", { thread: root1.id });
  const taken = await post("4");
  await note("1", { act: "pin", target: kept.id });
  await note("2", { act: "edit", target: root1.id, text: "message 1, edited" });
  await store.append(/** @type {any} */ ({ kind: "purge", operationId: "purge_room_purge_1", authorName: "Peer", authorKind: "human", authorRef: "person-1",
    purge: { targets: [taken.id], thread: root1.id, reason: "the corpus purge" } }), { accountId: HOST, via: "corpus-client" });
  await store.close();
  return { root, dir: join(root, "native", "rooms", ROOM) };
}

/** @param {string} into */
async function build(into) {
  const bases = { v1: await goodRoom(), purge: await purgeRoom() };
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  for (const [name, c] of /** @type {Array<[string, Case]>} */ ([["good", { expect: null, edit: () => {} }], ...Object.entries(CASES)])) {
    const dir = join(into, name, "native", "rooms", ROOM);
    cpSync(bases[c.base ?? "v1"].dir, dir, { recursive: true });
    writeFileSync(join(dir, "writer.lock"), DEAD_LOCK);
    // a purged room's log is the generation its boundary names (room.frames.<n>)
    const generation = JSON.parse(readFileSync(join(dir, "committed.json"), "utf8")).generation ?? 0;
    const frames = join(dir, generation ? `room.frames.${generation}` : "room.frames");
    c.edit({ dir, frames, manifest: join(dir, "room.json"), boundary: join(dir, "committed.json"), lock: join(dir, "writer.lock") });
    writeFileSync(join(into, name, "EXPECT.json"), JSON.stringify({ case: name, opens: c.expect === null, refusal: c.expect }, null, 2) + "\n");
  }
  for (const b of Object.values(bases)) await rm(b.root, { recursive: true, force: true });
}

/** a byte-for-byte listing of a tree, for --check */
/** @param {string} dir */
function listing(dir) {
  const out = [];
  const walk = (d, rel) => { for (const e of readdirSync(d).sort()) { const p = join(d, e); const r = rel ? `${rel}/${e}` : e; if (statSync(p).isDirectory()) walk(p, r); else out.push(`${r} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`); } };
  walk(dir, "");
  return out.join("\n");
}

const url = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (url) {
  const check = process.argv.includes("--check");
  if (check) {
    const tmp = await mkdtemp(join(tmpdir(), "agora-corpus-check-"));
    await build(tmp);
    const same = existsSync(OUT) && listing(tmp) === listing(OUT);
    await rm(tmp, { recursive: true, force: true });
    console.log(same ? `ok   ${OUT} matches a fresh build` : `${OUT} differs from a fresh build; run node scripts/make-bad-bytes-corpus.mjs`);
    process.exitCode = same ? 0 : 1;
  } else {
    await build(OUT);
    console.log(`wrote ${Object.keys(CASES).length + 1} cases under ${OUT}`);
  }
}
