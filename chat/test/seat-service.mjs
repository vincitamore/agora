// @ts-check
/**
 * A real agora seat service in a temporary state root, for the kit's tests: the service runs as its
 * own Node process through the agora CLI (as it does on a seat), one native room is minted on it,
 * and a config names that room. The test talks to it through `agora/client`, in process, as a host
 * does. Stopped and removed in the test's own after-hook, the service first and the directory
 * second (after-hooks run in registration order, and a root removed under a live service leaves
 * the service running).
 *
 * Node is required: the seat service runs on Node 22+. Under Bun it is found on PATH (or named by
 * AGORA_TEST_NODE); under Node it is the running executable.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The agora checkout this kit lives in. */
export const AGORA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(AGORA_DIR, "bin", "agora.mjs");

/** The Node executable that runs the agora CLI and its service. */
export function nodeExecutable() {
  if (process.env.AGORA_TEST_NODE) return process.env.AGORA_TEST_NODE;
  if (!process.versions.bun) return process.execPath;
  const found = /** @type {any} */ (globalThis).Bun?.which?.("node");
  if (typeof found !== "string" || !found) throw new Error("the seat service needs Node 22+: put node on PATH or set AGORA_TEST_NODE");
  return found;
}

/**
 * Start a seat service with one native room.
 * @param {import("node:test").TestContext} t
 * @param {{ alias?: string, seatLabel?: string }} [options]
 * @returns {Promise<{ agoraDir: string, root: string, state: string, config: string, roomId: string, alias: string, agora: (args: string[]) => Promise<{ stdout: string, stderr: string }> }>}
 */
export async function startSeat(t, options = {}) {
  const alias = options.alias ?? "main";
  const root = await mkdtemp(path.join(tmpdir(), "agora-chat-"));
  const state = path.join(root, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const config = path.join(root, "agora.json");
  // a fresh seat's service needs one room in the config before it can mint its first native room
  const desk = { transport: "local", path: path.join(root, "desk.ndjson") };
  await writeFile(config, JSON.stringify({ actor: { name: "Tester/kit", kind: "agent" }, state, rooms: { desk } }), "utf8");
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, AGORA_CONFIG: config, AGORA_STATE: state, AGORA_SESSION: "chat-test" };
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID",
    "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_ACTOR"]) delete env[name];
  const node = nodeExecutable();
  /** @param {string[]} args */
  const agora = (args) => run(node, [BIN, ...args], { env, windowsHide: true, timeout: 30_000 });

  let started = false;
  t.after(async () => {
    if (started) await agora(["service", "stop"]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await agora(["service", "start"]);
  started = true;
  const { stdout } = await agora(["service", "room", "create", "--json"]);
  const roomId = JSON.parse(stdout.trim()).roomId;
  if (!/^[a-f0-9]{32}$/.test(roomId)) throw new Error(`service room create printed no room id: ${stdout}`);
  await writeFile(config, JSON.stringify({ actor: { name: "Tester/kit", kind: "agent" }, state, rooms: { desk, [alias]: { transport: "native", roomId } } }), "utf8");
  return { agoraDir: AGORA_DIR, root, state, config, roomId, alias, agora };
}
