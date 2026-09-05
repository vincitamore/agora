// @ts-check
/**
 * Seat-service supervisor: start, stop, status. The live authority is NativeRoomService.
 * Shared config is never written here.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { AgoraError, EXIT } from "./core.mjs";
import { NativeRoomService } from "./native-service.mjs";
import { pidAlive } from "./session.mjs";
import { connectSeatService, serviceDescriptorPath, serviceDescriptorStatus } from "./wake/subscriber.mjs";

const STOP_MS = 5000;

/** @param {string} root */
export async function seatAccountId(root) {
  const physicalRoot = await realpath(path.resolve(root));
  const key = process.platform === "win32" ? physicalRoot.toLowerCase() : physicalRoot;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** @param {string} [label] */
export function seatLabel(label) {
  const raw = (label ?? hostname() ?? "seat").trim() || "seat";
  return raw.slice(0, 120);
}

/** @param {string} stateRoot */
export async function serviceStatus(stateRoot) {
  return serviceDescriptorStatus(stateRoot);
}

/**
 * Run the service in this process until SIGTERM/SIGINT. Used by the supervisor child.
 * @param {{ root: string, accountId: string, seatLabel: string }} options
 */
export async function runService(options) {
  const service = new NativeRoomService(options);
  const descriptor = await service.start();
  const halt = async () => {
    await service.stop();
    process.exitCode = 0;
  };
  process.on("SIGTERM", () => { void halt(); });
  process.on("SIGINT", () => { void halt(); });
  return descriptor;
}

/**
 * Handshake the published endpoint. Success means this descriptor names OUR service.
 * Failure means the file is stale: a recycled pid is not identity.
 * @param {string} stateRoot
 * @returns {Promise<{ live: true, pid?: number } | { live: false }>}
 */
async function probeOwnService(stateRoot) {
  try {
    const { client, descriptor } = await connectSeatService(stateRoot);
    client.close();
    return { live: true, pid: typeof descriptor.pid === "number" ? descriptor.pid : undefined };
  } catch {
    return { live: false };
  }
}

/** @param {string} stateRoot */
async function unlinkDescriptor(stateRoot) {
  await rm(serviceDescriptorPath(stateRoot), { force: true });
}

/**
 * @param {{ root: string, entry: string, execPath: string, accountId: string, seatLabel: string }} options
 */
export async function startService(options) {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const probe = await probeOwnService(options.root);
  if (probe.live) {
    throw new AgoraError(`native service already running (pid ${probe.pid ?? "unknown"})`, EXIT.error);
  }
  await unlinkDescriptor(options.root);
  const child = spawn(options.execPath, [options.entry, "service", "--daemon"], {
    env: {
      ...process.env,
      AGORA_STATE: options.root,
      AGORA_SERVICE_ACCOUNT: options.accountId,
      AGORA_SERVICE_LABEL: options.seatLabel,
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + STOP_MS;
  while (Date.now() < deadline) {
    const next = await probeOwnService(options.root);
    if (next.live) return serviceDescriptorStatus(options.root);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new AgoraError("native service did not publish a live descriptor", EXIT.error);
}

/** @param {string} stateRoot */
export async function stopService(stateRoot) {
  const probe = await probeOwnService(stateRoot);
  if (!probe.live) {
    await unlinkDescriptor(stateRoot);
    return serviceDescriptorStatus(stateRoot);
  }
  const pid = probe.pid ?? 0;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new AgoraError("native service is live at the endpoint but the descriptor has no pid; not killing by guess", EXIT.error);
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  const deadline = Date.now() + STOP_MS;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  const still = await probeOwnService(stateRoot);
  if (still.live) throw new AgoraError(`native service still running (pid ${still.pid})`, EXIT.error);
  await unlinkDescriptor(stateRoot);
  return serviceDescriptorStatus(stateRoot);
}

const ROOM_ID_RE = /^[a-f0-9]{32}$/;

/**
 * Mint a native room on the running service. Never writes the shared config.
 * @param {string} stateRoot
 * @param {string} [roomId]
 */
export async function createServiceRoom(stateRoot, roomId) {
  if (roomId !== undefined && !ROOM_ID_RE.test(roomId)) {
    throw new AgoraError("native room id must be 32 lowercase hexadecimal characters", EXIT.usage);
  }
  const { client } = await connectSeatService(stateRoot);
  try {
    const result = await client.request("create-room", roomId ? { roomId } : {});
    const minted = typeof result.roomId === "string" ? result.roomId : "";
    if (!ROOM_ID_RE.test(minted)) throw new AgoraError("native service did not return a minted room id", EXIT.error);
    return minted;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/already exists|already open/i.test(message)) throw new AgoraError(message, EXIT.error);
    throw e;
  } finally {
    client.close();
  }
}
