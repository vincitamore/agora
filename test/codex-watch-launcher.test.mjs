// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tmp } from "./helpers.mjs";

const runFile = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const launcher = path.join(repoRoot, "scripts", "start-codex-watch.sh");
const powershellLauncher = path.join(repoRoot, "scripts", "start-codex-watch.ps1");

test("Codex launcher waits beyond the old ten-second clock for the subscribed armed receipt", {
  skip: process.platform === "darwin" ? "the launchd lifecycle has its own opt-in integration cell" : false,
  timeout: 30_000,
}, async (t) => {
  const fixture = await tmp();
  const state = path.join(fixture.dir, "state");
  const config = path.join(fixture.dir, "config.json");
  const logPrefix = path.join(fixture.dir, "slow-watch");
  const room = "slow-subscribe";
  const session = `slow-subscribe-${process.pid}`;
  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    ...process.env,
    AGORA_CODEX_SERVER: "",
    AGORA_CODEX_TOKEN_FILE: "",
    AGORA_CODEX_MANAGED: "",
    CODEX_SESSION_ID: session,
    CODEX_THREAD_ID: session,
  };
  const fixtureScripts = path.join(fixture.dir, "scripts");
  const fixtureBin = path.join(fixture.dir, "bin");
  const testLauncher = path.join(fixtureScripts, process.platform === "win32" ? "start-codex-watch.ps1" : "start-codex-watch.sh");
  const fakeCodex = path.join(fixture.dir, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");

  t.after(() => fixture.cleanup());
  await mkdir(fixtureScripts, { recursive: true });
  await mkdir(fixtureBin, { recursive: true });
  await copyFile(process.platform === "win32" ? powershellLauncher : launcher, testLauncher);
  await writeFile(config, "{}");
  await writeFile(path.join(fixtureBin, "agora.mjs"), `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const room = process.argv[3];
const root = process.env.AGORA_STATE;
const session = process.env.CODEX_SESSION_ID;
const armed = path.join(root, "sessions", \`codex-\${session}\`, "armed", \`\${room}.json\`);
// Record the watch's pid the moment it starts, before the slow subscribe: the launcher's
// timeout path is measured against this, since the armed record is exactly what a timed-out
// arm never sees.
mkdirSync(${JSON.stringify(fixture.dir)}, { recursive: true });
writeFileSync(path.join(${JSON.stringify(fixture.dir)}, "started-" + process.argv[3] + ".pid"), String(process.pid));
await new Promise((resolve) => setTimeout(resolve, 12_000));
mkdirSync(path.dirname(armed), { recursive: true });
// Match the launcher's line-oriented armed-record reader as well as the
// PowerShell launcher's JSON parser. The real watch writes this shape.
writeFileSync(armed, JSON.stringify({ room, pid: process.pid }, null, 2) + "\\n");
const stop = () => { rmSync(armed, { force: true }); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 1_000);
`);
  if (process.platform === "win32") {
    await writeFile(fakeCodex, "@echo off\r\nexit /b 0\r\n");
  } else {
    await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n");
    await chmod(testLauncher, 0o755);
    await chmod(fakeCodex, 0o755);
  }

  const common = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-File", testLauncher,
      "-Room", room, "-Actor", "Codex/slow", "-SessionId", session, "-ThreadId", session,
      "-ConfigPath", config, "-StateRoot", state, "-RuntimePath", process.execPath,
      "-CodexPath", fakeCodex, "-LogPrefix", logPrefix]
    : ["--room", room, "--actor", "Codex/slow", "--session-id", session, "--thread-id", session,
      "--config", config, "--state", state, "--runtime", process.execPath,
      "--codex-bin", fakeCodex, "--log-prefix", logPrefix];
  const command = process.platform === "win32" ? "pwsh.exe" : testLauncher;
  const startedAt = Date.now();
  let result;
  try {
    result = await runFile(command, common, { env: environment, timeout: 25_000 });
  } catch (error) {
    const workerStderr = await readFile(`${logPrefix}.stderr.log`, "utf8").catch(() => "");
    if (workerStderr && typeof error === "object" && error !== null && "message" in error) {
      error.message += `\nWorker stderr:\n${workerStderr}`;
    }
    throw error;
  }
  const receipt = JSON.parse(result.stdout.trim());
  assert.ok(Date.now() - startedAt >= 10_000, "the fixture crosses the retired ten-second clock");
  assert.equal(receipt.armingTimeoutSeconds, 60, "the status line reports the bound used");
  assert.ok(receipt.watcherPid > 0, "the subscribed watch published its armed receipt");

  const stopArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-File", testLauncher,
      "-Room", room, "-SessionId", session, "-ThreadId", session,
      "-ConfigPath", config, "-StateRoot", state, "-Stop"]
    : ["--room", room, "--session-id", session, "--thread-id", session,
      "--config", config, "--state", state, "--stop"];
  await runFile(command, stopArgs, { env: environment, timeout: 10_000 });

  // Assert the reported seconds bind elapsed time, not a count of probes. On
  // POSIX, a deliberately slow sed makes the retired probe-count loop exceed
  // six seconds while the independent two-second deadline still refuses near
  // the bound it reports.
  let timeoutEnvironment = environment;
  if (process.platform !== "win32") {
    const shims = path.join(fixture.dir, "slow shims");
    const sedPath = (await runFile("sh", ["-c", "command -v sed"])).stdout.trim();
    await mkdir(shims, { recursive: true });
    await writeFile(path.join(shims, "sed"), `#!/bin/sh\nsleep 0.2\nexec "${sedPath}" "$@"\n`);
    await chmod(path.join(shims, "sed"), 0o755);
    timeoutEnvironment = { ...environment, PATH: `${shims}${path.delimiter}${process.env.PATH ?? ""}` };
  }
  const timeoutArgs = [...common,
    process.platform === "win32" ? "-ArmingTimeoutSeconds" : "--arming-timeout", "2"];
  // The first arm's watch also wrote this file; drop it so the assertion below can only be
  // satisfied by the worker the timed-out arm spawned.
  const startedPidFile = path.join(fixture.dir, `started-${room}.pid`);
  await rm(startedPidFile, { force: true });
  const timeoutStartedAt = Date.now();
  await assert.rejects(runFile(command, timeoutArgs, {
    env: timeoutEnvironment,
    timeout: 8_000,
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /subscribed armed receipt within 2 seconds/);
    return true;
  });
  const timeoutElapsed = Date.now() - timeoutStartedAt;
  assert.ok(timeoutElapsed >= 1_500, `two-second bound fired too early at ${timeoutElapsed} ms`);
  assert.ok(timeoutElapsed < 5_000, `two-second bound stretched to ${timeoutElapsed} ms`);

  // A timed-out arm leaves no worker behind. The watch was spawned and was mid-subscribe when
  // the launcher gave up; on Windows the worker shell's child does not die with the shell, and
  // one such orphan per suite run accumulated 75 fixture watches on a seat before this cell
  // measured it. Read the pid the watch recorded at its own start, then require it gone.
  const orphanPid = Number(await readFile(startedPidFile, "utf8"));
  assert.ok(orphanPid > 0, "the timed-out arm did spawn its watch (the launcher gave up after, not before)");
  const gone = async () => { try { process.kill(orphanPid, 0); return false; } catch (error) { return /** @type {any} */ (error).code === "ESRCH"; } };
  const reapDeadline = Date.now() + 3_000;
  while (!(await gone()) && Date.now() < reapDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(await gone(), `worker ${orphanPid} survived the launcher's arming timeout`);
});

test("Codex POSIX launcher gives macOS to launchd without weakening Linux detachment", async () => {
  const source = await readFile(launcher, "utf8");
  await access(launcher, constants.X_OK);
  assert.match(source, /launchctl bootstrap/);
  assert.match(source, /launchctl bootout/);
  assert.match(source, /plutil -insert ProgramArguments -array/);
  assert.match(source, /plutil -insert KeepAlive -bool false/);
  assert.match(source, /plutil -insert WorkingDirectory/);
  assert.match(source, /nohup setsid/);
  assert.doesNotMatch(source, /\beval\b/);
});

test("watch launcher recovers the managed server after Codex filters the TUI environment", {
  skip: process.platform === "darwin" ? "covered by the opt-in launchd lifecycle on macOS" : false,
  timeout: 30_000,
}, async (t) => {
  const fixture = await tmp();
  const state = path.join(fixture.dir, "state");
  const config = path.join(fixture.dir, "config.json");
  const scripts = path.join(fixture.dir, "scripts");
  const bin = path.join(fixture.dir, "bin");
  const tokenFile = path.join(state, "codex-control", "generation", "capability.token");
  const descriptor = path.join(state, "codex-control", "server.json");
  const capture = path.join(fixture.dir, "watch-argv.json");
  const logPrefix = path.join(fixture.dir, "managed-watch");
  const room = "managed-room";
  const session = `managed-${process.pid}`;
  const testLauncher = path.join(scripts, process.platform === "win32" ? "start-codex-watch.ps1" : "start-codex-watch.sh");
  const fakeCodex = path.join(fixture.dir, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
  const environment = {
    ...process.env,
    AGORA_CODEX_SERVER: "",
    AGORA_CODEX_TOKEN_FILE: "",
    AGORA_CODEX_MANAGED: "",
    CODEX_SESSION_ID: session,
    CODEX_THREAD_ID: session,
  };

  await mkdir(scripts, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await copyFile(process.platform === "win32" ? powershellLauncher : launcher, testLauncher);
  await writeFile(config, "{}");
  await writeFile(descriptor, '{"version":1}\n');
  await writeFile(tokenFile, "capability-value-never-in-argv");
  await writeFile(path.join(bin, "agora.mjs"), `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const verb = process.argv[2];
if (verb === "codex" && process.argv[3] === "status") {
  process.stdout.write(JSON.stringify({ type: "codex-server", running: true, endpoint: "ws://127.0.0.1:4567/", tokenFile: ${JSON.stringify(tokenFile)} }) + "\\n");
  process.exit(0);
}
if (verb !== "watch") process.exit(2);
const room = process.argv[3];
const armed = path.join(process.env.AGORA_STATE, "sessions", \`codex-\${process.env.CODEX_SESSION_ID}\`, "armed", \`\${room}.json\`);
mkdirSync(path.dirname(armed), { recursive: true });
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), remoteToken: process.env.AGORA_CODEX_REMOTE_AUTH_TOKEN ?? null }) + "\\n");
writeFileSync(armed, JSON.stringify({ room, pid: process.pid }, null, 2) + "\\n");
const stop = () => { rmSync(armed, { force: true }); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop); setInterval(() => {}, 1000);
`);
  if (process.platform === "win32") await writeFile(fakeCodex, "@echo off\r\nexit /b 0\r\n");
  else {
    await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n");
    await chmod(testLauncher, 0o755);
    await chmod(fakeCodex, 0o755);
  }

  const command = process.platform === "win32" ? "pwsh.exe" : testLauncher;
  const armArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-File", testLauncher, "-Room", room, "-Actor", "Codex/managed",
      "-SessionId", session, "-ThreadId", session, "-ConfigPath", config, "-StateRoot", state,
      "-RuntimePath", process.execPath, "-CodexPath", fakeCodex, "-LogPrefix", logPrefix]
    : ["--room", room, "--actor", "Codex/managed", "--session-id", session, "--thread-id", session,
      "--config", config, "--state", state, "--runtime", process.execPath, "--codex-bin", fakeCodex,
      "--log-prefix", logPrefix];
  const stopArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-File", testLauncher, "-Room", room, "-SessionId", session,
      "-ThreadId", session, "-ConfigPath", config, "-StateRoot", state, "-Stop"]
    : ["--room", room, "--session-id", session, "--thread-id", session, "--config", config, "--state", state, "--stop"];
  t.after(async () => {
    await runFile(command, stopArgs, { env: environment, timeout: 10_000 }).catch(() => {});
    await fixture.cleanup();
  });

  const started = await runFile(command, armArgs, { env: environment, timeout: 20_000 });
  assert.ok(JSON.parse(started.stdout).watcherPid > 0);
  const observed = JSON.parse(await readFile(capture, "utf8"));
  assert.ok(observed.args.includes("--codex-server"));
  assert.ok(observed.args.includes("ws://127.0.0.1:4567/"));
  assert.ok(observed.args.includes("--codex-token-file"));
  assert.ok(observed.args.includes(tokenFile));
  assert.equal(observed.args.includes("--codex-queue"), false);
  assert.equal(JSON.stringify(observed).includes("capability-value-never-in-argv"), false);
  assert.equal(observed.remoteToken, null);
});

test("managed Codex launchers refuse legacy queue fallback when the attachment is lost", {
  skip: process.platform === "darwin" ? "covered by the opt-in launchd lifecycle on macOS" : false,
}, async (t) => {
  const fixture = await tmp();
  const state = path.join(fixture.dir, "state");
  const config = path.join(fixture.dir, "config.json");
  const scripts = path.join(fixture.dir, "scripts");
  const bin = path.join(fixture.dir, "bin");
  const invoked = path.join(fixture.dir, "agora-invoked");
  const session = `managed-missing-${process.pid}`;
  const testLauncher = path.join(scripts, process.platform === "win32" ? "start-codex-watch.ps1" : "start-codex-watch.sh");
  const fakeCodex = path.join(fixture.dir, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");

  t.after(() => fixture.cleanup());
  await mkdir(scripts, { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(process.platform === "win32" ? powershellLauncher : launcher, testLauncher);
  await writeFile(config, "{}\n");
  await writeFile(path.join(bin, "agora.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(invoked)}, process.argv.join("\\n"));\n`);
  if (process.platform === "win32") await writeFile(fakeCodex, "@echo off\r\nexit /b 0\r\n");
  else {
    await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n");
    await chmod(testLauncher, 0o755);
    await chmod(fakeCodex, 0o755);
  }

  const command = process.platform === "win32" ? "pwsh.exe" : testLauncher;
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-File", testLauncher, "-Room", "managed-missing", "-Actor", "Codex/test",
      "-SessionId", session, "-ThreadId", session, "-ConfigPath", config, "-StateRoot", state,
      "-RuntimePath", process.execPath, "-CodexPath", fakeCodex]
    : ["--room", "managed-missing", "--actor", "Codex/test", "--session-id", session, "--thread-id", session,
      "--config", config, "--state", state, "--runtime", process.execPath, "--codex-bin", fakeCodex];
  const environment = {
    ...process.env,
    AGORA_CODEX_MANAGED: "1",
    AGORA_CODEX_SERVER: "",
    AGORA_CODEX_TOKEN_FILE: "",
    AGORA_CODEX_MANAGED: "",
    CODEX_SESSION_ID: session,
    CODEX_THREAD_ID: session,
  };

  await assert.rejects(runFile(command, args, { env: environment, timeout: 10_000 }), (/** @type {any} */ error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /session is managed[\s\S]*refusing legacy queue fallback/i);
    return true;
  });
  await assert.rejects(access(invoked), { code: "ENOENT" });
});

test("Codex POSIX launcher refuses an unsupported platform and Linux without setsid", {
  skip: process.platform === "win32" ? "requires a POSIX executable-script boundary" : false,
}, async (t) => {
  const fixture = await tmp();
  const shims = path.join(fixture.dir, "path shims");
  const state = path.join(fixture.dir, "state");
  const codex = path.join(fixture.dir, "fake codex");
  const logPrefix = path.join(fixture.dir, "watch");
  const session = `guard-test-${process.pid}`;
  const args = [
    "--room", "guard-test",
    "--actor", "Codex/test",
    "--session-id", session,
    "--thread-id", session,
    "--state", state,
    "--runtime", process.execPath,
    "--codex-bin", codex,
    "--log-prefix", logPrefix,
  ];

  t.after(() => fixture.cleanup());
  await mkdir(shims, { recursive: true });
  await writeFile(codex, "#!/bin/sh\nexit 0\n");
  await chmod(codex, 0o755);

  /** @param {string} name @param {string} body */
  const writeShim = async (name, body) => {
    const shim = path.join(shims, name);
    await writeFile(shim, `#!/bin/sh\n${body}\n`);
    await chmod(shim, 0o755);
  };

  await writeShim("uname", "printf '%s\\n' FreeBSD");
  await assert.rejects(runFile(launcher, args, {
    env: { ...process.env, PATH: `${shims}${path.delimiter}${process.env.PATH ?? ""}` },
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /unsupported on platform 'FreeBSD'; supported platforms are Linux and macOS/);
    return true;
  });

  await writeShim("uname", "printf '%s\\n' Linux");
  await writeShim("dirname", 'if [ "$1" = "--" ]; then shift; fi; case "$1" in */*) printf "%s\\n" "${1%/*}" ;; *) printf ".\\n" ;; esac');
  await writeShim("basename", 'if [ "$1" = "--" ]; then shift; fi; printf "%s\\n" "${1##*/}"');
  await assert.rejects(runFile(launcher, args, {
    env: { ...process.env, PATH: shims },
  }), (/** @type {any} */ error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /setsid is required to keep a Codex watch resident on Linux/);
    return true;
  });
});

const runLaunchdTest = process.platform === "darwin" && process.env.AGORA_TEST_LAUNCHD === "1";

test("macOS LaunchAgent survives the launcher and keeps exact lifecycle and arguments", {
  skip: runLaunchdTest ? false : "set AGORA_TEST_LAUNCHD=1 on macOS to exercise the real user LaunchAgent",
  timeout: 60_000,
}, async (t) => {
  const fixture = await tmp();
  const helpers = path.join(fixture.dir, "runtime & helpers");
  const state = path.join(fixture.dir, "state & literal $");
  const codexHome = path.join(fixture.dir, "codex home & literal $");
  const logs = path.join(fixture.dir, "logs & literal $");
  const config = path.join(fixture.dir, "config & literal $.toml");
  const runtime = path.join(helpers, "fake runtime");
  const codex = path.join(helpers, "fake codex");
  const capture = path.join(state, "capture.json");
  const sentinel = path.join(fixture.dir, "shell-injection-must-not-run");
  const session = `launchdtest-${process.pid}`;
  const thread = `thread-${process.pid}`;
  const room = "launchd fixture; still one argument";
  const bridgeRoom = "bridge";
  const actor = `Codex/watch; touch ${sentinel}`;
  const logPrefix = path.join(logs, "watch & literal $");
  const environment = { ...process.env, CODEX_HOME: codexHome, CODEX_SESSION_ID: session, CODEX_THREAD_ID: thread };

  await mkdir(helpers, { recursive: true });
  await writeFile(config, "[rooms]\n");
  await writeFile(codex, "#!/bin/sh\nexit 0\n");
  await chmod(codex, 0o755);
  await writeFile(runtime, `#!${process.execPath}
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const room = process.argv[4];
const session = process.env.CODEX_SESSION_ID;
const root = process.env.AGORA_STATE;
const armed = path.join(root, "sessions", \`codex-\${session}\`, "armed", \`\${room}.json\`);
mkdirSync(path.dirname(armed), { recursive: true });
writeFileSync(path.join(root, "capture.json"), JSON.stringify({
  actor: process.env.AGORA_ACTOR,
  config: process.env.AGORA_CONFIG,
  state: process.env.AGORA_STATE,
  codexHome: process.env.CODEX_HOME,
  args: process.argv.slice(2),
  pid: process.pid,
  ppid: process.ppid,
}) + "\\n");
// Publish readiness only after the observations consumed by the parent exist.
writeFileSync(armed, JSON.stringify({ room, pid: process.pid }, null, 2) + "\\n");
const stop = () => { rmSync(armed, { force: true }); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 1_000);
`);
  await chmod(runtime, 0o755);

  const lifecycleArgs = ["--room", room, "--state", state];
  const armArgs = [
    ...lifecycleArgs,
    "--actor", actor,
    "--config", config,
    "--runtime", runtime,
    "--codex-bin", codex,
    "--log-prefix", logPrefix,
    "--thread-interval", "137",
  ];
  /** @param {string[]} args */
  const run = async (args) => {
    try {
      const result = await runFile(launcher, args, { env: environment, timeout: 20_000 });
      return { ...result, json: JSON.parse(result.stdout.trim()) };
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const prefixIndex = args.indexOf("--log-prefix");
        const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : undefined;
        if (prefix) {
          const stderr = await readFile(`${prefix}.stderr.log`, "utf8").catch(() => "");
          if (stderr && "message" in error && typeof error.message === "string") {
            error.message += `\nLaunchAgent stderr:\n${stderr}`;
          }
        }
      }
      throw error;
    }
  };

  t.after(async () => {
    for (const cleanupRoom of [room, bridgeRoom]) {
      await runFile(launcher, ["--room", cleanupRoom, "--state", state, "--stop"], { env: environment, timeout: 10_000 }).catch(() => {});
    }
    await fixture.cleanup();
  });

  const armed = await run(armArgs);
  assert.equal(armed.json.watcherPid, armed.json.supervisorPid);
  assert.equal(armed.json.actor, actor);
  assert.equal(armed.json.stdout, `${logPrefix}.stdout.log`);
  assert.equal(armed.json.stderr, `${logPrefix}.stderr.log`);
  await access(`${logPrefix}.stdout.log`);
  await access(`${logPrefix}.stderr.log`);

  const firstPid = armed.json.watcherPid;
  const observed = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(observed.pid, firstPid);
  assert.equal(observed.ppid, 1, "launchd, not the completed launcher command, owns the worker");
  assert.equal(observed.actor, actor);
  assert.equal(observed.config, config);
  assert.equal(observed.state, state);
  assert.equal(observed.codexHome, codexHome);
  assert.deepEqual(observed.args, [
    path.join(repoRoot, "bin", "agora.mjs"),
    "watch", room, "--stream", "--follow", "--json", "--wake", "addressed",
    "--thread-interval", "137", "--coalesce", "20", "--codex-queue", "--codex-thread", thread, "--codex-bin", codex,
  ]);
  await assert.rejects(access(sentinel), { code: "ENOENT" });

  const status = await run([...lifecycleArgs, "--status"]);
  assert.deepEqual(
    { watcherPid: status.json.watcherPid, supervisorPid: status.json.supervisorPid, alive: status.json.alive },
    { watcherPid: firstPid, supervisorPid: firstPid, alive: true },
  );

  await assert.rejects(run(armArgs), (/** @type {any} */ error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /live watch already holds/);
    return true;
  });
  const afterDuplicate = await run([...lifecycleArgs, "--status"]);
  assert.equal(afterDuplicate.json.watcherPid, firstPid);

  const forced = await run([...armArgs, "--force"]);
  assert.notEqual(forced.json.watcherPid, firstPid);
  assert.equal(forced.json.watcherPid, forced.json.supervisorPid);
  assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" });

  const stopped = await run([...lifecycleArgs, "--stop"]);
  assert.equal(stopped.json.stopped, true);
  assert.equal(stopped.json.watcherPid, forced.json.watcherPid);
  assert.equal(stopped.json.supervisorPid, forced.json.watcherPid);
  assert.throws(() => process.kill(forced.json.watcherPid, 0), { code: "ESRCH" });
  const finalStatus = await run([...lifecycleArgs, "--status"]);
  assert.deepEqual(
    { watcherPid: finalStatus.json.watcherPid, supervisorPid: finalStatus.json.supervisorPid, alive: finalStatus.json.alive },
    { watcherPid: null, supervisorPid: null, alive: false },
  );
  const launchdFiles = await readdir(path.join(state, "sessions", `codex-${session}`, "launchd"));
  assert.deepEqual(launchdFiles, []);

  const roomFile = path.join(fixture.dir, "room & literal $.ndjson");
  const queueCapture = path.join(fixture.dir, "codex queue.json");
  await writeFile(config, JSON.stringify({
    actor: { name: "Fixture sender", kind: "agent" },
    rooms: {
      [bridgeRoom]: { transport: "local", path: roomFile, interval: 0.1, pollBudget: 1_000 },
    },
  }));
  await writeFile(codex, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(queueCapture)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
  await chmod(codex, 0o755);

  const bridgeArgs = [
    "--room", bridgeRoom,
    "--actor", "Codex/watch",
    "--config", config,
    "--state", state,
    "--runtime", process.execPath,
    "--codex-bin", codex,
    "--log-prefix", path.join(logs, "bridge & literal $"),
  ];
  const rolloutDir = path.join(codexHome, "sessions", "2026", "09", "04");
  const writerDir = path.join(codexHome, "thread-writer-locks");
  await mkdir(rolloutDir, { recursive: true });
  await mkdir(writerDir, { recursive: true });
  await writeFile(path.join(rolloutDir, `rollout-fixture-${thread}.jsonl`), "");
  const writer = await open(path.join(writerDir, `${thread}.lock`), "w");
  t.after(() => writer.close());
  const bridge = await run(bridgeArgs);
  assert.equal(bridge.json.watcherPid, bridge.json.supervisorPid);

  await runFile(process.execPath, [
    path.join(repoRoot, "bin", "agora.mjs"),
    "post", bridgeRoom, "launchd addressed wake probe", "--to", "Codex/watch",
  ], {
    env: {
      ...process.env,
      AGORA_CONFIG: config,
      AGORA_STATE: state,
      AGORA_ACTOR: "Fixture/sender",
      CODEX_SESSION_ID: `sender-${process.pid}`,
      CODEX_THREAD_ID: `sender-thread-${process.pid}`,
    },
    timeout: 10_000,
  });

  /** @type {any[] | undefined} */
  let queued;
  for (let i = 0; i < 50; i++) {
    try {
      const last = (await readFile(queueCapture, "utf8")).trim().split(/\r?\n/).at(-1);
      if (!last) throw new Error("no queued call yet");
      queued = JSON.parse(last);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(queued, "the addressed room message reached codex queue");
  assert.deepEqual(queued.slice(0, 3), ["queue", "--thread", thread]);
  assert.equal(queued[3], "--message");
  assert.match(queued[4], /^\[Agora delivery; room bridge; cursor 1; from Fixture\/sender\]/);
  assert.match(queued[4], /launchd addressed wake probe/);

  const bridgeStatus = await run(["--room", bridgeRoom, "--state", state, "--status"]);
  assert.deepEqual(
    { watcherPid: bridgeStatus.json.watcherPid, supervisorPid: bridgeStatus.json.supervisorPid, alive: bridgeStatus.json.alive },
    { watcherPid: bridge.json.watcherPid, supervisorPid: bridge.json.watcherPid, alive: true },
  );
  const doctor = await runFile(process.execPath, [path.join(repoRoot, "bin", "agora.mjs"), "doctor", "--offline", "--json"], {
    env: { ...environment, AGORA_CONFIG: config, AGORA_STATE: state, AGORA_CODEX_BIN: codex },
    timeout: 10_000,
  });
  const doctorRows = doctor.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const currentSession = doctorRows.find((row) => row.type === "session" && row.slug === `codex-${session}`);
  assert.deepEqual(
    currentSession.armed.map((/** @type {any} */ record) => ({
      key: record.key,
      room: record.room,
      mode: record.mode,
      pid: record.pid,
    })),
    [{ key: bridgeRoom, room: bridgeRoom, mode: "stream", pid: bridge.json.watcherPid }],
  );
  assert.equal(currentSession.armed[0].build.version, "0.1.0");
  assert.match(currentSession.armed[0].build.git, /^[0-9a-f]{40}$/);
  assert.equal(doctorRows.find((row) => row.type === "poll-rate")?.watches, 1);

  const bridgeStopped = await run(["--room", bridgeRoom, "--state", state, "--stop"]);
  assert.equal(bridgeStopped.json.stopped, true);
  assert.equal(bridgeStopped.json.watcherPid, bridge.json.watcherPid);
});

test("Linux launcher: --status reports this arm's ending only, never an earlier arm's line from the appended log", {
  skip: process.platform !== "linux" ? "the nohup/setsid path is Linux" : false,
  timeout: 60_000,
}, async (t) => {
  const fixture = await tmp();
  const helpers = path.join(fixture.dir, "runtime & helpers");
  const state = path.join(fixture.dir, "state");
  const codexHome = path.join(fixture.dir, "codex home");
  const logs = path.join(fixture.dir, "logs");
  const config = path.join(fixture.dir, "config.toml");
  const codex = path.join(helpers, "fake codex");
  const session = `twicetest-${process.pid}`;
  const thread = `thread-${process.pid}`;
  const room = "twice";
  const actor = "Codex/twice";
  const logPrefix = path.join(logs, "watch");
  const environment = { ...process.env, CODEX_HOME: codexHome, CODEX_SESSION_ID: session, CODEX_THREAD_ID: thread };
  await mkdir(helpers, { recursive: true });
  await writeFile(config, "[rooms]\n");
  await writeFile(codex, "#!/bin/sh\nexit 0\n");
  await chmod(codex, 0o755);
  // A fake runtime that arms, prints the line named by RUNTIME_LINE to stdout, lingers long enough
  // for the launcher to see it alive, and exits: arm one ends "dark", arm two ends normally.
  const runtime = path.join(helpers, "fake runtime");
  await writeFile(runtime, `#!${process.execPath}
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const room = process.argv[4];
const armed = path.join(process.env.AGORA_STATE, "sessions", \`codex-\${process.env.CODEX_SESSION_ID}\`, "armed", \`\${room}.json\`);
mkdirSync(path.dirname(armed), { recursive: true });
writeFileSync(armed, JSON.stringify({ room, pid: process.pid }, null, 2) + "\\n");
process.stdout.write(process.env.RUNTIME_LINE + "\\n");
setTimeout(() => { rmSync(armed, { force: true }); process.exit(1); }, 1500);
`);
  await chmod(runtime, 0o755);
  const lifecycleArgs = ["--room", room, "--state", state];
  const armArgs = [...lifecycleArgs, "--actor", actor, "--config", config, "--runtime", runtime, "--codex-bin", codex, "--log-prefix", logPrefix, "--thread-interval", "137"];
  /** @param {string[]} args @param {Record<string, string>} extra */
  const run = async (args, extra = {}) => {
    const result = await runFile(launcher, args, { env: { ...environment, ...extra }, timeout: 20_000 });
    return JSON.parse(result.stdout.trim());
  };
  t.after(async () => {
    await runFile(launcher, [...lifecycleArgs, "--stop"], { env: environment, timeout: 10_000 }).catch(() => {});
    await fixture.cleanup();
  });
  const dark = JSON.stringify({ type: "watch-ended", reason: "service-dark", re_arm: "agora watch twice", pid: 0 });
  const one = await run(armArgs, { RUNTIME_LINE: dark });
  await new Promise((r) => setTimeout(r, 2500));
  const afterOne = await run([...lifecycleArgs, "--log-prefix", logPrefix, "--status"]);
  assert.equal(afterOne.alive, false);
  assert.equal(afterOne.ended?.reason, "service-dark", "arm one ended dark and --status says so");
  const normal = JSON.stringify({ type: "watch-result", exit: 0 });
  const two = await run(armArgs, { RUNTIME_LINE: normal });
  assert.notEqual(two.watcherPid, one.watcherPid);
  await new Promise((r) => setTimeout(r, 2500));
  const afterTwo = await run([...lifecycleArgs, "--log-prefix", logPrefix, "--status"]);
  assert.equal(afterTwo.alive, false);
  assert.equal(afterTwo.ended, null, `arm two ended normally; a stale line from arm one must not be reported: ${JSON.stringify(afterTwo.ended)}`);
  const log = await readFile(`${logPrefix}.stdout.log`, "utf8");
  assert.doesNotMatch(log, /service-dark/, "the log was truncated at the second arm");
});
