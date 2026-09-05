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
import { serviceDescriptorPath, serviceDescriptorStatus } from "./wake/subscriber.mjs";

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
 * @param {{ root: string, entry: string, execPath: string, accountId: string, seatLabel: string }} options
 */
export async function startService(options) {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const status = await serviceDescriptorStatus(options.root);
  if (status.present && status.pidAlive) {
    throw new AgoraError(`native service already running (pid ${status.pid})`, EXIT.error);
  }
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
    const next = await serviceDescriptorStatus(options.root);
    if (next.present && next.pidAlive) return next;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new AgoraError("native service did not publish a live descriptor", EXIT.error);
}

/** @param {string} stateRoot */
export async function stopService(stateRoot) {
  const status = await serviceDescriptorStatus(stateRoot);
  if (!status.present) throw new AgoraError(`native service absent (${status.error ?? "no descriptor"})`, EXIT.error);
  const pid = status.pid;
  if (pid && pidAlive(pid)) {
    const sig = process.platform === "win32" ? "SIGKILL" : "SIGTERM";
    try { process.kill(pid, sig); } catch { /* already gone */ }
    const deadline = Date.now() + STOP_MS;
    while (Date.now() < deadline && pidAlive(pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (pidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  const after = await serviceDescriptorStatus(stateRoot);
  if (after.present && after.pidAlive) {
    throw new AgoraError(`native service still running (pid ${after.pid})`, EXIT.error);
  }
  if (after.present) await rm(serviceDescriptorPath(stateRoot), { force: true });
  return serviceDescriptorStatus(stateRoot);
}
