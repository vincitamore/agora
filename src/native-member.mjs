// @ts-check
// T1 host ingress: the host half of native membership over Tailcat.
//
// A member is an enrolled NODE KEY, never an account: both machines may post through one Slack
// app, so an enrollment directory keyed by the transport's account id holds one principal and the
// account cannot authorize. The account id is a routing hint and is never an authorization input.
//
// Nothing here reads or writes the shared config, and nothing here ever touches the seat-local
// service nonce: a member session authenticates with the Tailcat-authenticated key plus a
// transcript proof under a PER-ROUTE secret, resolved locally on each side from the descriptor's
// proofRef and rotated when the route closes.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import { nativeDigest, nativeHandshakeProof, validateNativeId as validateNativeIdText } from "./native-protocol.mjs";
import { publicNodeKeyDigest, validateRouteBinding, validateRouteDescriptor } from "./protocol/route.mjs";

/** The public node key exactly as the remote's `enroll` prints it. Tailcat's `--allow` takes the
 * key itself, not its digest (see startMemberRoute's serve arguments); the binding stores the
 * digest, and the member's native account id is derived from that digest. */
export const PUBLIC_NODE_KEY = /^nodekey:[a-f0-9]{64}$/;

/** Domain separation for the member handshake.
 *
 * The phase is inside the HMAC, so a proof minted under the seat-local service nonce cannot
 * validate on a member route and a member proof cannot validate on the local path, even if a
 * secret were crossed by mistake. */
export const MEMBER_PHASES = Object.freeze({ server: "member-server", client: "member-client", welcome: "member-welcome" });

/**
 * The one place a member proof is minted or checked.
 *
 * It delegates to `nativeHandshakeProof` so there is exactly one HMAC construction in the tool:
 * two copies of a proof function is how they drift apart. `nativeHandshakeProof` refuses a phase
 * outside its own set, so the member phases are registered there.
 * @param {string} secret @param {string} phase @param {Record<string, unknown>} transcript
 */
export function memberHandshakeProof(secret, phase, transcript) {
  if (!(/** @type {string[]} */ (Object.values(MEMBER_PHASES))).includes(phase))
    throw new AgoraError(`native member handshake has an invalid ${JSON.stringify(phase)} phase`);
  return nativeHandshakeProof(secret, /** @type {any} */ (phase), transcript);
}

/** @param {unknown} proof @param {string} secret @param {string} phase @param {Record<string, unknown>} transcript */
export function verifyMemberHandshakeProof(proof, secret, phase, transcript) {
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = memberHandshakeProof(secret, phase, transcript);
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"));
}

/** @param {unknown} value */
export function validatePublicNodeKey(value) {
  if (typeof value !== "string" || !PUBLIC_NODE_KEY.test(value))
    throw new AgoraError("a member key must be a public node key, nodekey: followed by 64 hex characters, exactly as enroll prints it");
  return value;
}

/**
 * The member's native account id, so a remote principal owns its own authorship on the host.
 *
 * The store stamps `author.id` from the authenticated account id and derives each message id from
 * it, so two principals sharing one id would share authorship and message identity.
 *
 * The `m-` prefix is load-bearing rather than cosmetic: it makes the remote principal space
 * disjoint from the local 32-hex account space BY CONSTRUCTION, so a remote id can never collide
 * with a host account id, and `author.id` says off-box at a glance in the log. The native id
 * grammar admits it (34 characters of `[A-Za-z0-9_-]`).
 * @param {string} keyDigest
 */
export function memberAccountId(keyDigest) {
  const digest = /^sha256:([a-f0-9]{64})$/.exec(keyDigest);
  if (!digest) throw new AgoraError("a member account id is derived from a sha256 key digest");
  return `m-${digest[1].slice(0, 32)}`;
}

/** True for an id minted by `memberAccountId`. A host account id can never satisfy it.
 * @param {unknown} value */
export function isMemberAccountId(value) {
  return typeof value === "string" && /^m-[a-f0-9]{32}$/.test(value);
}

/** A per-route secret in the shape `nativeHandshakeProof` already validates, so no new crypto. */
export function mintRouteSecret() {
  return `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`.slice(0, 64);
}

/** Route generation and grant ids share the native id grammar. */
export function mintRouteId() {
  return randomUUID().replaceAll("-", "");
}

/** A proof reference is a NAME. It is never joined to a path.
 *
 * Joining it would be a traversal with a credential oracle attached: a descriptor naming
 * `../../slack-bot.token` would resolve to the seat's Slack token, an `xoxb-` token satisfies the
 * native id grammar, and the host would then HMAC the transcript under that token and hand the
 * result to whoever published the descriptor. So the grammar admits no separator and no dot-dot,
 * and the directory comes from the binding rather than from the reference. */
export const PROOF_REF = /^[A-Za-z0-9_-]{16,128}\/[A-Za-z0-9_-]{16,128}\.secret$/;

/** The canonical proof reference for a binding: <grantId>/<routeGeneration>.secret.
 * @param {{ grantId: string, routeGeneration: string }} binding */
export function routeProofRef(binding) {
  validateNativeIdText(binding.grantId, "grant id");
  validateNativeIdText(binding.routeGeneration, "route generation");
  return `${binding.grantId}/${binding.routeGeneration}.secret`;
}

/**
 * Resolve a proof reference by EQUALITY against the binding the host already holds.
 *
 * The safety is the equality, not the shape. Containment ("does the resolved path stay under the
 * root?") answers the wrong question: it prevents escape and permits SELECTION, and selecting
 * which file gets HMAC'd is the whole attack. So the reference is compared with the canonical name
 * derived from the binding, and a descriptor can therefore name exactly one file: its own.
 * @param {string} root @param {{ grantId: string, routeGeneration: string }} binding @param {string} proofRef
 */
export function routeSecretPath(root, binding, proofRef) {
  const canonical = routeProofRef(binding);
  if (typeof proofRef !== "string" || !PROOF_REF.test(proofRef))
    throw new AgoraError("proof-ref-refused: a route proof reference is <grantId>/<routeGeneration>.secret");
  for (const segment of proofRef.split("/"))
    if (segment === "." || segment === ".." || segment === "")
      throw new AgoraError("proof-ref-refused: a route proof reference carries no traversal segment");
  if (proofRef.includes("\\") || proofRef.includes("\u0000"))
    throw new AgoraError("proof-ref-refused: a route proof reference carries no separator other than /");
  if (proofRef !== canonical)
    throw new AgoraError("proof-ref-refused: a route proof reference must equal this route's own <grantId>/<routeGeneration>.secret");
  const base = path.join(path.resolve(root), "native", "routes");
  const resolved = path.join(base, binding.grantId, `${binding.routeGeneration}.secret`);
  // Fail-loud tripwire if the grammar or the equality above is ever loosened.
  if (path.dirname(resolved) !== path.join(base, binding.grantId))
    throw new AgoraError("proof-ref-refused: a route proof reference must stay inside its own grant directory");
  return resolved;
}

/**
 * Refuse a secret whose mode grants group or other access; never chmod it quietly.
 *
 * This deliberately differs from `ensurePrivateStateDirectory`, which repairs a directory's mode.
 * A secret file travels between machines through the forge-only seat repo, and git's index stores
 * only 644 or 755 — so a cloned secret arrives world-readable on every checkout, and silently
 * repairing it would hide exactly the fact the operator needs to act on.
 *
 * On Windows the mode bits `fs.stat` reports are synthesized rather than an ACL, so a literal
 * `& 0o077` test there would refuse every checkout while proving nothing. The refusal path still
 * exists and is exercised; the ACL is the operator's step and the docs say so.
 * @param {string} file
 */
export async function assertSecretFileMode(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new AgoraError(`a route secret must be a regular file: ${file}`);
  if (process.platform === "win32") return info;
  if ((info.mode & 0o077) !== 0)
    throw new AgoraError(`route secret ${JSON.stringify(file)} grants group or other access; chmod 600 it (git stores only 644 or 755, so a cloned secret arrives 0644)`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    throw new AgoraError(`route secret ${JSON.stringify(file)} is not owned by this OS user`);
  return info;
}

/** @param {string} root @param {{ grantId: string, routeGeneration: string }} binding @param {string} secret */
export async function writeRouteSecret(root, binding, secret) {
  validateNativeIdText(secret, "route secret");
  const proofRef = routeProofRef(binding);
  const file = routeSecretPath(root, binding, proofRef);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
  return { proofRef, file };
}

/** @param {string} root @param {{ grantId: string, routeGeneration: string }} binding @param {string} proofRef */
export async function readRouteSecret(root, binding, proofRef) {
  const file = routeSecretPath(root, binding, proofRef);
  await assertSecretFileMode(file);
  const text = await readFile(file, "utf8");
  const secret = text.endsWith("\n") ? text.slice(0, -1) : text;
  validateNativeIdText(secret, "route secret");
  return secret;
}

/** Rotation: a stale copy on either side then fails the proof rather than authenticating. */
/** @param {string} root @param {{ grantId: string, routeGeneration: string }} binding */
export async function removeRouteSecret(root, binding) {
  const file = routeSecretPath(root, binding, routeProofRef(binding));
  // This is the only recursive delete in the file, so it validates its own path component rather
  // than relying on routeProofRef above having validated grantId for a different purpose. A
  // refactor that reorders those lines must not silently widen an rm -r.
  validateNativeIdText(binding.grantId, "grant id");
  await rm(file, { force: true });
  // close is revocation: the generation directory goes with the secret, so a reopen must mint a
  // new generation rather than reviving this one.
  await rm(path.join(path.resolve(root), "native", "routes", binding.grantId), { recursive: true, force: true });
  return file;
}

/**
 * The digest a remote checks the carried descriptor against, over everything BUT itself.
 * @param {Record<string, unknown>} descriptor
 */
export function descriptorDigest(descriptor) {
  const { descriptorDigest: _omit, ...rest } = descriptor;
  // nativeDigest emits exactly validateDigest's shape over canonicalJson; minting a second
  // canonicalization is how two of them drift apart.
  return nativeDigest(rest);
}

/**
 * @param {{ hostAccountId: string, hostAuthority: string, roomId: string, roomEpoch: string,
 *  serviceBootId: string, publicNodeKey: string, membershipRevision?: number }} input
 */
export function buildRouteBinding(input) {
  const publicKey = validatePublicNodeKey(input.publicNodeKey);
  const allowedKeyDigest = publicNodeKeyDigest(publicKey);
  const accountId = memberAccountId(allowedKeyDigest);
  return validateRouteBinding({
    host: { scheme: "native", authority: input.hostAuthority, id: input.hostAccountId },
    // The member ref carries the SAME minted id: it is a routing hint beside the principal,
    // never a second identity that could disagree with the one the store stamps.
    member: { scheme: "native", authority: input.hostAuthority, id: accountId },
    accountId,
    serviceBootId: input.serviceBootId,
    roomId: input.roomId,
    roomEpoch: input.roomEpoch,
    membershipRevision: input.membershipRevision ?? 1,
    grantId: mintRouteId(),
    routeGeneration: mintRouteId(),
    allowedKeyDigest,
  });
}

/**
 * @param {{ binding: ReturnType<typeof validateRouteBinding>,
 *  endpoint: { transport: string, address: string, port: number }, proofRef: string, issuedAt: string }} input
 */
export function buildRouteDescriptor(input) {
  const unsigned = {
    binding: input.binding,
    protocol: "agora-native/1",
    endpoint: { transport: input.endpoint.transport, address: input.endpoint.address, port: input.endpoint.port },
    issuedAt: input.issuedAt,
    proofRef: input.proofRef,
  };
  return validateRouteDescriptor({ ...unsigned, descriptorDigest: descriptorDigest(unsigned) });
}

/** @param {unknown} value */
export function assertDescriptorDigest(value) {
  const descriptor = validateRouteDescriptor(value);
  const expected = descriptorDigest(descriptor);
  if (descriptor.descriptorDigest !== expected)
    throw new AgoraError("route descriptor digest does not cover its own contents; the descriptor was altered in transit");
  return descriptor;
}

/**
 * The transcript a member proof covers.
 *
 * The local transcript plus every field that binds this handshake to ONE grant, generation, room
 * and epoch, so a proof cannot be replayed onto another route or across a rotation, and a frame
 * later claiming a different principal cannot match a proof minted for this one.
 * @param {ReturnType<typeof validateRouteBinding>} binding
 * @param {Record<string, unknown>} base
 */
export function memberTranscript(binding, base) {
  // The spread ORDER is the security property, not a style choice: `base` goes first and the
  // binding's fields last, so a hostile or careless base cannot override roomId, grantId,
  // routeGeneration or the minted principal. Reversing these two lines would let the caller
  // choose what the proof binds to.
  // seatLabel and the host's own accountId belong to the LOCAL transcript. The remote reads both
  // from service.json, which it does not have, so including them would bind the proof to values
  // the far side has no source for; host identity is carried by serviceBootId and the grant.
  const { seatLabel: _label, accountId: _local, ...fresh } = base;
  return {
    ...fresh,
    roomId: binding.roomId,
    roomEpoch: binding.roomEpoch,
    grantId: binding.grantId,
    routeGeneration: binding.routeGeneration,
    membershipRevision: binding.membershipRevision,
    memberAccountId: binding.accountId,
  };
}

/** Request types a member session may send. Everything else is refused by name.
 *
 * Board operations admitted through the host protocol under the remote principal are allowed;
 * direct store or control access is not, which is why create-room and spawn are absent. */
export const MEMBER_REQUEST_TYPES = Object.freeze(["status", "read", "subscribe", "append"]);

/** @param {string} type */
export function memberMayRequest(type) {
  return MEMBER_REQUEST_TYPES.includes(type);
}

/** The registry key for one admitted route. One principal per room per key.
 *
 * The colon join is safe because of the DIGEST'S FIXED LENGTH, not because of the delimiter: an
 * allowedKeyDigest is always exactly 71 characters, so no two (roomId, digest) pairs can produce
 * one key. A delimiter join over variable-length components is the standard collision shape, and
 * anyone widening either component has to restore that argument or change the join.
 * @param {string} roomId @param {string} allowedKeyDigest */
export function routeKey(roomId, allowedKeyDigest) {
  return `${roomId}:${allowedKeyDigest}`;
}
