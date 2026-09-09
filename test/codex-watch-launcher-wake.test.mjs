// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { tmp } from "./helpers.mjs";

const runFile = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const win32 = process.platform === "win32";
const sourceLauncher = path.join(repoRoot, "scripts", win32 ? "start-codex-watch.ps1" : "start-codex-watch.sh");

// The launcher's --wake / -Wake reaches the watch it arms. Tested on the wire: a fake agora
// records the argv it was started with, so a launcher that drops or ignores the option reddens
// the assertion on the recorded array, not on the launcher's own output.
test("Codex launcher passes --wake through to the armed watch and refuses an unknown mode", {
  skip: process.platform === "darwin" ? "the launchd lifecycle has its own opt-in integration cell" : false,
  timeout: 60_000,
}, async (t) => {
  const fixture = await tmp();
  const state = path.join(fixture.dir, "state");
  const config = path.join(fixture.dir, "config.json");
  const fixtureScripts = path.join(fixture.dir, "scripts");
  const fixtureBin = path.join(fixture.dir, "bin");
  const testLauncher = path.join(fixtureScripts, path.basename(sourceLauncher));
  const fakeCodex = path.join(fixture.dir, win32 ? "fake-codex.cmd" : "fake-codex");
  const argvFile = path.join(fixture.dir, "argv.json");
  const session = `wake-${process.pid}`;
  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    ...process.env,
    AGORA_CODEX_SERVER: "",
    AGORA_CODEX_TOKEN_FILE: "",
    CODEX_SESSION_ID: session,
    CODEX_THREAD_ID: session,
  };

  t.after(() => fixture.cleanup());
  await mkdir(fixtureScripts, { recursive: true });
  await mkdir(fixtureBin, { recursive: true });
  await copyFile(sourceLauncher, testLauncher);
  await writeFile(config, "{}");
  await writeFile(path.join(fixtureBin, "agora.mjs"), `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const room = process.argv[3];
const armed = path.join(process.env.AGORA_STATE, "sessions", \`codex-\${process.env.CODEX_SESSION_ID}\`, "armed", \`\${room}.json\`);
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
mkdirSync(path.dirname(armed), { recursive: true });
writeFileSync(armed, JSON.stringify({ room, pid: process.pid }, null, 2) + "\\n");
const stop = () => { rmSync(armed, { force: true }); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 1_000);
`);
  if (win32) {
    await writeFile(fakeCodex, "@echo off\r\nexit /b 0\r\n");
  } else {
    await writeFile(fakeCodex, "#!/bin/sh\nexit 0\n");
    await chmod(testLauncher, 0o755);
    await chmod(fakeCodex, 0o755);
  }

  const command = win32 ? "pwsh.exe" : testLauncher;
  /** @param {string} room @param {string[]} extra */
  const armArgs = (room, extra) => win32
    ? ["-NoProfile", "-NonInteractive", "-File", testLauncher,
      "-Room", room, "-Actor", "Codex/wake", "-SessionId", session, "-ThreadId", session,
      "-ConfigPath", config, "-StateRoot", state, "-RuntimePath", process.execPath,
      "-CodexPath", fakeCodex, "-LogPrefix", path.join(fixture.dir, room), ...extra]
    : ["--room", room, "--actor", "Codex/wake", "--session-id", session, "--thread-id", session,
      "--config", config, "--state", state, "--runtime", process.execPath,
      "--codex-bin", fakeCodex, "--log-prefix", path.join(fixture.dir, room), ...extra];
  /** @param {string} room */
  const stopArgs = (room) => win32
    ? ["-NoProfile", "-NonInteractive", "-File", testLauncher,
      "-Room", room, "-SessionId", session, "-ThreadId", session, "-ConfigPath", config, "-StateRoot", state, "-Stop"]
    : ["--room", room, "--session-id", session, "--thread-id", session, "--config", config, "--state", state, "--stop"];
  const wakeFlag = win32 ? "-Wake" : "--wake";

  /** @param {string} room @param {string[]} extra */
  const armAndRead = async (room, extra) => {
    const result = await runFile(command, armArgs(room, extra), { env: environment, timeout: 25_000 });
    const receipt = JSON.parse(result.stdout.trim());
    assert.ok(receipt.watcherPid > 0, `${room}: the watch published its armed receipt`);
    /** @type {string[]} */
    const argv = JSON.parse(await readFile(argvFile, "utf8"));
    await runFile(command, stopArgs(room), { env: environment, timeout: 10_000 });
    return argv;
  };

  const explicit = await armAndRead("wake-mine", [wakeFlag, "mine"]);
  assert.equal(explicit[explicit.indexOf("--wake") + 1], "mine", `the watch was armed with the requested mode: ${explicit.join(" ")}`);

  const byDefault = await armAndRead("wake-default", []);
  assert.equal(byDefault[byDefault.indexOf("--wake") + 1], "addressed", `the default stays addressed: ${byDefault.join(" ")}`);

  await assert.rejects(
    runFile(command, armArgs("wake-bogus", [wakeFlag, "everyone"]), { env: environment, timeout: 25_000 }),
    (/** @type {any} */ error) => {
      assert.notEqual(error.code, 0, "an unknown wake mode is refused before any worker starts");
      assert.match(String(error.stderr), /all|addressed|mine/, "the refusal names the accepted modes");
      return true;
    },
  );
});
