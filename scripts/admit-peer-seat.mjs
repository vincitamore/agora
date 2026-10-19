#!/usr/bin/env node
// @ts-check
/**
 * Host-seat peer route admission and authority bootstrap helper.
 *
 * Automates the counter-seat operator authority ceremony between a local operator-signer
 * state directory (`~/.agora/operator-signer`) and this seat's live service (`~/.agora/state`),
 * opens Tailcat member routes for admitted peer `nodekey:<64hex>` keys, and optionally exports
 * one self-contained kit per admitted peer (`<out-dir>/<alias>-<key prefix>/` holding
 * `descriptor.json`, `<routeGeneration>.secret` and `install-peer-route.mjs`) for handoff to
 * that peer seat.
 *
 * A running service is never stopped as a side effect. Routes belong to the service and a
 * restart drops every one of them, so a restart re-mints every peer's grant and generation and
 * strands every kit already installed on a remote. The helper therefore restarts only when the
 * authority policy the service loaded at start no longer covers what must be admitted, and only
 * when asked to with `--restart`. Without the flag it refuses before changing anything.
 *
 * Usage:
 *   # 1. Admit peers in one run on a stopped service; it starts with a policy covering them all
 *   #    and every peer gets a kit:
 *   node scripts/admit-peer-seat.mjs --room partner --allow-key nodekey:<64hex> --allow-key nodekey:<64hex> --out-dir ./kits
 *
 *   # 2. Admit one more peer's nodeKey (from their `agora enroll --local --json`). A key the running
 *   #    service's policy does not yet cover needs a restart; that is announced by a refusal until
 *   #    `--restart --out-dir <dir>` is passed, and then EVERY admitted peer gets a new kit:
 *   node scripts/admit-peer-seat.mjs --room partner --allow-key nodekey:<64hex> --out-dir ./kits --restart
 *
 *   # 3. Open any admitted route that is not live (a stopped service, a closed route) without
 *   #    touching the routes that are:
 *   node scripts/admit-peer-seat.mjs --reopen
 *
 *   # Bootstrap the host authority and ensure the native room exists, admitting nobody yet (the
 *   # service it starts holds a policy with no peer key, so the first admission after it needs
 *   # --restart as in step 2):
 *   node scripts/admit-peer-seat.mjs --room partner --bootstrap
 *
 * A run with nothing to do changes nothing and says so.
 */

import { generateKeyPairSync } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AgoraError, configPath, loadConfig, resolvePath, stateDir, writeFileAtomic } from "../src/core.mjs";
import { authorityIdForKey, readAuthorityRecord, validateAuthorityRecord } from "../src/authority.mjs";
import { humanKeyId } from "../src/protocol/human-authority.mjs";
import { publicNodeKeyDigest } from "../src/protocol/route.mjs";
import { nativeDigest } from "../src/native-protocol.mjs";
import { validatePublicNodeKey } from "../src/native-member.mjs";
import { localTransferIdentity } from "../src/tailcat.mjs";
import {
  challengeServiceRoute,
  completeSeatAuthorityEnrollment,
  createServiceRoom,
  listServiceRoutes,
  openServiceRoute,
  prepareSeatAuthorityEnrollment,
  seatAccountId,
  seatLabel,
  serviceStatus,
  signSeatAuthorityEnrollment,
  signSeatRouteAct,
  startService,
  stopService,
} from "../src/service-cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entryFile = path.resolve(__dirname, "..", "bin", "agora.mjs");

/** The all-zero key digest used only to give a policy its mandatory first entry. */
const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;
const PLACEHOLDER_KEY = `nodekey:${"0".repeat(64)}`;

/**
 * Everything the helper reaches outside itself through. A test replaces these to run the whole
 * admission against an in-process service and a fake Tailcat; the CLI uses the defaults.
 * @typedef {{
 *   startService: typeof startService,
 *   stopService: typeof stopService,
 *   serviceStatus: typeof serviceStatus,
 *   identity?: (root: string) => Promise<{ nodeKey: string }>,
 * }} Deps
 */

/** @typedef {{ roomId: string, alias?: string, publicNodeKey: string, allowedKeyDigest: string, addedAt: string }} RosterEntry */

/**
 * @param {string} stateRoot
 * @returns {Promise<{ entries: RosterEntry[] }>}
 */
async function readAdmittedRoster(stateRoot) {
  const file = path.join(stateRoot, "native", "admitted-peers.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch {}
  return { entries: [] };
}

/**
 * @param {string} stateRoot
 * @param {{ entries: RosterEntry[] }} roster
 */
async function writeAdmittedRoster(stateRoot, roster) {
  const file = path.join(stateRoot, "native", "admitted-peers.json");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, JSON.stringify(roster, null, 2) + "\n");
}

/**
 * Whether `record`'s policy already authorizes every entry in `wanted` for both route acts and
 * is still inside its validity window.
 * @param {{ policy: { expiresAt: string, entries: Array<{ roomId: string, allowedKeyDigest: string, actions: string[] }> } }} record
 * @param {RosterEntry[]} wanted
 */
function policyCovers(record, wanted) {
  if (Date.parse(record.policy.expiresAt) <= Date.now()) return false;
  return wanted.every((w) => record.policy.entries.some((e) =>
    e.roomId === w.roomId && e.allowedKeyDigest === w.allowedKeyDigest
    && e.actions.includes("room-enroll") && e.actions.includes("room-revoke")));
}

/**
 * The signer's authority record, when one has been created.
 * @param {string} signerRoot
 */
async function readSignerRecord(signerRoot) {
  const keyFile = path.join(signerRoot, "native", "authority-key.json");
  if (!existsSync(keyFile)) return undefined;
  const existing = JSON.parse(await readFile(keyFile, "utf8"));
  return validateAuthorityRecord(existing.record);
}

/**
 * Ensure the local operator-signer state directory has an Ed25519 signing key and updated policy,
 * and enroll that authority record into `stateRoot`.
 * @param {string} stateRoot
 * @param {string} signerRoot
 * @param {Array<{ roomId: string, allowedKeyDigest: string }>} policyEntries
 * @param {(root: string) => Promise<{ nodeKey: string }>} readIdentity
 */
async function ensureOperatorAuthority(stateRoot, signerRoot, policyEntries, readIdentity) {
  await mkdir(path.join(stateRoot, "native"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(signerRoot, "native"), { recursive: true, mode: 0o700 });

  const targetIdentity = await readIdentity(stateRoot);
  const signerIdentity = await readIdentity(signerRoot);

  const keyFile = path.join(signerRoot, "native", "authority-key.json");
  let privateJwk;
  let publicKeyHex;
  let revision = 1;

  if (existsSync(keyFile)) {
    const existing = JSON.parse(await readFile(keyFile, "utf8"));
    privateJwk = existing.privateKey;
    publicKeyHex = existing.record.publicKey;
    revision = (Number(existing.record?.policy?.revision) || 1) + 1;
  } else {
    const keys = generateKeyPairSync("ed25519");
    privateJwk = keys.privateKey.export({ format: "jwk" });
    publicKeyHex = Buffer.from(/** @type {string} */ (keys.publicKey.export({ format: "jwk" }).x), "base64url").toString("hex");
  }

  const nowMs = Date.now();
  const validFrom = new Date(nowMs - 60_000).toISOString();
  const expiresAt = new Date(nowMs + 365 * 86_400_000).toISOString();
  // Policy requires at least one entry; include a placeholder if bootstrapping before first peer key
  const effectiveEntries =
    policyEntries.length > 0
      ? policyEntries.map((e) => ({
          roomId: e.roomId,
          allowedKeyDigest: e.allowedKeyDigest,
          actions: ["room-enroll", "room-revoke"],
        }))
      : [
          {
            roomId: "0".repeat(32),
            allowedKeyDigest: PLACEHOLDER_DIGEST,
            actions: ["room-enroll", "room-revoke"],
          },
        ];

  const authorityId = authorityIdForKey(publicKeyHex);
  const record = validateAuthorityRecord({
    version: 1,
    algorithm: "ed25519",
    authorityId,
    publicKey: publicKeyHex,
    keyId: humanKeyId(publicKeyHex),
    boundNodeKeyDigest: publicNodeKeyDigest(signerIdentity.nodeKey),
    enrolledAt: new Date(nowMs).toISOString(),
    enrolledBy: "operator-local-bootstrap",
    label: `${seatLabel()}-operator-signer`,
    profile: "pinned-cooperative",
    policy: {
      policyId: authorityId.slice(2, 34),
      revision,
      validFrom,
      expiresAt,
      entries: effectiveEntries,
    },
  });

  await writeFileAtomic(keyFile, JSON.stringify({ record, privateKey: privateJwk }, null, 2) + "\n");
  if (process.platform !== "win32") await chmod(keyFile, 0o600);

  // Remove old enrolled copy of this authorityId if updating policy revision
  const targetAuthorityFile = path.join(stateRoot, "native", "authorities", `${authorityId}.json`);
  await rm(targetAuthorityFile, { force: true });

  const challenge = await prepareSeatAuthorityEnrollment(
    stateRoot,
    record,
    record.keyId,
    async () => targetIdentity,
  );
  const proof = await signSeatAuthorityEnrollment(
    signerRoot,
    challenge,
    async () => signerIdentity,
  );
  const enrolled = await completeSeatAuthorityEnrollment(
    stateRoot,
    proof,
    record.keyId,
    async () => targetIdentity,
  );
  return { authorityId: enrolled.authorityId, keyId: enrolled.keyId, targetNodeKey: targetIdentity.nodeKey };
}

/**
 * Write a peer route kit directory with `descriptor.json`, the `.secret` file, and a 1-command
 * installer script `install-peer-route.mjs` for the remote seat.
 * @param {string} outDir
 * @param {string} alias
 * @param {{ descriptor?: any, descriptorPath: string, secretRef?: string, secretPath: string, grantId: string }} opened
 */
async function exportPeerKit(outDir, alias, opened) {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  // A reissued kit replaces the one before it: a secret of an earlier generation left beside the
  // new one would be a live-looking credential for a route that no longer exists.
  for (const name of await readdir(outDir)) {
    if (name.endsWith(".secret")) await rm(path.join(outDir, name), { force: true });
  }
  const descOut = path.join(outDir, "descriptor.json");
  const secretName = path.basename(opened.secretPath);
  const secretOut = path.join(outDir, secretName);
  await copyFile(opened.descriptorPath, descOut);
  await copyFile(opened.secretPath, secretOut);
  if (process.platform !== "win32") await chmod(secretOut, 0o600);

  const installer = `#!/usr/bin/env node
// One-command peer route installer for Agora native-remote room "${alias}".
// Run on the peer seat from the directory containing this file:
//   node install-peer-route.mjs [--state ~/.agora/state]
import { copyFile, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateIdx = process.argv.indexOf("--state");
const stateRoot = stateIdx !== -1 && process.argv[stateIdx + 1]
  ? path.resolve(process.argv[stateIdx + 1])
  : process.env.AGORA_STATE
    ? path.resolve(process.env.AGORA_STATE)
    : path.join(homedir(), ".agora", "state");

const grantId = ${JSON.stringify(opened.grantId)};
const secretName = ${JSON.stringify(secretName)};
const alias = ${JSON.stringify(alias)};

const routeSecretDir = path.join(stateRoot, "native", "routes", grantId);
const remoteDescDir = path.join(stateRoot, "native", "remote", grantId);
await mkdir(routeSecretDir, { recursive: true, mode: 0o700 });
await mkdir(remoteDescDir, { recursive: true, mode: 0o700 });

const dstSecret = path.join(routeSecretDir, secretName);
const dstDesc = path.join(remoteDescDir, "descriptor.json");
await copyFile(path.join(here, secretName), dstSecret);
await copyFile(path.join(here, "descriptor.json"), dstDesc);
if (process.platform !== "win32") {
  await chmod(dstSecret, 0o600);
  await chmod(dstDesc, 0o600);
}

console.log("Installed route secret to:", dstSecret);
console.log("Installed route descriptor to:", dstDesc);
console.log("\\nNext step — verify and print the config row:");
console.log(\`  agora room add-remote \${alias} "\${dstDesc}"\`);
`;
  await writeFile(path.join(outDir, "install-peer-route.mjs"), installer, "utf8");
  return { dir: outDir, descOut, secretOut, installerPath: path.join(outDir, "install-peer-route.mjs") };
}

/** One kit folder per admitted key, named so two peers never share a directory.
 * @param {string} outDir @param {RosterEntry} entry */
function kitDir(outDir, entry) {
  const label = String(entry.alias || entry.roomId).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(outDir, `${label}-${entry.allowedKeyDigest.replace(/^sha256:/, "").slice(0, 12)}`);
}

/**
 * Admit peers and open their routes. Returns the run summary; prints nothing.
 * @param {string[]} argv
 * @param {Partial<Deps>} [overrides]
 */
export async function admit(argv, overrides = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      room: { type: "string" },
      "allow-key": { type: "string", multiple: true },
      "out-dir": { type: "string" },
      bootstrap: { type: "boolean", default: false },
      reopen: { type: "boolean", default: false },
      restart: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  /** @type {Deps} */
  const deps = { startService, stopService, serviceStatus, ...overrides };
  const readIdentity = deps.identity ?? ((/** @type {string} */ root) => localTransferIdentity(root));

  const cfgFile = configPath(values.config);
  const cfg = await loadConfig(cfgFile);
  const stateRoot = stateDir(cfg);
  const signerRoot = path.join(path.dirname(stateRoot), "operator-signer");
  const outDir = values["out-dir"] ? resolvePath(values["out-dir"]) : undefined;

  let roomId = "";
  let roomAlias = values.room || "partner";
  if (values.room) {
    if (/^[a-f0-9]{32}$/.test(values.room)) {
      roomId = values.room;
    } else {
      const r = cfg.rooms[values.room];
      if (!r || r.transport !== "native" || typeof r.roomId !== "string") {
        throw new AgoraError(`room "${values.room}" is not a configured native room in ${cfgFile}`, 2);
      }
      roomId = r.roomId;
    }
  }

  const roster = await readAdmittedRoster(stateRoot);
  const allowKeys = (values["allow-key"] ?? []).map((k) => validatePublicNodeKey(String(k).trim()));

  if (allowKeys.length > 0 && !roomId) {
    throw new AgoraError("--allow-key requires --room <native-room-alias-or-id>", 2);
  }

  // Who was admitted before this run: only those can hold a kit that a re-minted route strands.
  const previouslyAdmitted = new Set(roster.entries.map((e) => `${e.roomId}:${e.allowedKeyDigest}`));

  /** @type {RosterEntry[]} */
  const nextEntries = [...roster.entries];
  let rosterChanged = false;
  for (const key of allowKeys) {
    const digest = publicNodeKeyDigest(key);
    if (!nextEntries.some((e) => e.roomId === roomId && e.allowedKeyDigest === digest)) {
      nextEntries.push({
        roomId,
        alias: roomAlias,
        publicNodeKey: key,
        allowedKeyDigest: digest,
        addedAt: new Date().toISOString(),
      });
      rosterChanged = true;
    }
  }
  const admitted = nextEntries.filter((e) => e.publicNodeKey !== PLACEHOLDER_KEY);

  // Decide before changing anything on disk. The service reads its authority policy once, at
  // start; a policy that does not cover every admitted key cannot be loaded by a running one.
  const signerRecord = await readSignerRecord(signerRoot);
  /** @type {Awaited<ReturnType<typeof readAuthorityRecord>> | undefined} */
  let enrolled;
  if (signerRecord) {
    try { enrolled = await readAuthorityRecord(stateRoot, signerRecord.authorityId); } catch { enrolled = undefined; }
  }
  const authorityCurrent = Boolean(signerRecord && enrolled
    && policyCovers(signerRecord, admitted)
    && nativeDigest(enrolled.policy) === nativeDigest(signerRecord.policy));

  const before = await deps.serviceStatus(stateRoot);
  const running = Boolean(before.present && before.pidAlive);
  /** @type {Awaited<ReturnType<typeof listServiceRoutes>>} */
  const liveBefore = running ? await listServiceRoutes(stateRoot) : [];
  const isLive = (/** @type {RosterEntry} */ e) =>
    liveBefore.some((/** @type {any} */ r) => r.roomId === e.roomId && r.allowedKeyDigest === e.allowedKeyDigest);
  const missing = admitted.filter((e) => !isLive(e));

  /** @type {string | undefined} */
  let restartReason;
  /** @type {{ request: unknown, challenge: any } | undefined} */
  let probe;
  if (running) {
    if (!authorityCurrent) {
      restartReason = "the authority policy the running service loaded at start does not cover every admitted key";
    } else if (missing.length > 0) {
      const first = /** @type {RosterEntry} */ (missing[0]);
      try {
        probe = await challengeServiceRoute(stateRoot, "room-enroll", first.roomId, first.publicNodeKey);
      } catch (e) {
        restartReason = `the running service refused a route challenge (${e instanceof Error ? e.message : String(e)})`;
      }
      if (probe && signerRecord && probe.challenge.policyDigest !== nativeDigest(signerRecord.policy)) {
        restartReason = "the running service holds a different authority policy than the signer's";
        probe = undefined;
      }
    }
  }

  if (restartReason) {
    const affected = liveBefore.length;
    if (!values.restart) {
      throw new AgoraError(
        `restart required, nothing changed: ${restartReason}. The service reads that policy only at start, ` +
        `and a restart ends every local native watch and re-mints all ${affected} live route(s), so every ` +
        `remote's installed kit stops working until it installs a new one. Announce it, then re-run with ` +
        `--restart --out-dir <dir> to restart and reissue a kit for every admitted key.`, 2);
    }
    if (!outDir) {
      throw new AgoraError(
        "--restart requires --out-dir: every admitted key gets a new kit, and the kits have nowhere to go. Nothing changed.", 2);
    }
  }

  if (rosterChanged) {
    await writeAdmittedRoster(stateRoot, { entries: nextEntries });
  }

  let authorityWritten = false;
  let authorityId = signerRecord?.authorityId ?? "";
  let hostNodeKey = "";
  if (!authorityCurrent) {
    const policyEntries = [...nextEntries];
    if (roomId && !policyEntries.some((e) => e.roomId === roomId)) {
      // Include a placeholder entry for the room so the room is in the policy
      policyEntries.push({ roomId, allowedKeyDigest: PLACEHOLDER_DIGEST, publicNodeKey: PLACEHOLDER_KEY, addedAt: new Date().toISOString() });
    }
    const auth = await ensureOperatorAuthority(stateRoot, signerRoot, policyEntries, readIdentity);
    authorityId = auth.authorityId;
    hostNodeKey = auth.targetNodeKey;
    authorityWritten = true;
  } else {
    hostNodeKey = (await readIdentity(stateRoot)).nodeKey;
  }

  let restarted = false;
  let started = false;
  if (restartReason) {
    await deps.stopService(stateRoot);
    restarted = true;
  }
  if (!running || restarted) {
    const accountId = await seatAccountId(stateRoot);
    await deps.startService({
      root: stateRoot,
      entry: entryFile,
      execPath: process.execPath,
      accountId,
      seatLabel: seatLabel(),
      authorityId,
      configPath: cfgFile,
    });
    started = true;
  }
  const service = await deps.serviceStatus(stateRoot);

  // Ensure all configured native rooms exist on the service
  for (const [, r] of Object.entries(cfg.rooms)) {
    if (r && r.transport === "native" && typeof r.roomId === "string" && /^[a-f0-9]{32}$/.test(r.roomId)) {
      const roomDir = path.join(stateRoot, "native", "rooms", r.roomId);
      if (!existsSync(path.join(roomDir, "room.json"))) {
        await createServiceRoom(stateRoot, r.roomId);
      }
    }
  }

  // A fresh service has no routes; a surviving one keeps every route it already had, and only
  // the ones it lacks are opened.
  const liveNow = started ? [] : liveBefore;
  /** @type {Array<Record<string, any>>} */
  const openedRoutes = [];
  /** @type {RosterEntry[]} */
  const staleRemotes = [];
  let routesOpened = 0;
  for (const entry of admitted) {
    const named = allowKeys.includes(entry.publicNodeKey) && entry.roomId === roomId;
    const already = liveNow.find((/** @type {any} */ r) => r.roomId === entry.roomId && r.allowedKeyDigest === entry.allowedKeyDigest);
    if (already) {
      // Same grant, same generation: whatever kit this peer holds is still valid. A kit is
      // re-exported only when the caller names the key and asks for one.
      let kit = null;
      if (outDir && named) {
        kit = await exportPeerKit(kitDir(outDir, entry), entry.alias || roomAlias, already);
      }
      openedRoutes.push({
        roomId: entry.roomId, alias: entry.alias, accountId: already.accountId, grantId: already.grantId,
        routeGeneration: already.routeGeneration, descriptorPath: already.descriptorPath, secretPath: already.secretPath,
        reopened: false, ...(kit ? { kit } : {}),
      });
      continue;
    }
    const challenge = probe && entry === missing[0] && !started
      ? probe
      : await challengeServiceRoute(stateRoot, "room-enroll", entry.roomId, entry.publicNodeKey);
    const proof = await signSeatRouteAct(signerRoot, challenge, deps.identity);
    const opened = await openServiceRoute(stateRoot, entry.roomId, entry.publicNodeKey, proof);
    routesOpened++;
    const wasAdmitted = previouslyAdmitted.has(`${entry.roomId}:${entry.allowedKeyDigest}`);
    if (wasAdmitted) staleRemotes.push(entry);
    let kit = null;
    if (outDir) {
      kit = await exportPeerKit(kitDir(outDir, entry), entry.alias || roomAlias, {
        descriptorPath: opened.descriptorPath, secretPath: opened.secretPath, grantId: opened.descriptor.binding.grantId,
      });
    }
    openedRoutes.push({
      roomId: entry.roomId,
      alias: entry.alias,
      accountId: opened.descriptor.binding.accountId,
      grantId: opened.descriptor.binding.grantId,
      routeGeneration: opened.descriptor.binding.routeGeneration,
      descriptorPath: opened.descriptorPath,
      secretPath: opened.secretPath,
      reopened: true,
      ...(kit ? { kit } : {}),
    });
  }

  const changed = rosterChanged || authorityWritten || started || routesOpened > 0;
  return {
    ok: true,
    changed,
    service: {
      pid: service.pid, seatLabel: service.seatLabel, accountId: service.accountId, authorityId,
      started, restarted,
    },
    hostNodeKey,
    admittedCount: admitted.length,
    openedRoutes,
    /** Remotes admitted before this run whose installed kit named a route that no longer exists. */
    staleRemotes: staleRemotes.map((e) => ({
      roomId: e.roomId, alias: e.alias, publicNodeKey: e.publicNodeKey,
      ...(outDir ? { kitDir: kitDir(outDir, e) } : {}),
    })),
  };
}

/** @param {Awaited<ReturnType<typeof admit>>} summary */
function printSummary(summary) {
  const { service } = summary;
  if (!summary.changed) {
    console.log(`Nothing to do: service pid ${service.pid} is running and all ${summary.admittedCount} admitted route(s) are live. Nothing was changed.`);
  } else {
    const how = service.restarted ? "restarted" : service.started ? "started" : "running, left untouched";
    console.log(`Host service ready (${how}): pid ${service.pid} · seat ${service.seatLabel} · authority ${service.authorityId.slice(0, 18)}…`);
  }
  console.log(`Host Tailcat nodeKey: ${summary.hostNodeKey}`);
  for (const r of summary.openedRoutes) {
    console.log(`  route ${r.reopened ? "opened" : "already live"}: room ${r.alias || r.roomId} -> member ${r.accountId}`);
    console.log(`    descriptor: ${r.descriptorPath}`);
    console.log(`    secret:     ${r.secretPath}`);
    if (r.kit) console.log(`    exported kit: ${r.kit.installerPath}`);
  }
  if (summary.staleRemotes.length > 0) {
    console.log("");
    console.log(`NOTICE: ${summary.staleRemotes.length} previously admitted remote(s) now have a new route, and the kit each one installed earlier no longer works.`);
    console.log("Each must install its new kit (carry it by hand, never through a room) and replace its room row before it can dial again:");
    for (const s of summary.staleRemotes) {
      console.log(`  - ${s.publicNodeKey} (room ${s.alias || s.roomId})${s.kitDir ? `: kit at ${s.kitDir}` : ": no --out-dir given, so no kit was written; the files above are on this host"}`);
    }
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  admit(process.argv.slice(2))
    .then((summary) => {
      if (process.argv.includes("--json")) console.log(JSON.stringify(summary, null, 2));
      else printSummary(summary);
    })
    .catch((e) => {
      console.error(`admit-peer-seat: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
}
