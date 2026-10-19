#!/usr/bin/env node
// @ts-check
/**
 * Host-seat peer route admission and authority bootstrap helper.
 *
 * Automates the counter-seat operator authority ceremony between a local operator-signer
 * state directory (`~/.agora/operator-signer`) and this seat's live service (`~/.agora/state`),
 * opens Tailcat member routes for admitted peer `nodekey:<64hex>` keys, and optionally exports
 * a self-contained peer bundle (`descriptor.json`, `<grantId>/<routeGeneration>.secret`, and
 * `install-peer-route.mjs`) for handoff to the peer seat.
 *
 * Usage:
 *   # 1. Bootstrap the host authority and ensure native room is open:
 *   node scripts/admit-peer-seat.mjs --room partner --bootstrap
 *
 *   # 2. Admit a peer's nodeKey (from their `agora enroll --local --json`) and export their kit:
 *   node scripts/admit-peer-seat.mjs --room partner --allow-key nodekey:<64hex> --out-dir ./partner-kit
 *   # 3. Re-open all previously admitted routes after a service restart:
 *   node scripts/admit-peer-seat.mjs --reopen
 */

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AgoraError, configPath, loadConfig, resolvePath, stateDir, writeFileAtomic } from "../src/core.mjs";
import { authorityIdForKey, validateAuthorityRecord } from "../src/authority.mjs";
import { humanKeyId } from "../src/protocol/human-authority.mjs";
import { publicNodeKeyDigest } from "../src/protocol/route.mjs";
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

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    room: { type: "string" },
    "allow-key": { type: "string", multiple: true },
    "out-dir": { type: "string" },
    bootstrap: { type: "boolean", default: false },
    reopen: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  strict: true,
});

/**
 * @param {string} stateRoot
 * @returns {Promise<{ entries: Array<{ roomId: string, alias?: string, publicNodeKey: string, allowedKeyDigest: string, addedAt: string }> }>}
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
 * @param {{ entries: Array<{ roomId: string, alias?: string, publicNodeKey: string, allowedKeyDigest: string, addedAt: string }> }} roster
 */
async function writeAdmittedRoster(stateRoot, roster) {
  const file = path.join(stateRoot, "native", "admitted-peers.json");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, JSON.stringify(roster, null, 2) + "\n");
}

/**
 * Ensure the local operator-signer state directory has an Ed25519 signing key and updated policy,
 * and enroll that authority record into `stateRoot`.
 * @param {string} stateRoot
 * @param {string} signerRoot
 * @param {Array<{ roomId: string, allowedKeyDigest: string }>} policyEntries
 */
async function ensureOperatorAuthority(stateRoot, signerRoot, policyEntries) {
  await mkdir(path.join(stateRoot, "native"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(signerRoot, "native"), { recursive: true, mode: 0o700 });

  const targetIdentity = await localTransferIdentity(stateRoot);
  const signerIdentity = await localTransferIdentity(signerRoot);

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
            allowedKeyDigest: `sha256:${"0".repeat(64)}`,
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
 * @param {{ descriptor: any, descriptorPath: string, secretRef: string, secretPath: string }} opened
 */
async function exportPeerKit(outDir, alias, opened) {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const descOut = path.join(outDir, "descriptor.json");
  const secretName = path.basename(opened.secretRef);
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

const grantId = ${JSON.stringify(opened.descriptor.binding.grantId)};
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
  return { descOut, secretOut, installerPath: path.join(outDir, "install-peer-route.mjs") };
}

async function main() {
  const cfgFile = configPath(values.config);
  const cfg = await loadConfig(cfgFile);
  const stateRoot = stateDir(cfg);
  const signerRoot = path.join(path.dirname(stateRoot), "operator-signer");

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

  let rosterChanged = false;
  for (const key of allowKeys) {
    const digest = publicNodeKeyDigest(key);
    if (!roster.entries.some((e) => e.roomId === roomId && e.allowedKeyDigest === digest)) {
      roster.entries.push({
        roomId,
        alias: roomAlias,
        publicNodeKey: key,
        allowedKeyDigest: digest,
        addedAt: new Date().toISOString(),
      });
      rosterChanged = true;
    }
  }
  if (rosterChanged) {
    await writeAdmittedRoster(stateRoot, roster);
  }

  const policyEntries = [...roster.entries];
  if (roomId && !policyEntries.some((e) => e.roomId === roomId)) {
    // Include a placeholder entry for the room so the room is in the policy
    policyEntries.push({
      roomId,
      allowedKeyDigest: `sha256:${"0".repeat(64)}`,
      publicNodeKey: `nodekey:${"0".repeat(64)}`,
      addedAt: new Date().toISOString(),
    });
  }

  const auth = await ensureOperatorAuthority(stateRoot, signerRoot, policyEntries);

  // Restart service if needed so it loads the updated authority snapshot
  const status = await serviceStatus(stateRoot);
  if (status.present && status.pidAlive) {
    await stopService(stateRoot);
  }
  const accountId = await seatAccountId(stateRoot);
  const started = await startService({
    root: stateRoot,
    entry: entryFile,
    execPath: process.execPath,
    accountId,
    seatLabel: seatLabel(),
    authorityId: auth.authorityId,
    configPath: cfgFile,
  });

  // Ensure all configured native rooms exist on the service
  for (const [, r] of Object.entries(cfg.rooms)) {
    if (r && r.transport === "native" && typeof r.roomId === "string" && /^[a-f0-9]{32}$/.test(r.roomId)) {
      const roomDir = path.join(stateRoot, "native", "rooms", r.roomId);
      if (!existsSync(path.join(roomDir, "room.json"))) {
        await createServiceRoom(stateRoot, r.roomId);
      }
    }
  }

  // Open routes for all entries in roster (since service restart resets in-memory routes)
  const openedRoutes = [];
  const liveRoutes = await listServiceRoutes(stateRoot);
  for (const entry of roster.entries) {
    if (entry.publicNodeKey === `nodekey:${"0".repeat(64)}`) continue;
    const already = liveRoutes.find((r) => r.roomId === entry.roomId && r.allowedKeyDigest === entry.allowedKeyDigest);
    if (already) {
      openedRoutes.push({ roomId: entry.roomId, alias: entry.alias, accountId: already.accountId, descriptorPath: already.descriptorPath, secretPath: already.secretPath, reopened: false });
      continue;
    }
    const challenge = await challengeServiceRoute(stateRoot, "room-enroll", entry.roomId, entry.publicNodeKey);
    const proof = await signSeatRouteAct(signerRoot, challenge);
    const opened = await openServiceRoute(stateRoot, entry.roomId, entry.publicNodeKey, proof);
    let kit = null;
    if (values["out-dir"] && allowKeys.includes(entry.publicNodeKey)) {
      kit = await exportPeerKit(resolvePath(values["out-dir"]), entry.alias || roomAlias, opened);
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

  const summary = {
    ok: true,
    service: { pid: started.pid, seatLabel: started.seatLabel, accountId: started.accountId, authorityId: auth.authorityId },
    hostNodeKey: auth.targetNodeKey,
    admittedCount: roster.entries.length,
    openedRoutes,
  };

  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Host service ready: pid ${started.pid} · seat ${started.seatLabel} · authority ${auth.authorityId.slice(0, 18)}…`);
    console.log(`Host Tailcat nodeKey: ${auth.targetNodeKey}`);
    for (const r of openedRoutes) {
      console.log(`  route open: room ${r.alias || r.roomId} -> member ${r.accountId}`);
      console.log(`    descriptor: ${r.descriptorPath}`);
      console.log(`    secret:     ${r.secretPath}`);
      if (r.kit) {
        console.log(`    exported kit: ${r.kit.installerPath}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(`admit-peer-seat: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
