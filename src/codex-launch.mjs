// @ts-check
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/** SQLite is the cross-runtime, crash-releasing authority already used by Agora's native service.
 * @param {string} file @param {number} deadline @param {(ms:number)=>Promise<void>} sleep */
async function acquireStartupAuthority(file, deadline, sleep) {
  const moduleName = typeof process.versions.bun === "string" ? "bun:sqlite" : "node:sqlite";
  let sqlite;
  try { sqlite = await import(moduleName); }
  catch { throw new AgoraError("Codex app-server startup authority needs Node 22.13 or later, or Bun with SQLite support", EXIT.error); }
  const Database = sqlite.DatabaseSync ?? sqlite.Database;
  if (typeof Database !== "function") throw new AgoraError("runtime has no supported SQLite API for Codex app-server startup", EXIT.error);
  while (Date.now() < deadline) {
    /** @type {{exec:(sql:string)=>unknown,close:()=>void} | undefined} */
    let database;
    try {
      const opened = new Database(file);
      database = opened;
      opened.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      await chmod(file, 0o600);
      let held = true;
      return { release() { if (!held) return; held = false; try { opened.exec("ROLLBACK"); } finally { opened.close(); } } };
    } catch (error) {
      try { database?.close(); } catch {}
      const sqliteError = /** @type {Error & {code?:string,errno?:number,errcode?:number}} */ (error);
      if (sqliteError.code !== "SQLITE_BUSY" && sqliteError.errno !== 5 && sqliteError.errcode !== 5 &&
          !/database is locked/i.test(sqliteError.message))
        throw new AgoraError(`Codex app-server startup authority is unusable: ${file}`, EXIT.error);
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
  throw new AgoraError(`Codex app-server startup authority remained busy through the deadline: ${file}`, EXIT.error);
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

/** @param {string} file */
async function readLockOwner(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!Number.isInteger(value?.pid) || value.pid <= 0 || typeof value.token !== "string" ||
        !/^[0-9a-f-]{16,64}$/i.test(value.token) || typeof value.at !== "string") return undefined;
    return value;
  } catch { return undefined; }
}

/** @param {string} lockFile @param {{pid:number,token:string}} owner @param {()=>Promise<void>} [beforeRename] */
async function releaseLock(lockFile, owner, beforeRename) {
  const current = await readLockOwner(lockFile);
  if (current?.pid !== owner.pid || current.token !== owner.token) return;
  const released = `${lockFile}.${owner.token}.released`;
  await beforeRename?.();
  try { await rename(lockFile, released); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return; throw error; }
  const moved = await readLockOwner(released);
  if (moved?.pid === owner.pid && moved.token === owner.token) await rm(released, { force: true });
  else {
    try { await link(released, lockFile); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    }
    await rm(released, { force: true });
    throw new AgoraError("Codex app-server startup lock ownership changed before release", EXIT.error);
  }
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
 *     uuid?:()=>string, token?:()=>string, sleep?:(ms:number)=>Promise<void>, now?:()=>string,
 *     processAlive?:(pid:number)=>boolean, beforeLockPublish?:()=>Promise<void>,
 *     afterLockObservation?:(owner:{pid:number,token:string,at:string})=>Promise<void>,
 *     beforeLockRelease?:()=>Promise<void>, kill?:(pid:number)=>void }
 * }} options
 */
export async function ensureCodexServer(options) {
  const env = options.env ?? process.env;
  const paths = codexControlPaths(options.stateRoot);
  const deps = options.deps ?? {};
  const probe = deps.probe ?? probeDescriptor;
  const sleep = deps.sleep ?? delay;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const authority = await acquireStartupAuthority(path.join(paths.root, "startup-authority.sqlite"), deadline, sleep);

  /** @type {{pid:number,token:string,at:string} | undefined} */
  let lockOwner;
  try {
    // The JSON file is diagnostic state, not authority. SQLite serializes every observation and
    // mutation below, so a pathname vacancy can never admit another starter.
    while (Date.now() < deadline) {
      const existing = await readDescriptor(paths.descriptor);
      if (existing && await probe(existing)) return { ...existing, reused: true, descriptor: paths.descriptor };
      let lockPresent = true;
      try { await readFile(paths.lock, "utf8"); }
      catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") lockPresent = false;
        else throw error;
      }
      if (!lockPresent) break;
      const owner = await readLockOwner(paths.lock);
      if (owner && !(deps.processAlive ?? processAlive)(owner.pid)) {
        await deps.afterLockObservation?.(owner);
        await rm(paths.lock);
        break;
      }
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    if (Date.now() >= deadline)
      throw new AgoraError("Codex app-server startup lock remains held or has unknown ownership", EXIT.error);

    const ownerToken = (deps.uuid ?? randomUUID)();
    lockOwner = { pid: process.pid, token: ownerToken, at: new Date().toISOString() };
    const candidate = `${paths.lock}.${ownerToken}.candidate`;
    const handle = await open(candidate, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(lockOwner)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try { await deps.beforeLockPublish?.(); await link(candidate, paths.lock); }
    finally { await rm(candidate, { force: true }).catch(() => {}); }

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
    while (Date.now() < deadline) {
      if (await probe(descriptor)) {
        await atomicJson(paths.descriptor, descriptor);
        return { ...descriptor, reused: false, descriptor: paths.descriptor };
      }
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    try { (deps.kill ?? process.kill)(pid); } catch { /* the failed process may already be gone */ }
    await rm(generationDir, { recursive: true, force: true }).catch(() => {});
    throw new AgoraError("Codex app server did not accept an authenticated loopback connection before the startup deadline", EXIT.error);
  } finally {
    try { if (lockOwner) await releaseLock(paths.lock, lockOwner, deps.beforeLockRelease); }
    finally { authority.release(); }
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
