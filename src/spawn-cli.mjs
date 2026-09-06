// @ts-check
/**
 * `agora spawn --file`: one bounded request in, one pane out. Never writes the shared config.
 */
import { readFile } from "node:fs/promises";
import { AgoraError, EXIT } from "./core.mjs";
import { parseSpawnRequest } from "./spawn/request.mjs";
import { connectSeatService } from "./wake/subscriber.mjs";

const SPAWN_ID_RE = /^[a-f0-9]{32}$/;

/**
 * @param {string} file
 */
export async function readSpawnRequestFile(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === "ENOENT") throw new AgoraError(`spawn request not found: ${file}`, EXIT.error);
    throw e;
  }
  const req = parseSpawnRequest(raw);
  if (req.harness === "hermes") {
    throw new AgoraError("spawn-unsupported: hermes has no interactive initial-prompt mechanism", EXIT.error);
  }
  return req;
}

/**
 * @param {string} stateRoot
 * @param {string} file
 */
export async function spawnFromFile(stateRoot, file) {
  const request = await readSpawnRequestFile(file);
  const { client } = await connectSeatService(stateRoot);
  try {
    const result = await client.request("spawn", { request });
    const spawnId = typeof result.spawnId === "string" ? result.spawnId : "";
    if (!SPAWN_ID_RE.test(spawnId)) throw new AgoraError("native service did not return a minted spawn id", EXIT.error);
    return spawnId;
  } finally {
    client.close();
  }
}
