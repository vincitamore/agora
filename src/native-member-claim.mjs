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
 * ## The shape, and why it is a DIRECTORY of numbered files
 *
 * Ruled at seam 7 of `docs/RESIDENT-MEMBER-CLIENT.md` (brief r12). The claim is not one path that
 * is emptied and refilled. Reclaiming a stale claim is itself an ownership operation, and the two
 * obvious ways to write it are both wrong:
 *
 *   * read-decide-unlink-create: between one contender's decision and its unlink, another can clear
 *     the same stale claim and create its own, and the first contender's `rm` then deletes that NEW
 *     claim before creating a second. Two live holders. Measured with real process concurrency:
 *     eight contenders against one stale claim admitted two holders, 2026-09-08 03:56Z.
 *   * rename to a tombstone: `fs.rename` REPLACES an existing destination and returns success, so
 *     "exactly one renamer wins" is false — and a late reclaimer's rename moves a legitimate
 *     successor's LIVE claim out of the path exactly as an unlink would delete it. The
 *     read-then-act window reappears inside the operation chosen to close it.
 *
 *     Measured on both platforms rather than assumed, because the reasoning that reached this file
 *     had it as a PORTABILITY SPLIT — POSIX `rename(2)` replacing while Windows refuses — which
 *     would have made rename correct on one platform and a cross-platform hazard rather than a
 *     mistake. It is not a split at the layer this code calls: `fs.renameSync` over an existing
 *     file succeeded on ext4 AND on NTFS (Node 22, 2026-09-08), because Node's Windows rename is
 *     `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`. The raw Win32 `MoveFile` does refuse, which is
 *     where the split belongs and why it was believed; it is not the call available here. So the
 *     argument against rename is simpler and stronger than the one that produced it: rename selects
 *     no winner ANYWHERE, and no platform makes it safe.
 *
 * A unique token per acquire (the shape this file carried at `921022c`) does close the reuse (ABA)
 * question without a floor, and that is a real merit. It does not make read-and-remove atomic, so
 * it still needs a lock, whose own residual — a reclaimer dying while holding it — is the same
 * delayed-actor race one level up. And a unique name NEVER COLLIDES, so an `O_EXCL` create on it
 * selects no winner at all; the create stops being a compare-and-swap and the lock becomes the
 * whole of the exclusion.
 *
 * So: `<claims>/<digest>/` holds per-generation files `<n>.claim`, each created `O_EXCL`, and the
 * holder is the creator of the highest generation present whose process is live. Four contracts
 * make that sound, and each is pinned by a cell:
 *
 *   1. **The same next name.** A taker's generation is one above the highest number PRESENT, so
 *      every taker that decided on the same record computes the SAME name and `O_EXCL` admits
 *      exactly one. A loser gets `EEXIST`, re-reads, and finds the live holder.
 *   2. **The spawn follows the LISTING, not the create.** After its own create succeeds a taker
 *      lists the directory once more: a higher generation present means a faster contender already
 *      reclaimed past it, so it removes only its own file and holds nothing. A taker that spawned
 *      on the strength of its create would be the second Tailcat child this module exists to
 *      prevent.
 *   3. **A durable floor across release.** The generation is one above the highest file present
 *      whether that file is live, dead or RELEASED: release never empties the directory — the
 *      holder marks its own file released with an `O_EXCL` sidecar and leaves the claim — so the
 *      highest number ever issued always survives and no number is ever reissued. Without it a
 *      delayed taker's `2` outranks a fresh live `1` taken after a clean release, and no listing
 *      can see the difference.
 *   4. **Nothing is renamed, and nobody removes a file it did not create** — except the holder
 *      pruning generations strictly below its own after the listing, which is safe because its own
 *      file is then the floor. A delayed prune of a dead generation is harmless by construction,
 *      and a delayed taker's late create is caught by its own post-create listing.
 *
 * **A live holder is never taken.** Staleness is proven death and nothing else — the pid probe plus
 * boot epoch that armed records use, never presence and never a heartbeat timeout — so there is no
 * "false-stale" case for a slow holder to notice later. A holder loses the key only by its own
 * stop; an operator who wants it replaced runs `member stop` (which tears the Tailcat child down
 * before it returns) and then `start`.
 *
 * A concurrent loser LOSES BY NAME and does not wait, in both directions. Waiting needs a bound,
 * and a bound is a second policy to get wrong; the refusal instead names the holder's pid, boot
 * epoch and `kind`, so a start refused by a `gate` reads as retry in seconds while one refused by
 * a live `resident` reads as already running, pid N.
 */
import { mkdir, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import { publicNodeKeyDigest } from "./protocol/route.mjs";
import { bootEpoch, pidAlive } from "./session.mjs";

/** How many times an acquire will re-read and race for the next generation before giving up. */
const CLAIM_ATTEMPTS = 8;

/** The two kinds of key-bearing dialer. A third would be a third way to spawn a child. */
export const CLAIM_KINDS = Object.freeze(["resident", "gate"]);

/** The file suffixes a generation can carry. `child` is seam 8's teardown proof. */
const CLAIM_SUFFIXES = Object.freeze(["claim", "released", "child"]);

const GENERATION_FILE = /^(\d+)\.(claim|released|child)$/;

/**
 * A held claim, as it sits on disk. `generation` is the number in its filename: it is unique for
 * the life of the directory, because the floor guarantees no number is ever reissued, so it is
 * also what a release is fenced by.
 * @typedef {object} KeyClaimRecord
 * @property {string} keyDigest the enrolled key digest this claim is over (`sha256:<64 hex>`)
 * @property {number} pid the process holding it
 * @property {number} bootEpoch the boot that pid belongs to; a pid outlives nothing across a reboot
 * @property {'resident' | 'gate'} kind what the holder is, so a refusal is actionable
 * @property {number} generation the file's number
 * @property {string} startedAt
 * @property {string} [label] free text for the refusal line (an alias, a probe name)
 */

/** @param {string} code @param {string} detail */
function claimRefusal(code, detail) {
  return Object.assign(new AgoraError(`${code}: ${detail}`), { code });
}

/** @param {string} raw */
function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/**
 * The claim's DIRECTORY. The digest's hex half is the directory name: a `sha256:` prefix is not a
 * path segment on every filesystem, and every record carries the full digest anyway.
 * @param {string} stateRoot a CANONICAL state root (see {@link canonicalStateRoot})
 * @param {string} keyDigest
 */
export function keyClaimDir(stateRoot, keyDigest) {
  const hex = /^sha256:([a-f0-9]{64})$/.exec(String(keyDigest));
  if (!hex) throw claimRefusal("member-key-claim-digest-invalid", `expected sha256:<64 hex>, got ${JSON.stringify(String(keyDigest))}`);
  return path.join(stateRoot, "native", "member", "claims", hex[1]);
}

/**
 * One generation's file. `suffix` is `claim`, `released` or `child`.
 * @param {string} dir @param {number} generation @param {'claim' | 'released' | 'child'} [suffix]
 */
export function keyClaimFile(dir, generation, suffix = "claim") {
  if (!Number.isInteger(generation) || generation <= 0)
    throw claimRefusal("member-key-claim-generation-invalid", `a generation is a positive integer, got ${JSON.stringify(generation)}`);
  if (!CLAIM_SUFFIXES.includes(suffix))
    throw claimRefusal("member-key-claim-generation-invalid", `unknown claim file suffix ${JSON.stringify(suffix)}`);
  return path.join(dir, `${generation}.${suffix}`);
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
  if (typeof rec.keyDigest !== "string") return undefined;
  if (!Number.isInteger(rec.generation) || Number(rec.generation) <= 0) return undefined;
  if (!Number.isInteger(rec.pid) || Number(rec.pid) <= 0) return undefined;
  if (typeof rec.kind !== "string" || !CLAIM_KINDS.includes(rec.kind)) return undefined;
  return /** @type {KeyClaimRecord} */ (rec);
}

/**
 * Is the process this claim names still the one that took it? The pid alone is not enough — pids
 * are reused, and a claim written before a reboot names a pid that now belongs to something else,
 * so a crashed resident would fence out every later start forever. This is `armedAlive`'s test,
 * deliberately: a claim is an armed record with one holder.
 * @param {{ pid: number, bootEpoch?: number }} claim
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 */
export function claimAlive(claim, deps = {}) {
  if (typeof claim.bootEpoch === "number" && Math.abs((deps.boot ?? bootEpoch()) - claim.bootEpoch) > 2) return false;
  return pidAlive(claim.pid, deps.kill);
}

/** @param {KeyClaimRecord} claim */
function holderDetail(claim) {
  const label = claim.label ? ` (${claim.label})` : "";
  return `${claim.kind} pid ${claim.pid}${label}, generation ${claim.generation}, held since ${claim.startedAt}`;
}

/**
 * @typedef {object} ClaimDirScan
 * @property {string} dir
 * @property {number} floor the highest generation number PRESENT under any suffix; 0 when empty.
 *   This is the durable floor: it counts released and dead generations, so no number is reissued.
 * @property {{ generation: number, record: KeyClaimRecord } | undefined} holder the live, unreleased
 *   claim of the highest generation, if any
 * @property {number[]} generations every generation number present, ascending
 * @property {Set<number>} released generations whose holder marked them released
 * @property {number[]} malformed generations whose `.claim` file could not be read as a claim
 * @property {Map<number, { bootEpoch: number, pids: number[] }>} children per generation, the
 *   Tailcat children its holder recorded and had not seen exit. Seam 8's death proof: a holder
 *   that crashed leaves this behind, and a replacement that spawned beside a child still dying
 *   would be the second peer on the key exactly as a second resident would.
 */

/**
 * Read the claim directory once. Everything else in this module is a decision on top of this.
 *
 * A `.claim` file that cannot be parsed is reported, never cleared and never counted as free: an
 * unreadable claim may belong to a live process, and clearing it is how the second child gets
 * spawned. It still counts toward the floor, because its number was issued.
 * @param {string} dir
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 * @returns {Promise<ClaimDirScan>}
 */
export async function scanClaimDir(dir, deps = {}) {
  /** @type {string[]} */
  let entries;
  try { entries = await readdir(dir); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT")
      return { dir, floor: 0, holder: undefined, generations: [], released: new Set(), malformed: [], children: new Map() };
    throw error;
  }

  /** @type {Set<number>} */
  const claims = new Set();
  /** @type {Set<number>} */
  const released = new Set();
  /** @type {Set<number>} */
  const childFiles = new Set();
  /** @type {Set<number>} */
  const all = new Set();
  for (const name of entries) {
    const match = GENERATION_FILE.exec(name);
    if (!match) continue;
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation <= 0) continue;
    all.add(generation);
    if (match[2] === "claim") claims.add(generation);
    if (match[2] === "released") released.add(generation);
    if (match[2] === "child") childFiles.add(generation);
  }

  const generations = [...all].sort((a, b) => a - b);
  const floor = generations.length ? generations[generations.length - 1] : 0;

  /** @type {{ generation: number, record: KeyClaimRecord } | undefined} */
  let holder;
  /** @type {number[]} */
  const malformed = [];
  // Descending: the holder is the HIGHEST live unreleased claim. Scanning every unreleased claim
  // rather than only the top one fails toward refusing, which is the safe direction here.
  for (const generation of [...claims].sort((a, b) => b - a)) {
    if (released.has(generation)) continue;
    /** @type {string} */
    let raw;
    try { raw = await readFile(keyClaimFile(dir, generation), "utf8"); }
    catch (error) {
      // Vanished between the listing and the read: a prune or a self-removal racing us. Not ours
      // to judge; the caller re-reads.
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") continue;
      malformed.push(generation);
      continue;
    }
    const record = parseClaim(safeParse(raw));
    if (!record) { malformed.push(generation); continue; }
    if (!holder && claimAlive(record, deps)) holder = { generation, record };
  }

  /** @type {Map<number, { bootEpoch: number, pids: number[] }>} */
  const children = new Map();
  for (const generation of childFiles) {
    /** @type {any} */
    let record;
    try { record = safeParse(await readFile(keyClaimFile(dir, generation, "child"), "utf8")); }
    catch { continue; }
    if (!record || typeof record !== "object") continue;
    const pids = Array.isArray(record.pids) ? record.pids.filter((/** @type {unknown} */ pid) => Number.isInteger(pid) && Number(pid) > 0) : [];
    children.set(generation, { bootEpoch: Number(record.bootEpoch), pids });
  }

  return { dir, floor, holder, generations, released, malformed: malformed.sort((a, b) => a - b), children };
}

/**
 * The Tailcat children a generation's holder recorded and that are still ALIVE on this boot.
 *
 * Seam 8's teardown proof, and the only reason it exists: a holder that DIED does not tear its
 * child down, and the child of a dead resident is still a peer on the enrolled key. A replacement
 * that spawned beside it would be exactly the second child this module prevents everywhere else,
 * arriving through the one door a claim cannot see — the previous holder's corpse.
 *
 * A boot epoch that does not match this one means the pids belong to a machine state that is gone,
 * so they are not probed at all: a reused pid would otherwise fence the key out forever.
 * @param {ClaimDirScan} scan @param {number} generation
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 * @returns {number[]} the pids still answering
 */
export function liveClaimChildren(scan, generation, deps = {}) {
  const record = scan.children.get(generation);
  if (!record || !record.pids.length) return [];
  if (Number.isFinite(record.bootEpoch) && Math.abs((deps.boot ?? bootEpoch()) - record.bootEpoch) > 2) return [];
  return record.pids.filter((pid) => pidAlive(pid, deps.kill));
}

/**
 * Record the Tailcat children this holder currently owns, so a replacement can prove they are gone.
 * Written by the holder AFTER each spawn and rewritten as children exit; removed by
 * {@link clearClaimChildren} once teardown is confirmed. It is the holder's own file, so the
 * "nobody removes a file it did not create" rule is not bent by rewriting it.
 * @param {string} dir @param {number} generation @param {Iterable<number>} pids
 * @param {{ boot?: number }} [deps]
 */
export async function recordClaimChildren(dir, generation, pids, deps = {}) {
  const list = [...pids].filter((pid) => Number.isInteger(pid) && pid > 0);
  const file = keyClaimFile(dir, generation, "child");
  if (!list.length) { await rm(file, { force: true }).catch(() => {}); return; }
  await writeFile(file, `${JSON.stringify({ bootEpoch: deps.boot ?? bootEpoch(), pids: list })}
`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Teardown is finished: this generation owns no Tailcat child any more. Only after this may the
 * holder publish a release, which is why {@link releaseKeyClaim} refuses while the file names a
 * live pid rather than trusting the caller to have ordered its own shutdown correctly.
 * @param {string} dir @param {number} generation
 */
export async function clearClaimChildren(dir, generation) {
  await rm(keyClaimFile(dir, generation, "child"), { force: true }).catch(() => {});
}

/**
 * Remove every file of every generation strictly BELOW `generation`. Only the holder does this, and
 * only after its post-create listing said it holds: its own file is then the floor, so the floor
 * survives the prune. A file that vanished under us is somebody's own self-removal; `force` is the
 * whole error handling that needs.
 * @param {string} dir @param {number} generation
 */
async function pruneBelow(dir, generation) {
  /** @type {string[]} */
  let entries;
  try { entries = await readdir(dir); } catch { return; }
  for (const name of entries) {
    const match = GENERATION_FILE.exec(name);
    if (!match) continue;
    if (Number(match[1]) >= generation) continue;
    await rm(path.join(dir, name), { force: true }).catch(() => {});
  }
}

/**
 * Take ONE named generation: the `O_EXCL` create, then the post-create LISTING that decides whether
 * the create won anything.
 *
 * This is the whole of winner selection and it is exported so a reader's twin can drive the delayed
 * cases directly — a taker that decided on a record the world has since moved past is exactly a
 * call with a stale `generation`, and nothing else about it is special.
 *
 * @param {string} dir @param {number} generation @param {KeyClaimRecord} record
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 * @returns {Promise<{ outcome: 'held', path: string } | { outcome: 'taken' } | { outcome: 'lost', by: number }>}
 *   `taken` — the name already existed, so another taker of the same record won it.
 *   `lost` — the create succeeded but a HIGHER generation exists, so this taker removed its own
 *   file and holds nothing. It has spawned nothing, because the spawn follows this listing.
 */
export async function attemptClaimGeneration(dir, generation, record, deps = {}) {
  const file = keyClaimFile(dir, generation);
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") return { outcome: "taken" };
    throw error;
  }

  // THE POST-CREATE LISTING. The create admits one taker of this NAME; it says nothing about a
  // faster contender that already reclaimed past it. Spawning on the strength of the create is the
  // second child.
  const after = await scanClaimDir(dir, deps);
  if (after.floor > generation) {
    await rm(file, { force: true }).catch(() => {});
    return { outcome: "lost", by: after.floor };
  }

  await pruneBelow(dir, generation);
  return { outcome: "held", path: file };
}

/**
 * Take the key's claim, or refuse by name. This is the FIRST act of anything that will spawn a
 * Tailcat child under the enrolled key — before the spawn, not after, and never as a check
 * followed by a spawn.
 *
 * Refusals, each by `code`:
 * - `member-key-claim-held` — a live holder; the message names its kind, pid, generation and start.
 * - `member-key-claim-malformed` — a claim file that cannot be read as a claim. It is NOT cleared:
 *   an unreadable claim may belong to a live process, and clearing it is how the second child gets
 *   spawned. This one wants a person, exactly as an unusable `writer.lock` does.
 * - `member-key-claim-digest-invalid` — the caller's digest is not a key digest.
 * - `member-key-claim-contended` — every attempt lost its race. A real outcome under a race,
 *   distinct from a settled holder.
 *
 * @param {{ stateRoot: string, keyDigest: string, kind: 'resident' | 'gate', pid?: number, label?: string }} input
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number, now?: () => Date }} [deps]
 * @returns {Promise<{ dir: string, path: string, generation: number, record: KeyClaimRecord,
 *   release: () => Promise<boolean> }>}
 */
export async function takeKeyClaim(input, deps = {}) {
  if (!CLAIM_KINDS.includes(input.kind))
    throw claimRefusal("member-key-claim-kind-invalid", `expected one of ${CLAIM_KINDS.join(", ")}, got ${JSON.stringify(String(input.kind))}`);
  const stateRoot = await canonicalStateRoot(input.stateRoot);
  const dir = keyClaimDir(stateRoot, input.keyDigest);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const scan = await scanClaimDir(dir, deps);
    if (scan.holder)
      throw claimRefusal("member-key-claim-held",
        `the enrolled key is held by ${holderDetail(scan.holder.record)}; this process spawns nothing`);
    if (scan.malformed.length)
      throw claimRefusal("member-key-claim-malformed",
        `${dir} carries a claim that is not readable (generation ${scan.malformed.join(", ")}); it is not cleared automatically, `
        + "because an unreadable claim may still belong to a live process");

    // TEARDOWN BEFORE REPLACEMENT. The holder is dead — that is why we got here — but a dead
    // holder tears nothing down, and its Tailcat child is still a peer on this key. Spawning now
    // is the second child arriving through the one door the claim cannot watch: the corpse of the
    // process that held it. Refuse by name and let the child finish dying.
    if (scan.floor) {
      const orphans = liveClaimChildren(scan, scan.floor, deps);
      if (orphans.length)
        throw claimRefusal("member-key-claim-child-alive",
          `generation ${scan.floor}'s holder is gone but its Tailcat child is still running `
          + `(pid ${orphans.join(", ")}); a replacement started now would be a second peer on this key. `
          + "Wait for it to exit, or stop it deliberately");
    }

    const generation = scan.floor + 1;
    /** @type {KeyClaimRecord} */
    const record = {
      keyDigest: input.keyDigest,
      pid: input.pid ?? process.pid,
      bootEpoch: deps.boot ?? bootEpoch(),
      kind: input.kind,
      generation,
      startedAt: (deps.now?.() ?? new Date()).toISOString(),
      ...(input.label ? { label: String(input.label) } : {}),
    };
    const result = await attemptClaimGeneration(dir, generation, record, deps);
    // `taken` — another taker of the same record won this name. `lost` — a faster contender is
    // already past us. Both re-read, and the next pass names the live holder in the refusal.
    if (result.outcome !== "held") continue;
    return {
      dir,
      path: result.path,
      generation,
      record,
      release: () => releaseKeyClaim(dir, generation, deps),
    };
  }
  throw claimRefusal("member-key-claim-contended",
    `the enrolled key's claim was re-taken by another process on every one of ${CLAIM_ATTEMPTS} attempts`);
}

/**
 * Release a claim by marking its own generation released and LEAVING the claim file in place.
 *
 * This is contract 3, the durable floor. Emptying the directory would let a delayed taker's stale
 * `2` outrank a fresh live `1`, and no listing could tell the two apart. Leaving the number behind
 * costs one small file per acquire, and the next holder prunes everything below itself.
 *
 * Never throws — a release runs in a `finally`, and a teardown that throws hides what it was
 * tearing down.
 * @param {string} dir @param {number} generation
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 * @returns {Promise<boolean>} true when this call marked this generation released; FALSE while the
 *   generation still owns a live Tailcat child, because a released state published ahead of child
 *   termination is how the next holder spawns beside a child still dying
 */
export async function releaseKeyClaim(dir, generation, deps = {}) {
  try {
    // A PUBLISHED RELEASE MUST NEVER PRECEDE CHILD TERMINATION. Ordering this in the caller's
    // shutdown path is not enough: the caller is exactly the process that is exiting, and an
    // unconfirmed teardown looks identical to a finished one from inside it. So the release reads
    // the holder's own child record and refuses while it names a live pid — the next holder then
    // sees a stale claim with a live child and is refused by name rather than spawning beside it.
    const scan = await scanClaimDir(dir, deps);
    if (liveClaimChildren(scan, generation, deps).length) return false;
    const handle = await open(keyClaimFile(dir, generation, "released"), "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify({ at: new Date().toISOString() })}\n`, "utf8"); }
    finally { await handle.close().catch(() => {}); }
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
 * @returns {Promise<{ dir: string, path: string, held: boolean | 'unknown', floor: number,
 *   stale?: boolean, claim?: KeyClaimRecord }>}
 */
export async function readKeyClaim(stateRoot, keyDigest, deps = {}) {
  const dir = keyClaimDir(await canonicalStateRoot(stateRoot), keyDigest);
  /** @type {ClaimDirScan} */
  let scan;
  try { scan = await scanClaimDir(dir, deps); }
  catch { return { dir, path: dir, held: "unknown", floor: 0 }; }

  if (scan.holder)
    return { dir, path: keyClaimFile(dir, scan.holder.generation), held: true, floor: scan.floor, claim: scan.holder.record };
  if (scan.malformed.length)
    return { dir, path: keyClaimFile(dir, scan.malformed[scan.malformed.length - 1]), held: "unknown", floor: scan.floor };
  if (!scan.floor) return { dir, path: dir, held: false, floor: 0 };

  // A floor with no live holder: either every generation was released cleanly, or the last holder
  // died. Only the second is STALE, and the difference is what an operator needs.
  const top = scan.floor;
  if (scan.released.has(top)) return { dir, path: keyClaimFile(dir, top), held: false, floor: scan.floor };
  /** @type {KeyClaimRecord | undefined} */
  let record;
  try { record = parseClaim(safeParse(await readFile(keyClaimFile(dir, top), "utf8"))); } catch { record = undefined; }
  return record
    ? { dir, path: keyClaimFile(dir, top), held: false, floor: scan.floor, stale: true, claim: record }
    : { dir, path: keyClaimFile(dir, top), held: false, floor: scan.floor };
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
