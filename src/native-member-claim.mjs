/**
 * The exclusive ownership claim over one enrolled node key.
 *
 * The host's Tailcat server indexes clients by node PUBLIC key (`onMeow`, vendored `ce6fedca`):
 * an existing key returns success before the peer entry is replaced, so N client processes on one
 * key are ONE peer, and each fresh dial can re-point the entry while an earlier subscription stays
 * established and silent. The remedy is not "one descriptor" — a descriptor published after the
 * dial excludes nothing, because the side effect it was meant to exclude has already happened.
 * The remedy is that **no second Tailcat child is ever spawned on the key**, which means the claim
 * is taken BEFORE any child, by every process that would spawn one.
 *
 * So this is a primitive with no per-caller variant. `member start` takes it as its first act.
 * The direct-path gate (`scripts/probe-tailcat-live.mjs --direct`) takes the SAME claim before its
 * own key-bearing child and holds it through teardown: checking for a holder and then spawning is
 * a TOCTOU, and a presence probe does not enforce that one process owns the key.
 *
 * The claim is keyed by the canonical state root plus the key digest, never by alias: two aliases
 * whose routes use the same key are two rooms on one client, and the alias is a room while the
 * claim is a key.
 *
 * A concurrent loser LOSES BY NAME and does not wait, in both directions. Waiting needs a bound,
 * and a bound is a second policy to get wrong; the refusal instead names the holder's pid, boot
 * epoch and `kind`, so a start refused by a `gate` reads as retry in seconds while one refused by
 * a live `resident` reads as already running, pid N. If the resident should outrank a transient
 * gate, that is a rule about which kind may break a claim and it belongs in this file.
 */
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgoraError } from "./core.mjs";
import { publicNodeKeyDigest } from "./protocol/route.mjs";
import { bootEpoch, pidAlive } from "./session.mjs";

/** How many times an acquire will re-try after clearing a claim it proved stale. */
const CLAIM_ATTEMPTS = 4;

/** The two kinds of key-bearing dialer. A third would be a third way to spawn a child. */
export const CLAIM_KINDS = Object.freeze(["resident", "gate"]);

/**
 * A held claim, as it sits on disk. `generation` is what a release is fenced by: a release that
 * finds another generation in the file is a release of somebody else's claim and does nothing.
 * @typedef {object} KeyClaimRecord
 * @property {string} keyDigest the enrolled key digest this claim is over (`sha256:<64 hex>`)
 * @property {number} pid the process holding it
 * @property {number} bootEpoch the boot that pid belongs to; a pid outlives nothing across a reboot
 * @property {'resident' | 'gate'} kind what the holder is, so a refusal is actionable
 * @property {string} generation unique to this acquire
 * @property {string} startedAt
 * @property {string} [label] free text for the refusal line (an alias, a probe name)
 */

/** @param {string} code @param {string} detail */
function claimRefusal(code, detail) {
  return Object.assign(new AgoraError(`${code}: ${detail}`), { code });
}

/**
 * The claim's directory and file. The digest's hex half is the filename: a `sha256:` prefix is not
 * a path segment on every filesystem, and the record carries the full digest anyway.
 * @param {string} stateRoot a CANONICAL state root (see {@link canonicalStateRoot})
 * @param {string} keyDigest
 */
export function keyClaimPath(stateRoot, keyDigest) {
  const hex = /^sha256:([a-f0-9]{64})$/.exec(String(keyDigest));
  if (!hex) throw claimRefusal("member-key-claim-digest-invalid", `expected sha256:<64 hex>, got ${JSON.stringify(String(keyDigest))}`);
  return path.join(stateRoot, "native", "member", "claims", `${hex[1]}.claim.json`);
}

/**
 * Two sessions reaching one state root by different paths (a symlinked home, a bind mount) would
 * otherwise take two claims over one key and both spawn. `realpath` where the directory exists,
 * `path.resolve` where it does not yet.
 * @param {string} stateRoot
 */
export async function canonicalStateRoot(stateRoot) {
  const resolved = path.resolve(String(stateRoot));
  try { return await realpath(resolved); } catch { return resolved; }
}

/** @param {unknown} value @returns {KeyClaimRecord | undefined} */
function parseClaim(value) {
  if (!value || typeof value !== "object") return undefined;
  const rec = /** @type {Record<string, unknown>} */ (value);
  if (typeof rec.keyDigest !== "string" || typeof rec.generation !== "string") return undefined;
  if (!Number.isInteger(rec.pid) || Number(rec.pid) <= 0) return undefined;
  if (typeof rec.kind !== "string" || !CLAIM_KINDS.includes(rec.kind)) return undefined;
  return /** @type {KeyClaimRecord} */ (rec);
}

/**
 * Is the process this claim names still the one that took it? The pid alone is not enough — pids
 * are reused, and a claim written before a reboot names a pid that now belongs to something else,
 * so a crashed resident would fence out every later start forever. This is `armedAlive`'s test,
 * deliberately: a claim is an armed record with one holder.
 * @param {KeyClaimRecord} claim
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 */
export function claimAlive(claim, deps = {}) {
  if (typeof claim.bootEpoch === "number" && Math.abs((deps.boot ?? bootEpoch()) - claim.bootEpoch) > 2) return false;
  return pidAlive(claim.pid, deps.kill);
}

/** @param {KeyClaimRecord} claim */
function holderDetail(claim) {
  const label = claim.label ? ` (${claim.label})` : "";
  return `${claim.kind} pid ${claim.pid}${label}, held since ${claim.startedAt}`;
}

/**
 * Take the key's claim, or refuse by name. This is the FIRST act of anything that will spawn a
 * Tailcat child under the enrolled key — before the spawn, not after, and never as a check
 * followed by a spawn.
 *
 * Refusals, each by `code`:
 * - `member-key-claim-held` — a live holder; the message names its kind, pid and start.
 * - `member-key-claim-malformed` — a claim file that cannot be read as a claim. It is NOT cleared:
 *   an unreadable claim may belong to a live process, and clearing it is how the second child gets
 *   spawned. This one wants a person, exactly as an unusable `writer.lock` does.
 * - `member-key-claim-digest-invalid` — the caller's digest is not a key digest.
 * - `member-key-claim-contended` — the claim was proven stale and cleared, and a competitor won
 *   every retry. A real outcome under a race, distinct from a settled holder.
 *
 * @param {{ stateRoot: string, keyDigest: string, kind: 'resident' | 'gate', pid?: number, label?: string }} input
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number, now?: () => Date }} [deps]
 * @returns {Promise<{ path: string, generation: string, record: KeyClaimRecord, release: () => Promise<boolean> }>}
 */
export async function takeKeyClaim(input, deps = {}) {
  if (!CLAIM_KINDS.includes(input.kind))
    throw claimRefusal("member-key-claim-kind-invalid", `expected one of ${CLAIM_KINDS.join(", ")}, got ${JSON.stringify(String(input.kind))}`);
  const stateRoot = await canonicalStateRoot(input.stateRoot);
  const claimPath = keyClaimPath(stateRoot, input.keyDigest);
  await mkdir(path.dirname(claimPath), { recursive: true });

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    /** @type {KeyClaimRecord} */
    const record = {
      keyDigest: input.keyDigest,
      pid: input.pid ?? process.pid,
      bootEpoch: deps.boot ?? bootEpoch(),
      kind: input.kind,
      generation: randomUUID().replaceAll("-", ""),
      startedAt: (deps.now?.() ?? new Date()).toISOString(),
      ...(input.label ? { label: String(input.label) } : {}),
    };
    try {
      const handle = await open(claimPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
      return {
        path: claimPath,
        generation: record.generation,
        record,
        release: () => releaseKeyClaim(claimPath, record.generation),
      };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    }

    /** @type {KeyClaimRecord | undefined} */
    let held;
    try { held = parseClaim(JSON.parse(await readFile(claimPath, "utf8"))); }
    catch (error) {
      // A claim that vanished between the EEXIST and this read is a release racing us: retry.
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") continue;
      held = undefined;
    }
    if (!held)
      throw claimRefusal("member-key-claim-malformed",
        `${claimPath} is not a readable claim; it is not cleared automatically, because an unreadable claim may still belong to a live process`);
    if (claimAlive(held, deps))
      throw claimRefusal("member-key-claim-held", `the enrolled key is held by ${holderDetail(held)}; this process spawns nothing`);

    // Proven stale. RECLAIMING IS ITSELF AN OWNERSHIP OPERATION, and read-decide-unlink-create is
    // not one: between one contender's decision and its unlink, another can clear the same stale
    // claim and create its own, and the first contender's `rm` then deletes that NEW claim before
    // creating a second. Two live holders with valid generations. Measured with real process
    // concurrency: 8 contenders against one stale claim admitted 2 holders on 2 of 8 trials.
    // In-process it never reproduces — the event loop walks all eight through the same await
    // points in lockstep — so a same-process cell for this is one that cannot fail.
    //
    // `rename` is NOT the fix, though it looks like one. POSIX rename(2) atomically REPLACES an
    // existing destination and returns success, so "exactly one renamer succeeds" is false there
    // and true on Windows; and worse, a late reclaimer renaming the claim path moves a legitimate
    // successor's LIVE claim out of it just as an unlink would delete it. The read-then-act window
    // simply reappears in the operation chosen to close it. (Opus/architect, backroom 1788839977.)
    //
    // So winner selection rests ENTIRELY on the O_EXCL create, which genuinely admits exactly one,
    // and the only process permitted to remove anything is the one holding a second O_EXCL lock:
    //
    //   * every deletion happens under `<claim>.reclaim`, itself taken with `wx`;
    //   * under that lock the claim is RE-READ, and it is removed only if it is still the same
    //     generation and still dead — a successor's claim has a different generation and aborts it;
    //   * a claim can only appear while the path is empty, which can only follow a removal, which
    //     requires this lock. So while the lock is held the state cannot change underneath it, and
    //     the re-read is authoritative rather than a guess.
    //
    // Residual, stated rather than hidden: a reclaimer that dies holding the lock leaves it behind.
    // It is cleared only when its own pid is dead and its boot epoch matches, and two clearers
    // racing that window could both proceed — bounded to a crash mid-reclaim, and far narrower
    // than the defect it replaces. A portable atomic compare-and-delete would close it outright;
    // node:fs has none (`renameat2`/`RENAME_NOREPLACE` is Linux-only).
    const lockPath = `${claimPath}.reclaim`;
    /** @type {import("node:fs/promises").FileHandle | undefined} */
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(`${JSON.stringify({ pid: process.pid, bootEpoch: deps.boot ?? bootEpoch() })}\n`, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      // Someone else is reclaiming, or a reclaimer died holding it.
      const owner = safeParse(await readFile(lockPath, "utf8").catch(() => ""));
      const dead = owner && typeof owner === "object"
        && !claimAlive(/** @type {any} */ ({ ...owner, kind: "resident", keyDigest: input.keyDigest, generation: "x" }), deps);
      if (dead) await rm(lockPath, { force: true }).catch(() => {});
      continue;
    }
    try {
      const current = parseClaim(safeParse(await readFile(claimPath, "utf8").catch(() => "")));
      // Still the record we judged, and still dead? Only then may it go.
      if (current && current.generation === held.generation && !claimAlive(current, deps))
        await rm(claimPath, { force: true });
    } finally {
      await lock.close().catch(() => {});
      await rm(lockPath, { force: true }).catch(() => {});
    }
  }
  throw claimRefusal("member-key-claim-contended",
    `the enrolled key's claim was cleared as stale and re-taken by another process ${CLAIM_ATTEMPTS} times`);
}

/**
 * Release a claim, fenced by generation: a file that carries a different generation belongs to a
 * later holder, and unlinking it would hand the key to a third process while that holder still has
 * a child. Never throws — a release runs in a `finally`, and a teardown that throws hides what it
 * was tearing down.
 * @param {string} claimPath @param {string} generation
 * @returns {Promise<boolean>} true when this call removed this generation's claim
 */
export async function releaseKeyClaim(claimPath, generation) {
  try {
    const held = parseClaim(JSON.parse(await readFile(claimPath, "utf8")));
    if (!held || held.generation !== generation) return false;
    await rm(claimPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Who holds the key here, if anyone. For `status`, `doctor` and a refusal line — never as the
 * gate before a spawn, which is the TOCTOU this module exists to close.
 *
 * `held` is THREE-STATE on purpose. A claim file that cannot be parsed does not mean the key is
 * free; it means nobody here can say, and a caller that reads a green `false` off it is one step
 * from spawning the second child. `'unknown'` is truthy, so a caller that forgets the third state
 * fails toward refusing rather than toward dialing.
 * @param {string} stateRoot @param {string} keyDigest
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 * @returns {Promise<{ path: string, held: boolean | 'unknown', stale?: boolean, claim?: KeyClaimRecord }>}
 */
export async function readKeyClaim(stateRoot, keyDigest, deps = {}) {
  const claimPath = keyClaimPath(await canonicalStateRoot(stateRoot), keyDigest);
  /** @type {string} */
  let raw;
  try { raw = await readFile(claimPath, "utf8"); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return { path: claimPath, held: false };
    return { path: claimPath, held: "unknown" };
  }
  const claim = parseClaim(safeParse(raw));
  if (!claim) return { path: claimPath, held: "unknown" };
  return claimAlive(claim, deps)
    ? { path: claimPath, held: true, claim }
    : { path: claimPath, held: false, stale: true, claim };
}

/** @param {string} raw */
function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/**
 * The enrolled key's digest, read from the identity file and NOTHING ELSE.
 *
 * This exists because of a circularity the seams do not mention. The claim must be taken before any
 * Tailcat child, and it is keyed by the enrolled key digest; but the ordinary way to learn this
 * seat's public node key is `tailcat --key=<path> printpub`, which IS a Tailcat child. A claim that
 * spawns a child to decide whether it may spawn a child has already lost the argument.
 *
 * The identity file carries both halves — `{ Private, Public: { ServerPublic, ServerDiscoPublic } }`
 * — so `Public.ServerPublic` is the same `nodekey:<64 hex>` that `printpub` prints, and the digest
 * is a pure file read. Verified against live state 2026-09-08: the digest computed here equalled the
 * `binding.allowedKeyDigest` in this seat's issued route descriptor exactly.
 *
 * The private half is read into memory and never returned, logged, digested or included in any
 * refusal. Only `Public.ServerPublic` leaves this function, and only as a digest.
 *
 * @param {string} keyPath the identity file (`<state>/tailcat/identity.private.json`)
 * @returns {Promise<string>} `sha256:<64 hex>` over the public node key
 */
export async function enrolledKeyDigest(keyPath) {
  /** @type {string} */
  let raw;
  try { raw = await readFile(keyPath, "utf8"); }
  catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    throw claimRefusal("member-key-identity-unreadable",
      `the enrolled identity at ${keyPath} could not be read (${code ?? String(error)}); a key-bearing child must not start before its key is known`);
  }
  const parsed = safeParse(raw);
  const publicKey = parsed && typeof parsed === "object" ? /** @type {any} */ (parsed).Public?.ServerPublic : undefined;
  if (typeof publicKey !== "string" || !/^nodekey:[a-f0-9]{64}$/.test(publicKey))
    throw claimRefusal("member-key-identity-malformed",
      `the enrolled identity at ${keyPath} carries no usable public node key; the digest cannot be derived without spawning a Tailcat child, which is what the claim exists to prevent`);
  return publicNodeKeyDigest(publicKey);
}
