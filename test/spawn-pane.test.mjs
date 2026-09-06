// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { openPane, paneHelloProof, paneSockPath } from "../src/spawn-pane.mjs";

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

test("echoing bootEpoch is not a proven hello", () => {
  const echo = { type: "hello", bootEpoch: 7 };
  assert.equal("proof" in echo, false);
  const proof = paneHelloProof(NONCE, 7, CHALLENGE);
  assert.match(proof, /^[a-f0-9]{64}$/);
  assert.notEqual(proof, String(echo.bootEpoch));
});
