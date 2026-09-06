// @ts-check
/**
 * Lazy pane-authority start and one open frame. The root CLI never imports spawn/.
 * The seat service starts the authority on first spawn.
 */
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgoraError, EXIT } from "./core.mjs";

export const PANE_PACKAGE = fileURLToPath(new URL("../spawn/", import.meta.url));

/** @param {string} stateRoot */
export function paneSockPath(stateRoot) {
  if (process.platform === "win32") {
    const seat = createHash("sha256").update(path.resolve(stateRoot).toLowerCase()).digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\agora-pane-${seat}`;
  }
  return path.join(stateRoot, "native", "pane.sock");
}

/** @returns {string} */
export function mintSpawnId() {
  return randomUUID().replaceAll("-", "");
}

function bunBin() {
  return process.env.BUN || "bun";
}

/**
 * @param {string} sock
 * @returns {Promise<net.Socket>}
 */
async function connectPane(sock) {
  const socket = net.createConnection({ path: sock });
  await Promise.race([
    once(socket, "connect"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);
  return socket;
}

/**
 * @param {net.Socket} socket
 * @returns {Promise<string>}
 */
function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (/** @type {Buffer} */ chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      cleanup();
      resolve(buf.slice(0, nl).trim());
    };
    const onError = (/** @type {Error} */ error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/**
 * @param {string} stateRoot
 */
/** @param {string} stateRoot @returns {Promise<{ sock: string, pid?: number }>} */
export async function ensurePaneAuthority(stateRoot) {
  const sock = paneSockPath(stateRoot);
  try {
    const probe = await connectPane(sock);
    probe.destroy();
    return { sock };
  } catch {
    /* start */
  }
  if (!existsSync(path.join(PANE_PACKAGE, "package.json"))) {
    throw new AgoraError(`pane-package-absent: ${PANE_PACKAGE} (bun install in spawn/)`, EXIT.error);
  }
  const child = spawn(bunBin(), ["run", "listen.ts"], {
    cwd: PANE_PACKAGE,
    env: { ...process.env, AGORA_STATE: stateRoot, AGORA_PANE_SOCK: sock },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const probe = await connectPane(sock);
      probe.destroy();
      return { sock, pid: typeof child.pid === "number" ? child.pid : undefined };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new AgoraError("pane-package-absent: pane.sock did not come up", EXIT.error);
}

/** HMAC-SHA256 of the hello transcript. The nonce never rides the wire. Root CLI never imports spawn/. */
export function paneHelloProof(nonce, bootEpoch, challenge) {
  return createHmac("sha256", nonce).update(`pane-hello:${bootEpoch}:${challenge}`).digest("hex");
}

/**
 * @param {string} sock
 * @param {string} spawnId
 * @param {string} stateRoot
 */
export async function openPane(sock, spawnId, stateRoot) {
  let nonce;
  try {
    nonce = (await readFile(path.join(stateRoot, "native", "pane.nonce"), "utf8")).trim();
  } catch {
    throw new AgoraError("pane nonce is absent; the authority never wrote native/pane.nonce", EXIT.error);
  }
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new AgoraError("pane nonce is unusable", EXIT.error);
  const socket = await connectPane(sock);
  try {
    const helloLine = await readLine(socket);
    const hello = JSON.parse(helloLine);
    if (
      hello.type !== "hello"
      || !Number.isInteger(hello.bootEpoch)
      || typeof hello.challenge !== "string"
      || hello.challenge.length < 16
    ) {
      throw new AgoraError("pane authority hello was not challenge-bound", EXIT.error);
    }
    const proof = paneHelloProof(nonce, hello.bootEpoch, hello.challenge);
    socket.write(`${JSON.stringify({ type: "hello", bootEpoch: hello.bootEpoch, proof })}\n`);
    socket.write(`${JSON.stringify({ type: "open", spawnId })}\n`);
    const maybe = await Promise.race([
      readLine(socket),
      new Promise((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    if (typeof maybe === "string" && maybe) {
      const parsed = JSON.parse(maybe);
      if (parsed.type === "error") throw new AgoraError(String(parsed.error ?? "pane open refused"), EXIT.error);
    }
  } finally {
    socket.end();
  }
}
