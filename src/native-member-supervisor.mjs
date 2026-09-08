/**
 * `member start|stop|status`: the resident member client's supervisor.
 *
 * Seam 3 named two options — a member ROLE on the seat service, or a SIBLING VERB running the same
 * supervisor shape — and asked the builder to pick one. This is the sibling verb, and the reason is
 * that the two processes are not the same kind of thing: the seat service HOSTS rooms (it mints
 * them, serves faces, holds the counter-seat authority, admits member routes), while this is a
 * CLIENT of another seat's service. A machine can be a member and never host anything; the laptop
 * is exactly that. Folding a client role into the host service would give one process both sets of
 * failure modes and make "is the service up?" ambiguous on a seat that only ever joins.
 *
 * The ordering is the unit's whole point and is enforced here rather than documented:
 *
 *   1. take the exclusive key claim — FIRST, before any Tailcat child can exist
 *   2. open the member channel and prove it
 *   3. bind the local endpoint
 *   4. publish the readiness descriptor
 *
 * A start that loses the claim at (1) exits by name reporting the winner and spawns NOTHING. That
 * is the property the contest cell counts at the injected spawn seam, and it is only true because
 * the claim precedes `openRemoteRoom`, which is what spawns `tailcat-process.mjs`.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { AgoraError, EXIT } from "./core.mjs";
import { pidAlive } from "./session.mjs";
import { takeKeyClaim, releaseKeyClaim, readKeyClaim, enrolledKeyDigest } from "./native-member-claim.mjs";
import { memberDescriptorStatus, memberStartLine, readMemberDescriptor, removeMemberDescriptor } from "./native-member-descriptor.mjs";
import { MemberClientService } from "./native-member-client.mjs";
import { readRemoteDescriptor, resolveSeatIdentity } from "./native-remote.mjs";

/** Both the start-readiness deadline and the stop-drain deadline, as the seat service uses one. */
const STOP_MS = 5000;

/**
 * The enrolled key digest this alias's route is granted to, from the route descriptor — a file
 * read, never a Tailcat child. The descriptor's binding is the one source the digest covers.
 * @param {string} descriptorPath
 */
export async function routeKeyDigest(descriptorPath) {
  const descriptor = await readRemoteDescriptor(descriptorPath);
  return { keyDigest: descriptor.binding.allowedKeyDigest, roomId: descriptor.binding.roomId };
}

/**
 * Run the client in THIS process until SIGTERM/SIGINT — the supervisor child. The claim is taken
 * here, in the process that will own the Tailcat child, rather than in the parent: a claim held by
 * a parent that exits would name a pid that is gone, and the staleness check would then hand the
 * key away while the child still held it.
 * @param {{ stateRoot: string, alias: string, descriptorPath: string,
 *  build?: import("./harness.mjs").BuildIdentity, seatLabel?: string,
 *  channelOptions?: any, identity?: any }} options
 */
export async function runMemberClient(options) {
  const { keyDigest } = await routeKeyDigest(options.descriptorPath);
  const claim = await takeKeyClaim({
    stateRoot: options.stateRoot, keyDigest, kind: "resident", label: options.alias,
  });
  const service = new MemberClientService({
    stateRoot: options.stateRoot, alias: options.alias, descriptorPath: options.descriptorPath,
    keyDigest, claim: { dir: claim.dir, path: claim.path, generation: claim.generation },
    ...(options.build ? { build: options.build } : {}),
    ...(options.seatLabel ? { seatLabel: options.seatLabel } : {}),
    ...(options.channelOptions ? { channelOptions: options.channelOptions } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
  });
  /** @type {any} */
  let started;
  try {
    started = await service.start();
  } catch (error) {
    // The channel or the bind failed, so nothing is resident and the key must go back. Releasing
    // our own generation only: a competitor that took the key after us keeps it.
    await releaseKeyClaim(claim.dir, claim.generation);
    throw error;
  }
  const halt = async () => {
    await service.stop();
    await releaseKeyClaim(claim.dir, claim.generation);
    process.exitCode = 0;
  };
  process.on("SIGTERM", () => { void halt(); });
  process.on("SIGINT", () => { void halt(); });
  return started;
}

/**
 * Handshake the published endpoint. Success means this descriptor names OUR client; failure means
 * the file is stale, because a recycled pid is not identity. Exactly the seat service's probe.
 * @param {string} stateRoot @param {string} alias
 * @returns {Promise<{ live: true, pid?: number } | { live: false }>}
 */
async function probeOwnClient(stateRoot, alias) {
  try {
    const descriptor = await readMemberDescriptor(stateRoot, alias);
    const { NativeServiceClient } = await import("./native-service.mjs");
    const client = await NativeServiceClient.connect({ ...descriptor, timeoutMs: 2000 });
    client.close();
    return { live: true, ...(typeof descriptor.pid === "number" ? { pid: descriptor.pid } : {}) };
  } catch {
    return { live: false };
  }
}

/**
 * Start the resident client, detached, and wait for it to publish a descriptor that answers.
 *
 * The claim is NOT taken here. It is taken by the child, so the pid on the claim is the pid that
 * owns the Tailcat child; a losing child exits by name and this call reports that refusal rather
 * than a timeout, so `member start` while another holds the key says who holds it.
 * @param {{ root: string, entry: string, execPath: string, alias: string, descriptorPath: string }} options
 */
export async function startMemberClient(options) {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const probe = await probeOwnClient(options.root, options.alias);
  if (probe.live)
    throw new AgoraError(`resident member client for "${options.alias}" already running (pid ${probe.pid ?? "unknown"})`, EXIT.error);

  const { keyDigest } = await routeKeyDigest(options.descriptorPath);
  const held = await readKeyClaim(options.root, keyDigest);
  if (held.held === true)
    throw new AgoraError(`the enrolled key is held by ${held.claim?.kind} pid ${held.claim?.pid}`
      + `${held.claim?.label ? ` (${held.claim.label})` : ""}; this start spawns nothing`, EXIT.error);
  // NOTE: the read above is a courtesy that turns the common case into a clear message before a
  // process is spawned at all. It is NOT the enforcement — the child's own O_EXCL claim is, which
  // is why the child takes it rather than trusting this answer. Reading here and spawning is the
  // TOCTOU; the child losing the race is the correctness.

  const child = spawn(options.execPath, [options.entry, "member", "--daemon", options.alias], {
    env: { ...process.env, AGORA_STATE: options.root, AGORA_MEMBER_ALIAS: options.alias },
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + STOP_MS;
  while (Date.now() < deadline) {
    const next = await probeOwnClient(options.root, options.alias);
    if (next.live) return memberDescriptorStatus(options.root, options.alias);
    await new Promise((r) => setTimeout(r, 50));
  }
  // The child may have lost the claim and exited by name, or the dial may have failed. Say which,
  // by reading who holds the key now rather than reporting a bare timeout.
  const after = await readKeyClaim(options.root, keyDigest);
  if (after.held === true)
    throw new AgoraError(`resident member client for "${options.alias}" did not start: the enrolled key is held by `
      + `${after.claim?.kind} pid ${after.claim?.pid}`, EXIT.error);
  throw new AgoraError(`resident member client for "${options.alias}" did not publish a live descriptor`, EXIT.error);
}

/**
 * Bounded stop, handshake first. A pid is never signalled until a full authenticated connect proved
 * the descriptor names our client; that is what makes the pid safe to signal.
 * @param {string} stateRoot @param {string} alias
 */
export async function stopMemberClient(stateRoot, alias) {
  const probe = await probeOwnClient(stateRoot, alias);
  if (!probe.live) {
    await removeMemberDescriptor(stateRoot, alias);
    return memberDescriptorStatus(stateRoot, alias);
  }
  const pid = probe.pid ?? 0;
  if (!Number.isInteger(pid) || pid <= 0)
    throw new AgoraError(`the resident member client for "${alias}" is live at its endpoint but its descriptor has no pid; not killing by guess`, EXIT.error);

  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  const deadline = Date.now() + STOP_MS;
  while (Date.now() < deadline && pidAlive(pid)) await new Promise((r) => setTimeout(r, 50));
  if (pidAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }

  const still = await probeOwnClient(stateRoot, alias);
  if (still.live) throw new AgoraError(`resident member client for "${alias}" still running (pid ${still.pid})`, EXIT.error);
  await removeMemberDescriptor(stateRoot, alias);
  return memberDescriptorStatus(stateRoot, alias);
}

/**
 * What `member status` and `doctor` may say without connecting: the readiness descriptor's public
 * fields, and beside them the KEY CLAIM, which is the other artifact and answers a different
 * question. A descriptor says a client is routable; the claim says who owns the key. Reporting
 * only the first is how "there is no member client" gets confused with "the key is free".
 * @param {string} stateRoot @param {string} alias
 * @param {string} [descriptorPath] the route descriptor, when the caller has it, so the claim can
 *   be reported even with no readiness descriptor published at all
 */
export async function memberClientStatus(stateRoot, alias, descriptorPath) {
  const status = await memberDescriptorStatus(stateRoot, alias);
  /** @type {string | undefined} */
  let keyDigest = status.keyDigest;
  if (!keyDigest && descriptorPath) {
    try { ({ keyDigest } = await routeKeyDigest(descriptorPath)); } catch { keyDigest = undefined; }
  }
  if (!keyDigest) return { ...status, start: memberStartLine(alias) };
  const claim = await readKeyClaim(stateRoot, keyDigest);
  return {
    ...status,
    ...(status.present ? {} : { start: memberStartLine(alias) }),
    keyClaim: {
      path: claim.path,
      held: claim.held,
      ...(claim.stale ? { stale: true } : {}),
      ...(claim.claim ? { kind: claim.claim.kind, pid: claim.claim.pid, label: claim.claim.label } : {}),
    },
  };
}

/**
 * The seat's own enrolled identity path, for callers that need the digest without a route
 * descriptor (the direct-path gate has a `--key-file`; this is the seat's own).
 * @param {string} stateRoot
 */
export async function seatKeyDigest(stateRoot) {
  const seat = await resolveSeatIdentity(stateRoot);
  return enrolledKeyDigest(seat.keyPath);
}
