// @ts-check
/**
 * Seat-service supervisor: start, stop, status. The live authority is NativeRoomService.
 * Shared config is never written here.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { constants } from 'node:fs';
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { mkdir, realpath, rm, open, link } from "node:fs/promises";
import path from "node:path";
import { AgoraError, EXIT } from "./core.mjs";
import { NativeRoomService } from "./native-service.mjs";
import { pidAlive } from "./session.mjs";
import { connectSeatService, serviceDescriptorPath, serviceDescriptorStatus } from "./wake/subscriber.mjs";
import { localTransferIdentity, privateDirectory, assertPrivateAncestry } from './tailcat.mjs';
import { AuthorityError, authorityIdForKey, validateAuthorityRecord, validateAuthorityRequest,
  validateAuthorityChallenge, assertAuthorityDelegation, createAuthorityEnrollmentChallenge,
  authorityEnrollmentSigningBytes, authoritySigningBytes, enrollAuthorityRecord } from './authority.mjs';
import { humanKeyId } from './protocol/human-authority.mjs';
import { publicNodeKeyDigest } from './protocol/route.mjs';
import { nativeDigest } from './native-protocol.mjs';
import { readRecord } from './protocol/common.mjs';

const STOP_MS = 5000;

/** Bounded hand-carried JSON, never a room lookup. Private inputs additionally deny group/other.
 * @param {string} file @param {boolean} [privateInput] */
export async function readAuthorityInput(file, privateInput = false) {
  let handle;
  try {
    if (privateInput) await assertPrivateAncestry(path.dirname(file));
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || (privateInput && process.platform !== 'win32' && (info.mode & 0o077)))
      throw new AuthorityError('authority-input-permissions');
    if (info.size > 262144) throw new AuthorityError('authority-input-too-large');
    const bytes = Buffer.alloc(262145); let used = 0;
    while (used < bytes.length) {
      const next = await handle.read(bytes, used, bytes.length - used, null);
      if (!next.bytesRead) break; used += next.bytesRead;
    }
    if (used > 262144) throw new AuthorityError('authority-input-too-large');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw new AuthorityError('authority-input-unreadable');
  } finally { await handle?.close(); }
}

/** Atomic no-clobber publication. A sync failure has unknown outcome, never a silent overwrite.
 * @param {string} file @param {unknown} value */
export async function writeAuthorityOutput(file, value) {
  const dir = path.dirname(path.resolve(file));
  await assertPrivateAncestry(dir);
  const temporary = path.join(dir, `.authority-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, file); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') throw new AuthorityError('authority-output-exists');
      throw error;
    }
    if (process.platform !== 'win32') {
      const directory = await open(dir, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw new AuthorityError('authority-output-unknown');
  } finally { await rm(temporary, { force: true }); }
}

/** Explicit key generation only. The output is PUBLIC; the private half stays on this seat.
 * The operator provides this signer's own delegation list, independently of the verifier's.
 * @param {string} root @param {unknown} policy @param {string} label */
export async function generateSeatAuthority(root, policy, label) {
  const identity = await localTransferIdentity(root, { create: false });
  const keys = generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(/** @type {string} */ (keys.publicKey.export({ format: 'jwk' }).x), 'base64url').toString('hex');
  const record = validateAuthorityRecord({ version: 1, algorithm: 'ed25519', authorityId: authorityIdForKey(publicKey),
    publicKey, keyId: humanKeyId(publicKey), boundNodeKeyDigest: publicNodeKeyDigest(identity.nodeKey),
    enrolledAt: new Date().toISOString(), enrolledBy: 'operator-local-bootstrap', label, profile: 'pinned-cooperative', policy });
  const dir = await privateDirectory(path.join(root, 'native'));
  await writeAuthorityOutput(path.join(dir, 'authority-key.json'), { record, privateKey: keys.privateKey.export({ format: 'jwk' }) });
  return record;
}

/** @param {string} root */
async function signingIdentity(root) {
  const value = readRecord(await readAuthorityInput(path.join(root, 'native/authority-key.json'), true), ['record', 'privateKey']);
  const record = validateAuthorityRecord(value.record);
  let key;
  try { key = createPrivateKey({ format: 'jwk', key: /** @type {import('node:crypto').JsonWebKey} */ (value.privateKey) }); }
  catch { throw new AuthorityError('authority-signing-key-malformed'); }
  const publicKey = createPublicKey(key).export({ format: 'jwk' });
  if (key.asymmetricKeyType !== 'ed25519' || Buffer.from(publicKey.x ?? '', 'base64url').toString('hex') !== record.publicKey)
    throw new AuthorityError('authority-key-mismatch');
  const target = publicNodeKeyDigest((await localTransferIdentity(root, { create: false })).nodeKey);
  if (record.boundNodeKeyDigest !== target) throw new AuthorityError('authority-seat-binding-refused');
  return { record, key };
}

/** Prepare and retain locally BEFORE carrying the challenge to the counter-seat.
 * Fingerprint must be confirmed on that seat's terminal; shared room names prove no provenance.
 * @param {string} root @param {unknown} candidate @param {string} fingerprint */
export async function prepareSeatAuthorityEnrollment(root, candidate, fingerprint) {
  const record = validateAuthorityRecord(candidate);
  if (record.keyId !== fingerprint) throw new AuthorityError('authority-fingerprint-refused');
  const target = publicNodeKeyDigest((await localTransferIdentity(root, { create: false })).nodeKey);
  const challenge = createAuthorityEnrollmentChallenge(record, target, new Date().toISOString());
  const dir = await privateDirectory(path.join(root, 'native/authority-enrollments'));
  const retained = { record, challenge };
  await writeAuthorityOutput(path.join(dir, `${challenge.challengeId}.json`), retained);
  return retained;
}

/** Sign possession on the seat holding the private key, never on the enrolling target.
 * @param {string} root @param {unknown} input */
export async function signSeatAuthorityEnrollment(root, input) {
  const { record, key } = await signingIdentity(root);
  const value = readRecord(input, ['record', 'challenge']);
  const proposed = validateAuthorityRecord(value.record);
  const bytes = authorityEnrollmentSigningBytes(value.challenge);
  const challenge = /** @type {ReturnType<typeof createAuthorityEnrollmentChallenge>} */ (value.challenge);
  if (proposed.publicKey !== record.publicKey || proposed.boundNodeKeyDigest !== record.boundNodeKeyDigest
    || challenge.recordDigest !== nativeDigest(proposed) || challenge.targetNodeKeyDigest === record.boundNodeKeyDigest)
    throw new AuthorityError('authority-possession-context');
  const now = Date.now();
  if (now < Date.parse(challenge.issuedAt) || now >= Date.parse(challenge.expiresAt)) throw new AuthorityError('authority-possession-expired');
  return { challenge, signature: sign(null, bytes, key).toString('hex') };
}

/** @param {string} root @param {unknown} input @param {string} fingerprint */
export async function completeSeatAuthorityEnrollment(root, input, fingerprint) {
  const proof = readRecord(input, ['challenge', 'signature']);
  authorityEnrollmentSigningBytes(proof.challenge);
  const challenge = /** @type {ReturnType<typeof createAuthorityEnrollmentChallenge>} */ (proof.challenge);
  const retained = readRecord(await readAuthorityInput(path.join(root, 'native/authority-enrollments', `${challenge.challengeId}.json`), true), ['record', 'challenge']);
  const target = publicNodeKeyDigest((await localTransferIdentity(root, { create: false })).nodeKey);
  return await enrollAuthorityRecord(root, retained.record, fingerprint,
    { targetNodeKeyDigest: target, retainedChallenge: retained.challenge, proof, now: new Date().toISOString() });
}

/** Deliberate local signing command. No signer is invoked by the service or any room message.
 * @param {string} root @param {unknown} input */
export async function signSeatRouteAct(root, input) {
  const { record, key } = await signingIdentity(root);
  const value = readRecord(input, ['request', 'challenge']);
  const request = validateAuthorityRequest(value.request), challenge = validateAuthorityChallenge(value.challenge);
  // The signing seat's list is an additional restriction, not a replacement verifier grant.
  assertAuthorityDelegation(record, { ...request, revisions: { ...request.revisions, policy: record.policy.revision } }, new Date().toISOString());
  if (challenge.keyId !== record.keyId || challenge.act.authorityId !== record.authorityId
    || challenge.sourceNodeKeyDigest !== record.boundNodeKeyDigest || challenge.targetNodeKeyDigest !== request.targetNodeKeyDigest
    || challenge.act.requestDigest !== nativeDigest(request) || challenge.act.operationId !== request.operationId
    || challenge.act.action !== request.action || challenge.serviceBootId !== request.binding.serviceBootId
    || challenge.act.targetServiceId !== request.binding.host.id || challenge.act.room?.roomId !== request.binding.roomId
    || challenge.act.room.epoch !== request.binding.roomEpoch
    || challenge.act.revisions.membership !== request.revisions.membership || challenge.act.revisions.policy !== request.revisions.policy)
    throw new AuthorityError('operator-context-refused');
  const now = Date.now();
  if (now < Date.parse(challenge.act.issuedAt) || now >= Date.parse(challenge.act.expiresAt)) throw new AuthorityError('operator-act-expired');
  return { challenge, signature: sign(null, authoritySigningBytes(challenge), key).toString('hex') };
}

/** @param {string} root @param {string} action @param {unknown} roomId @param {unknown} publicNodeKey */
export async function challengeServiceRoute(root, action, roomId, publicNodeKey) {
  const room = readRouteRoomId(roomId), key = readPublicNodeKey(publicNodeKey, '--allow-key');
  const { client } = await connectSeatService(root);
  try {
    const result = await client.request('route-challenge', { action, roomId: room, publicNodeKey: key });
    return { request: result.request, challenge: result.challenge };
  } finally { client.close(); }
}

/** @param {string} root @param {string} operationId */
export async function statusServiceRouteAct(root, operationId) {
  const { client } = await connectSeatService(root);
  try { return (await client.request('route-act-status', { operationId })).status; } finally { client.close(); }
}

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
 * @param {{ root: string, accountId: string, seatLabel: string, authorityId?: string, build?: import("./harness.mjs").BuildIdentity }} options
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
 * @param {{ root: string, entry: string, execPath: string, accountId: string, seatLabel: string, authorityId?: string }} options
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
      AGORA_SERVICE_AUTHORITY: options.authorityId ?? '',
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
 * @param {string} stateRoot @param {unknown} roomId @param {unknown} publicNodeKey @param {unknown} [proof]
 */
export async function openServiceRoute(stateRoot, roomId, publicNodeKey, proof) {
  const room = readRouteRoomId(roomId);
  const key = readPublicNodeKey(publicNodeKey, "--allow-key");
  const { client } = await connectSeatService(stateRoot);
  try {
    return await client.request("route-open", { roomId: room, publicNodeKey: key, proof });
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
 * @param {string} stateRoot @param {unknown} roomId @param {unknown} publicNodeKey @param {unknown} [proof]
 */
export async function closeServiceRoute(stateRoot, roomId, publicNodeKey, proof) {
  const room = readRouteRoomId(roomId);
  const key = readPublicNodeKey(publicNodeKey, "--allow-key");
  const { client } = await connectSeatService(stateRoot);
  try {
    return await client.request("route-close", { roomId: room, publicNodeKey: key, proof });
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
