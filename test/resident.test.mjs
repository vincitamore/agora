// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DEAF_SECONDS, DEFAULT_IDLE_SECONDS, DEFAULT_MAX_CONTEXT, DEFAULT_MIN_CONTEXT, configuredResidents, cycleVerdict, inheritMarkerPath, matchesResidentRecord, measureClaudeTranscript, measureOmpTranscript,
  readInheritMarker, renderResidentPrompt, restartCommand, transcriptFor, writeInheritMarker,
} from "../src/resident.mjs";
import { readCursorFile, writeCursor } from "../src/core.mjs";
import { DEFAULT_BOUNDS } from "../src/messenger.mjs";
import { readPosted, writeRecord } from "../src/session.mjs";
// the verbs this wave adds, read through the namespace so a build without them fails only their cells
import * as resident from "../src/resident.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "OMP_SESSION_ID", "OMP_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_LABEL", "AGORA_CONFIG", "AGORA_STATE"];

/** @param {string[]} args @param {Record<string, string>} env */
async function agora(args, env) {
  try {
    const clean = { ...process.env };
    for (const name of CLEARED) delete clean[name];
    const child = run(process.execPath, [BIN, ...args], { env: { ...clean, ...env }, windowsHide: true });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** A Claude Code transcript: hook noise, then assistant turns with usage. @param {Array<[string, number, number, number]>} turns [ts, input, cacheRead, cacheWrite] */
function transcript(turns) {
  const lines = [JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "You are the r1 resident." } })];
  for (const [ts, input, cr, cw] of turns) {
    lines.push(JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", usage: { input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: 5 } } }));
    lines.push(JSON.stringify({ type: "progress", timestamp: ts, data: { hook: "stop" } })); // appended without inference
  }
  return lines.join("\n") + "\n";
}

/** A seat: state root, a fake home with one transcript, one live session record signing as the resident.
 * @param {import("node:test").TestContext} t @param {{ bearer: string, turns: Array<[string, number, number, number]>, source?: string }} a */
async function seat(t, a) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  const uuid = "0b7b6b0c-1111-4222-8333-444455556666";
  const slug = `claude-code-${uuid}`;
  const proj = path.join(home, ".claude", "projects", "-home-user-src-tree");
  await mkdir(proj, { recursive: true });
  await writeFile(path.join(proj, `${uuid}.jsonl`), transcript(a.turns));
  const dir = path.join(state, "sessions", slug);
  await mkdir(dir, { recursive: true });
  await writeRecord(dir, /** @type {any} */ ({ slug, source: a.source ?? "CLAUDE_CODE_SESSION_ID" }), { bearer: a.bearer, pid: process.pid, pidSource: "CLAUDE_PID" });
  return { root, state, home, uuid, slug };
}

test("renderResidentPrompt appends the block once and leaves a profile that already carries it alone", () => {
  const block = "## Room mechanics (shared)\n\nbody\n";
  const out = renderResidentPrompt("# P\n\ncharter", block);
  assert.equal(out, "# P\n\ncharter\n\n## Room mechanics (shared)\n\nbody\n");
  assert.equal(renderResidentPrompt(out, block), out);
});

test("measureClaudeTranscript takes the newest assistant usage, never the trailing hook lines", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-m-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const f = path.join(root, "t.jsonl");
  await writeFile(f, transcript([["2026-01-01T01:00:00.000Z", 2, 100, 10], ["2026-01-01T02:00:00.000Z", 3, 200_000, 500]]) + "not json\n");
  const m = await measureClaudeTranscript(f);
  assert.deepEqual(m, { lastInference: "2026-01-01T02:00:00.000Z", context: 200_503, uncached: 3, cacheRead: 200_000, cacheWrite: 500 });
  await writeFile(f, "{}\n");
  assert.equal(await measureClaudeTranscript(f), null);
});

test("measureClaudeTranscript skips harness-written error entries: a trailing 529 is not context 0", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-s-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const f = path.join(root, "t.jsonl");
  const zero = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  const synthetic = (/** @type {string} */ ts) => JSON.stringify({ type: "assistant", timestamp: ts, message: { model: "<synthetic>", role: "assistant", usage: zero } });
  const zeroReal = JSON.stringify({ type: "assistant", timestamp: "2026-01-03T00:00:00.000Z", message: { model: "claude-x", role: "assistant", usage: zero } });
  await writeFile(f, transcript([["2026-01-01T02:00:00.000Z", 2, 720_000, 400]]) + synthetic("2026-01-02T01:05:00.000Z") + "\n" + synthetic("2026-01-02T01:18:00.000Z") + "\n" + zeroReal + "\n");
  const m = await measureClaudeTranscript(f);
  assert.equal(m?.lastInference, "2026-01-01T02:00:00.000Z");
  assert.equal(m?.context, 720_402);
  await writeFile(f, synthetic("2026-01-02T01:05:00.000Z") + "\n");
  assert.equal(await measureClaudeTranscript(f), null);
});

test("cycleVerdict: deaf (no live watch) and past-the-ceiling cycle whatever the warmth, never mid-turn", async () => {
  const now = new Date("2026-01-02T00:00:00.000Z");
  const rec = { slug: "claude-code-r1", state: "live", record: { bearer: "Model/r1", startedAt: "2026-01-01T00:00:00.000Z", source: "CLAUDE_CODE_SESSION_ID" } };
  const at = (/** @type {number} */ secondsAgo) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
  const measured = (/** @type {number} */ ctx, /** @type {number} */ ago) => async () => ({ status: /** @type {const} */ ("measured"), lastInference: at(ago), context: ctx, file: "t" });
  const base = { slug: "r1", now, sessions: [rec] };
  // deaf: small and warm, but no live watch past the grace
  let v = await cycleVerdict({ ...base, measure: measured(95_000, DEFAULT_DEAF_SECONDS + 60), watching: 0 });
  assert.equal(v.action, "cycle"); assert.match(String(v.reason), /^deaf/);
  // a watch-less resident still inside the grace is working, not deaf
  v = await cycleVerdict({ ...base, measure: measured(95_000, 60), watching: 0 });
  assert.equal(v.action, "none"); assert.match(String(v.reason), /warm or working/);
  // watching unmeasured (older callers) never yields a deaf verdict
  v = await cycleVerdict({ ...base, measure: measured(95_000, DEFAULT_DEAF_SECONDS + 60) });
  assert.equal(v.action, "none");
  // ceiling: warm but huge, between turns
  v = await cycleVerdict({ ...base, measure: measured(DEFAULT_MAX_CONTEXT + 1, DEFAULT_DEAF_SECONDS + 60), watching: 2 });
  assert.equal(v.action, "cycle"); assert.match(String(v.reason), /^ceiling/);
  // huge but mid-turn is left alone
  v = await cycleVerdict({ ...base, measure: measured(DEFAULT_MAX_CONTEXT + 1, 30), watching: 2 });
  assert.equal(v.action, "none");
  // watching and moderate: the cold-and-large rule is unchanged
  v = await cycleVerdict({ ...base, measure: measured(200_000, DEFAULT_IDLE_SECONDS + 60), watching: 2 });
  assert.equal(v.action, "cycle"); assert.match(String(v.reason), /^cold/);
  assert.equal(/** @type {any} */ (v).watching, 2);
  // a cross-seat resident whose bearer names the seat owner (`Owner/Model`) matches by `label: slug`
  const labeled = { slug: "omp-r1", state: "live", record: { bearer: "Grace/Model", label: "r1", startedAt: "2026-01-01T00:00:00.000Z", source: "OMP_SESSION_ID" } };
  v = await cycleVerdict({ slug: "r1", now, sessions: [labeled], measure: measured(200_000, DEFAULT_IDLE_SECONDS + 60), watching: 2 });
  assert.equal(v.action, "cycle");
  assert.equal(/** @type {any} */ (v).bearer, "Grace/Model");
});

test("transcriptFor finds the harness transcript by session uuid and refuses other harnesses by name", async (t) => {
  const s = await seat(t, { bearer: "Model/r1", turns: [["2026-01-01T01:00:00.000Z", 2, 100, 10]] });
  const found = transcriptFor({ slug: s.slug, source: "CLAUDE_CODE_SESSION_ID" }, { home: s.home });
  assert.equal(found.status, "found");
  assert.ok(/** @type {any} */ (found).file.endsWith(`${s.uuid}.jsonl`));
  const ompDir = path.join(s.home, ".omp", "agent", "sessions", "-work-project");
  await mkdir(ompDir, { recursive: true });
  const ompFile = path.join(ompDir, `2026-10-19T12-00-00-000Z_${s.uuid}.jsonl`);
  await writeFile(ompFile, JSON.stringify({ type: "message", timestamp: "2026-10-19T12:05:00.000Z", message: { role: "assistant", usage: { input: 500, output: 100, cacheRead: 160_000, cacheWrite: 2_000 } } }) + "\n");
  const ompFound = transcriptFor({ slug: `omp-${s.uuid}`, source: "OMP_SESSION_ID" }, { home: s.home });
  assert.equal(ompFound.status, "found");
  assert.equal(/** @type {any} */ (ompFound).harness, "omp");
  assert.equal(/** @type {any} */ (ompFound).file, ompFile);
  const ompMeasured = await measureOmpTranscript(ompFile);
  assert.deepEqual(ompMeasured, { lastInference: "2026-10-19T12:05:00.000Z", context: 162_500, uncached: 500, cacheRead: 160_000, cacheWrite: 2_000 });
  const other = transcriptFor({ slug: "codex-abc", source: "CODEX_SESSION_ID" }, { home: s.home });
  assert.equal(other.status, "unsupported");
  assert.match(/** @type {any} */ (other).reason, /Claude Code or OMP transcripts only/);
  const missing = transcriptFor({ slug: "claude-code-nope", source: "CLAUDE_CODE_SESSION_ID" }, { home: s.home });
  assert.equal(missing.status, "unsupported");
});

test("matchesResidentRecord: a labelled record matches by its position only; an unlabelled one keeps the /<slug> suffix", async () => {
  const unlabelled = { bearer: "Opus/code-review" };
  const roleFirst = { bearer: "coding/Opus", label: "desk.coding" };
  // a labelled record whose bearer also ends /<slug> for another resident: the position decides
  const crossed = { bearer: "Opus/code-review", label: "desk.review" };
  const legacy = { bearer: "Opus/code-review", label: "the watch" }; // free text an older build accepted
  /** @type {Array<[any, string, boolean]>} */
  const table = [
    [unlabelled, "code-review", true], [unlabelled, "coding", false],
    [roleFirst, "desk.coding", true], [roleFirst, "coding", false], [roleFirst, "Opus", false],
    [crossed, "desk.review", true], [crossed, "code-review", false],
    [legacy, "code-review", true], [legacy, "the watch", true], // an older label equal to the slug matched, and still does
    [{ bearer: "Grace/Haiku/messenger", label: "desk-messenger" }, "desk-messenger", true],
    [{ bearer: "Grace/Haiku/messenger", label: "desk-messenger" }, "messenger", false],
    [{}, "coding", false], [null, "coding", false],
  ];
  for (const [record, slug, want] of table) assert.equal(matchesResidentRecord(record, slug), want, `${JSON.stringify(record)} as ${slug}`);

  // the cycle: the unlabelled resident's verdict is unchanged, the labelled one is found by position
  const now = new Date("2026-01-02T00:00:00.000Z");
  const live = (/** @type {string} */ slug, /** @type {any} */ record) => ({ slug, state: "live", record: { ...record, startedAt: "2026-01-01T00:00:00.000Z", source: "CLAUDE_CODE_SESSION_ID" } });
  const sessions = [live("u", unlabelled), live("p", roleFirst), live("x", crossed)];
  const measure = async () => ({ status: /** @type {const} */ ("measured"), lastInference: "2026-01-01T12:00:00.000Z", context: 300_000, file: "t" });
  const verdict = async (/** @type {string} */ slug) => /** @type {any} */ (await cycleVerdict({ slug, now, sessions, measure }));
  assert.deepEqual([(await verdict("code-review")).session, (await verdict("code-review")).action], ["u", "cycle"], "the unlabelled resident: same session, same verdict");
  assert.equal((await verdict("desk.coding")).session, "p");
  assert.equal((await verdict("desk.review")).session, "x");
  assert.match(String((await verdict("coding")).reason), /no live session/, "a role-first bearer is not a position");
});

test("cycleVerdict: cold AND large cycles; warm, small, unsupported and absent each say why", async () => {
  const now = new Date("2026-01-02T00:00:00.000Z");
  const rec = (/** @type {string} */ bearer, /** @type {string} */ startedAt = "2026-01-01T00:00:00.000Z") => ({ slug: `claude-code-${bearer.replace("/", "-")}`, state: "live", record: { bearer, startedAt, source: "CLAUDE_CODE_SESSION_ID" } });
  const measured = (/** @type {number} */ ctx, /** @type {string} */ ts) => async () => ({ status: /** @type {const} */ ("measured"), lastInference: ts, context: ctx, file: "t" });
  const base = { slug: "r1", now, idleSeconds: DEFAULT_IDLE_SECONDS, minContext: DEFAULT_MIN_CONTEXT };
  let v = await cycleVerdict({ ...base, sessions: [rec("Model/r1")], measure: measured(300_000, "2026-01-01T12:00:00.000Z") });
  assert.equal(v.action, "cycle");
  assert.equal(/** @type {any} */ (v).idleSeconds, 43_200);
  v = await cycleVerdict({ ...base, sessions: [rec("Model/r1")], measure: measured(300_000, "2026-01-01T23:30:00.000Z") });
  assert.equal(v.action, "none"); assert.match(String(v.reason), /warm or working/);
  v = await cycleVerdict({ ...base, sessions: [rec("Model/r1")], measure: measured(100_000, "2026-01-01T12:00:00.000Z") });
  assert.equal(v.action, "none"); assert.match(String(v.reason), /small/);
  v = await cycleVerdict({ ...base, sessions: [rec("Model/r1")], measure: async () => ({ status: /** @type {const} */ ("unsupported"), reason: "no transcript" }) });
  assert.equal(v.action, "none"); assert.equal(v.reason, "no transcript");
  v = await cycleVerdict({ ...base, sessions: [{ ...rec("Model/r1"), state: "gone" }, rec("Model/r2")], measure: measured(300_000, "2026-01-01T12:00:00.000Z") });
  assert.equal(v.action, "none"); assert.match(String(v.reason), /no live session/);
  // two live sessions for one resident: the newest is the one measured
  const seen = /** @type {string[]} */ ([]);
  v = await cycleVerdict({ ...base, sessions: [rec("Model/r1", "2026-01-01T00:00:00.000Z"), rec("Model/r1", "2026-01-01T06:00:00.000Z")], measure: async (r) => { seen.push(r.startedAt); return { status: "measured", lastInference: "2026-01-01T12:00:00.000Z", context: 300_000, file: "t" }; } });
  assert.deepEqual(seen, ["2026-01-01T06:00:00.000Z"]);
  await assert.rejects(cycleVerdict({ ...base, slug: "Bad Slug", sessions: [], measure: measured(1, "x") }), /resident slug/);
});

test("the inherit marker round-trips and a foreign file is refused", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-k-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const w = await writeInheritMarker(root, "r1", { from: "claude-code-x", context: 5, lastInference: "2026-01-01T00:00:00.000Z" });
  assert.equal(w.file, inheritMarkerPath(root, "r1"));
  const r = await readInheritMarker(root, "r1");
  assert.equal(r?.from, "claude-code-x"); assert.equal(r?.context, 5); assert.equal(r?.by, "cycle");
  assert.equal(await readInheritMarker(root, "r2"), null);
  await writeFile(inheritMarkerPath(root, "r1"), "{\"type\":\"other\"}\n");
  await assert.rejects(readInheritMarker(root, "r1"), /not a resident inherit marker/);
});

/**
 * A seat holding one omp resident at `lab.review`: its OMP transcript (one assistant turn) in a fake
 * home, its live session record, and, when given, the activity record its harness-owned watch writes.
 * @param {import("node:test").TestContext} t @param {{ lastInference: string, activity?: { updatedAt: string, intervalMs?: number } }} a
 */
async function ompSeat(t, a) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-omp-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  const uuid = "0b7b6b0c-2222-4222-8333-444455556666";
  const slug = `omp-${uuid}`;
  const bucket = path.join(home, ".omp", "agent", "sessions", "-work");
  await mkdir(bucket, { recursive: true });
  const turn = { type: "message", timestamp: a.lastInference, message: { role: "assistant", stopReason: "stop", usage: { input: 3, cacheRead: 40_000, cacheWrite: 100, output: 5 } } };
  await writeFile(path.join(bucket, `2026-01-01T00-00-00-000Z_${uuid}.jsonl`), JSON.stringify(turn) + "\n");
  const dir = path.join(state, "sessions", slug);
  await mkdir(dir, { recursive: true });
  await writeRecord(dir, /** @type {any} */ ({ slug, source: "AGORA_SESSION (OMP_SESSION_ID)" }), { bearer: "review/Argon", label: "lab.review", pid: process.pid, pidSource: "OMP_PID" });
  if (a.activity) {
    const rec = { v: 1, type: "activity", session: slug, position: "lab.review", turn: "idle", since: a.lastInference, lastToolAt: null, lastOutputAt: a.lastInference, progress: 4, progressAt: a.lastInference, intervalMs: a.activity.intervalMs ?? 2000, updatedAt: a.activity.updatedAt };
    await writeFile(path.join(dir, "activity.json"), JSON.stringify(rec, null, 1) + "\n");
  }
  return { state, home, slug };
}

test("cycle: a quiet resident whose harness-owned watch keeps its heartbeat is listening, not deaf; a silent heartbeat is deaf (red leg: the heartbeat stops)", async (t) => {
  const ago = (/** @type {number} */ s) => new Date(Date.now() - s * 1000).toISOString();
  const quiet = DEFAULT_DEAF_SECONDS + 22; // the trial's 922 s of quiet
  // the extension wrote no armed record; its activity record was refreshed 10 s ago
  const armed = await ompSeat(t, { lastInference: ago(quiet), activity: { updatedAt: ago(10) } });
  for (const pass of [1, 2]) {
    const v = /** @type {any} */ (await resident.planCycle(armed.state, "lab.review", { home: armed.home }));
    assert.equal(v.session, armed.slug);
    assert.equal(v.action, "none", `pass ${pass}: ${v.reason}`);
    assert.match(String(v.reason), /^warm or working/);
    assert.equal(v.watching, 1, "the heartbeat is the live watch");
    assert.equal(typeof v.activityAt, "string");
  }
  // a slow poller counts by its own interval: three of them bound the silence, past D
  const slow = await ompSeat(t, { lastInference: ago(quiet), activity: { updatedAt: ago(DEFAULT_BOUNDS.D / 1000 + 120), intervalMs: 200_000 } });
  assert.equal((/** @type {any} */ (await resident.planCycle(slow.state, "lab.review", { home: slow.home }))).watching, 1);
  // red leg: the heartbeat stopped past the silent bound, so the watch is dead and the resident deaf
  const silent = await ompSeat(t, { lastInference: ago(quiet), activity: { updatedAt: ago(DEFAULT_BOUNDS.D / 1000 + 60) } });
  const deaf = /** @type {any} */ (await resident.planCycle(silent.state, "lab.review", { home: silent.home }));
  assert.deepEqual([deaf.action, deaf.watching], ["cycle", 0]);
  assert.match(String(deaf.reason), /^deaf: no live watch/);
  // no activity record at all (a watch armed by the model, now dead): deaf as before
  const none = await ompSeat(t, { lastInference: ago(quiet) });
  const v = /** @type {any} */ (await resident.planCycle(none.state, "lab.review", { home: none.home }));
  assert.deepEqual([v.action, v.watching, v.activityAt], ["cycle", 0, null]);
});

/** A state root with a predecessor and a successor session at `lab.orchestrator`. @param {import("node:test").TestContext} t */
async function successionSeat(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-i-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const pred = path.join(state, "sessions", "omp-pred");
  await mkdir(pred, { recursive: true });
  await writeRecord(pred, /** @type {any} */ ({ slug: "omp-pred", source: "AGORA_SESSION" }), { bearer: "orchestrator/Sonnet", label: "lab.orchestrator", now: new Date(Date.now() - 3_600_000) });
  await writeCursor(pred, "lab", "5");
  await writeFile(path.join(pred, "posted.jsonl"), JSON.stringify({ id: "own-1", pid: 1 }) + "\n");
  return { state, pred };
}

test("inherit: the successor a marker names takes the predecessor's place even after its watch read the room at the head; an older session keeps the refusal; a second call says it already did (red leg: a session older than the marker)", async (t) => {
  const s = await successionSeat(t);
  await writeInheritMarker(s.state, "lab.orchestrator", { from: "omp-pred", by: "succeed" });
  // the successor: started after the marker, and its extension already set its cursor at the head
  const succ = { slug: "omp-succ", source: "AGORA_SESSION" };
  const sdir = path.join(s.state, "sessions", succ.slug);
  await mkdir(sdir, { recursive: true });
  await writeRecord(sdir, /** @type {any} */ (succ), { bearer: "orchestrator/Haiku", label: "lab.orchestrator" });
  await writeCursor(sdir, "lab", "9");
  const record = JSON.parse(await readFile(path.join(sdir, "session.json"), "utf8"));
  const r = /** @type {any} */ (await resident.inheritResident(s.state, "lab.orchestrator", succ, { record }));
  assert.deepEqual([r.inherited, r.successor, r.from, r.cursors, r.conflicts], [true, true, "omp-pred", ["lab"], ["lab"]]);
  assert.equal((await readCursorFile(sdir, "lab")).cursor, "5", "the predecessor's position: what it had not read is owed");
  assert.ok((await readPosted(sdir)).has("own-1"), "the ledger: its posts are this session's own");
  assert.equal(existsSync(inheritMarkerPath(s.state, "lab.orchestrator")), false, "the marker is consumed");
  // the profile's arming step asks again: it already happened, by name
  const again = /** @type {any} */ (await resident.inheritResident(s.state, "lab.orchestrator", succ, { record }));
  assert.deepEqual([again.inherited, again.reason, again.from], [false, "already", "omp-pred"]);
  const fresh = /** @type {any} */ (await resident.inheritResident(s.state, "lab.orchestrator", { slug: "omp-other", source: "AGORA_SESSION" }, {}));
  assert.deepEqual([fresh.inherited, fresh.reason], [false, "no marker"]);

  // red leg: a session that was running before the marker holds its own position; it is not moved
  await writeInheritMarker(s.state, "lab.orchestrator", { from: "omp-pred", by: "cycle" });
  const old = { slug: "omp-old", source: "AGORA_SESSION" };
  const odir = path.join(s.state, "sessions", old.slug);
  await mkdir(odir, { recursive: true });
  await writeRecord(odir, /** @type {any} */ (old), { bearer: "orchestrator/Opus", label: "lab.orchestrator", now: new Date(Date.now() - 600_000) });
  await writeCursor(odir, "lab", "12");
  const orecord = JSON.parse(await readFile(path.join(odir, "session.json"), "utf8"));
  await assert.rejects(resident.inheritResident(s.state, "lab.orchestrator", old, { record: orecord }), /already holds a position in lab/);
  assert.equal((await readCursorFile(odir, "lab")).cursor, "12");
  const forced = /** @type {any} */ (await resident.inheritResident(s.state, "lab.orchestrator", old, { record: orecord, force: true }));
  assert.deepEqual([forced.inherited, forced.successor, forced.forced], [true, false, true]);
});

test("succession at a start: the newest session that held the position and is gone is named; a pending marker whose predecessor has state is kept (red leg: no session ever held it)", async (t) => {
  const s = await successionSeat(t);
  const dead = (/** @type {number} */ pid) => { if (pid === 999_001 || pid === 999_002) throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
  // the predecessor's record names a pid that is gone; a newer one at the position too (a swap)
  await writeRecord(s.pred, /** @type {any} */ ({ slug: "omp-pred", source: "AGORA_SESSION" }), { bearer: "orchestrator/Sonnet", label: "lab.orchestrator", pid: 999_001, pidSource: "OMP_PID" });
  const swap = path.join(s.state, "sessions", "omp-swap");
  await mkdir(swap, { recursive: true });
  await writeRecord(swap, /** @type {any} */ ({ slug: "omp-swap", source: "AGORA_SESSION" }), { bearer: "orchestrator/Haiku", label: "lab.orchestrator", pid: 999_002, pidSource: "OMP_PID" });
  const m = /** @type {any} */ (await resident.markSuccession(s.state, "lab.orchestrator", { kill: dead }));
  assert.deepEqual([m.written, m.from, m.by], [true, "omp-swap", "start"]);
  assert.equal((await readInheritMarker(s.state, "lab.orchestrator"))?.from, "omp-swap");
  await writeInheritMarker(s.state, "lab.orchestrator", { from: "omp-pred", by: "cycle" });
  const kept = /** @type {any} */ (await resident.markSuccession(s.state, "lab.orchestrator", { kill: dead }));
  assert.deepEqual([kept.written, kept.from, kept.by], [false, "omp-pred", "cycle"], "a cycle's marker stands until its successor consumes it");
  assert.equal(await resident.markSuccession(s.state, "lab.review", { kill: dead }), null);
  assert.equal(existsSync(inheritMarkerPath(s.state, "lab.review")), false);
});

test("configuredResidents reads the table and nothing else; restartCommand substitutes the slug", () => {
  assert.deepEqual(configuredResidents({}), {});
  assert.deepEqual(configuredResidents({ residents: { a: { restart: "x {slug}" }, b: {}, c: true } }), { a: { restart: "x {slug}" }, b: { restart: undefined }, c: {} });
  assert.throws(() => configuredResidents({ residents: { "Bad Slug": {} } }), /resident slug/);
  assert.equal(restartCommand("systemctl --user restart resident-{slug}.service", "r1"), "systemctl --user restart resident-r1.service");
});

test("CLI: prompt appends the shipped block; cycle measures the seat, writes the marker and runs the restart; inherit consumes it", async (t) => {
  const s = await seat(t, { bearer: "Model/r1", turns: [["2026-01-01T01:00:00.000Z", 2, 100, 10], ["2026-01-01T02:00:00.000Z", 3, 200_000, 500]] });
  const profile = path.join(s.root, "PROFILE.md");
  await writeFile(profile, "# Resident profile: r1\n\ncharter\n");
  const cfgPath = path.join(s.root, "agora.json");
  const stamp = path.join(s.root, "restarted.txt");
  const stampScript = path.join(s.root, "stamp.mjs");
  await writeFile(stampScript, `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], process.argv[3]);
`);
  await writeFile(cfgPath, JSON.stringify({ actor: { name: "Model", kind: "agent" }, rooms: { r: { transport: "local", path: path.join(s.root, "room.ndjson") } }, residents: { r1: { restart: `"${process.execPath}" "${stampScript}" "${stamp}" {slug}` } } }));
  const env = { AGORA_STATE: s.state, AGORA_CONFIG: cfgPath, HOME: s.home, USERPROFILE: s.home };

  const p = await agora(["resident", "prompt", profile], env);
  assert.equal(p.code, 0, p.stderr);
  assert.ok(p.stdout.startsWith("# Resident profile: r1\n"));
  assert.match(p.stdout, /\n## Room mechanics \(shared by every resident; appended by the launcher\)\n/);
  assert.match(p.stdout, /agora resident inherit <slug>/);

  // the transcript's last inference is in 2026-01; now is later, so it is cold; 200,503 > 150,000
  const dry = await agora(["resident", "cycle", "r1", "--dry-run", "--json"], env);
  assert.equal(dry.code, 0, dry.stderr);
  const drow = JSON.parse(dry.stdout.trim().split("\n").pop() ?? "{}");
  assert.equal(drow.action, "would-cycle");
  assert.equal(drow.context, 200_503);
  assert.equal(drow.session, s.slug);
  assert.equal(existsSync(inheritMarkerPath(s.state, "r1")), false);
  assert.equal(existsSync(stamp), false);

  // this seat's session arms no watch, so past the deaf grace it is deaf whatever its size
  const deaf = await agora(["resident", "cycle", "r1", "--min-context", "300000", "--dry-run", "--json"], env);
  assert.equal(deaf.code, 0);
  assert.match(JSON.parse(deaf.stdout.trim()).reason, /^deaf/);
  assert.equal(JSON.parse(deaf.stdout.trim()).watching, 0);

  const small = await agora(["resident", "cycle", "r1", "--min-context", "300000", "--deaf", "999999999", "--json"], env);
  assert.equal(small.code, 0);
  assert.match(JSON.parse(small.stdout.trim()).reason, /small/);
  assert.equal(existsSync(inheritMarkerPath(s.state, "r1")), false);

  const bad = await agora(["resident", "cycle", "r1", "--idle", "soon"], env);
  assert.equal(bad.code, 2);

  const real = await agora(["resident", "cycle", "--all", "--json"], env);
  assert.equal(real.code, 0, real.stderr);
  const row = JSON.parse(real.stdout.trim());
  assert.equal(row.action, "cycle");
  assert.equal(row.restartExit, 0);
  assert.equal(await readFile(stamp, "utf8"), "r1");
  const marker = await readInheritMarker(s.state, "r1");
  assert.equal(marker?.from, s.slug);
  assert.equal(marker?.context, 200_503);

  // the successor: a different session, holding no position yet
  const cursors = path.join(s.state, "sessions", s.slug);
  await writeFile(path.join(cursors, "room-a.cursor"), "7\n");
  await writeFile(path.join(cursors, "posted.jsonl"), JSON.stringify({ id: "m1", pid: 1 }) + "\n");
  const succ = { ...env, AGORA_SESSION: "claude-code-9999" };
  const inh = await agora(["resident", "inherit", "r1", "--json"], succ);
  assert.equal(inh.code, 0, inh.stderr);
  const irow = JSON.parse(inh.stdout.trim());
  assert.equal(irow.inherited, true);
  assert.equal(irow.from, s.slug);
  assert.deepEqual(irow.cursors, ["room-a"]);
  assert.equal(await readFile(path.join(s.state, "sessions", "claude-code-9999", "room-a.cursor"), "utf8"), "7\n");
  assert.equal(existsSync(inheritMarkerPath(s.state, "r1")), false, "the marker is consumed");
  assert.match(inh.stderr, /session --as <bearer> --label r1` \(the bearer your profile gives, e\.g\. <Model>\/r1\)/);

  const again = await agora(["resident", "inherit", "r1", "--json"], succ);
  assert.equal(again.code, 0);
  assert.deepEqual([JSON.parse(again.stdout.trim()).reason, JSON.parse(again.stdout.trim()).from], ["already", s.slug], "a second call names what this session already inherited");
});

test("CLI: a marker naming a pruned predecessor is removed with a warning; the cycled session itself may not inherit", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-p-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const cfgPath = path.join(root, "agora.json");
  await writeFile(cfgPath, JSON.stringify({ actor: { name: "Model", kind: "agent" }, rooms: { r: { transport: "local", path: path.join(root, "room.ndjson") } } }));
  const env = { AGORA_STATE: state, AGORA_CONFIG: cfgPath, AGORA_SESSION: "claude-code-succ" };
  await writeInheritMarker(state, "r1", { from: "claude-code-gone" });
  const gone = await agora(["resident", "inherit", "r1", "--json"], env);
  assert.equal(gone.code, 0, gone.stderr);
  assert.equal(JSON.parse(gone.stdout.trim()).reason, "predecessor-gone");
  assert.match(gone.stderr, /pruned/);
  assert.equal(existsSync(inheritMarkerPath(state, "r1")), false);
  await writeInheritMarker(state, "r1", { from: "claude-code-succ" });
  const self = await agora(["resident", "inherit", "r1"], env);
  assert.equal(self.code, 2);
  assert.match(self.stderr, /names this session/);
  assert.equal(existsSync(inheritMarkerPath(state, "r1")), false);
  const usage = await agora(["resident", "dance"], env);
  assert.equal(usage.code, 2);
});

test("CLI: inherit takes the predecessor's place for the successor whose watch already read the room, and says `already` to a second call (red leg: a session older than the marker is refused)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-resident-c-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const cfgPath = path.join(root, "agora.json");
  await writeFile(cfgPath, JSON.stringify({ actor: { name: "Model", kind: "agent" }, rooms: { r: { transport: "local", path: path.join(root, "room.ndjson") } } }));
  const base = { AGORA_STATE: state, AGORA_CONFIG: cfgPath };
  // the room has a message, so a cursor taken at its head is one; the predecessor read the room to 5
  assert.equal((await agora(["post", "r", "--", "hello"], { ...base, AGORA_SESSION: "omp-ada" })).code, 0);
  const pred = path.join(state, "sessions", "omp-pred");
  await mkdir(pred, { recursive: true });
  await writeCursor(pred, "r", "5");
  // a session that was running before the marker: refused, as before
  const old = { ...base, AGORA_SESSION: "omp-old" };
  assert.equal((await agora(["session", "--as", "orchestrator/Opus", "--label", "lab.orchestrator"], old)).code, 0);
  assert.equal((await agora(["cursor", "r", "--now"], old)).code, 0);
  await new Promise((r) => setTimeout(r, 20));
  await writeInheritMarker(state, "lab.orchestrator", { from: "omp-pred", by: "succeed" });
  const refused = await agora(["resident", "inherit", "lab.orchestrator"], old);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /already holds a position in r/);
  // the successor registered and its watch took the head before the arming step ran
  const succ = { ...base, AGORA_SESSION: "omp-succ" };
  assert.equal((await agora(["session", "--as", "orchestrator/Haiku", "--label", "lab.orchestrator"], succ)).code, 0);
  assert.equal((await agora(["cursor", "r", "--now"], succ)).code, 0);
  const r = await agora(["resident", "inherit", "lab.orchestrator", "--json"], succ);
  assert.equal(r.code, 0, r.stderr);
  const row = JSON.parse(r.stdout.trim());
  assert.deepEqual([row.inherited, row.successor, row.from, row.conflicts], [true, true, "omp-pred", ["r"]]);
  assert.equal((await readCursorFile(path.join(state, "sessions", "omp-succ"), "r")).cursor, "5");
  const again = await agora(["resident", "inherit", "lab.orchestrator"], succ);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already inherited resident lab\.orchestrator from omp-pred/);
});

test("succeed: a session that took a claim after its request is mid-task, so the cycle defers until that claim is released, then honours at its next idle (red leg: a claim taken before the request)", async (t) => {
  const s = await seat(t, { bearer: "orchestrator/Opus", turns: [["2026-01-01T00:00:10.000Z", 10, 50_000, 0]] });
  const dir = path.join(s.state, "sessions", s.slug);
  await writeRecord(dir, /** @type {any} */ ({ slug: s.slug, source: "CLAUDE_CODE_SESSION_ID" }), { bearer: "orchestrator/Opus", label: "lab.orchestrator" });
  const { appendCarryEvent } = await import("../src/carry-check.mjs");
  const t0 = Math.floor(Date.now() / 1000) * 1000 + 5_000; // after the session started, so the request is not stale
  const iso = (/** @type {number} */ ms) => new Date(t0 + ms).toISOString();
  let n = 0;
  const event = (/** @type {string} */ kind, /** @type {string} */ subject, /** @type {number} */ ms) => appendCarryEvent(dir, {
    version: 1, id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, kind, at: iso(ms), session: s.slug, bearer: "orchestrator/Opus",
    ref: { room: "lab", id: `m${n}`, cursor: String(n) }, subject,
  });
  const plan = () => /** @type {Promise<any>} */ (resident.planCycle(s.state, "lab.orchestrator", { home: s.home }));
  await event("claim", "task:before", -60_000); // red leg: a claim taken before the request does not hold it
  await resident.writeSucceedRequest(s.state, "lab.orchestrator", { by: s.slug, now: new Date(t0) });
  let v = await plan();
  assert.equal(v.action, "cycle", `a claim older than the request is the task the close ended: ${v.reason}`);
  await event("claim", "task:orphans-report", 100_000);
  v = await plan();
  assert.equal(v.action, "none");
  assert.equal(v.reason, `succeed requested ${iso(0)}; waits while this session holds task:orphans-report, claimed ${iso(100_000)} after the request`);
  await event("release", "task:orphans-report", 400_000);
  v = await plan();
  assert.deepEqual([v.action, /^succeed: /.test(v.reason)], ["cycle", true], "released: honoured at the next idle");
});
