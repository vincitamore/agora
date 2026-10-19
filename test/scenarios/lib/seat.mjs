// @ts-check
/**
 * A real seat for a scenario: the agora seat service started through the CLI as its own Node
 * process in a temporary root, one native room minted on it, a config naming that room, and a fake
 * home inside the root so no harness file outside it is ever read. The pattern is
 * chat/test/seat-service.mjs `startSeat`, without node:test's lifecycle: a scenario is a plain
 * process that opens its seat and closes it in a `finally`.
 *
 * Every process the seat starts (the service, stand-in harness processes, background watches) is
 * stopped by the exact pid it was started with, never by name, and the root is removed last. The
 * operator's own state (`~/.agora`) is never named: AGORA_CONFIG, AGORA_STATE, HOME and USERPROFILE
 * all point inside the root.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The agora checkout these scenarios live in. */
export const AGORA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const BIN = path.join(AGORA_DIR, "bin", "agora.mjs");

/** Variables a harness injects; a scenario participant carries only the ones it is given. */
const CLEARED = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "OMP_SESSION_ID", "OMP_PID", "GROK_SESSION_ID", "GROK_PID",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE",
  "AGORA_LABEL"];

/** The Node executable that runs the CLI and its service (Node 22+). */
export function nodeExecutable() {
  if (process.env.AGORA_TEST_NODE) return process.env.AGORA_TEST_NODE;
  if (!process.versions.bun) return process.execPath;
  const found = /** @type {any} */ (globalThis).Bun?.which?.("node");
  if (typeof found !== "string" || !found) throw new Error("the seat service needs Node 22+: put node on PATH or set AGORA_TEST_NODE");
  return found;
}

/** @typedef {{ code: number, stdout: string, stderr: string }} CliResult */

/**
 * @typedef {object} Seat
 * @property {string} root
 * @property {string} state
 * @property {string} home
 * @property {string} config
 * @property {string} roomId
 * @property {string} alias
 * @property {string} seatName the config's actor name: the seat's own name
 * @property {(args: string[], env?: Record<string, string>) => Promise<CliResult>} cli
 * @property {(args: string[], env?: Record<string, string>) => { pid: number, done: Promise<CliResult>, output: () => { stdout: string, stderr: string } }} cliBackground
 * @property {() => Promise<number>} spawnHarness a stand-in harness process: its pid is what a session's record names
 * @property {(pid: number) => Promise<void>} kill stop one process this seat started, by its exact pid
 * @property {() => Promise<void>} close
 */

const ROOT_PREFIX = "agora-scenario-";
/** The runner that made a seat writes its pid here; a seat whose runner is gone is stale. */
const OWNER_FILE = "runner.pid";
let swept = false;

/**
 * Stop the services of seats a dead runner left behind, and remove their roots. Only roots this
 * rig made (the prefix, and an owner file) whose owner pid no longer answers are touched, and each
 * service is stopped through `agora service stop` against that root's own state: the CLI checks the
 * descriptor it is stopping, so a recycled pid is never signalled on a stale file's say-so.
 * Once per process, before its first seat.
 */
export async function sweepStaleSeats() {
  if (swept) return;
  swept = true;
  let names = [];
  try { names = (await readdir(tmpdir())).filter((n) => n.startsWith(ROOT_PREFIX)); } catch { return; }
  for (const name of names) {
    const root = path.join(tmpdir(), name);
    let owner = 0;
    try { owner = Number((await readFile(path.join(root, OWNER_FILE), "utf8")).trim()); } catch { continue; }
    if (!Number.isInteger(owner) || owner <= 0 || owner === process.pid) continue;
    try { process.kill(owner, 0); continue; } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "EPERM") continue; }
    const env = { ...process.env, AGORA_CONFIG: path.join(root, "agora.json"), AGORA_STATE: path.join(root, "state"), AGORA_SESSION: "scenario-sweep" };
    await new Promise((resolve) => execFile(nodeExecutable(), [BIN, "service", "stop"], { env, windowsHide: true, timeout: 30_000 }, () => resolve(undefined)));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
  }
}

/**
 * Open a seat with one native room.
 * @param {{ seatName?: string, alias?: string }} [options]
 * @returns {Promise<Seat>}
 */
export async function openSeat(options = {}) {
  await sweepStaleSeats();
  const seatName = options.seatName ?? "host";
  const alias = options.alias ?? "main";
  const root = await mkdtemp(path.join(tmpdir(), ROOT_PREFIX));
  await writeFile(path.join(root, OWNER_FILE), String(process.pid), "utf8");
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true });
  const config = path.join(root, "agora.json");
  // a fresh seat's service needs one room in the config before it can mint its first native room
  const desk = { transport: "local", path: path.join(root, "desk.ndjson") };
  await writeFile(config, JSON.stringify({ actor: { name: seatName, kind: "agent" }, state, rooms: { desk } }), "utf8");
  /** @type {Record<string, string>} */
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !CLEARED.includes(k)) base[k] = v;
  Object.assign(base, { AGORA_CONFIG: config, AGORA_STATE: state, HOME: home, USERPROFILE: home });
  const node = nodeExecutable();
  /** @type {Map<number, import("node:child_process").ChildProcess>} */
  const started = new Map();

  // a call that names no session of its own runs as the runner's session, never as "default"
  /** @param {Record<string, string>} env */
  const envFor = (env) => ({ ...base, ...(env.AGORA_SESSION || env.CLAUDE_CODE_SESSION_ID ? {} : { AGORA_SESSION: "scenario-runner" }), ...env });

  /** @param {string[]} args @param {Record<string, string>} [env] @returns {Promise<CliResult>} */
  const cli = (args, env = {}) => new Promise((resolve) => {
    const child = execFile(node, [BIN, ...args], { env: envFor(env), windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof /** @type {any} */ (error).code === "number" ? /** @type {any} */ (error).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    child.stdin?.end();
  });

  /** @param {string[]} args @param {Record<string, string>} [env] */
  const cliBackground = (args, env = {}) => {
    const child = spawn(node, [BIN, ...args], { env: envFor(env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid === undefined) throw new Error(`could not start agora ${args.join(" ")}`);
    started.set(child.pid, child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    /** @type {Promise<CliResult>} */
    const done = new Promise((resolve) => child.on("close", (code) => { started.delete(/** @type {number} */ (child.pid)); resolve({ code: code ?? 1, stdout, stderr }); }));
    return { pid: child.pid, done, output: () => ({ stdout, stderr }) };
  };

  const spawnHarness = async () => {
    // a process that only waits: its pid stands in for a harness, and it is stopped by that pid
    const child = spawn(node, ["-e", "setTimeout(() => {}, 600000)"], { windowsHide: true, stdio: "ignore" });
    if (child.pid === undefined) throw new Error("could not start a stand-in harness process");
    started.set(child.pid, child);
    child.on("exit", () => started.delete(/** @type {number} */ (child.pid)));
    return child.pid;
  };

  /** @param {number} pid */
  const kill = async (pid) => {
    const child = started.get(pid);
    if (!child) throw new Error(`pid ${pid} was not started by this seat; refusing to stop it`);
    const exited = new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(undefined); else child.once("exit", resolve); });
    child.kill();
    await exited;
    started.delete(pid);
  };

  let serviceStarted = false;
  let servicePid = 0;
  const close = async () => {
    for (const pid of [...started.keys()]) await kill(pid).catch(() => undefined);
    if (serviceStarted) {
      await cli(["service", "stop"]).catch(() => undefined);
      // the service is stopped by the pid its own descriptor named, only if `service stop` left it
      if (servicePid) try { process.kill(servicePid, 0); process.kill(servicePid); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  try {
    const start = await cli(["service", "start"]);
    if (start.code !== 0) throw new Error(`service start failed: ${start.stderr}`);
    serviceStarted = true;
    try { servicePid = Number(JSON.parse(await readFile(path.join(state, "native", "service.json"), "utf8")).pid) || 0; }
    catch { servicePid = 0; }
    const created = await cli(["service", "room", "create", "--json"]);
    const roomId = JSON.parse(created.stdout.trim() || "{}").roomId;
    if (!/^[a-f0-9]{32}$/.test(String(roomId))) throw new Error(`service room create printed no room id: ${created.stdout}${created.stderr}`);
    await writeFile(config, JSON.stringify({ actor: { name: seatName, kind: "agent" }, state, rooms: { desk, [alias]: { transport: "native", roomId } } }), "utf8");
    return { root, state, home, config, roomId, alias, seatName, cli, cliBackground, spawnHarness, kill, close };
  } catch (e) {
    await close();
    throw e;
  }
}
