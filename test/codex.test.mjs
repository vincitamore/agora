// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { codexHome, codexLiveness, codexPrompt, codexRollout, codexSpawnWarning, codexThread, probeCodexWriterLock, queueCodex, resolveCodexBinary } from "../src/codex.mjs";

const message = /** @type {import('../src/core.mjs').Message} */ ({
  id: "m1",
  cursor: "1788475881.165359",
  ts: "2026-09-03T22:51:21Z",
  author: { id: "U1", name: "Alex", kind: "human" },
  text: "please inspect this\n\n-- to: Codex-Sol/general",
});

test("Codex task identity prefers CODEX_THREAD_ID and falls back to CODEX_SESSION_ID", () => {
  assert.equal(codexThread({ CODEX_THREAD_ID: "thread", CODEX_SESSION_ID: "session" }), "thread");
  assert.equal(codexThread({ CODEX_SESSION_ID: "session" }), "session");
  assert.equal(codexThread({}), undefined);
});

test("Codex liveness requires both a rollout and the thread-store writer marker", () => {
  const env = { CODEX_HOME: path.resolve("fixture", "codex-home") };
  const thread = "01a06c9b-a40b-7121-84a7-82c8cedb3325";
  const rollout = path.join(env.CODEX_HOME, "sessions", "2026", "09", "04", `rollout-now-${thread}.jsonl`);
  const lock = path.join(env.CODEX_HOME, "thread-writer-locks", `${thread}.lock`);
  assert.equal(codexHome(env), env.CODEX_HOME);
  assert.deepEqual(codexLiveness(thread, env, { rollout: () => undefined }), {
    state: "gone",
    reason: `Codex thread ${thread} has no rollout under ${path.join(env.CODEX_HOME, "sessions")}`,
  });
  assert.match(codexLiveness(thread, env, { rollout: () => rollout, exists: () => false }).reason ?? "", /no writer lock/);
  assert.deepEqual(codexLiveness(thread, env, { rollout: () => rollout, exists: (file) => file === lock, probe: () => "active" }), { state: "live", rollout, lock });
  assert.match(codexLiveness(thread, env, { rollout: () => rollout, exists: () => true, probe: () => "stale" }).reason ?? "", /stale writer lock/);
  assert.equal(codexLiveness(thread, env, { rollout: () => rollout, exists: () => true, probe: () => "unknown" }).state, "unknown");
});

test("Codex writer-lock probing distinguishes active, stale, and unprobeable locks on every supported OS", () => {
  const busy = () => { const error = /** @type {NodeJS.ErrnoException} */ (new Error("busy")); error.code = "EBUSY"; throw error; };
  const denied = () => { const error = /** @type {NodeJS.ErrnoException} */ (new Error("denied")); error.code = "EACCES"; throw error; };
  assert.equal(probeCodexWriterLock("x", { platform: "win32", read: /** @type {any} */ (busy) }), "active");
  assert.equal(probeCodexWriterLock("x", { platform: "win32", read: /** @type {any} */ (denied) }), "unknown", "permission denial is not proof that Codex holds the lock");
  assert.equal(probeCodexWriterLock("x", { platform: "win32", read: /** @type {any} */ (() => Buffer.alloc(0)) }), "stale");
  assert.equal(probeCodexWriterLock("x", { platform: "linux", run: /** @type {any} */ (() => ({ status: 1 })) }), "active");
  assert.equal(probeCodexWriterLock("x", { platform: "linux", run: /** @type {any} */ (() => ({ status: 0 })) }), "stale");
  assert.equal(probeCodexWriterLock("x", { platform: "darwin", run: /** @type {any} */ ((/** @type {string} */ command, /** @type {string[]} */ args) => {
    assert.equal(command, "/usr/sbin/lsof");
    assert.deepEqual(args, ["-F", "p", "--", "x"]);
    return { status: 0, stdout: "p123\n" };
  }) }), "active");
  assert.equal(probeCodexWriterLock("x", { platform: "darwin", run: /** @type {any} */ (() => ({ status: 1, stdout: "" })) }), "stale");
  assert.equal(probeCodexWriterLock("x", { platform: "darwin", run: /** @type {any} */ (() => ({ status: null, error: { code: "ENOENT" } })) }), "unknown");
});

test("Codex rollout discovery follows CODEX_HOME recursively", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const home = await mkdtemp(path.join(os.tmpdir(), "agora-codex-home-"));
  try {
    const thread = "01a06c9b-a40b-7121-84a7-82c8cedb3325";
    const dir = path.join(home, "sessions", "2026", "09", "04");
    await mkdir(dir, { recursive: true });
    const rollout = path.join(dir, `rollout-now-${thread}.jsonl`);
    await writeFile(rollout, "");
    assert.equal(codexRollout(thread, { CODEX_HOME: home }), rollout);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex warns only when the current thread differs from the stable seat session", () => {
  assert.equal(codexSpawnWarning({ CODEX_THREAD_ID: "root", CODEX_SESSION_ID: "root" }), undefined);
  assert.equal(codexSpawnWarning({ CODEX_THREAD_ID: "child", CODEX_SESSION_ID: "root" })?.includes("spawned Codex thread"), true);
});

test("Codex prompt preserves the original delivery with a compact origin envelope", () => {
  const prompt = codexPrompt("slopcannon", message);
  assert.match(prompt, /^\[Agora delivery; room slopcannon; cursor 1788475881\.165359; from Alex\]/);
  assert.match(prompt, /Codex no-op policy:[^\n]+<!-- agora:no-maintenance -->/);
  assert.ok(prompt.endsWith(message.text));
});

test("Codex prompt carries locally materialized image paths without private transport URLs", () => {
  const prompt = codexPrompt("agora", {
    ...message,
    attachments: [{
      id: "F1", name: "screen shot.jpg", kind: "image", mimetype: "image/jpeg", size: 121548,
      path: "C:\\state\\media\\agora\\F1.jpg",
      url: "https://files.slack.com/private/source",
    }],
  });
  assert.match(prompt, /\[Agora attachments\]/);
  assert.match(prompt, /local path "C:\\\\state\\\\media\\\\agora\\\\F1\.jpg"/);
  assert.doesNotMatch(prompt, /files\.slack\.com/);
});

test("Codex binary honors the explicit environment override", async () => {
  const expected = path.resolve("fixture", "codex.exe");
  assert.equal(await resolveCodexBinary({
    env: { AGORA_CODEX_BIN: expected },
    exists: (file) => file === expected,
  }), expected);
});

test("Codex binary resolves the native executable reported by doctor behind an npm shim", async () => {
  const root = path.resolve("fixture", "nodejs");
  const node = path.join(root, "node.exe");
  const cli = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  const native = path.resolve("fixture", "vendor", "codex.exe");
  assert.equal(await resolveCodexBinary({
    platform: "win32",
    env: { PATH: root },
    exists: (file) => [node, cli, native].includes(file),
    run: /** @type {any} */ (async (/** @type {string} */ file, /** @type {string[]} */ args) => {
      if (file === "where.exe") throw new Error("not found");
      assert.equal(file, node);
      assert.deepEqual(args, [cli, "doctor", "--json"]);
      return { stdout: JSON.stringify({ checks: { "runtime.provenance": { details: { "current executable": native } } } }), stderr: "" };
    }),
  }), native);
});

test("Codex queue sends each delivery in order to the current task", async () => {
  /** @type {Array<{ file: string, args: string[] }>} */
  const calls = [];
  const second = { ...message, id: "m2", cursor: "2", text: "next", signedAs: "Fable/review" };
  await queueCodex("slopcannon", [message, second], {
    env: { CODEX_THREAD_ID: "task-123" },
    bin: process.execPath,
    run: /** @type {any} */ (async (/** @type {string} */ file, /** @type {string[]} */ args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    }),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 4), ["queue", "--thread", "task-123", "--message"]);
  assert.equal(calls[0].file, process.execPath);
  assert.match(calls[1].args[4], /from Fable\/review/);
});

test("Codex queue awaits each acceptance checkpoint before starting the next delivery", async () => {
  const second = { ...message, id: "m2", cursor: "2", text: "next" };
  /** @type {string[]} */
  const order = [];
  await queueCodex("slopcannon", [message, second], {
    env: { CODEX_THREAD_ID: "task-123" },
    bin: process.execPath,
    run: /** @type {any} */ (async (/** @type {string} */ _file, /** @type {string[]} */ args) => {
      order.push(`queue:${args[4].includes("cursor 2") ? "2" : "1"}`);
      return { stdout: "", stderr: "" };
    }),
    onQueued: async ({ message: accepted }) => {
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`checkpoint:${accepted.cursor}`);
    },
  });
  assert.deepEqual(order, ["queue:1", "checkpoint:1788475881.165359", "queue:2", "checkpoint:2"]);
});

test("Codex queue serializes a burst instead of starting later deliveries concurrently", async () => {
  /** @type {() => void} */
  let releaseFirst = () => {};
  /** @type {Promise<void>} */
  const firstHeld = new Promise((resolve) => { releaseFirst = () => resolve(); });
  /** @type {string[]} */
  const started = [];
  const second = { ...message, id: "m2", cursor: "2", text: "next" };
  const queued = queueCodex("slopcannon", [message, second], {
    env: { CODEX_THREAD_ID: "task-123" },
    bin: process.execPath,
    run: /** @type {any} */ (async (/** @type {string} */ _file, /** @type {string[]} */ args) => {
      started.push(args[4]);
      if (started.length === 1) await firstHeld;
      return { stdout: "", stderr: "" };
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 1, "the second delivery waits for the first queue call");
  releaseFirst();
  await queued;
  assert.equal(started.length, 2);
  assert.match(started[0], /cursor 1788475881\.165359/);
  assert.match(started[1], /cursor 2/);
});

test("Codex queue fails before consuming a delivery when no task id exists", async () => {
  await assert.rejects(() => queueCodex("slopcannon", [message], { env: {} }), /CODEX_THREAD_ID.*CODEX_SESSION_ID/);
});

test("Codex queue keeps peer-authored shell metacharacters in one argv value", async () => {
  const text = 'literal & | " %VAR% stays data';
  /** @type {any[]} */
  const calls = [];
  await queueCodex("slopcannon", [{ ...message, text }], {
    env: { CODEX_SESSION_ID: "task-123" },
    bin: process.execPath,
    run: /** @type {any} */ (async (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {Record<string, unknown>} */ options) => {
      calls.push({ file, args, options });
      return { stdout: "", stderr: "" };
    }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[4].endsWith(text), true);
  assert.equal(calls[0].options.shell, undefined);
});

test("both Codex launchers record the detached worker as the session pid", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [powershell, posix] = await Promise.all([
    readFile(path.join(root, "scripts", "start-codex-watch.ps1"), "utf8"),
    readFile(path.join(root, "scripts", "start-codex-watch.sh"), "utf8"),
  ]);
  assert.match(powershell, /\$env:AGORA_SESSION_PID = \[string\]\$PID/);
  assert.match(posix, /AGORA_SESSION_PID=\$\$/);
  assert.match(posix, /exec "\$runtime_path"/, "exec preserves the worker pid in the Node watch");
});

test("Codex launcher default logs are isolated by session and room", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [powershell, posix] = await Promise.all([
    readFile(path.join(root, "scripts", "start-codex-watch.ps1"), "utf8"),
    readFile(path.join(root, "scripts", "start-codex-watch.sh"), "utf8"),
  ]);
  assert.match(powershell, /agora-codex-watch-\$SessionId-\$safeRoom/);
  assert.match(posix, /agora-codex-watch-\$session_id-\$safe_room/);
  assert.doesNotMatch(powershell, /\[string\]\$LogPrefix\s*=\s*\(Join-Path[^\r\n]+['"]agora-codex-watch['"]/);
  assert.doesNotMatch(posix, /^log_prefix=\$\{TMPDIR:-\/tmp\}\/agora-codex-watch$/m);
});

test("both Codex launchers coalesce a dark-seat backlog before queueing it", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [powershell, posix] = await Promise.all([
    readFile(path.join(root, "scripts", "start-codex-watch.ps1"), "utf8"),
    readFile(path.join(root, "scripts", "start-codex-watch.sh"), "utf8"),
  ]);
  assert.match(powershell, /watch \$Room[^\r\n]+--coalesce 20 --max-batch 32 --codex-thread \$ThreadId @deliveryArgs/);
  assert.match(powershell, /'--codex-server', \$CodexServer, '--codex-token-file', \$CodexTokenFile/);
  assert.match(powershell, /'--codex-queue', '--codex-bin', \$CodexPath/);
  assert.match(posix, /watch "\$room"[^\n]+--wake addressed \\\n\s+[^\n]*--coalesce 20 --codex-queue/);
});

test("both Codex launchers slow followed-thread polling without weakening room delivery", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [powershell, posix] = await Promise.all([
    readFile(path.join(root, "scripts", "start-codex-watch.ps1"), "utf8"),
    readFile(path.join(root, "scripts", "start-codex-watch.sh"), "utf8"),
  ]);
  assert.match(powershell, /\[double\]\$ThreadInterval = 120/);
  assert.match(powershell, /--wake addressed --thread-interval \$ThreadInterval --coalesce 20/);
  assert.match(powershell, /'-ThreadInterval', \[string\]\$ThreadInterval/);
  assert.match(posix, /^thread_interval=120$/m);
  assert.match(posix, /--wake addressed \\\n\s+--thread-interval "\$thread_interval" --coalesce 20/);
  assert.match(posix, /--thread-interval "\$thread_interval"/);
});
