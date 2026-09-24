// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensurePaneAuthority, openPane, paneAlive, paneHelloProof, paneSockPath, reapPane, resolveBunBin } from "../src/spawn-pane.mjs";

const NONCE = "ab".repeat(16);
const CHALLENGE = "cd".repeat(16);
const SPAWN_ID = "11".repeat(16);

/** @param {net.Server} server @param {string} endpoint */
function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: endpoint, exclusive: true }, () => { server.off("error", reject); resolve(undefined); });
  });
}

test("openPane proves hello with HMAC of the challenge under pane.nonce; open carries no cmd", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-spawn-pane-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "native"), { recursive: true });
  await writeFile(path.join(root, "native", "pane.nonce"), NONCE);
  const sock = paneSockPath(root);
  /** @type {Record<string, unknown>[]} */
  const seen = [];
  /** @type {(value?: unknown) => void} */
  let done;
  const gotTwo = new Promise((resolve) => { done = resolve; });
  const server = net.createServer((socket) => {
    socket.write(`${JSON.stringify({ type: "hello", bootEpoch: 7, challenge: CHALLENGE })}\n`);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        seen.push(frame);
        if (frame.type === "hello" && !frame.proof) {
          socket.write(`${JSON.stringify({ type: "error", error: "unproven hello" })}\n`);
        }
        if (seen.length >= 2) done();
      }
    });
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  await listen(server, sock);
  await openPane(sock, SPAWN_ID, root);
  await Promise.race([gotTwo, once(server, "error")]);
  assert.equal(seen[0]?.type, "hello");
  assert.equal(seen[0].bootEpoch, 7);
  assert.equal(seen[0].proof, paneHelloProof(NONCE, 7, CHALLENGE));
  assert.equal(seen[0].proof, createHmac("sha256", NONCE).update(`pane-hello:7:${CHALLENGE}`).digest("hex"));
  assert.equal("challenge" in seen[0], false, "the nonce never rides the wire; neither does the server challenge echo");
  assert.equal(seen[1]?.type, "open");
  assert.equal(seen[1].spawnId, SPAWN_ID);
  assert.equal("cmd" in seen[1], false);
});

test("reapPane kills the recorded pid", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const pid = child.pid;
  assert.equal(typeof pid, "number");
  assert.equal(paneAlive(pid), true);
  await reapPane(pid);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && paneAlive(pid)) await new Promise((r) => setTimeout(r, 50));
  assert.equal(paneAlive(pid), false);
});

test("ensurePaneAuthority pid is gone after reapPane", {
  skip: resolveBunBin() ? false : "no bun at BUN or ~/.bun/bin",
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-pane-reap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pane = await ensurePaneAuthority(root);
  assert.equal(typeof pane.pid, "number");
  assert.equal(paneAlive(pane.pid), true);
  t.after(() => reapPane(pane.pid));
  await reapPane(pane.pid);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && paneAlive(pane.pid)) await new Promise((r) => setTimeout(r, 50));
  assert.equal(paneAlive(pane.pid), false);
});

test("pane exits when its parent is gone", {
  skip: resolveBunBin() ? false : "no bun at BUN or ~/.bun/bin",
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-pane-pdeath-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawnPane = pathToFileURL(fileURLToPath(new URL("../src/spawn-pane.mjs", import.meta.url))).href;
  const script = path.join(root, "parent.mjs");
  await writeFile(script, `import { ensurePaneAuthority } from ${JSON.stringify(spawnPane)};
const pane = await ensurePaneAuthority(process.env.AGORA_STATE);
process.stdout.write(JSON.stringify({ pid: pane.pid }) + "\\n");
setInterval(() => {}, 1000);
`);
  const parent = spawn(process.execPath, [script], {
    env: { ...process.env, AGORA_STATE: root },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const parentPid = parent.pid;
  t.after(() => { try { if (parentPid) process.kill(parentPid); } catch { /* gone */ } });
  /** @type {string[]} */
  const errChunks = [];
  parent.stderr.on("data", (chunk) => { errChunks.push(chunk.toString("utf8")); });
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`parent stayed silent: ${errChunks.join("")}`)), 8000);
    parent.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(chunk.toString("utf8"));
    });
    parent.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`parent exited ${code}: ${errChunks.join("")}`));
    });
  });
  const { pid: panePid } = JSON.parse(line.trim().split("\n")[0]);
  assert.equal(typeof panePid, "number");
  assert.equal(paneAlive(panePid), true);
  if (typeof parentPid !== "number") throw new Error("parent pid missing");
  if (process.platform === "win32") {
    // Await taskkill: under a loaded full-suite run it can take seconds to start, and an
    // unawaited kill spent the whole liveness window before the parent was even gone.
    await new Promise((resolve) => {
      const k = spawn("taskkill", ["/PID", String(parentPid), "/F"], { stdio: "ignore", windowsHide: true });
      k.once("exit", resolve);
      k.once("error", resolve);
    });
  } else {
    process.kill(parentPid, "SIGKILL");
  }
  // The pane polls its parent every 250 ms; the window is that plus scheduling slack under load.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && paneAlive(panePid)) await new Promise((r) => setTimeout(r, 50));
  assert.equal(paneAlive(panePid), false);
});

test("echoing bootEpoch is not a proven hello", () => {
  const echo = { type: "hello", bootEpoch: 7 };
  assert.equal("proof" in echo, false);
  const proof = paneHelloProof(NONCE, 7, CHALLENGE);
  assert.match(proof, /^[a-f0-9]{64}$/);
  assert.notEqual(proof, String(echo.bootEpoch));
});
