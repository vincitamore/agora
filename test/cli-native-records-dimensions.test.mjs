// @ts-check
// `post --attach` sends an image's width and height read from its header (PNG, JPEG, GIF, WebP):
// the parser against a minimal header of each kind, and a PNG posted through the CLI reads back with
// its dimensions on the attachment.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { imageDimensions } from "../src/cli-native-records.mjs";
import { seat } from "./client-fixtures.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** @param {number} width @param {number} height */
function png(width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(64)]);
}

/** @param {number} width @param {number} height */
function gif(width, height) {
  const b = Buffer.alloc(32);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/** @param {number} width @param {number} height */
function jpeg(width, height) {
  // SOI, an APP0 segment to walk past, then SOF0 with precision, height, width
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\u0000", "latin1"), Buffer.alloc(9)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

/** @param {string} chunk @param {Buffer} body */
const riff = (chunk, body) => Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.from(chunk, "latin1"), Buffer.alloc(4), body, Buffer.alloc(16)]);

test("the header says the width and height of a PNG, a GIF, a JPEG and each kind of WebP", () => {
  assert.deepEqual(imageDimensions(png(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageDimensions(gif(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageDimensions(jpeg(1920, 1080)), { width: 1920, height: 1080 });
  // lossy: frame tag, start code 9d 01 2a, then 14-bit width and height
  const lossy = Buffer.alloc(10);
  lossy.set([0x9d, 0x01, 0x2a], 3);
  lossy.writeUInt16LE(800, 6);
  lossy.writeUInt16LE(600, 8);
  assert.deepEqual(imageDimensions(riff("VP8 ", lossy)), { width: 800, height: 600 });
  // lossless: signature 0x2f, then width-1 and height-1 in 14 bits each
  const w = 1023, h = 767;
  const bits = (w - 1) | ((h - 1) << 14);
  const lossless = Buffer.from([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff]);
  assert.deepEqual(imageDimensions(riff("VP8L", lossless)), { width: w, height: h });
  // extended: flags, then canvas width-1 and height-1 in 24 bits each
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(4096 - 1, 4, 3);
  extended.writeUIntLE(2160 - 1, 7, 3);
  assert.deepEqual(imageDimensions(riff("VP8X", extended)), { width: 4096, height: 2160 });

  assert.equal(imageDimensions(Buffer.from("PK\u0003\u0004 a drawing package", "latin1")), undefined);
  assert.equal(imageDimensions(png(0, 480)), undefined, "a zero dimension says nothing");
  assert.equal(imageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47])), undefined, "a cut-off header says nothing");
});

test("post --attach carries a PNG's dimensions onto its attachment", { timeout: 60_000 }, async (t) => {
  const s = await seat(t);
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, AGORA_CONFIG: s.config, AGORA_STATE: s.root, AGORA_SESSION: "probe", AGORA_ACTOR: "Grace/watch" };
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID"]) delete env[name];
  const dir = await mkdtemp(path.join(tmpdir(), "agora-cli-dims-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "site.png"), png(1280, 720));
  await writeFile(path.join(dir, "notes.txt"), "no dimensions here\n");
  await run(process.execPath, [BIN, "post", "house", "with a picture", "--attach", path.join(dir, "site.png"), "--attach", path.join(dir, "notes.txt")], { env, windowsHide: true });
  const [message] = (await run(process.execPath, [BIN, "read", "house", "--json"], { env, windowsHide: true })).stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(message.attachments.map((/** @type {any} */ a) => [a.name, a.kind, a.width, a.height]),
    [["site.png", "image", 1280, 720], ["notes.txt", "file", undefined, undefined]]);
});
