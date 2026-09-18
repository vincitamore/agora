#!/usr/bin/env node
// Model-based fuzz of the native room store. Random sequences of board acts, message posts,
// clock advances and reads run through the real NativeRoomStore AND through a model written
// from the documented rules alone (README § the board, skill § claims; never from the store's
// code), and every divergence is printed with the seed and the step that produced it, so the
// run can be replayed. A divergence is a defect in the store, a defect in the model, or a rule
// the documentation states differently from the code; which one is the reader's call, and
// the point of the instrument is that the question is now asked by a script and not by a reader.
//
//   node scripts/fuzz-native-store.mjs [--seed <n>] [--runs <n>] [--steps <n>] [--json]
//
// Exit 1 on any divergence. test/native-store-model.test.mjs runs a bounded number of seeds.
//
// The model's readings where the documentation leaves room (each is a finding when the store
// disagrees, not a verdict against it):
//   - an expired lease is no holder for EVERY verb, break included, and is not listed as held;
//   - a retried operation id from the same account with the same bytes is a duplicate and
//     changes nothing; with different bytes it is refused;
//   - the cursor of the record that admits an act is its fence.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomStore } from "../src/native-store.mjs";

const DEFAULT_LEASE = 3_600_000;
const EPOCH = "e".repeat(32);
const ACCOUNTS = ["seat_host_0000001", "seat_peer_0000001", "seat_peer_0000002"];
const SUBJECTS = ["work:a", "work:b", "human:q"];

/** xorshift32, seeded: the same seed replays the same sequence */
function rng(/** @type {number} */ seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x1_0000_0000; };
}

/** The documented board, message log and read plan, kept as plain state. */
class Model {
  constructor(/** @type {() => number} */ now) {
    this.now = now; this.seq = 0;
    /** @type {Map<string, { accountId: string, leaseId: string, fence: string, expiresAt: number, leaseMs: number }>} */
    this.holders = new Map();
    /** @type {Map<string, { cursor: string, bytes: string }>} */
    this.ops = new Map();
    /** @type {Array<{ cursor: string, text: string, seq: number }>} */
    this.messages = [];
  }
  cursor(/** @type {number} */ seq) { return `${EPOCH}:${seq}`; }
  live(/** @type {string} */ subject) { const h = this.holders.get(subject); return h && h.expiresAt > this.now() ? h : null; }
  board() { return [...this.holders].filter(([s]) => this.live(s)).map(([subject, h]) => ({ subject, accountId: h.accountId, leaseId: h.leaseId, fence: h.fence })).sort((a, b) => a.subject.localeCompare(b.subject)); }
  /** @returns {{ outcome: string, cursor?: string }} */
  act(/** @type {string} */ account, /** @type {string} */ op, /** @type {any} */ a, /** @type {string} */ authorKind) {
    const key = `${account}\0${op}`;
    const bytes = JSON.stringify({ board: a });
    const prior = this.ops.get(key);
    if (prior) return prior.bytes === bytes ? { outcome: "duplicate", cursor: prior.cursor } : { outcome: "refused:different-bytes" };
    const live = this.live(a.subject);
    const admit = () => { this.seq += 1; const c = this.cursor(this.seq); this.ops.set(key, { cursor: c, bytes }); return c; };
    if (a.action === "claim") {
      if (live) return { outcome: "refused:held" };
      const c = admit();
      this.holders.set(a.subject, { accountId: account, leaseId: op, fence: c, expiresAt: this.now() + (a.leaseMs ?? DEFAULT_LEASE), leaseMs: a.leaseMs ?? DEFAULT_LEASE });
      return { outcome: "applied", cursor: c };
    }
    if (a.action === "renew" || a.action === "release") {
      if (!live || live.accountId !== account || live.leaseId !== a.leaseId) return { outcome: "refused:not-holder" };
      if (live.fence !== a.fence) return { outcome: "refused:fence" };
      const c = admit();
      if (a.action === "release") this.holders.delete(a.subject);
      else { const ms = a.leaseMs ?? live.leaseMs; this.holders.set(a.subject, { ...live, fence: c, expiresAt: this.now() + ms, leaseMs: ms }); }
      return { outcome: "applied", cursor: c };
    }
    if (a.action === "break") {
      if (authorKind !== "human") return { outcome: "refused:not-human" };
      if (!live) return { outcome: "refused:nothing-to-break" };
      const c = admit();
      this.holders.delete(a.subject);
      return { outcome: "applied", cursor: c };
    }
    const c = admit();
    return { outcome: "applied", cursor: c };
  }
  post(/** @type {string} */ account, /** @type {string} */ op, /** @type {string} */ text) {
    const key = `${account}\0${op}`;
    const bytes = JSON.stringify({ text });
    const prior = this.ops.get(key);
    if (prior) return prior.bytes === bytes ? { outcome: "duplicate", cursor: prior.cursor } : { outcome: "refused:different-bytes" };
    this.seq += 1; const c = this.cursor(this.seq); this.ops.set(key, { cursor: c, bytes });
    this.messages.push({ cursor: c, text, seq: this.seq });
    return { outcome: "applied", cursor: c };
  }
  /** what a read after `since` with `limit` delivers, by message cursor */
  read(/** @type {number} */ sinceSeq, /** @type {number} */ limit, epoch = EPOCH) {
    if (epoch !== EPOCH) return { outcome: "refused:epoch" };
    if (sinceSeq > this.seq) return { outcome: "refused:future" };
    const to = Math.min(sinceSeq + limit, this.seq);
    return { outcome: "delivered", cursors: this.messages.filter((m) => m.seq > sinceSeq && m.seq <= to).map((m) => m.cursor) };
  }
}

/** @param {unknown} e */
function classify(e) {
  const m = e instanceof Error ? e.message : String(e);
  if (/is held at/.test(m)) return "refused:held";
  if (/not held by this account/.test(m)) return "refused:not-holder";
  if (/fence is/.test(m)) return "refused:fence";
  if (/break is a human verb/.test(m)) return "refused:not-human";
  if (/no holder to break/.test(m)) return "refused:nothing-to-break";
  if (/belongs to epoch/.test(m)) return "refused:epoch";
  if (/exceeds committed sequence/.test(m)) return "refused:future";
  if (/already committed with different bytes/.test(m)) return "refused:different-bytes";
  return `refused:other(${m.slice(0, 80)})`;
}

/**
 * One random sequence against a fresh store.
 * @param {number} seed @param {number} steps @param {string} root
 * @returns {Promise<{ divergences: Array<{ seed: number, step: number, what: string, expected: unknown, got: unknown, trace: unknown[] }>, steps: number }>}
 */
export async function fuzzOnce(seed, steps, root) {
  const rand = rng(seed);
  const pick = (/** @type {any[]} */ xs) => xs[Math.floor(rand() * xs.length)];
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => now;
  const store = await NativeRoomStore.create({ root, roomId: seed.toString(16).padStart(32, "0"), epoch: EPOCH, hostAccountId: ACCOUNTS[0], now: () => new Date(now) });
  const model = new Model(clock);
  /** @type {Array<{ seed: number, step: number, what: string, expected: unknown, got: unknown, trace: unknown[] }>} */
  const divergences = [];
  /** @type {string[]} */
  const ops = []; // every op id ever used, for retries
  /** @type {unknown[]} */
  const trace = [];
  const seen = new Set();
  const log = process.env.FUZZ_TRACE ? (/** @type {unknown} */ x) => console.error(JSON.stringify(x)) : () => {};
  const note = (/** @type {number} */ step, /** @type {string} */ what, /** @type {unknown} */ expected, /** @type {unknown} */ got) => { log({ divergence: what, step, expected, got }); if (!seen.has(what)) { seen.add(what); divergences.push({ seed, step, what, expected, got, trace: trace.slice(-6) }); } };
  // after a divergence the model adopts the store's sequence and live board, so one disagreement
  // is one finding and not a cascade of cursor offsets through every later step
  const resync = (/** @type {string | null} */ key, /** @type {string} */ bytes, /** @type {any} */ got) => {
    model.seq = Number(store.status().committed);
    model.holders = new Map(store.board().map((h) => [h.subject, { accountId: h.accountId, leaseId: h.leaseId, fence: h.fence, expiresAt: Date.parse(h.expiresAt), leaseMs: h.leaseMs }]));
    if (key && got?.outcome === "applied") model.ops.set(key, { cursor: got.cursor, bytes });
  };
  try {
    for (let step = 0; step < steps; step++) {
      const r = rand();
      if (r < 0.12) { const dt = pick([1, 500, 999, 1000, 1001, 5000, 3_600_000, 3_600_001]); now += dt; log(trace.at(-1)), trace.push({ step, tick: dt }); continue; }
      if (r < 0.30) {
        const account = pick(ACCOUNTS);
        const op = rand() < 0.15 && ops.length ? pick(ops) : `operation_${step.toString().padStart(6, "0")}_msg`;
        ops.push(op);
        const text = `m${step}`;
        log(trace.at(-1)), trace.push({ step, post: { account, op } });
        let got;
        try { const rr = await store.append({ operationId: op, authorName: account, authorKind: "agent", text }, { accountId: account }); got = { outcome: rr.duplicate ? "duplicate" : "applied", cursor: rr.cursor }; }
        catch (e) { got = { outcome: classify(e) }; }
        const exp = model.post(account, op, text);
        if (exp.outcome !== got.outcome || (exp.cursor && exp.cursor !== got.cursor)) { note(step, "post", exp, got); resync(`${account}\0${op}`, JSON.stringify({ text }), got); if (got.outcome === "applied" && exp.outcome !== "applied") model.messages.push({ cursor: got.cursor, text, seq: model.seq }); }
        continue;
      }
      if (r < 0.42) {
        const sinceSeq = Math.floor(rand() * (model.seq + 3));
        const limit = pick([1, 2, 5, 1000]);
        const epoch = rand() < 0.08 ? "f".repeat(32) : EPOCH;
        log(trace.at(-1)), trace.push({ step, read: { sinceSeq, limit, foreign: epoch !== EPOCH } });
        let got;
        try { got = { outcome: "delivered", cursors: store.read({ since: `${epoch}:${sinceSeq}`, limit }).map((m) => m.cursor) }; }
        catch (e) { got = { outcome: classify(e) }; }
        const exp = model.read(sinceSeq, limit, epoch);
        if (JSON.stringify(exp) !== JSON.stringify(got)) note(step, "read", exp, got);
        continue;
      }
      // a board act
      const account = pick(ACCOUNTS);
      const subject = pick(SUBJECTS);
      const action = pick(["claim", "claim", "renew", "release", "contest", "break"]);
      const retry = rand() < 0.12 && ops.length;
      const op = retry ? pick(ops) : `operation_${step.toString().padStart(6, "0")}_brd`;
      ops.push(op);
      const authorKind = rand() < 0.5 ? "human" : "agent";
      // fences and lease ids: mostly the holder's real ones (from the store's own receipts, so a
      // divergence in cursors shows up as a fence divergence too), sometimes stale or foreign
      const held = store.board().find((h) => h.subject === subject);
      const stale = rand() < 0.25;
      const leaseId = held && !stale ? held.leaseId : (ops.find((o) => o.endsWith("_brd")) ?? "operation_none_000000");
      const fence = held && !stale ? held.fence : `${EPOCH}:${Math.max(1, Math.floor(rand() * (model.seq + 1)))}`;
      const leaseMs = rand() < 0.5 ? pick([1000, 1001, 5000, 3_600_000]) : undefined;
      const payload = action === "claim" ? { action, subject, ...(leaseMs ? { leaseMs } : {}) }
        : action === "renew" ? { action, subject, leaseId, fence, ...(leaseMs ? { leaseMs } : {}) }
        : action === "release" ? { action, subject, leaseId, fence }
        : action === "contest" ? { action, subject, because: "probe" }
        : { action, subject };
      log(trace.at(-1)), trace.push({ step, act: { account, op, authorKind, payload } });
      let got;
      try { const rr = await store.append({ kind: "board", operationId: op, payload, authorKind, authorName: account }, { accountId: account }); got = { outcome: rr.duplicate ? "duplicate" : "applied", cursor: rr.cursor }; }
      catch (e) { got = { outcome: classify(e) }; }
      const exp = model.act(account, op, payload, authorKind);
      if (exp.outcome !== got.outcome || (exp.cursor && exp.cursor !== got.cursor)) { note(step, `board:${action}`, exp, got); resync(`${account}\0${op}`, JSON.stringify({ board: payload }), got); }
      // the visible board: live holders, and the store's own listing as it stands
      const liveView = store.board().filter((h) => Date.parse(h.expiresAt) > now).map((h) => ({ subject: h.subject, accountId: h.accountId, leaseId: h.leaseId, fence: h.fence })).sort((a, b) => a.subject.localeCompare(b.subject));
      const mv = model.board();
      if (JSON.stringify(liveView) !== JSON.stringify(mv)) { note(step, "board-live", mv, liveView); resync(null, "", null); }
      const rawView = store.board().map((h) => h.subject).sort();
      if (JSON.stringify(rawView) !== JSON.stringify(mv.map((h) => h.subject))) note(step, "board-listing-includes-expired", mv.map((h) => h.subject), rawView);
    }
  } finally {
    await store.close();
  }
  return { divergences, steps };
}

/** @param {string[]} argv */
async function main(argv) {
  const arg = (/** @type {string} */ k, /** @type {number} */ d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
  const seed0 = arg("--seed", 1), runs = arg("--runs", 50), steps = arg("--steps", 60);
  const json = argv.includes("--json");
  const root = await mkdtemp(path.join(tmpdir(), "agora-fuzz-"));
  /** @type {Map<string, number>} */
  const byKind = new Map();
  /** @type {Map<string, any>} */
  const firstOf = new Map();
  /** @type {any} */
  let first = null;
  let total = 0;
  try {
    for (let i = 0; i < runs; i++) {
      const { divergences } = await fuzzOnce(seed0 + i, steps, path.join(root, String(i)));
      total += divergences.length;
      for (const /** @type {{ what: string, seed: number, step: number }} */ d of divergences) { byKind.set(d.what, (byKind.get(d.what) ?? 0) + 1); first ??= d; if (!firstOf.has(d.what)) firstOf.set(d.what, d); }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const summary = { seeds: `${seed0}..${seed0 + runs - 1}`, steps, divergences: total, byKind: Object.fromEntries(byKind), first, firstOfKind: Object.fromEntries(firstOf) };
  console.log(json ? JSON.stringify(summary) : `${total ? "RED  " : "green"} ${runs} runs x ${steps} steps, ${total} divergences${total ? `: ${JSON.stringify(Object.fromEntries(byKind))}` : ""}`);
  if (!json) for (const [k, d] of firstOf) console.log(`\nfirst ${k} (seed ${d.seed}, step ${d.step}): expected ${JSON.stringify(d.expected)} got ${JSON.stringify(d.got)}\n  trace: ${JSON.stringify(d.trace)}`);
  return total ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
}
