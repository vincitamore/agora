// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearStandDown, completeStandDownAck, declareStandDown, readStandDown, requestWatchStop, standDownRequested, watchAckPath, watchStopPath } from "../src/stand-down.mjs";
import { pidAlive, readArmed, writeArmed } from "../src/session.mjs";
import { watch } from "../src/watch.mjs";
import { localTransport } from "../src/transports/local.mjs";
import { actor, tmp } from "./helpers.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"];

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

test("schema lists stand-down and resume", async () => {
  const { code, stdout } = await agora(["schema", "--json"], {});
  assert.equal(code, 0);
  const schema = JSON.parse(stdout);
  assert.ok(schema.verbs["stand-down"]);
  assert.ok(schema.verbs.resume);
});

test("stand-down writes the record, drains a cooperative watch, and resume clears it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-stand-down-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sessionDir = path.join(root, "sessions", "s1");
  const generation = "gen-live-1";
  const stop = watchStopPath(sessionDir, "agora");
  const ack = watchAckPath(sessionDir, "agora");
  const watcher = path.join(root, "watcher.cjs");
  await writeFile(watcher, "const fs=require('fs');const path=require('path');const stop=process.argv[2];const ack=process.argv[3];const gen=process.argv[4];setInterval(()=>{try{const rec=JSON.parse(fs.readFileSync(stop,'utf8'));if(rec.generation===gen){fs.mkdirSync(path.dirname(ack),{recursive:true});fs.writeFileSync(ack,JSON.stringify({generation:gen,at:new Date().toISOString()}));process.exit(0);}}catch{}},40);\n");
  const dummy = spawn(process.execPath, [watcher, stop, ack, generation], { stdio: "ignore", windowsHide: true });
  // An ACK proves the flush completed; the OS may reap the process afterward.
  const exited = new Promise((resolve, reject) => {
    dummy.once("error", reject);
    dummy.once("close", resolve);
  });
  t.after(() => { try { dummy.kill("SIGKILL"); } catch { /* gone */ } });
  assert.ok(dummy.pid);
  await writeArmed(sessionDir, "agora", {
    room: "agora", pid: dummy.pid, interval: 15, startedAt: new Date().toISOString(), generation,
  });
  const armed = await readArmed(sessionDir, "agora");
  assert.ok(armed);
  const until = new Date(Date.now() + 60_000).toISOString();
  const rec = await declareStandDown({
    sessionDir, slug: "s1", bearer: "Grok-4.6/forge", until, because: "meter",
    armed: [{ key: "agora", armed }], ackMs: 1500,
  });
  assert.equal(rec.because, "meter");
  assert.equal(rec.drained.length, 1);
  assert.equal(rec.drained[0].pid, dummy.pid);
  const onDisk = await readStandDown(sessionDir);
  assert.equal(onDisk?.because, "meter");
  let exitTimer;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error("cooperative watcher did not exit after ACK")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(exitTimer);
  }
  assert.equal(pidAlive(dummy.pid), false);
  const cleared = await clearStandDown(sessionDir);
  assert.equal(cleared?.because, "meter");
  assert.equal(await readStandDown(sessionDir), undefined);
});

test("stand-down refuses a past until and a missing because", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-stand-down-bad-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sessionDir = path.join(root, "sessions", "s1");
  await assert.rejects(
    () => declareStandDown({ sessionDir, slug: "s1", bearer: "x", until: "not-a-date", because: "n" }),
    /RFC 3339/,
  );
  await assert.rejects(
    () => declareStandDown({ sessionDir, slug: "s1", bearer: "x", until: new Date(Date.now() - 1000).toISOString(), because: "n" }),
    /future/,
  );
  await assert.rejects(
    () => declareStandDown({ sessionDir, slug: "s1", bearer: "x", until: new Date(Date.now() + 60_000).toISOString(), because: "  " }),
    /--because/,
  );
});

test("cli stand-down and resume round-trip", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-stand-down-cli-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const cfg = path.join(root, "agora.json");
  await writeFile(cfg, JSON.stringify({ actor: { name: "Grok-4.6/forge", kind: "agent" }, rooms: { scratch: { transport: "local", path: path.join(root, "room.ndjson") } } }));
  const env = { AGORA_STATE: root, AGORA_CONFIG: cfg, AGORA_SESSION: "s1", AGORA_ACTOR: "Grok-4.6/forge" };
  const until = new Date(Date.now() + 120_000).toISOString();
  const down = await agora(["stand-down", "--until", until, "--because", "meter", "--json"], env);
  assert.equal(down.code, 0, down.stderr);
  const line = JSON.parse(down.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(line.type, "stand-down");
  assert.equal(line.because, "meter");
  const onDisk = JSON.parse(await readFile(path.join(root, "sessions", "s1", "stand-down.json"), "utf8"));
  assert.equal(onDisk.because, "meter");
  const doctor = await agora(["doctor", "--offline", "--json"], env);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /"type":"stand-down"/);
  const up = await agora(["resume", "--json"], env);
  assert.equal(up.code, 0, up.stderr);
  const cleared = JSON.parse(up.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
  assert.equal(cleared.cleared, true);
  await assert.rejects(readFile(path.join(root, "sessions", "s1", "stand-down.json")));
});

test("a watch that does not ack is refused, not drained, and the record already exists", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-stand-down-noack-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sessionDir = path.join(root, "sessions", "s1");
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore", windowsHide: true });
  t.after(() => { try { dummy.kill("SIGKILL"); } catch { /* gone */ } });
  assert.ok(dummy.pid);
  await writeArmed(sessionDir, "agora", {
    room: "agora", pid: dummy.pid, interval: 15, startedAt: new Date().toISOString(), generation: "gen-noack",
  });
  const armed = await readArmed(sessionDir, "agora");
  assert.ok(armed);
  const rec = await declareStandDown({
    sessionDir, slug: "s1", bearer: "x", until: new Date(Date.now() + 60_000).toISOString(), because: "meter",
    armed: [{ key: "agora", armed }], ackMs: 200,
  });
  assert.equal(rec.drained.length, 0);
  assert.equal(rec.refused.length, 1);
  assert.equal(rec.refused[0].reason, "no-ack");
  assert.equal(pidAlive(dummy.pid), true);
  assert.equal((await readStandDown(sessionDir))?.refused[0].reason, "no-ack");
});

test("keep-watches declares without signalling", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-stand-down-keep-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sessionDir = path.join(root, "sessions", "s1");
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore", windowsHide: true });
  t.after(() => { try { dummy.kill("SIGKILL"); } catch { /* gone */ } });
  assert.ok(dummy.pid);
  await writeArmed(sessionDir, "agora", {
    room: "agora", pid: dummy.pid, interval: 15, startedAt: new Date().toISOString(), generation: "gen-keep",
  });
  const armed = await readArmed(sessionDir, "agora");
  assert.ok(armed);
  const rec = await declareStandDown({
    sessionDir, slug: "s1", bearer: "x", until: new Date(Date.now() + 60_000).toISOString(), because: "meter",
    keepWatches: true, armed: [{ key: "agora", armed }],
  });
  assert.equal(rec.keepWatches, true);
  assert.equal(rec.drained.length, 0);
  assert.equal(pidAlive(dummy.pid), true);
  await assert.rejects(readFile(watchStopPath(sessionDir, "agora")));
});

test("a record without generation is skipped, not asked", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-stand-down-unver-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sessionDir = path.join(root, "sessions", "s1");
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore", windowsHide: true });
  t.after(() => { try { dummy.kill("SIGKILL"); } catch { /* gone */ } });
  assert.ok(dummy.pid);
  const rec = await declareStandDown({
    sessionDir, slug: "s1", bearer: "x", until: new Date(Date.now() + 60_000).toISOString(), because: "meter",
    armed: [{ key: "agora", armed: { room: "agora", pid: dummy.pid, interval: 15, startedAt: new Date().toISOString() } }],
  });
  assert.equal(rec.drained.length, 0);
  assert.equal(rec.skipped[0].reason, "unverified");
  assert.equal(pidAlive(dummy.pid), true);
});

test("a replacement generation does not inherit an old stop request, and resume clears it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-stand-down-gen-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sessionDir = path.join(root, "sessions", "s1");
  await requestWatchStop(sessionDir, "agora", "gen-old");
  assert.equal(await standDownRequested(sessionDir, "agora", "gen-old"), true);
  assert.equal(await standDownRequested(sessionDir, "agora", "gen-new"), false);
  await clearStandDown(sessionDir);
  assert.equal(await standDownRequested(sessionDir, "agora", "gen-old"), false);
});

test("ack is not written when the real watch flush throws", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const tport = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    await tport.post("held");
    const sessionDir = path.join(dir, "s");
    const key = "r";
    const generation = "gen-flush-fail";
    let polls = 0;
    await assert.rejects(
      () => watch(tport, {
        stateDir: sessionDir, key, mode: "stream", interval: 0.05, coalesceSeconds: 30, maxBatch: 8,
        guard: () => { polls += 1; return polls >= 2 ? "stand-down" : undefined; },
        onBatch: async () => { throw new Error("delivery-failed"); },
        sleep: async () => {},
      }),
      /delivery-failed/,
    );
    await completeStandDownAck(undefined, sessionDir, key, generation);
    await assert.rejects(readFile(watchAckPath(sessionDir, key)));
  } finally {
    await cleanup();
  }
});

test("ack is written only after watch returns stand-down", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const tport = localTransport({ transport: "local", path: path.join(dir, "r.ndjson") }, { actor });
    const sessionDir = path.join(dir, "s");
    const key = "r";
    const generation = "gen-flush-ok";
    let polls = 0;
    const result = await watch(tport, {
      stateDir: sessionDir, key, mode: "stream", interval: 0.05,
      guard: () => { polls += 1; return polls >= 2 ? "stand-down" : undefined; },
      onBatch: () => {},
      sleep: async () => {},
    });
    assert.equal(result.reason, "stand-down");
    await completeStandDownAck(result, sessionDir, key, generation);
    const ack = JSON.parse(await readFile(watchAckPath(sessionDir, key), "utf8"));
    assert.equal(ack.generation, generation);
  } finally {
    await cleanup();
  }
});
