/**
 * The resident member client's READINESS descriptor.
 *
 * Seam 7 splits one artifact into two, because conflating them is the defect wearing a fix:
 *
 * - the CLAIM (`native-member-claim.mjs`) is exclusive, is keyed by the enrolled key, and is taken
 *   BEFORE any Tailcat child exists. It is what makes a second client impossible.
 * - this DESCRIPTOR is advisory, is keyed by ALIAS, and is written only AFTER the member channel is
 *   subscribed — as `service.json` is written after the endpoint binds. It is what sessions route
 *   on, and it never stands in for the claim.
 *
 * A descriptor published after the dial excludes nothing: the side effect it would exclude has
 * already happened. So nothing in this file takes, checks or repairs ownership, and a caller that
 * reaches for it to decide whether it may dial has picked up the wrong artifact.
 *
 * The alias/key split is the other half of the same sentence: two aliases whose routes use one key
 * share ONE client and one claim, and each publishes its own readiness descriptor. The alias is a
 * room; the claim is a key.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pidAlive } from "./session.mjs";
import { ServiceDarkError } from "./wake/subscriber.mjs";
import { writeFileAtomic } from "./core.mjs";

/** Where a resident member client publishes its readiness for one alias. @param {string} stateRoot @param {string} alias */
export function memberDescriptorPath(stateRoot, alias) {
  if (typeof alias !== "string" || !/^[A-Za-z0-9._-]+$/.test(alias))
    throw new ServiceDarkError(`"${String(alias)}" is not a usable room alias for a member descriptor`);
  return path.join(stateRoot, "native", "member", `${alias}.json`);
}

/**
 * The start line every refusal ends with. A session that finds no resident client must be told to
 * START ONE, never to dial: "re-dial" is the defect returning under another name, and a refusal
 * that only says the client is absent invites exactly that.
 * @param {string} alias
 */
export function memberStartLine(alias) {
  return `start the resident member client for this machine with \`agora member start ${alias}\`; no session dials Tailcat directly`;
}

/**
 * @typedef {object} MemberDescriptor
 * @property {string} path the local endpoint sessions subscribe to; the member channel is NOT here
 * @property {string} nonce seat-private, like the seat service's; never printed, never on the wire
 * @property {string} alias
 * @property {string} roomId from the route descriptor's binding, the one source the digest covers
 * @property {string} keyDigest the enrolled key this client holds the CLAIM over
 * @property {string} accountId the minted member principal `m-<32hex>`
 * @property {string} seatLabel this client's label. It is part of the local handshake TRANSCRIPT,
 *   so a descriptor without it cannot be connected to at all — the seat service's descriptor
 *   carries it for the same reason, and omitting it here is a dark client, not a cosmetic gap.
 * @property {string} bootEpoch
 * @property {number} [pid]
 * @property {string} [startedAt]
 * @property {{ dir?: string, path: string, generation: number }} [claim] where this client's ownership claim is,
 *   so `status` can show the two artifacts together and `stop` can refuse to stop a client that
 *   does not hold the claim it names. A readiness descriptor without it is readable and routable;
 *   it simply cannot corroborate ownership, which is the honest reading.
 * @property {import("./harness.mjs").BuildIdentity} [build] code this resident loaded, so
 *   `doctor`'s re-arm check applies to it exactly as it does to a watch
 */

/**
 * Publish readiness. Called ONCE, after the member channel is subscribed — never at start, never
 * before the claim, never speculatively.
 * @param {string} stateRoot @param {MemberDescriptor} descriptor
 */
export async function writeMemberDescriptor(stateRoot, descriptor) {
  const file = memberDescriptorPath(stateRoot, descriptor.alias);
  await writeFileAtomic(file, JSON.stringify(descriptor, null, 2) + "\n");
  return file;
}

/**
 * Remove it on a bounded stop. Never throws: a teardown that throws hides what it tore down.
 * @param {string} stateRoot @param {string} alias
 */
export async function removeMemberDescriptor(stateRoot, alias) {
  try { await rm(memberDescriptorPath(stateRoot, alias), { force: true }); return true; }
  catch { return false; }
}

/**
 * The descriptor, or a `ServiceDarkError` naming the member descriptor AND the start line. Seam 4:
 * a session's watch on the remote alias ends `service-dark` the way a dark seat service does, and
 * says to start the member client rather than to re-dial.
 *
 * Advisory, exactly as the seat service's is: the local bind is the live authority and a stale file
 * is discovered by the connection, not here.
 * @param {string} stateRoot @param {string} alias
 * @returns {Promise<MemberDescriptor>}
 */
export async function readMemberDescriptor(stateRoot, alias) {
  const file = memberDescriptorPath(stateRoot, alias);
  /** @type {string} */
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new ServiceDarkError(`no resident member client for "${alias}": there is no descriptor at ${file}. ${memberStartLine(alias)}`);
    throw new ServiceDarkError(`member client descriptor ${file} cannot be read (${code ?? String(e)}). ${memberStartLine(alias)}`);
  }
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new ServiceDarkError(`member client descriptor ${file} is not valid JSON. ${memberStartLine(alias)}`); }
  if (!parsed || typeof parsed !== "object" || typeof parsed.path !== "string" || typeof parsed.nonce !== "string")
    throw new ServiceDarkError(`member client descriptor ${file} does not describe an endpoint. ${memberStartLine(alias)}`);
  if (typeof parsed.roomId !== "string" || typeof parsed.keyDigest !== "string")
    throw new ServiceDarkError(`member client descriptor ${file} names no room binding or enrolled key. ${memberStartLine(alias)}`);
  // seatLabel and accountId ride the handshake transcript, so a descriptor missing either cannot be
  // connected to. Refusing here names the file; letting it through would fail as a proof mismatch.
  if (typeof parsed.accountId !== "string" || typeof parsed.seatLabel !== "string")
    throw new ServiceDarkError(`member client descriptor ${file} is missing the handshake identity it must carry. ${memberStartLine(alias)}`);
  return parsed;
}

/**
 * What `doctor` and `member status` may say without connecting: the public fields and whether the
 * pid still answers. Never the nonce — it is the seat-local service secret and it does not leave
 * this machine, this file included.
 * @param {string} stateRoot @param {string} alias
 * @returns {Promise<{ descriptor: string, present: boolean, alias: string, pid?: number, pidAlive?: boolean, roomId?: string, keyDigest?: string, accountId?: string, seatLabel?: string, bootEpoch?: string, startedAt?: string, endpoint?: string, claim?: { dir?: string, path: string, generation: number }, build?: import("./harness.mjs").BuildIdentity, error?: string }>}
 */
export async function memberDescriptorStatus(stateRoot, alias) {
  /** @type {string} */
  let descriptor;
  try { descriptor = memberDescriptorPath(stateRoot, alias); }
  catch (e) { return { descriptor: "", present: false, alias, error: e instanceof Error ? e.message : String(e) }; }
  try {
    const d = await readMemberDescriptor(stateRoot, alias);
    return {
      descriptor, present: true, alias,
      ...(typeof d.pid === "number" ? { pid: d.pid, pidAlive: pidAlive(d.pid) } : {}),
      roomId: d.roomId, keyDigest: d.keyDigest,
      ...(d.accountId ? { accountId: d.accountId } : {}),
      ...(d.seatLabel ? { seatLabel: d.seatLabel } : {}),
      bootEpoch: d.bootEpoch,
      ...(d.startedAt ? { startedAt: d.startedAt } : {}),
      endpoint: d.path,
      ...(d.claim ? { claim: d.claim } : {}),
      ...(d.build ? { build: d.build } : {}),
    };
  } catch (e) {
    return { descriptor, present: false, alias, error: e instanceof Error ? e.message : String(e) };
  }
}
