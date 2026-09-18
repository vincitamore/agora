#!/usr/bin/env node
// Writes test/fixtures/native-store-bad/: one GOOD native room the reopen path must accept
// (messages, board records, a checkpointed boundary), and one damaged copy per case, each a
// named edit of that good room (a truncated last frame, a length header that overruns, a
// checksum that no longer matches, a payload that is not JSON, a manifest field gone or wrong,
// a boundary that ends inside a frame or names a foreign epoch or disagrees with the log, a
// writer lock naming a dead endpoint or unparseable). Every case carries an EXPECT.json naming
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
export const ROOM = "05965422ca7443659256e229a2d03479";
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
 * each case: a named edit of the good room and what open must say (null: opens)
 * @typedef {{ dir: string, frames: string, manifest: string, boundary: string, lock: string }} Paths
 * @type {Record<string, { expect: string | null, edit: (p: Paths) => void }>}
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
  "boundary-ends-inside-frame": { expect: "ends inside a", edit: ({ boundary }) => editJson(boundary, (o) => { o.end = o.end - 2; }) },
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
};

/** write the good room under a fixed clock and return its directory */
async function goodRoom() {
  const root = await mkdtemp(join(tmpdir(), "agora-corpus-"));
  let tick = Date.UTC(2026, 8, 18, 12, 0, 0);
  const store = await NativeRoomStore.create({ root, roomId: ROOM, hostAccountId: HOST, epoch: "9f97cbaedb3b45d5a9807816a2c6fa5a", now: () => new Date((tick += 1000)) });
  for (let i = 1; i <= 3; i++) await store.append({ operationId: `operation_${String(i).padStart(8, "0")}`, authorName: "Peer", text: `message ${i}` }, { accountId: HOST });
  await store.append({ kind: "board", operationId: "operation_board_00000001", payload: { action: "claim", subject: "work:x" } }, { accountId: HOST });
  await store.append({ operationId: "operation_00000004", authorName: "Peer", text: "message 4", thread: undefined }, { accountId: HOST });
  await store.close();
  return { root, dir: join(root, "native", "rooms", ROOM) };
}

/** @param {string} into */
async function build(into) {
  const good = await goodRoom();
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  for (const [name, c] of [["good", { expect: null, edit: () => {} }], ...Object.entries(CASES)]) {
    const dir = join(into, name, "native", "rooms", ROOM);
    cpSync(good.dir, dir, { recursive: true });
    writeFileSync(join(dir, "writer.lock"), DEAD_LOCK);
    c.edit({ dir, frames: join(dir, "room.frames"), manifest: join(dir, "room.json"), boundary: join(dir, "committed.json"), lock: join(dir, "writer.lock") });
    writeFileSync(join(into, name, "EXPECT.json"), JSON.stringify({ case: name, opens: c.expect === null, refusal: c.expect }, null, 2) + "\n");
  }
  await rm(good.root, { recursive: true, force: true });
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
