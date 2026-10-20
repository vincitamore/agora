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
import { validateManifest } from "../src/resident-start.mjs";
import { admitWant, ensure, foldLedger, grantedRow, grantView, readLedger, recordUnwant, recordWant, roomSubject, wantEnding, withGranted } from "../src/resident-grant.mjs";
import { cycleVerdict, readSucceedRequest, turnState } from "../src/resident.mjs";
import { parseNotice } from "../src/messenger.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "OMP_SESSION_ID", "OMP_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_LABEL", "AGORA_CONFIG", "AGORA_STATE", "TERN_WINDOW_KEY"];

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

/**
 * The manifest the room seed writes (residents/seed templates/residents.json, filled): a messenger
 * row, the orchestrator, coding with max 3, review, and the orchestrator's grant open within caps.
 * @param {Record<string, unknown>} [grant] @param {Record<string, unknown>} [extraRows]
 */
function seedDoc(grant, extraRows = {}) {
  return {
    version: 1,
    models: { haiku: "vendor/claude-haiku-9:medium", sonnet: "vendor/claude-sonnet-9:high", opus: "vendor/claude-opus-9:high", argon: "other/gemini-9:high" },
    defaults: { harness: "omp", host: "tern", model: "opus", rooms: ["lab"], wake: "mine", preamble: "off", profile: "PROFILE.md", workdir: { files: { "CLAUDE.md": ["HOME.md"] } } },
    residents: {
      "lab.messenger": { role: "messenger", harness: "agora", wake: "all", rooms: ["lab"], tenure: "standing" },
      "lab.orchestrator": { role: "orchestrator", model: "opus", tenure: "standing", append: ["roles/orchestrator.md"] },
      "lab.coding": { role: "coding", model: "opus", tenure: "standing", max: 3, append: ["roles/coding.md"] },
      "lab.review": { role: "review", model: "argon", tenure: "standing", append: ["roles/review.md"] },
      ...extraRows,
    },
    grants: { "lab.orchestrator": grant ?? { roles: "open", models: ["sonnet", "opus"], maxLive: 2, maxHours: 8 } },
  };
}

/** @param {import("node:test").TestContext} t */
async function seat(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-rgrant-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = path.join(root, "state");
  const mdir = path.join(root, "team");
  await mkdir(path.join(mdir, "roles"), { recursive: true });
  for (const f of ["PROFILE.md", "HOME.md", "roles/orchestrator.md", "roles/coding.md", "roles/review.md", "roles/ad-hoc.md", "brief.md"]) await writeFile(path.join(mdir, f), `# ${f}\n`);
  const manifestFile = path.join(mdir, "residents.json");
  return { root, state, mdir, manifestFile };
}

/** @param {Awaited<ReturnType<typeof seat>>} s @param {any} doc */
const load = (s, doc) => validateManifest(doc, s.manifestFile);

/** Admit against a fold, with slots held as given. */
async function admit(/** @type {any} */ m, /** @type {any} */ fold, /** @type {Record<string, any>} */ a, /** @type {Set<string>} */ held = new Set()) {
  return admitWant({ manifest: m, fold, requester: "lab.orchestrator", session: "orc", because: "parallel units", now: Date.parse("2026-01-01T00:00:00.000Z"), held: async (x) => held.has(x), position: "lab.coding", ...a });
}

// ---------------------------------------------------------------------------------------------

test("manifest: the seed's grant, tenure and max parse; a bad grant is refused by its field", async (t) => {
  const s = await seat(t);
  const m = load(s, seedDoc());
  assert.deepEqual(m.grants["lab.orchestrator"], { holder: "lab.orchestrator", room: "lab", roles: "open", models: ["sonnet", "opus"], maxLive: 2, maxHours: 8, card: null });
  assert.deepEqual([m.residents["lab.coding"].tenure, m.residents["lab.coding"].max, m.residents["lab.review"].max], ["standing", 3, 1]);
  const listed = load(s, seedDoc({ roles: ["coding", "triage"], models: ["sonnet"], maxLive: 1, maxHours: 4, card: "roles/ad-hoc.md" }));
  assert.deepEqual([listed.grants["lab.orchestrator"].roles, listed.grants["lab.orchestrator"].card], [["coding", "triage"], path.join(s.mdir, "roles", "ad-hoc.md")]);
  /** @param {(d: any) => void} edit @param {RegExp} re */
  const refuses = (edit, re) => { const d = seedDoc(); edit(d); assert.throws(() => load(s, d), re); };
  refuses((d) => { d.grants["lab.orchestrator"].colour = 1; }, /grants\.lab\.orchestrator\.colour: unknown field/);
  refuses((d) => { d.grants["lab.orchestrator"].models = ["gpt"]; }, /grants\.lab\.orchestrator\.models: "gpt" is not an alias/);
  refuses((d) => { d.grants["lab.nobody"] = d.grants["lab.orchestrator"]; }, /grants\.lab\.nobody: a grant's key is the position that holds it/);
  refuses((d) => { d.grants["lab.orchestrator"].roles = "some"; }, /roles: must be "open" or a non-empty list/);
  refuses((d) => { d.grants["lab.orchestrator"].maxLive = -1; }, /maxLive: must be a whole number/);
  refuses((d) => { delete d.grants["lab.orchestrator"].maxHours; }, /maxHours: is required/);
  refuses((d) => { d.residents["lab.coding"].tenure = "sometimes"; }, /lab\.coding\.tenure: must be one of standing, on-demand/);
  refuses((d) => { d.residents["lab.coding"].max = 0; }, /lab\.coding\.max: must be a whole number/);
});

test("want: within caps takes the next slot; refused by name past maxLive, outside models or roles, and with no card for a new role", async (t) => {
  const s = await seat(t);
  const m = load(s, seedDoc());
  const empty = foldLedger([]);
  const first = /** @type {any} */ (await admit(m, empty, {}));
  assert.equal(first.ok, true);
  assert.deepEqual([first.want.position, first.want.role, first.want.model, first.want.base], ["lab.coding-2", "coding", "opus", "lab.coding"], "a standing row's slots start at -2");
  const fold = foldLedger([first.want]);
  const second = /** @type {any} */ (await admit(m, fold, {}));
  assert.equal(second.want.position, "lab.coding-3");
  const full = foldLedger([first.want, second.want]);
  assert.match(String(/** @type {any} */ (await admit(m, full, {})).reason), /past maxLive 2: lab\.orchestrator already holds lab\.coding-2, lab\.coding-3/);
  // a held slot is skipped; every slot held is refused by name
  assert.equal(/** @type {any} */ (await admit(m, empty, {}, new Set(["lab.coding-2"]))).want.position, "lab.coding-3");
  assert.match(String(/** @type {any} */ (await admit(m, empty, {}, new Set(["lab.coding-2", "lab.coding-3"]))).reason), /every slot of lab\.coding is held \(lab\.coding-2, lab\.coding-3; max 3, the row itself is standing\)/);
  assert.match(String(/** @type {any} */ (await admit(m, empty, { model: "haiku" })).reason), /model haiku is outside lab\.orchestrator's grant \(models: sonnet, opus\)/);
  assert.match(String(/** @type {any} */ (await admit(m, empty, { position: "lab.review", model: "opus" })).reason), /every slot of lab\.review is held/, "a standing row with max 1 has no slot to grant");
  assert.match(String(/** @type {any} */ (await admit(m, empty, { position: "lab.messenger" })).reason), /messenger row/);
  assert.match(String(/** @type {any} */ (await admit(m, empty, { position: "lab.orchestrator" })).reason), /does not want its own position/);
  assert.match(String(/** @type {any} */ (await admit(m, empty, { position: "lab.coding-2" })).reason), /is a slot of lab\.coding/);
  assert.match(String(/** @type {any} */ (await admit(m, empty, { position: "other.coding" })).reason), /outside it/);
  // open: a new role needs a card; with one it is admitted at its own position
  assert.match(String(/** @type {any} */ (await admit(m, empty, { position: "lab.triage" })).reason), /new role: it needs a card/);
  const brief = path.join(s.mdir, "brief.md");
  const triage = /** @type {any} */ (await admit(m, empty, { position: "lab.triage", model: "sonnet", cards: [brief] }));
  assert.deepEqual([triage.want.position, triage.want.base, triage.want.cards], ["lab.triage", null, [brief]]);
  // a grant's card is worn first, then the want's
  const carded = load(s, seedDoc({ roles: "open", models: ["sonnet", "opus"], maxLive: 2, maxHours: 8, card: "roles/ad-hoc.md" }));
  assert.deepEqual(/** @type {any} */ (await admit(carded, empty, { position: "lab.triage", cards: [brief] })).want.cards, [path.join(s.mdir, "roles", "ad-hoc.md"), brief]);
  // a list grant refuses an unlisted role
  const listed = load(s, seedDoc({ roles: ["triage"], models: ["sonnet", "opus"], maxLive: 2, maxHours: 8 }));
  assert.match(String(/** @type {any} */ (await admit(listed, empty, {})).reason), /role coding is not in lab\.orchestrator's grant \(roles: triage\)/);
  // hours past the cap, and no requester or no grant
  assert.match(String(/** @type {any} */ (await admit(m, empty, { hours: 9 })).reason), /past the grant's maxHours 8/);
  assert.match(String(/** @type {any} */ (await admit(m, empty, { requester: undefined })).reason), /asked by the session that holds a grant/);
  assert.match(String(/** @type {any} */ (await admit(m, empty, { requester: "lab.coding" })).reason), /lab\.coding holds no grant/);
  assert.match(String(/** @type {any} */ (await admit(m, empty, { because: " " })).reason), /--because/);
  // an on-demand row is its own first slot; host none cannot be supervised
  const od = load(s, seedDoc(undefined, { "lab.triage": { role: "triage", model: "sonnet", tenure: "on-demand" } }));
  assert.equal(/** @type {any} */ (await admit(od, empty, { position: "lab.triage" })).want.position, "lab.triage");
  const none = load(s, seedDoc(undefined, { "lab.triage": { role: "triage", model: "sonnet", tenure: "on-demand", host: "none" } }));
  assert.match(String(/** @type {any} */ (await admit(none, empty, { position: "lab.triage" })).reason), /host none/);
});

test("a granted row is the base row with the want's model, its own folder, the default bearer and the cards appended", async (t) => {
  const s = await seat(t);
  const m = load(s, seedDoc(undefined, { "lab.coding": { role: "coding", model: "opus", tenure: "standing", max: 3, append: ["roles/coding.md"], bearer: "coding/Special", restart: "x {slug}", workdir: { path: "shared", files: { "NOTE.md": [{ text: "n" }] } } } }));
  const brief = path.join(s.mdir, "brief.md");
  const w = /** @type {any} */ (await admit(m, foldLedger([]), { model: "sonnet", cards: [brief] })).want;
  const row = grantedRow(m, w);
  assert.deepEqual([row.slug, row.role, row.model, row.tenure, row.bearer, row.restart, row.workdir.path], ["lab.coding-2", "coding", "sonnet", "on-demand", null, null, null]);
  assert.deepEqual(row.append, [path.join(s.mdir, "roles", "coding.md"), brief]);
  assert.deepEqual(row.workdir.files.map((f) => f.path), ["NOTE.md"]);
  assert.ok(withGranted(m, foldLedger([w])).residents["lab.coding-2"], "an open want is a row for start, stop and the cycle");
  assert.equal(m.residents["lab.coding-2"], undefined, "the file's manifest is not changed");
});

test("wantEnding: unwanted, revoked by the grant's removal or narrowing, expired by its until or the grant's maxHours", async (t) => {
  const s = await seat(t);
  const m = load(s, seedDoc());
  const w = /** @type {any} */ (await admit(m, foldLedger([]), { hours: 2 })).want;
  const at = Date.parse(w.at);
  const state = /** @type {any} */ ([...foldLedger([w]).values()][0]);
  assert.equal(wantEnding(state, m, at + 60_000), null);
  assert.equal(wantEnding(state, m, at + 2 * 3_600_000)?.why, "expired");
  assert.equal(wantEnding(state, load(s, { ...seedDoc(), grants: {} }), at)?.why, "revoked");
  assert.equal(wantEnding(state, load(s, seedDoc({ roles: ["triage"], models: ["opus"], maxLive: 2, maxHours: 8 })), at)?.why, "revoked");
  assert.equal(wantEnding(state, load(s, seedDoc({ roles: "open", models: ["sonnet"], maxLive: 2, maxHours: 8 })), at)?.why, "revoked");
  assert.equal(wantEnding(state, load(s, seedDoc({ roles: "open", models: ["opus"], maxLive: 2, maxHours: 1 })), at + 3_600_000)?.why, "expired");
  const unwanted = /** @type {any} */ ([...foldLedger([w, { type: "resident-grant", ev: "unwant", id: w.id, at: w.at, by: "lab.orchestrator" }]).values()][0]);
  assert.deepEqual(wantEnding(unwanted, m, at), { why: "unwanted", by: "lab.orchestrator", at: w.at });
});

/**
 * Fake seat acts for ensure: positions run in a set, a turn per position, posts recorded.
 * @param {number} now
 */
function fakeDeps(now) {
  const running = new Set();
  const runs = new Set();
  /** @type {Record<string, any>} */
  const turns = {};
  /** @type {Array<{ room: string, text: string }>} */
  const posts = [];
  /** @type {string[]} */
  const raws = [];
  /** @type {string[]} */
  const acts = [];
  /** @type {import("../src/resident-grant.mjs").EnsureDeps} */
  const deps = {
    start: async (p) => { acts.push(`start ${p}`); running.add(p); runs.add(p); return { action: "started" }; },
    stop: async (p) => { acts.push(`stop ${p}`); running.delete(p); runs.delete(p); return { action: "stopped" }; },
    state: async (p) => ({ running: running.has(p), run: runs.has(p) ? {} : null, reason: running.has(p) ? "live" : null }),
    marker: async () => false,
    turn: async (p) => turns[p] ?? { status: "none" },
    post: async (room, text) => { posts.push({ room, text: text.split("\n")[0] }); raws.push(text); return { id: `m${posts.length}` }; },
    now: () => now,
  };
  return { deps, running, runs, turns, posts, raws, acts };
}

test("ensure: an admitted want starts with one N8 line; a second pass posts nothing; a revoked grant stops it at idle with one N8 line; the record is kept", async (t) => {
  const s = await seat(t);
  await writeFile(s.manifestFile, "{}");
  const m = load(s, seedDoc());
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const r = await recordWant(m, s.state, { requester: "lab.orchestrator", session: "orc", position: "lab.coding", because: "parallel units", now: t0 }, { held: async () => false });
  assert.equal(r.ok, true);
  const f = fakeDeps(t0 + 30_000);
  let rows = await ensure(m, s.state, f.deps);
  assert.deepEqual(rows.map((x) => [x.position, x.action]), [["lab.coding-2", "started"]]);
  assert.deepEqual(f.posts, [{ room: "lab", text: "lab.coding-2: wanted by lab.orchestrator 30s; path grant; outcome started." }]);
  assert.deepEqual([parseNotice(f.raws[0])?.kind, parseNotice(f.raws[0])?.fields.outcome], ["N8", "started"], "the line is the messenger's pinned N8 form, read back whole");
  assert.match(f.raws[0], /\n\nack: none$/, "a record line owes no disposition");
  rows = await ensure(m, s.state, f.deps);
  assert.deepEqual(rows.map((x) => x.action), ["running"]);
  assert.equal(f.posts.length, 1, "a second pass posts nothing");

  // the operator removes the grant: held while a turn runs, stopped once it ended past the grace
  const revoked = load(s, { ...seedDoc(), grants: {} });
  f.turns["lab.coding-2"] = { status: "read", at: new Date(t0).toISOString(), turnEnded: false };
  rows = await ensure(revoked, s.state, f.deps);
  assert.deepEqual(rows.map((x) => [x.action, x.reason]), [["held", "revoked; stops at its next idle: a turn is running"]]);
  f.turns["lab.coding-2"] = { status: "read", at: new Date(t0 + 25_000).toISOString(), turnEnded: true };
  rows = await ensure(revoked, s.state, f.deps, { graceSeconds: 60 });
  assert.equal(rows[0].action, "held", "inside the grace it is still held");
  rows = await ensure(revoked, s.state, f.deps, { graceSeconds: 5 });
  assert.deepEqual(rows.map((x) => x.action), ["stopped"]);
  assert.equal(f.posts.at(-1)?.text, "lab.coding-2: revoked by manifest 0s; path grant; outcome stopped.");
  assert.equal(f.posts.length, 2);
  assert.deepEqual((await ensure(revoked, s.state, f.deps)).length, 0, "an ended want is not acted on again");
  const evs = (await readLedger(s.state)).map((e) => e.ev);
  assert.deepEqual(evs, ["want", "start", "ending", "stop", "end"], "every want, start and stop is on the record");
});

test("ensure: a dead granted position is restarted (absent by host); one stopped by hand ends its want; an unwanted one stops at idle; an expired one with nothing running ends", async (t) => {
  const s = await seat(t);
  const m = load(s, seedDoc());
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const want = async (/** @type {string} */ position, /** @type {any} */ extra = {}) => /** @type {any} */ (await recordWant(m, s.state, { requester: "lab.orchestrator", session: "orc", position, because: "b", now: t0, ...extra }, { held: async () => false })).want;
  const a = await want("lab.coding");
  const f = fakeDeps(t0);
  await ensure(m, s.state, f.deps);
  f.running.delete("lab.coding-2"); // died: its run record is left
  let rows = await ensure(m, s.state, f.deps);
  assert.deepEqual(rows.map((x) => [x.action, x.notice]), [["restarted", "lab.coding-2: absent by host 0s; path restart; outcome started."]]);
  f.running.delete("lab.coding-2"); f.runs.delete("lab.coding-2"); // stopped by the operator: no run record
  rows = await ensure(m, s.state, f.deps);
  assert.deepEqual(rows.map((x) => x.action), ["ended"]);
  assert.equal(f.posts.length, 2, "a stop by hand posts nothing: it was not the supervisor's");

  const b = await want("lab.coding");
  await ensure(m, s.state, f.deps);
  assert.notEqual(b.id, a.id);
  const u = await recordUnwant(s.state, { target: b.position, by: "lab.orchestrator", now: t0 + 10_000 });
  assert.equal(u.ok, true);
  rows = await ensure(m, s.state, f.deps);
  assert.deepEqual(rows.map((x) => [x.action, x.notice]), [["stopped", "lab.coding-2: unwanted by lab.orchestrator 0s; path grant; outcome stopped."]]);
  assert.equal(/** @type {any} */ (await recordUnwant(s.state, { target: b.id, by: "x", now: t0 })).ok, false, "an ended want cannot be unwanted");

  await want("lab.coding", { hours: 1 });
  const late = fakeDeps(t0 + 2 * 3_600_000);
  rows = await ensure(m, s.state, late.deps);
  assert.deepEqual(rows.map((x) => [x.action, x.reason]), [["ended", "expired; nothing runs at the position"]], "an expired want that never started just ends");
});

test("ensure: a messenger row whose host died is restarted with one N8 line; one stopped by its operator is left; --dry-run acts on nothing", async (t) => {
  const s = await seat(t);
  const m = load(s, seedDoc());
  const f = fakeDeps(Date.parse("2026-01-01T00:00:00.000Z"));
  let rows = await ensure(m, s.state, f.deps);
  assert.deepEqual(rows, [], "no run record: stopped by its operator, or never started");
  f.runs.add("lab.messenger");
  rows = await ensure(m, s.state, f.deps, { dryRun: true });
  assert.deepEqual(rows.map((x) => x.action), ["would-restart"]);
  assert.deepEqual([f.acts, f.posts], [[], []]);
  rows = await ensure(m, s.state, f.deps);
  assert.deepEqual(rows.map((x) => [x.position, x.action, x.notice]), [["lab.messenger", "restarted", "lab.messenger: absent by host 0s; path restart; outcome started."]]);
  assert.equal((await ensure(m, s.state, f.deps)).length, 0, "running again: nothing to do");
});

test("grantView lists caps and open wants; roomSubject is the titled pinned root", async (t) => {
  const s = await seat(t);
  const m = load(s, seedDoc());
  const w = /** @type {any} */ (await admit(m, foldLedger([]), {})).want;
  const [v] = grantView(m, foldLedger([w]), Date.parse(w.at));
  assert.deepEqual([v.holder, v.maxLive, v.wants.map((x) => [x.position, x.state, x.started])], ["lab.orchestrator", 2, [["lab.coding-2", "open", false]]]);
  const msgs = [{ id: "a" }, { id: "b" }, { id: "c", thread: "b" }, { id: "d" }];
  assert.equal(roomSubject(msgs, [{ act: "pin", target: "a" }, { act: "pin", target: "d" }, { act: "title", target: "d", text: "Room" }]), "d");
  assert.equal(roomSubject(msgs, [{ act: "pin", target: "a" }]), "a");
  assert.equal(roomSubject(msgs, [{ act: "pin", target: "a" }, { act: "unpin", target: "a" }]), null);
});

test("turnState: an assistant message with no tool call ends a turn; a tool call or anything after it means a turn runs", async (t) => {
  const s = await seat(t);
  const omp = path.join(s.root, "omp.jsonl");
  const line = (/** @type {any} */ o) => JSON.stringify(o) + "\n";
  const msg = (/** @type {string} */ ts, /** @type {string} */ role, /** @type {string} */ stop) => ({ type: "message", timestamp: ts, message: { role, ...(stop ? { stopReason: stop } : {}) } });
  await writeFile(omp, line({ type: "session", timestamp: "2026-01-01T00:00:00Z" }) + line(msg("2026-01-01T00:01:00Z", "custom", "")) + line(msg("2026-01-01T00:02:00Z", "assistant", "toolUse")));
  assert.deepEqual(await turnState(omp, "omp"), { at: "2026-01-01T00:02:00Z", turnEnded: false });
  await writeFile(omp, line(msg("2026-01-01T00:02:00Z", "assistant", "toolUse")) + line(msg("2026-01-01T00:03:00Z", "toolResult", "")) + line(msg("2026-01-01T00:04:00Z", "assistant", "stop")) + line({ type: "title_change", timestamp: "2026-01-01T00:05:00Z" }));
  assert.deepEqual(await turnState(omp, "omp"), { at: "2026-01-01T00:04:00Z", turnEnded: true });
  const cc = path.join(s.root, "cc.jsonl");
  await writeFile(cc, line({ type: "assistant", timestamp: "2026-01-01T00:01:00Z", message: { content: [{ type: "text" }, { type: "tool_use" }] } }));
  assert.equal((await turnState(cc, "claude-code"))?.turnEnded, false);
  await writeFile(cc, line({ type: "user", timestamp: "2026-01-01T00:01:00Z", message: {} }) + line({ type: "assistant", timestamp: "2026-01-01T00:02:00Z", message: { content: [{ type: "text" }] } }) + line({ type: "progress", timestamp: "2026-01-01T00:03:00Z" }));
  assert.deepEqual(await turnState(cc, "claude-code"), { at: "2026-01-01T00:02:00Z", turnEnded: true });
});

test("cycleVerdict: a succeed request waits for the running turn, is honoured once it ends, and is stale when the session outlived it", async () => {
  const now = new Date("2026-01-02T00:00:00.000Z");
  const rec = { slug: "omp-x", state: "live", record: { bearer: "orchestrator/Opus", label: "lab.orchestrator", startedAt: "2026-01-01T00:00:00.000Z", source: "OMP_SESSION_ID" } };
  const measure = async () => ({ status: /** @type {const} */ ("measured"), lastInference: "2026-01-01T23:59:30.000Z", context: 90_000, file: "t" });
  const base = { slug: "lab.orchestrator", now, sessions: [rec], measure };
  const read = (/** @type {boolean} */ turnEnded) => ({ status: /** @type {const} */ ("read"), session: "omp-x", startedAt: rec.record.startedAt, at: "2026-01-01T23:59:30.000Z", turnEnded });
  let v = /** @type {any} */ (await cycleVerdict({ ...base, succeed: { at: "2026-01-01T23:00:00.000Z", turn: read(false) } }));
  assert.deepEqual([v.action, /waits for the running turn/.test(v.reason)], ["none", true]);
  v = await cycleVerdict({ ...base, succeed: { at: "2026-01-01T23:00:00.000Z", turn: read(true) } });
  assert.deepEqual([v.action, v.succeed, v.context, /^succeed: /.test(v.reason)], ["cycle", "2026-01-01T23:00:00.000Z", 90_000, true], "small and warm, yet asked: it is handed on");
  v = await cycleVerdict({ ...base, succeed: { at: "2025-12-31T00:00:00.000Z", turn: read(true) } });
  assert.deepEqual([v.action, v.stale], ["none", true]);
  v = await cycleVerdict({ ...base });
  assert.equal(v.action, "none", "no request: small and warm is left alone");
});

// ---------------------------------------------------------------------------------------------

/** A seat for the CLI: a local room, the manifest, empty harness and tern files on a PATH of their own. @param {import("node:test").TestContext} t */
async function cliSeat(t) {
  const s = await seat(t);
  const bin = path.join(s.root, "bin");
  await mkdir(bin, { recursive: true });
  for (const n of ["omp", "tern"]) for (const ext of ["", ".exe", ".com"]) await writeFile(path.join(bin, n + ext), "");
  const config = path.join(s.root, "config.json");
  await writeFile(config, JSON.stringify({ actor: { name: "Grace", kind: "agent" }, state: s.state, rooms: { lab: { transport: "local", path: path.join(s.root, "lab.ndjson") } } }));
  await writeFile(s.manifestFile, JSON.stringify(seedDoc({ roles: "open", models: ["sonnet", "opus"], maxLive: 1, maxHours: 8 })));
  const env = { PATH: bin, PATHEXT: ".COM;.EXE", AGORA_CONFIG: config, AGORA_STATE: s.state };
  const orc = { ...env, AGORA_SESSION: "orc", AGORA_LABEL: "lab.orchestrator" };
  return { ...s, config, env, orc };
}

test("CLI: want from the grant holder records and runs ensure (a start the host refuses posts one N8 failed line); past maxLive and outside models are refused by name", async (t) => {
  const s = await cliSeat(t);
  const m = ["--manifest", s.manifestFile];
  const r = await agora(["resident", "want", "lab.coding", "--because", "two units wait", "--json", ...m], s.orc);
  const lines = /** @type {any[]} */ (String(r.stdout).trim().split(/\r?\n/).map((/** @type {string} */ l) => JSON.parse(l)));
  assert.equal(lines[0].action, "wanted", r.stderr);
  assert.equal(lines[0].position, "lab.coding-2");
  const start = lines.find((l) => l.type === "resident-ensure");
  assert.equal(start.action, "failed", "the empty tern on PATH cannot start anything");
  assert.match(start.notice, /^lab\.coding-2: wanted by lab\.orchestrator \d+s; path grant; outcome failed\.$/);
  assert.equal(r.code, 1);
  // the line is in the room, signed by the room's messenger position
  const room = (await readFile(path.join(s.root, "lab.ndjson"), "utf8")).trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const n8 = room.filter((x) => typeof x.text === "string" && x.text.startsWith("lab.coding-2: wanted by"));
  assert.equal(n8.length, 1);
  assert.match(n8[0].text, /-- messenger\/Code$/);

  const past = await agora(["resident", "want", "lab.coding", "--because", "a third", ...m], s.orc);
  assert.equal(past.code, 1);
  assert.match(past.stderr, /want lab\.coding refused: past maxLive 1: lab\.orchestrator already holds lab\.coding-2/);
  await agora(["resident", "unwant", "lab.coding-2", "--because", "done", ...m], s.orc);
  const outside = await agora(["resident", "want", "lab.coding", "--model", "haiku", "--because", "cheap", ...m], s.orc);
  assert.match(outside.stderr, /model haiku is outside lab\.orchestrator's grant \(models: sonnet, opus\)/);
  const nobody = await agora(["resident", "want", "lab.coding", "--because", "x", ...m], { ...s.env, AGORA_SESSION: "stray" });
  assert.match(nobody.stderr, /asked by the session that holds a grant/);
  const evs = (await readLedger(s.state)).map((e) => `${e.ev}${e.reason ? `:${String(e.reason).split(":")[0]}` : ""}`);
  assert.deepEqual(evs.filter((e) => !e.startsWith("start")), ["want", "refuse:past maxLive 1", "unwant", "end", "refuse:model haiku is outside lab.orchestrator's grant (models", "refuse:a want is asked by the session that holds a grant"]);

  const view = await agora(["resident", "grant", ...m], s.env);
  assert.match(view.stdout, /^lab\.orchestrator: roles open, models sonnet,opus, maxLive 1, maxHours 8/);
});

test("CLI: succeed writes the request for this session's position; ensure --dry-run acts on nothing", async (t) => {
  const s = await cliSeat(t);
  const r = await agora(["resident", "succeed", "--json"], s.orc);
  assert.equal(r.code, 0, r.stderr);
  const req = await readSucceedRequest(s.state, "lab.orchestrator");
  assert.deepEqual([req?.slug, req?.by], ["lab.orchestrator", "orc"]);
  const none = await agora(["resident", "succeed"], { ...s.env, AGORA_SESSION: "stray" });
  assert.equal(none.code, 2);
  const dry = await agora(["resident", "ensure", "--dry-run", "--manifest", s.manifestFile], s.env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(existsSync(path.join(s.state, "residents", "grants.jsonl")), false, "a dry run writes no record");
});
