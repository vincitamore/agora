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
 * @param {{ root: string, accountId: string, seatLabel: string, build?: import("./harness.mjs").BuildIdentity }} options
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

/** The public node key exactly as the remote's `enroll` prints it. There is deliberately no flag
 * anywhere that takes a private key or a bare digest: `route open` admits a principal by the key
 * the room's enrollment record published, and the absence of any other input is the enforcement. */
const PUBLIC_NODE_KEY_RE = /^nodekey:[a-f0-9]{64}$/;

/** @param {unknown} value @param {string} flag */
function readPublicNodeKey(value, flag) {
  const key = value === undefined ? "" : String(value).trim();
  if (!PUBLIC_NODE_KEY_RE.test(key))
    throw new AgoraError(`${flag} takes the public node key as enroll prints it: nodekey: followed by 64 hex characters`, EXIT.usage);
  return key;
}

/** @param {unknown} value */
function readRouteRoomId(value) {
  const roomId = value === undefined ? "" : String(value).trim();
  if (!ROOM_ID_RE.test(roomId))
    throw new AgoraError("native room id must be 32 lowercase hexadecimal characters", EXIT.usage);
  return roomId;
}

/**
 * Admit one enrolled key to one room over a Tailcat member route.
 *
 * The route belongs to the seat SERVICE, not to this process: its resources are fenced to the
 * service's own lifetime, so a listener started here would die when this verb exits. This is a
 * request to the running service, the way `service room create` is.
 * @param {string} stateRoot @param {unknown} roomId @param {unknown} publicNodeKey
 */
export async function openServiceRoute(stateRoot, roomId, publicNodeKey) {
  const room = readRouteRoomId(roomId);
  const key = readPublicNodeKey(publicNodeKey, "--allow-key");
  const { client } = await connectSeatService(stateRoot);
  try {
    return await client.request("route-open", { roomId: room, publicNodeKey: key });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/route-already-open/.test(message)) throw new AgoraError(message, EXIT.error);
    throw e;
  } finally {
    client.close();
  }
}

/** Live routes, read from the service's own registry. A service restart drops every route.
 * @param {string} stateRoot */
export async function listServiceRoutes(stateRoot) {
  const { client } = await connectSeatService(stateRoot);
  try {
    const result = await client.request("route-list", {});
    return Array.isArray(result.routes) ? result.routes : [];
  } finally {
    client.close();
  }
}

/**
 * Revoke one route. Nothing runs on the remote, so its copy of the secret goes stale and fails
 * the proof by name; a reopen mints a new generation whose descriptor and secret travel by hand.
 * @param {string} stateRoot @param {unknown} roomId @param {unknown} publicNodeKey
 */
export async function closeServiceRoute(stateRoot, roomId, publicNodeKey) {
  const room = readRouteRoomId(roomId);
  const key = readPublicNodeKey(publicNodeKey, "--allow-key");
  const { client } = await connectSeatService(stateRoot);
  try {
    return await client.request("route-close", { roomId: room, publicNodeKey: key });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/route-not-open/.test(message)) throw new AgoraError(message, EXIT.error);
    throw e;
  } finally {
    client.close();
  }
}

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
