// @ts-check
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AgoraError, EXIT } from "./core.mjs";
import { resolveCodexBinary } from "./codex.mjs";
import { connectCodexServer, codexServerURL } from "./codex-server.mjs";

const DESCRIPTOR_VERSION = 1;
const execFileAsync = promisify(execFile);
const windowsLauncher = fileURLToPath(new URL("../scripts/start-codex-app-server.ps1", import.meta.url));
export const CODEX_REMOTE_TOKEN_ENV = "AGORA_CODEX_REMOTE_AUTH_TOKEN";

/** @param {string} stateRoot */
export function codexControlPaths(stateRoot) {
  const root = path.resolve(stateRoot, "codex-control");
  return { root, descriptor: path.join(root, "server.json"), lock: path.join(root, "server.lock") };
}

/** @param {string} endpoint @param {string} tokenFile */
export function codexAppServerArgs(endpoint, tokenFile) {
  return ["app-server", "--listen", codexServerURL(endpoint).replace(/\/$/, ""), "--ws-auth", "capability-token", "--ws-token-file", path.resolve(tokenFile)];
}

/** @param {string} endpoint @param {string[]} args */
export function codexAttachedArgs(endpoint, args = []) {
  return ["--remote", codexServerURL(endpoint).replace(/\/$/, ""), "--remote-auth-token-env", CODEX_REMOTE_TOKEN_ENV, ...args];
}

/** @param {NodeJS.ProcessEnv} env @param {string} endpoint @param {string} tokenFile @param {string} token @returns {NodeJS.ProcessEnv} */
export function codexAttachedEnvironment(env, endpoint, tokenFile, token) {
  return {
    ...env,
    AGORA_CODEX_SERVER: codexServerURL(endpoint),
    AGORA_CODEX_TOKEN_FILE: path.resolve(tokenFile),
    [CODEX_REMOTE_TOKEN_ENV]: token,
  };
}

/** @param {number} pid */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM"; }
}

async function reserveLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/** @param {string} file @param {unknown} value */
async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temp, file); }
  finally { await rm(temp, { force: true }).catch(() => {}); }
}

/** @param {string} file */
async function readDescriptor(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.version !== DESCRIPTOR_VERSION || typeof value.endpoint !== "string" ||
        typeof value.tokenFile !== "string" || !path.isAbsolute(value.tokenFile) ||
        !Number.isInteger(value.pid) || value.pid <= 0) return undefined;
    codexServerURL(value.endpoint);
    return value;
  } catch { return undefined; }
}

/** @param {{endpoint:string,tokenFile:string}} descriptor */
async function probeDescriptor(descriptor) {
  try {
    const client = await connectCodexServer({ endpoint: descriptor.endpoint, tokenFile: descriptor.tokenFile, timeoutMs: 500 });
    client.close();
    return true;
  } catch { return false; }
}

/**
 * One seat-local app server owns every TUI launched by `agora codex`. Its environment carries only
 * the endpoint and token-file reference, so tool processes can arm native watches without
 * inheriting the capability value used by the attaching TUI.
 * @param {{
 *   stateRoot:string, env?:NodeJS.ProcessEnv, codexPath?:string, timeoutMs?:number,
 *   deps?:{ probe?:(d:any)=>Promise<boolean>, reservePort?:()=>Promise<number>, spawn?:typeof spawn,
 *     run?:typeof execFileAsync, platform?:NodeJS.Platform,
 *     uuid?:()=>string, token?:()=>string, sleep?:(ms:number)=>Promise<void>, now?:()=>string }
 * }} options
 */
export async function ensureCodexServer(options) {
  const env = options.env ?? process.env;
  const paths = codexControlPaths(options.stateRoot);
  const deps = options.deps ?? {};
  const probe = deps.probe ?? probeDescriptor;
  await mkdir(paths.root, { recursive: true, mode: 0o700 });

  let lock;
  try {
    lock = await open(paths.lock, "wx", 0o600);
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    let owner;
    try { owner = JSON.parse(await readFile(paths.lock, "utf8")); } catch { /* malformed is not live evidence */ }
    if (!processAlive(Number(owner?.pid))) {
      await rm(paths.lock, { force: true });
      return ensureCodexServer(options);
    }
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      const existing = await readDescriptor(paths.descriptor);
      if (existing && await probe(existing)) return { ...existing, reused: true, descriptor: paths.descriptor };
      await (deps.sleep ?? delay)(100);
    }
    throw new AgoraError("another agora codex launch still holds the app-server startup lock", EXIT.error);
  }

  try {
    const existing = await readDescriptor(paths.descriptor);
    if (existing && await probe(existing)) return { ...existing, reused: true, descriptor: paths.descriptor };

    const codexPath = await resolveCodexBinary({ env, ...(options.codexPath ? { bin: options.codexPath } : {}) });
    const generation = (deps.uuid ?? randomUUID)();
    const generationDir = path.join(paths.root, generation);
    const tokenFile = path.resolve(generationDir, "capability.token");
    await mkdir(generationDir, { recursive: false, mode: 0o700 });
    const token = (deps.token ?? (() => randomBytes(32).toString("base64url")))();
    await writeFile(tokenFile, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const port = await (deps.reservePort ?? reserveLoopbackPort)();
    const endpoint = codexServerURL(`ws://127.0.0.1:${port}`);
    const serverEnv = /** @type {NodeJS.ProcessEnv} */ ({ ...env, AGORA_CODEX_SERVER: endpoint, AGORA_CODEX_TOKEN_FILE: tokenFile });
    delete serverEnv[CODEX_REMOTE_TOKEN_ENV];
    let pid;
    let supervisorPid;
    if (deps.spawn) {
      const child = deps.spawn(codexPath, codexAppServerArgs(endpoint, tokenFile), {
        detached: true, windowsHide: true, stdio: "ignore", cwd: generationDir, env: serverEnv,
      });
      child.unref();
      pid = child.pid;
    } else if ((deps.platform ?? process.platform) === "win32") {
      const receiptFile = path.join(generationDir, "server-receipt.json");
      const stdoutFile = path.join(generationDir, "server.stdout.log");
      const stderrFile = path.join(generationDir, "server.stderr.log");
      const launched = await (deps.run ?? execFileAsync)("pwsh.exe", [
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", windowsLauncher,
        "-CodexPath", codexPath, "-Endpoint", endpoint.replace(/\/$/, ""), "-TokenFile", tokenFile,
        "-CurrentDirectory", generationDir, "-ReceiptPath", receiptFile,
        "-StdoutPath", stdoutFile, "-StderrPath", stderrFile,
      ], { windowsHide: true, env: serverEnv });
      try {
        const receipt = JSON.parse(String(launched.stdout));
        pid = Number(receipt.pid);
        supervisorPid = Number(receipt.supervisorPid) || undefined;
      }
      catch { throw new AgoraError("Windows process service returned an invalid Codex app-server receipt", EXIT.error); }
    } else {
      const child = spawn(codexPath, codexAppServerArgs(endpoint, tokenFile), {
        detached: true, windowsHide: true, stdio: "ignore", cwd: generationDir, env: serverEnv,
      });
      child.unref();
      pid = child.pid;
    }
    if (!pid) throw new AgoraError("Codex app server did not publish a process id", EXIT.error);

    const descriptor = {
      version: DESCRIPTOR_VERSION, endpoint, tokenFile, pid, ...(supervisorPid ? { supervisorPid } : {}), codexPath,
      startedAt: (deps.now ?? (() => new Date().toISOString()))(),
    };
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      if (await probe(descriptor)) {
        await atomicJson(paths.descriptor, descriptor);
        return { ...descriptor, reused: false, descriptor: paths.descriptor };
      }
      await (deps.sleep ?? delay)(100);
    }
    try { process.kill(pid); } catch { /* the failed process may already be gone */ }
    await rm(generationDir, { recursive: true, force: true }).catch(() => {});
    throw new AgoraError("Codex app server did not accept an authenticated loopback connection before the startup deadline", EXIT.error);
  } finally {
    try { await lock?.close(); } catch { /* close best effort; ownership is the file */ }
    await rm(paths.lock, { force: true }).catch(() => {});
  }
}

/** @param {{stateRoot:string,env?:NodeJS.ProcessEnv,codexPath?:string,args?:string[],spawn?:typeof spawn}} options */
export async function launchAttachedCodex(options) {
  const env = options.env ?? process.env;
  const server = await ensureCodexServer({ stateRoot: options.stateRoot, env, ...(options.codexPath ? { codexPath: options.codexPath } : {}) });
  const token = (await readFile(server.tokenFile, "utf8")).trim();
  const childEnv = codexAttachedEnvironment(env, server.endpoint, server.tokenFile, token);
  const child = (options.spawn ?? spawn)(server.codexPath, codexAttachedArgs(server.endpoint, options.args), {
    stdio: "inherit", windowsHide: false, cwd: process.cwd(), env: childEnv,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? EXIT.error));
  });
  return { code: Number(code), server };
}

/** @param {string} stateRoot */
export async function codexServerStatus(stateRoot) {
  const paths = codexControlPaths(stateRoot);
  const descriptor = await readDescriptor(paths.descriptor);
  if (!descriptor) return { running: false, descriptor: paths.descriptor };
  const running = await probeDescriptor(descriptor);
  return { running, ...descriptor, descriptor: paths.descriptor };
}
