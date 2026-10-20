// @ts-check
/**
 * Starting, stopping and supervising residents from a manifest.
 *
 * A seat's operator keeps one **resident manifest** (a JSON file agora reads and never writes): per
 * resident, its position (the slug), role, harness, model, rooms and wake, profile, working folder,
 * skills and host. `agora resident start` turns one row into a plan and runs it:
 *
 *   plan     pure: the rendered prompt's path, the working folder and its files, the harness argv
 *            with the one fixed first prompt, the environment the harness's agora-room extension or
 *            plugin reads, and the host command. `--plan` prints it and does nothing else.
 *   prepare  writes what the plan names: the rendered prompt (profile + room-mechanics block +
 *            appended files), the omp settings overlay, the working folder's files, the skill copies
 *            (Claude Code) and the folder's trust entry (Claude Code).
 *   launch   the host starts the harness: `none` runs it in this terminal; `tern` and `tmux` start a
 *            session whose program is `agora resident start <slug> --run <run.json>`, which runs the
 *            harness from the recorded plan (a Tern session does not inherit the caller's environment,
 *            so everything travels in the run record).
 *
 * The spawner's only act is the start with its first prompt; nothing is typed into a session after.
 * A position that already holds a live session (its session record, or the host handle recorded at
 * the last start) is never started twice. The run record `<state>/residents/<slug>/run.json` keeps the
 * host's own handle, so `stop` acts by that handle and never by a name.
 *
 * The timer half writes one OS scheduler entry that runs `agora resident cycle --all` on an interval:
 * a Windows scheduled task, a systemd user timer, or a launchd agent; `check` reports and changes
 * nothing.
 *
 * Harness `agora` is the room's messenger (docs/MESSENGER.md): no model and no prompt; the row's
 * program is `agora messenger <room> --stream <args>`, run as the position's own session (it
 * registers itself with its own pid, so liveness and the departure sweep read it like any
 * resident) and writing a liveness file beside its session. The cycle runs one `--once` tick for
 * such a row as a backstop: the messenger's own posts are its incident record, so a tick after a
 * dead stream posts every line that came due while it was down, once.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { AgoraError, EXIT, expandHome, writeFileAtomic } from "./core.mjs";
import { ROOM_MECHANICS_DOC, RESIDENT_SLUG_RE, renderResidentPrompt, residentDir } from "./resident.mjs";
import { POSITION_RE, listRecords, pidAlive, positionOf } from "./session.mjs";
import { modelLabel } from "../plugins/omp/agora-room/index.mjs";
import { livenessPath } from "./messenger.mjs";

export const MANIFEST_VERSION = 1;
export const HARNESSES = Object.freeze(["omp", "claude", "agora"]);
export const HOSTS = Object.freeze(["tern", "tmux", "none"]);
export const WAKES = Object.freeze(["all", "addressed", "mine"]);
const TOP_KEYS = new Set(["version", "models", "vars", "defaults", "residents"]);
const ROW_KEYS = new Set(["role", "harness", "model", "thinking", "rooms", "wake", "profile", "append", "workdir", "skills", "host", "env", "args", "preamble", "bearer", "restart", "command"]);
const REQUIRED = ["role", "harness", "model", "rooms", "profile", "host"];
/** A messenger row runs code, not a model: it names no model and no profile. */
const NOT_REQUIRED_FOR_AGORA = new Set(["model", "profile"]);
/** The model a messenger row records when it names none: its bearer is `<role>/Code`. */
export const MESSENGER_MODEL = "code";
/** What the verb itself sets for the harness; a manifest may not set these. */
export const RESERVED_ENV = Object.freeze(["AGORA_CONFIG", "AGORA_STATE", "AGORA_SESSION", "AGORA_LABEL", "AGORA_ACTOR", "AGORA_ROLE", "AGORA_ROOM", "AGORA_ROOM_WAKE", "AGORA_ROOM_PREAMBLE", "AGORA_ROOM_CMD"]);
/** A manifest names paths and switches, never a credential. */
const SECRET_NAME = /TOKEN|SECRET|PASSW(OR)?D|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i;
const ROLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VAR_RE = /^[A-Z][A-Z0-9_]*$/;
const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BEARER_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const START_LOCK_STALE_MS = 120_000;
export const STOP_WAIT_MS = 10_000;
export const TIMER_NAME = "agora-resident-cycle";
export const LAUNCHD_LABEL = "agora.resident-cycle";
export const DEFAULT_TIMER_SECONDS = 900;

/** @typedef {{ file: string } | { text: string }} FilePart */
/**
 * @typedef {{
 *   slug: string, role: string, harness: 'omp' | 'claude' | 'agora', model: string, thinking: string | null,
 *   rooms: string[], wake: 'all' | 'addressed' | 'mine', profile: string, append: string[],
 *   workdir: { path: string | null, files: Array<{ path: string, parts: FilePart[] }> },
 *   skills: { dir: string, names: string[] } | null, host: 'tern' | 'tmux' | 'none',
 *   env: Record<string, string>, args: string[], preamble: 'on' | 'off' | null, bearer: string | null,
 *   restart: string | null, command: string[] | null,
 * }} ManifestResident
 */
/** @typedef {{ file: string, dir: string, models: Record<string, string>, vars: Record<string, string>, residents: Record<string, ManifestResident> }} Manifest */

// ---------------------------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------------------------

/**
 * Validate a parsed manifest. Paths resolve against the manifest's own folder; every error names
 * the file and the field.
 * @param {unknown} raw @param {string} file
 * @returns {Manifest}
 */
export function validateManifest(raw, file) {
  const dir = path.dirname(path.resolve(file));
  /** @param {string} where @param {string} msg @returns {never} */
  const bad = (where, msg) => { throw new AgoraError(`${file}: ${where}: ${msg}`, EXIT.error); };
  const isObj = (/** @type {unknown} */ v) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(raw)) bad("manifest", "must be a JSON object");
  const top = /** @type {Record<string, unknown>} */ (raw);
  for (const k of Object.keys(top)) if (!TOP_KEYS.has(k)) bad(k, `unknown key (have: ${[...TOP_KEYS].join(", ")})`);
  if (top.version !== MANIFEST_VERSION) bad("version", `must be ${MANIFEST_VERSION}`);
  const resolveIn = (/** @type {string} */ p) => path.resolve(dir, expandHome(p));

  /** @type {Record<string, string>} */
  const models = {};
  if (top.models !== undefined) {
    if (!isObj(top.models)) bad("models", "must be an object of alias: model id");
    for (const [k, v] of Object.entries(/** @type {object} */ (top.models))) {
      if (typeof v !== "string" || !v.trim()) bad(`models.${k}`, "must be a non-empty model id");
      models[k] = v.trim();
    }
  }
  /** @type {Record<string, string>} */
  const vars = {};
  if (top.vars !== undefined) {
    if (!isObj(top.vars)) bad("vars", "must be an object of NAME: text or NAME: { path }");
    for (const [k, v] of Object.entries(/** @type {object} */ (top.vars))) {
      if (!VAR_RE.test(k)) bad(`vars.${k}`, `a var name is upper-case letters, digits and _ (${VAR_RE})`);
      if (typeof v === "string") vars[k] = v;
      else if (isObj(v) && typeof (/** @type {any} */ (v)).path === "string" && Object.keys(/** @type {object} */ (v)).length === 1)
        vars[k] = resolveIn(/** @type {any} */ (v).path).replace(/\\/g, "/");
      else bad(`vars.${k}`, "must be a string or { \"path\": <path relative to the manifest> }");
    }
  }
  /** @type {Record<string, unknown>} */
  const defaults = {};
  if (top.defaults !== undefined) {
    if (!isObj(top.defaults)) bad("defaults", "must be an object of resident fields");
    Object.assign(defaults, top.defaults);
  }
  if (!isObj(top.residents) || !Object.keys(/** @type {object} */ (top.residents)).length) bad("residents", "must name at least one resident");

  /** @type {Record<string, ManifestResident>} */
  const residents = {};
  for (const [slug, rowRaw] of Object.entries(/** @type {Record<string, unknown>} */ (top.residents))) {
    const at = `residents.${slug}`;
    if (!RESIDENT_SLUG_RE.test(slug) || !POSITION_RE.test(slug))
      bad(at, "a resident key is its position: lower-case segments of letters, digits, _ and -, joined by . (coding, desk.messenger)");
    if (!isObj(rowRaw)) bad(at, "must be an object");
    const row = { ...defaults, .../** @type {object} */ (rowRaw) };
    for (const k of Object.keys(row)) if (!ROW_KEYS.has(k)) bad(`${at}.${k}`, `unknown field (have: ${[...ROW_KEYS].join(", ")})`);
    const agoraRow = row.harness === "agora";
    for (const k of REQUIRED) if (row[k] === undefined && !(agoraRow && NOT_REQUIRED_FOR_AGORA.has(k))) bad(`${at}.${k}`, "is required (here or in defaults)");
    const str = (/** @type {string} */ k) => {
      const v = row[k];
      if (typeof v !== "string" || !v.trim()) bad(`${at}.${k}`, "must be a non-empty string");
      return /** @type {string} */ (v).trim();
    };
    const optStr = (/** @type {string} */ k) => (row[k] === undefined || row[k] === null ? null : str(k));
    const strList = (/** @type {string} */ k, /** @type {RegExp | null} */ re) => {
      const v = row[k];
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) bad(`${at}.${k}`, "must be a list of non-empty strings");
      const list = /** @type {string[]} */ (v).map((x) => x.trim());
      if (re) for (const x of list) if (!re.test(x)) bad(`${at}.${k}`, `${JSON.stringify(x)} does not match ${re}`);
      return list;
    };
    const oneOf = (/** @type {string} */ k, /** @type {readonly string[]} */ allowed, /** @type {string | null} */ dflt) => {
      if (row[k] === undefined) return dflt;
      const v = row[k];
      if (typeof v !== "string" || !allowed.includes(v)) bad(`${at}.${k}`, `must be one of ${allowed.join(", ")}`);
      return /** @type {string} */ (v);
    };

    const role = str("role");
    if (!ROLE_RE.test(role)) bad(`${at}.role`, `a role is one segment of lower-case letters, digits, _ and - (${ROLE_RE})`);
    const harness = /** @type {'omp' | 'claude' | 'agora'} */ (oneOf("harness", HARNESSES, null));
    const host = /** @type {'tern' | 'tmux' | 'none'} */ (oneOf("host", HOSTS, null));
    const wake = /** @type {'all' | 'addressed' | 'mine'} */ (oneOf("wake", WAKES, "addressed"));
    const preamble = /** @type {'on' | 'off' | null} */ (oneOf("preamble", ["on", "off"], null));
    const rooms = strList("rooms", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    if (!rooms.length) bad(`${at}.rooms`, "must name at least one room alias from the agora config");
    if (agoraRow && rooms.length !== 1) bad(`${at}.rooms`, "a messenger row (harness agora) watches one room; give each room its own row");
    const bearer = optStr("bearer");
    if (bearer !== null && !BEARER_RE.test(bearer)) bad(`${at}.bearer`, "a bearer is letters, digits, . _ - in segments joined by /");

    /** @type {Record<string, string>} */
    const env = {};
    if (row.env !== undefined) {
      if (!isObj(row.env)) bad(`${at}.env`, "must be an object of NAME: value");
      for (const [k, v] of Object.entries(/** @type {object} */ (row.env))) {
        if (!ENV_NAME_RE.test(k)) bad(`${at}.env.${k}`, "is not an environment variable name");
        if (RESERVED_ENV.includes(k)) bad(`${at}.env.${k}`, "is set by agora resident start itself; remove it");
        if (SECRET_NAME.test(k)) bad(`${at}.env.${k}`, "looks like a credential; a manifest names paths and switches, never a secret");
        if (typeof v !== "string") bad(`${at}.env.${k}`, "must be a string");
        env[k] = /** @type {string} */ (v);
      }
    }

    /** @type {ManifestResident['workdir']} */
    const workdir = { path: null, files: [] };
    if (row.workdir !== undefined) {
      if (!isObj(row.workdir)) bad(`${at}.workdir`, "must be an object { path?, files? }");
      const w = /** @type {Record<string, unknown>} */ (row.workdir);
      for (const k of Object.keys(w)) if (k !== "path" && k !== "files") bad(`${at}.workdir.${k}`, "unknown field (have: path, files)");
      if (w.path !== undefined) {
        if (typeof w.path !== "string" || !w.path.trim()) bad(`${at}.workdir.path`, "must be a non-empty path");
        workdir.path = resolveIn(/** @type {string} */ (w.path));
      }
      if (w.files !== undefined) {
        if (!isObj(w.files)) bad(`${at}.workdir.files`, "must be an object of <relative path>: [parts]");
        for (const [rel, parts] of Object.entries(/** @type {object} */ (w.files))) {
          const where = `${at}.workdir.files.${rel}`;
          const norm = path.normalize(rel);
          if (!rel.trim() || path.isAbsolute(rel) || norm === ".." || norm.startsWith(`..${path.sep}`) || norm.split(/[\\/]/).includes(".."))
            bad(where, "must be a path inside the working folder");
          if (!Array.isArray(parts) || !parts.length) bad(where, "must be a non-empty list of parts (a path, or { \"text\": ... })");
          /** @type {FilePart[]} */
          const out = [];
          for (const p of /** @type {unknown[]} */ (parts)) {
            if (typeof p === "string" && p.trim()) out.push({ file: resolveIn(p) });
            else if (isObj(p) && typeof (/** @type {any} */ (p)).text === "string" && Object.keys(/** @type {object} */ (p)).length === 1) out.push({ text: /** @type {any} */ (p).text });
            else bad(where, "a part is a path (relative to the manifest) or { \"text\": <text> }");
          }
          workdir.files.push({ path: norm, parts: out });
        }
      }
    }

    /** @type {ManifestResident['skills']} */
    let skills = null;
    if (row.skills !== undefined) {
      if (!isObj(row.skills)) bad(`${at}.skills`, "must be an object { dir, names }");
      const s = /** @type {Record<string, unknown>} */ (row.skills);
      for (const k of Object.keys(s)) if (k !== "dir" && k !== "names") bad(`${at}.skills.${k}`, "unknown field (have: dir, names)");
      if (typeof s.dir !== "string" || !s.dir.trim()) bad(`${at}.skills.dir`, "must name the folder the skills live in");
      if (!Array.isArray(s.names) || s.names.some((n) => typeof n !== "string" || !SKILL_RE.test(n))) bad(`${at}.skills.names`, `must be a list of skill folder names (${SKILL_RE})`);
      skills = { dir: resolveIn(/** @type {string} */ (s.dir)), names: [...new Set(/** @type {string[]} */ (s.names))].sort() };
    }

    let command = null;
    if (row.command !== undefined) {
      command = strList("command", null);
      if (!command.length) bad(`${at}.command`, "must be a non-empty argv prefix");
    }

    residents[slug] = {
      slug, role, harness, model: agoraRow ? MESSENGER_MODEL : str("model"), thinking: agoraRow ? null : optStr("thinking"), rooms: [...new Set(rooms)], wake,
      // a messenger row has no prompt: a profile or an append inherited from defaults is not read
      profile: agoraRow ? "" : resolveIn(str("profile")), append: agoraRow ? [] : strList("append", null).map(resolveIn), workdir, skills: agoraRow ? null : skills, host, env,
      args: strList("args", null), preamble, bearer, restart: optStr("restart"), command,
    };
  }
  return { file: path.resolve(file), dir, models, vars, residents };
}

/** @param {string} file @returns {Promise<Manifest>} */
export async function loadManifest(file) {
  let text;
  try { text = await readFile(file, "utf8"); }
  catch (e) { throw new AgoraError(`cannot read the resident manifest ${file}: ${/** @type {any} */ (e).code ?? /** @type {any} */ (e).message}`, EXIT.error); }
  let raw;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (e) { throw new AgoraError(`${file}: ${e instanceof Error ? e.message : String(e)}`, EXIT.error); }
  return validateManifest(raw, file);
}

/**
 * Where this seat's manifest is: `--manifest`, else the config's `residentManifest` (relative to the
 * config file), else `<state>/residents.json`.
 * @param {{ path?: string, [k: string]: unknown }} cfg @param {string} stateRoot @param {string | undefined} explicit
 * @returns {{ file: string, named: boolean }}
 */
export function manifestPath(cfg, stateRoot, explicit) {
  if (explicit) return { file: path.resolve(expandHome(explicit)), named: true };
  const fromCfg = cfg.residentManifest;
  if (typeof fromCfg === "string" && fromCfg.trim())
    return { file: path.resolve(cfg.path ? path.dirname(cfg.path) : process.cwd(), expandHome(fromCfg.trim())), named: true };
  return { file: path.join(stateRoot, "residents.json"), named: false };
}

/**
 * The seat's manifest, or null when none was named and the default file is absent (a seat with no
 * manifest is not an error for `cycle`).
 * @param {{ path?: string, [k: string]: unknown }} cfg @param {string} stateRoot @param {string | undefined} explicit
 * @param {{ required?: boolean }} [opts]
 */
export async function findManifest(cfg, stateRoot, explicit, opts = {}) {
  const { file, named } = manifestPath(cfg, stateRoot, explicit);
  if (!existsSync(file)) {
    if (named || opts.required)
      throw new AgoraError(`no resident manifest at ${file} (pass --manifest <path>, set residentManifest in the agora config, or write ${path.join(stateRoot, "residents.json")}); see docs/RESIDENTS.md`, EXIT.error);
    return null;
  }
  return loadManifest(file);
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

/**
 * An executable on PATH (with PATHEXT on Windows; a name with an extension is taken as is), or null.
 * @param {string} name @param {{ env?: Record<string, string | undefined>, platform?: string, exists?: (p: string) => boolean }} [deps]
 */
export function which(name, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? ((/** @type {string} */ p) => { try { return statSync(p).isFile(); } catch { return false; } });
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  if (name.includes("/") || (win && name.includes("\\"))) return exists(name) ? name : null;
  const exts = win && !p.extname(name) ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()) : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  for (const d of dirs) for (const e of exts) {
    const c = p.join(d, name + e);
    if (exists(c)) return c;
  }
  return null;
}

/** Tern's CLI: on PATH, else where the Windows installer puts it.
 * @param {{ env?: Record<string, string | undefined>, platform?: string, exists?: (p: string) => boolean }} deps */
export function findTern(deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? ((/** @type {string} */ p) => { try { return statSync(p).isFile(); } catch { return false; } });
  const onPath = which("tern", deps);
  if (onPath) return onPath;
  if (platform === "win32" && env.LOCALAPPDATA)
    for (const n of ["tern.com", "tern.exe"]) {
      const c = path.win32.join(env.LOCALAPPDATA, "Programs", "Tern", n);
      if (exists(c)) return c;
    }
  return null;
}

/** Replace `{{NAME}}` for each declared var. @param {string} text @param {Record<string, string>} vars */
export function substituteVars(text, vars) {
  return text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (m, name) => (Object.hasOwn(vars, name) ? vars[name] : m));
}

/** The default bearer: `<role>/<Model>`, with the model named as the omp extension names it. @param {string} role @param {string} model */
export function defaultBearer(role, model) {
  return `${role}/${modelLabel(model)}`;
}

/**
 * The one first prompt: the spawner's only act.
 * @param {{ slug: string, role: string, bearer: string, rooms: string[], wake: string, harness: string }} p
 */
export function firstPrompt(p) {
  const owner = p.harness === "omp" ? "extension" : "plugin";
  return `You are the ${p.slug} resident: role ${p.role}, bearer ${p.bearer}, position ${p.slug}. Rooms: ${p.rooms.join(",")} (post only there). Wake: ${p.wake}. The harness's agora-room ${owner} owns your watch: arm none. Run the arming sequence in your profile now, then report in one line.`;
}

/** @param {string} stateRoot @param {string} slug */
export function runFilePath(stateRoot, slug) {
  return path.join(residentDir(stateRoot, slug), "run.json");
}

/**
 * @typedef {{
 *   cfg: { path?: string, rooms: Record<string, unknown> }, stateRoot: string, checkout: string, entry: string, node: string,
 *   room?: string, host?: string, model?: string,
 *   platform?: string, env?: Record<string, string | undefined>, exists?: (p: string) => boolean, home?: string,
 * }} PlanContext
 */

/**
 * Everything one start would do, as data. Pure except for executable lookups.
 * @param {Manifest} manifest @param {string} slug @param {PlanContext} ctx
 */
export function planResident(manifest, slug, ctx) {
  const row = manifest.residents[slug];
  if (!row) throw new AgoraError(`no resident ${JSON.stringify(slug)} in ${manifest.file} (have: ${Object.keys(manifest.residents).join(", ")})`, EXIT.usage);
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const deps = { env, platform, exists: ctx.exists };
  const host = /** @type {'tern' | 'tmux' | 'none'} */ (ctx.host ?? row.host);
  if (!HOSTS.includes(host)) throw new AgoraError(`--host takes ${HOSTS.join(", ")}, not ${JSON.stringify(host)}`, EXIT.usage);
  const rooms = ctx.room ? [ctx.room] : row.rooms;
  const known = Object.keys(ctx.cfg.rooms ?? {});
  for (const r of rooms) if (!known.includes(r)) throw new AgoraError(`resident ${slug}: room ${JSON.stringify(r)} is not in the agora config (have: ${known.join(", ")})`, EXIT.usage);
  const messenger = row.harness === "agora";
  const modelKey = messenger ? row.model : ctx.model ?? row.model;
  const model = manifest.models[modelKey] ?? modelKey;
  const bearer = row.bearer ?? defaultBearer(row.role, model);
  const dir = residentDir(ctx.stateRoot, slug);
  const workdir = row.workdir.path ?? path.join(dir, "work");
  const promptFile = path.join(dir, "prompt.md");
  const overlay = row.harness === "omp" ? path.join(dir, "omp-config.yml") : null;
  const fwd = (/** @type {string} */ p) => p.replace(/\\/g, "/");

  /** @type {Record<string, string>} */
  const harnessEnv = messenger
    // the messenger is its own session under its position, signing as its bearer
    ? { ...row.env, AGORA_CONFIG: ctx.cfg.path ?? "", AGORA_STATE: ctx.stateRoot, AGORA_LABEL: slug, AGORA_SESSION: slug, AGORA_ACTOR: bearer }
    : {
      ...row.env,
      AGORA_CONFIG: ctx.cfg.path ?? "",
      AGORA_STATE: ctx.stateRoot,
      AGORA_LABEL: slug,
      AGORA_ROOM: rooms.join(","),
      AGORA_ROOM_WAKE: row.wake,
      AGORA_ROOM_CMD: JSON.stringify([ctx.node, ctx.entry]),
    };
  if (!ctx.cfg.path) delete harnessEnv.AGORA_CONFIG;
  if (row.preamble && !messenger) harnessEnv.AGORA_ROOM_PREAMBLE = row.preamble;
  // omp's extension registers `<role>/<Model>` itself and follows a model change; an explicit bearer,
  // and every Claude Code session, signs through AGORA_ACTOR.
  if (!messenger) {
    if (row.harness === "omp" && row.bearer === null) harnessEnv.AGORA_ROLE = row.role;
    else harnessEnv.AGORA_ACTOR = bearer;
  }

  const prompt = messenger ? null : firstPrompt({ slug, role: row.role, bearer, rooms, wake: row.wake, harness: row.harness });
  /** @type {string[]} */
  let argv;
  if (messenger) argv = messengerArgv(ctx, rooms[0], "--stream", row.args);
  else {
    const exeName = row.command ? row.command[0] : row.harness;
    const exe = which(exeName, deps) ?? (existsSync(exeName) ? exeName : null);
    if (!exe) throw new AgoraError(`resident ${slug}: ${exeName} is not on PATH; install ${row.harness} or set "command" in the manifest`, EXIT.error);
    if (platform === "win32" && /\.(cmd|bat)$/i.test(exe)) throw new AgoraError(`resident ${slug}: ${exe} is a batch shim, which cannot be started without a shell; set "command" in the manifest to the executable it runs`, EXIT.error);
    const prefix = [exe, ...(row.command ? row.command.slice(1) : [])];
    if (row.harness === "omp") {
      argv = [...prefix, "--append-system-prompt", promptFile, "--config", /** @type {string} */ (overlay), "--approval-mode", "yolo", "--model", model];
      if (row.thinking) argv.push("--thinking", row.thinking);
      if (row.skills?.names.length) argv.push("--skills", row.skills.names.join(","));
    } else {
      argv = [...prefix, "--system-prompt", ".", "--append-system-prompt-file", promptFile, "--plugin-dir", path.join(ctx.checkout, "plugins", "claude", "agora-room"), "--dangerously-skip-permissions", "--model", model];
      if (row.thinking) argv.push("--effort", row.thinking);
    }
    argv.push(...row.args, /** @type {string} */ (prompt));
  }

  const runFile = runFilePath(ctx.stateRoot, slug);
  const name = ctx.room ? `${slug} (${ctx.room})` : slug;
  const inner = [ctx.node, ctx.entry, "resident", "start", slug, "--run", runFile, ...(ctx.cfg.path ? ["--config", ctx.cfg.path] : [])];
  /** @type {string[] | null} */
  let hostArgv = null;
  /** @type {Record<string, string>} */
  const hostInfo = {};
  if (host === "tern") {
    const tern = findTern(deps);
    if (!tern) throw new AgoraError(`resident ${slug}: tern is not on PATH${platform === "win32" ? " or in the installer's folder" : ""}; pass --host tmux or none`, EXIT.error);
    const windowKey = env.TERN_WINDOW_KEY;
    hostArgv = [tern, "new", "session", name, "--json", ...(windowKey ? ["--window", windowKey] : []), "--cwd", workdir, "--", ...inner];
    hostInfo.tern = tern;
    if (windowKey) hostInfo.window = windowKey;
  } else if (host === "tmux") {
    const tmux = which("tmux", deps);
    if (!tmux) throw new AgoraError(`resident ${slug}: tmux is not on PATH; pass --host tern or none`, EXIT.error);
    const server = `agora-resident-${slug}`;
    hostArgv = [tmux, "-L", server, "new-session", "-d", "-s", slug, "-c", workdir, ...inner];
    Object.assign(hostInfo, { tmux, server, session: slug });
  }

  return {
    type: "resident-plan", resident: slug, role: row.role, harness: row.harness, model, bearer, position: slug,
    rooms, wake: row.wake, host, manifest: manifest.file, dir, workdir,
    files: row.workdir.files.map((f) => ({ path: path.join(workdir, f.path), parts: f.parts })),
    skills: row.skills ? { dir: row.skills.dir, names: row.skills.names, mode: row.harness === "omp" ? "overlay" : "copy" } : null,
    prompt: messenger ? null : { file: promptFile, profile: row.profile, append: row.append },
    overlay, overlayText: overlay ? ompOverlay(fwd(path.join(ctx.checkout, "plugins", "omp", "agora-room")), row.skills ? fwd(row.skills.dir) : null) : null,
    trust: row.harness === "claude" ? workdir : null,
    vars: manifest.vars, argv, env: harnessEnv, firstPrompt: prompt, hostArgv, hostInfo, runFile, name,
    restart: row.restart,
    // where the messenger's stream keeps its liveness (docs/MESSENGER.md); null for a model harness
    liveness: messenger ? livenessPath(ctx.stateRoot, slug, rooms[0]) : null,
  };
}

/** @typedef {ReturnType<typeof planResident>} ResidentPlan */

/**
 * The messenger's argv: `agora messenger <room> <mode> [--config] <row args>` on this checkout's
 * own CLI, run by this node.
 * @param {{ node: string, entry: string, cfg: { path?: string } }} ctx @param {string} room
 * @param {'--stream' | '--once'} mode @param {string[]} args
 */
export function messengerArgv(ctx, room, mode, args) {
  return [ctx.node, ctx.entry, "messenger", room, mode, ...(mode === "--once" ? ["--json"] : []), ...(ctx.cfg.path ? ["--config", ctx.cfg.path] : []), ...args];
}

/**
 * The cycle's backstop for a messenger row: one `--once` tick as the position's own session, and
 * whether its stream is holding the position. A tick while the stream lives is harmless (the room's
 * messenger lock serialises them, and its own posts are the record); after a dead stream it posts
 * every line that came due meanwhile, once.
 * @param {Manifest} manifest @param {string} slug @param {PlanContext} ctx
 * @param {{ run?: (argv: string[], opts?: { timeoutMs?: number, env?: Record<string, string> }) => Promise<{ code: number, stdout: string, stderr: string }>, kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 */
export async function cycleMessenger(manifest, slug, ctx, deps = {}) {
  const plan = planResident(manifest, slug, ctx);
  const base = { type: "resident-cycle", resident: slug, harness: "agora", position: slug, room: plan.rooms[0] };
  const state = await residentState(ctx.stateRoot, slug, deps);
  const stream = state.running ? "live" : "gone";
  const argv = messengerArgv(ctx, plan.rooms[0], "--once", manifest.residents[slug].args);
  const r = await (deps.run ?? runCommand)(argv, { timeoutMs: 60_000, env: plan.env });
  const line = r.stdout.split(/\r?\n/).find((l) => l.includes('"messenger-tick"'));
  /** @type {any} */
  let tick = null;
  try { tick = line ? JSON.parse(line) : null; } catch { tick = null; }
  if (r.code !== 0 || !tick)
    return { ...base, action: "failed", stream, reason: `the backstop tick exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}` };
  return { ...base, action: "tick", stream, due: tick.due.length, posted: tick.posted.length,
    reason: `backstop tick posted ${tick.posted.length} of ${tick.due.length} due; the stream is ${stream}${state.reason ? ` (${state.reason})` : ""}` };
}

/** The per-run omp settings overlay (JSON strings are YAML strings). @param {string} extension @param {string | null} skillsDir */
export function ompOverlay(extension, skillsDir) {
  let out = `extensions:\n  - ${JSON.stringify(extension)}\n`;
  if (skillsDir) out += `skills:\n  customDirectories:\n    - ${JSON.stringify(skillsDir)}\n`;
  return out;
}

/** What --plan prints: the plan without the file parts' internals. @param {ResidentPlan} plan */
export function planView(plan) {
  const { vars: _v, overlayText: _o, files, ...rest } = plan;
  return { ...rest, files: files.map((f) => f.path) };
}

// ---------------------------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------------------------

/** Join parts with a blank line, LF endings, one final newline. @param {string[]} texts */
function joinParts(texts) {
  return texts.map((t) => t.replace(/\r\n/g, "\n").replace(/\n+$/, "")).join("\n\n") + "\n";
}

/** Remove an entry without following a link into its target. @param {string} p */
function removeEntry(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) {
    try { unlinkSync(p); } catch { rmdirSync(p); } // a directory link on Windows (junction) is removed as a directory
  } else rmSync(p, { recursive: true, force: true });
}

/**
 * Mark a folder trusted in Claude Code's `~/.claude.json` (temp file and rename; a folder already
 * trusted is left alone). Claude Code keys projects by the folder with forward slashes.
 * @param {string} folder @param {string} home
 */
export async function trustClaudeFolder(folder, home) {
  const file = path.join(home, ".claude.json");
  /** @type {any} */
  let cfg = {};
  try { cfg = JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw new AgoraError(`cannot read ${file} to trust ${folder}: ${/** @type {any} */ (e).message}`, EXIT.error); }
  const key = folder.replace(/\\/g, "/");
  cfg.projects = cfg.projects ?? {};
  const proj = (cfg.projects[key] = cfg.projects[key] ?? {});
  if (proj.hasTrustDialogAccepted === true) return false;
  proj.hasTrustDialogAccepted = true;
  await writeFileAtomic(file, JSON.stringify(cfg, null, 2));
  return true;
}

/**
 * Write what the plan names: the rendered prompt, the omp overlay, the working folder's files, the
 * skill copies (Claude Code) and the folder's trust entry (Claude Code).
 * @param {ResidentPlan} plan @param {{ checkout: string, home?: string }} deps
 */
export async function prepareRun(plan, deps) {
  await mkdir(plan.dir, { recursive: true });
  const read = async (/** @type {string} */ f, /** @type {string} */ what) => {
    try { return await readFile(f, "utf8"); }
    catch (e) { throw new AgoraError(`resident ${plan.resident}: cannot read ${what} ${f}: ${/** @type {any} */ (e).code ?? /** @type {any} */ (e).message}`, EXIT.error); }
  };
  // a messenger row has no prompt: nothing to render
  if (plan.prompt) {
    const block = await read(path.join(deps.checkout, ROOM_MECHANICS_DOC), "the room-mechanics block");
    const parts = [renderResidentPrompt(await read(plan.prompt.profile, "the profile"), block)];
    for (const f of plan.prompt.append) parts.push(await read(f, "an appended file"));
    await writeFileAtomic(plan.prompt.file, joinParts(parts));
  }
  if (plan.overlay && plan.overlayText) await writeFileAtomic(plan.overlay, plan.overlayText);

  await mkdir(plan.workdir, { recursive: true });
  for (const f of plan.files) {
    const texts = [];
    for (const p of f.parts) texts.push(substituteVars("file" in p ? await read(p.file, "a working-folder part") : p.text, plan.vars));
    await writeFileAtomic(f.path, joinParts(texts));
  }
  if (plan.skills && plan.skills.mode === "copy") {
    // Claude Code discovers skills under the folder's .claude/skills; copies, rebuilt whole each start
    // (a directory link made fresh is not always traversable, and a dropped skill must leave).
    const into = path.join(plan.workdir, ".claude", "skills");
    if (existsSync(into)) for (const n of readdirSync(into)) removeEntry(path.join(into, n));
    await mkdir(into, { recursive: true });
    for (const n of plan.skills.names) {
      const src = path.join(plan.skills.dir, n);
      if (!existsSync(src)) { console.error(`agora: resident ${plan.resident}: skill ${n} is not in ${plan.skills.dir}; skipped`); continue; }
      cpSync(src, path.join(into, n), { recursive: true, dereference: true });
    }
  }
  if (plan.trust && (await trustClaudeFolder(plan.trust, deps.home ?? homedir()))) console.error(`agora: trusted ${plan.trust} in ~/.claude.json`);
}

// ---------------------------------------------------------------------------------------------
// Hosts, liveness, run records
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {(argv: string[], opts?: { timeoutMs?: number, env?: Record<string, string> }) => Promise<{ code: number, stdout: string, stderr: string }>} Runner
 */

/** Run a command with no shell, killed by its own pid at the deadline; `env` is added to this process's. @type {Runner} */
export const runCommand = (argv, opts = {}) => new Promise((resolve) => {
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  try { child = spawn(argv[0], argv.slice(1), { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) }); }
  catch (e) { resolve({ code: -1, stdout: "", stderr: String(/** @type {any} */ (e)?.message ?? e) }); return; }
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { try { if (child.pid) process.kill(child.pid); } catch { /* gone */ } }, opts.timeoutMs ?? 30_000);
  child.stdout?.on("data", (d) => { stdout += d; });
  child.stderr?.on("data", (d) => { stderr += d; });
  child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
});

/**
 * @typedef {{ type: 'resident-run', id: string, resident: string, host: 'tern' | 'tmux' | 'none', startedAt: string,
 *   hostInfo: Record<string, string>, handle: Record<string, unknown> | null, pid?: number,
 *   exec: { argv: string[], env: Record<string, string>, cwd: string } }} RunRecord
 */

/**
 * The run record, with the harness pid the host's wrapper recorded beside it (a sidecar file, so the
 * wrapper and the starter never write the same file at once).
 * @param {string} stateRoot @param {string} slug @returns {Promise<RunRecord | null>}
 */
export async function readRun(stateRoot, slug) {
  const file = runFilePath(stateRoot, slug);
  try {
    const rec = JSON.parse(await readFile(file, "utf8"));
    if (rec?.type !== "resident-run") throw new AgoraError(`${file} is not a resident run record; remove it by hand`, EXIT.error);
    try {
      const side = JSON.parse(await readFile(`${file}.pid`, "utf8"));
      if (side?.id === rec.id && Number.isInteger(side.pid)) rec.pid = side.pid;
    } catch { /* no wrapper pid yet */ }
    return rec;
  } catch (e) {
    if (/** @type {any} */ (e).code === "ENOENT") return null;
    throw e;
  }
}

/** @param {string} file */
async function removeRun(file) {
  await rm(file, { force: true });
  await rm(`${file}.pid`, { force: true });
}

/** @param {string} file @returns {Promise<RunRecord>} */
async function readRunFile(file) {
  const rec = JSON.parse(await readFile(file, "utf8"));
  if (rec?.type !== "resident-run" || !rec.exec || !Array.isArray(rec.exec.argv)) throw new AgoraError(`${file} is not a resident run record`, EXIT.error);
  return rec;
}

/** The sessions of a `tern ls --json` document, windowed and detached. @param {any} doc */
function ternSessions(doc) {
  const out = [];
  for (const s of [...(Array.isArray(doc?.sessions) ? doc.sessions : []), ...(Array.isArray(doc?.detached) ? doc.detached : [])]) if (s && typeof s === "object") out.push(s);
  return out;
}

/**
 * Is the host's handle still running something? `unknown` when the host cannot be asked.
 * @param {RunRecord} run @param {{ run?: Runner, kill?: (pid: number, sig: 0) => void }} [deps]
 * @returns {Promise<'live' | 'gone' | 'unknown'>}
 */
export async function hostAlive(run, deps = {}) {
  const exec = deps.run ?? runCommand;
  // The harness's own pid, once the wrapper recorded it, settles it either way it answers.
  if (typeof run.pid === "number" && !pidAlive(run.pid, deps.kill)) return "gone";
  const h = /** @type {Record<string, any>} */ (run.handle ?? {});
  // A record with no handle and no pid is a start that died between writing it and the host
  // answering; within the lock's bound it may still be that start, past it nothing holds it.
  const handleless = run.handle === null && typeof run.pid !== "number";
  const stale = Date.now() - new Date(run.startedAt).getTime() > START_LOCK_STALE_MS;
  if (handleless) return stale ? "gone" : "unknown";
  if (run.host === "none") return typeof h.pid === "number" ? (pidAlive(h.pid, deps.kill) ? "live" : "gone") : "unknown";
  if (run.host === "tmux") {
    if (!run.hostInfo.tmux) return "unknown";
    const r = await exec([run.hostInfo.tmux, "-L", run.hostInfo.server, "has-session", "-t", run.hostInfo.session], { timeoutMs: 10_000 });
    return r.code === 0 ? "live" : r.code === -1 ? "unknown" : "gone";
  }
  if (!run.hostInfo.tern || h.session === undefined) return "unknown";
  const r = await exec([run.hostInfo.tern, "ls", "--json", ...(run.hostInfo.window ? ["--window", run.hostInfo.window] : [])], { timeoutMs: 10_000 });
  if (r.code !== 0) return "unknown";
  let doc;
  try { doc = JSON.parse(r.stdout); } catch { return "unknown"; }
  const s = ternSessions(doc).find((x) => String(x.id) === String(h.session));
  if (!s) return "gone";
  const blocks = (Array.isArray(s.tabs) ? s.tabs : []).flatMap((/** @type {any} */ t) => (Array.isArray(t?.blocks) ? t.blocks : []));
  return blocks.some((/** @type {any} */ b) => b?.live === true && (b.exited === null || b.exited === undefined)) ? "live" : "gone";
}

/** Ask the host to end its handle; best effort. @param {RunRecord} run @param {{ run?: Runner, kill?: (pid: number, sig?: any) => void }} [deps] */
async function hostKill(run, deps = {}) {
  const exec = deps.run ?? runCommand;
  const h = /** @type {Record<string, any>} */ (run.handle ?? {});
  if (run.host === "tern" && run.hostInfo.tern && h.session !== undefined)
    return exec([run.hostInfo.tern, "kill", "session", String(h.session), "--json", ...(run.hostInfo.window ? ["--window", run.hostInfo.window] : [])], { timeoutMs: 15_000 });
  if (run.host === "tmux" && run.hostInfo.tmux) return exec([run.hostInfo.tmux, "-L", run.hostInfo.server, "kill-server"], { timeoutMs: 15_000 });
  const pid = run.host === "none" ? h.pid : run.pid;
  if (typeof pid === "number") {
    try { (deps.kill ?? ((p) => process.kill(p)))(pid); return { code: 0, stdout: "", stderr: "" }; }
    catch (e) { return { code: 1, stdout: "", stderr: String(/** @type {any} */ (e).message) }; }
  }
  return { code: 1, stdout: "", stderr: "the run record carries no handle" };
}

/**
 * Is this position held? A live session record labelled with it, or the host handle of the last
 * start still running (a session between its start and its registration holds no record yet).
 * @param {string} stateRoot @param {string} slug
 * @param {{ run?: Runner, kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 */
export async function residentState(stateRoot, slug, deps = {}) {
  const records = await listRecords(stateRoot, { kill: deps.kill, boot: deps.boot });
  const sessions = records.filter((r) => r.state === "live" && positionOf(r.record) === slug).map((r) => r.slug);
  const run = await readRun(stateRoot, slug);
  const host = run ? await hostAlive(run, deps) : null;
  /** @type {string | null} */
  let reason = null;
  if (sessions.length) reason = `live session ${sessions.join(", ")} holds the position`;
  else if (host === "live") reason = `the ${run?.host} handle of the last start is running`;
  else if (host === "unknown") reason = `the ${run?.host} handle of the last start cannot be checked; stop it first or remove ${runFilePath(stateRoot, slug)}`;
  return { running: reason !== null, reason, sessions, run, host };
}

/** Exclusive start lock; a lock older than the stale bound is taken over. @param {string} dir */
async function takeLock(dir) {
  const file = path.join(dir, "start.lock");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      await writeFile(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
      return async () => { await rm(file, { force: true }); };
    } catch (e) {
      if (/** @type {any} */ (e).code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - statSync(file).mtimeMs; } catch { /* removed meanwhile */ }
      if (age < START_LOCK_STALE_MS) throw new AgoraError(`a start of this resident is in progress (${file}); retry in a moment`, EXIT.error);
      await rm(file, { force: true });
    }
  }
  throw new AgoraError(`cannot take the start lock ${file}`, EXIT.error);
}

/**
 * Run the harness in this terminal and wait. The wrapper ignores the terminal's interrupt (the
 * harness owns Ctrl+C) and passes a termination on to it.
 * @param {RunRecord['exec']} exec @param {(pid: number) => Promise<void> | void} [onPid]
 */
export function runForeground(exec, onPid) {
  return new Promise((resolve) => {
    const child = spawn(exec.argv[0], exec.argv.slice(1), { cwd: exec.cwd, env: { ...process.env, ...exec.env }, stdio: "inherit", shell: false });
    const ignore = () => {};
    const forward = (/** @type {NodeJS.Signals} */ sig) => { try { child.kill(sig); } catch { /* gone */ } };
    const onTerm = () => forward("SIGTERM");
    const onHup = () => forward("SIGHUP");
    process.on("SIGINT", ignore);
    process.on("SIGTERM", onTerm);
    if (process.platform !== "win32") process.on("SIGHUP", onHup);
    /** @type {Promise<unknown>} */
    let pidWrite = Promise.resolve();
    const done = (/** @type {number} */ code) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
      pidWrite.finally(() => resolve(code));
    };
    child.on("error", (e) => { console.error(`agora: cannot start ${exec.argv[0]}: ${e.message}`); done(EXIT.error); });
    child.on("spawn", () => { if (child.pid && onPid) pidWrite = Promise.resolve(onPid(child.pid)).catch(() => {}); });
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 : EXIT.error)));
  });
}

/**
 * `start <slug> --run <file>`: the host's program. Runs the recorded harness in this terminal,
 * records its pid beside the run record, and exits with its code.
 * @param {string} file @param {string} slug
 */
export async function execRun(file, slug) {
  const run = await readRunFile(file);
  if (run.resident !== slug) throw new AgoraError(`${file} records resident ${run.resident}, not ${slug}`, EXIT.usage);
  return runForeground(run.exec, async (pid) => {
    await writeFileAtomic(`${file}.pid`, JSON.stringify({ id: run.id, pid }) + "\n");
  });
}

/**
 * @typedef {{ run?: Runner, kill?: (pid: number, sig?: any) => void, boot?: number, home?: string, checkout: string, now?: () => Date }} StartDeps
 */

/**
 * Start one resident unless its position is held. `none` returns an `exec` the caller awaits in the
 * foreground; `tern` and `tmux` return once the host reports its handle.
 * @param {ResidentPlan} plan @param {string} stateRoot @param {StartDeps} deps
 * @returns {Promise<{ row: Record<string, unknown>, exec?: () => Promise<number> }>}
 */
export async function startResident(plan, stateRoot, deps) {
  const base = { type: "resident-start", resident: plan.resident, host: plan.host, bearer: plan.bearer, position: plan.position, rooms: plan.rooms, wake: plan.wake, harness: plan.harness, model: plan.model, workdir: plan.workdir };
  const release = await takeLock(plan.dir);
  let released = false;
  const unlock = async () => { if (!released) { released = true; await release(); } };
  try {
    const state = await residentState(stateRoot, plan.resident, deps);
    if (state.running) return { row: { ...base, action: "running", reason: state.reason, sessions: state.sessions } };
    if (state.run) {
      await hostKill(state.run, deps).catch(() => {}); // a finished host session left behind (an empty Tern session)
      await removeRun(plan.runFile);
    }
    await prepareRun(plan, { checkout: deps.checkout, home: deps.home });
    /** @type {RunRecord} */
    const run = {
      type: "resident-run", id: randomUUID(), resident: plan.resident, host: plan.host, startedAt: (deps.now?.() ?? new Date()).toISOString(),
      hostInfo: plan.hostInfo, handle: null, exec: { argv: plan.argv, env: plan.env, cwd: plan.workdir },
    };
    await writeFileAtomic(plan.runFile, JSON.stringify(run) + "\n");
    if (plan.host === "none") {
      await unlock();
      return {
        row: { ...base, action: "started", run: plan.runFile },
        exec: () => runForeground(run.exec, async (pid) => {
          await writeFileAtomic(plan.runFile, JSON.stringify({ ...run, handle: { pid }, pid }) + "\n");
        }),
      };
    }
    const r = await (deps.run ?? runCommand)(/** @type {string[]} */ (plan.hostArgv), { timeoutMs: 30_000 });
    if (r.code !== 0) {
      await removeRun(plan.runFile);
      throw new AgoraError(`resident ${plan.resident}: the ${plan.host} host refused the start (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`, EXIT.error);
    }
    /** @type {Record<string, unknown>} */
    let handle;
    if (plan.host === "tern") {
      try { handle = JSON.parse(r.stdout); } catch { handle = {}; }
      if (handle.session === undefined) {
        throw new AgoraError(`resident ${plan.resident}: tern started something but printed no session id (${r.stdout.trim().slice(0, 200)}); find it with \`tern ls\``, EXIT.error);
      }
    } else handle = { server: plan.hostInfo.server, session: plan.hostInfo.session };
    const cur = (await readRun(stateRoot, plan.resident)) ?? run;
    await writeFileAtomic(plan.runFile, JSON.stringify({ ...cur, handle }) + "\n");
    return { row: { ...base, action: "started", handle, run: plan.runFile } };
  } finally {
    await unlock();
  }
}

/**
 * Stop a resident by the host handle its start recorded, and wait until the handle is gone.
 * @param {string} stateRoot @param {string} slug
 * @param {{ run?: Runner, kill?: (pid: number, sig?: any) => void, sleep?: (ms: number) => Promise<void>, waitMs?: number }} [deps]
 */
export async function stopResident(stateRoot, slug, deps = {}) {
  const run = await readRun(stateRoot, slug);
  const base = { type: "resident-stop", resident: slug };
  if (!run) return { ...base, action: "none", reason: "no run record: this resident was not started by agora resident start (or was stopped)" };
  const before = await hostAlive(run, deps);
  const killed = await hostKill(run, deps);
  if (before === "gone") {
    await removeRun(runFilePath(stateRoot, slug));
    return { ...base, action: "not-running", host: run.host, handle: run.handle };
  }
  const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.waitMs ?? STOP_WAIT_MS);
  let now = await hostAlive(run, deps);
  while (now !== "gone" && Date.now() < deadline) { await sleep(250); now = await hostAlive(run, deps); }
  if (now !== "gone") {
    return { ...base, action: "failed", host: run.host, handle: run.handle, reason: `the ${run.host} handle is still ${now} after the stop (${(killed.stderr || killed.stdout).trim().slice(0, 200) || `exit ${killed.code}`})` };
  }
  await removeRun(runFilePath(stateRoot, slug));
  return { ...base, action: "stopped", host: run.host, handle: run.handle };
}

/**
 * The cycle's restart for a manifest resident with no restart command: stop it by its handle, wait
 * until nothing holds the position, start it again. A resident on host none has no handle a timer
 * can start into; it needs a restart command of its own (a unit that runs `start --host none`).
 * @param {Manifest} manifest @param {string} slug @param {PlanContext} ctx
 * @param {StartDeps & { sleep?: (ms: number) => Promise<void>, waitMs?: number }} [deps]
 * @returns {Promise<{ code: number, err: string }>}
 */
export async function restartResident(manifest, slug, ctx, deps = { checkout: ctx.checkout }) {
  try {
    const plan = planResident(manifest, slug, ctx);
    if (plan.host === "none") return { code: EXIT.error, err: `resident ${slug} is on host none; give it a restart command in the manifest` };
    const stopped = await stopResident(ctx.stateRoot, slug, deps);
    if (stopped.action === "failed") return { code: EXIT.error, err: "reason" in stopped ? String(stopped.reason) : "the stop failed" };
    const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (deps.waitMs ?? STOP_WAIT_MS);
    let state = await residentState(ctx.stateRoot, slug, deps);
    while (state.running && Date.now() < deadline) { await sleep(250); state = await residentState(ctx.stateRoot, slug, deps); }
    if (state.running) return { code: EXIT.error, err: `${state.reason}; it was not started by agora resident start, so stop it by hand` };
    const { row } = await startResident(plan, ctx.stateRoot, { ...deps, checkout: ctx.checkout });
    return row.action === "started" ? { code: EXIT.ok, err: "" } : { code: EXIT.error, err: String(row.reason ?? row.action) };
  } catch (e) {
    return { code: EXIT.error, err: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// The cycle timer
// ---------------------------------------------------------------------------------------------

/** @param {string} s */
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A Windows command-line argument. @param {string} a */
const winArg = (a) => (/[\s"]/.test(a) || !a ? `"${a.replace(/"/g, '\\"')}"` : a);
/** A POSIX shell word. @param {string} a */
const shArg = (a) => `'${a.replace(/'/g, "'\\''")}'`;

/**
 * @typedef {{ platform: string, home: string, env?: Record<string, string | undefined>, node: string, entry: string,
 *   config?: string, manifest?: string, seconds?: number, uid?: number, stateRoot: string }} TimerContext
 */

/**
 * The scheduler entry for this OS, as data: the files it writes and the commands install, check and
 * remove run. Nothing is written here.
 * @param {TimerContext} ctx
 */
export function timerSpec(ctx) {
  const seconds = ctx.seconds ?? DEFAULT_TIMER_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 60 || seconds % 60 !== 0) throw new AgoraError(`--interval for the timer takes whole minutes in seconds (60, 900, ...), not ${seconds}`, EXIT.usage);
  const minutes = seconds / 60;
  const command = [ctx.node, ctx.entry, "resident", "cycle", "--all", ...(ctx.config ? ["--config", ctx.config] : []), ...(ctx.manifest ? ["--manifest", ctx.manifest] : [])];
  if (ctx.platform === "win32") {
    const args = ["--headless", ...command].map(winArg).join(" ");
    const doc = [
      `<?xml version="1.0" encoding="UTF-16"?>`,
      `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
      `  <RegistrationInfo><Description>agora resident cycle --all every ${minutes} minutes</Description></RegistrationInfo>`,
      `  <Triggers><TimeTrigger><Repetition><Interval>PT${minutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>`,
      `  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      `  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>`,
      `  <Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>`,
      `</Task>`,
      ``,
    ].join("\r\n");
    const xmlFile = path.join(tmpdir(), `${TIMER_NAME}-${process.pid}.xml`);
    return {
      kind: "schtasks", name: TIMER_NAME, command, interval: `PT${minutes}M`, expect: { command: "conhost.exe", arguments: args, interval: `PT${minutes}M` },
      files: [{ path: xmlFile, content: doc, encoding: /** @type {const} */ ("utf16le"), temporary: true }],
      install: [["schtasks", "/Create", "/TN", TIMER_NAME, "/XML", xmlFile, "/F"]],
      check: [["schtasks", "/Query", "/TN", TIMER_NAME, "/XML", "ONE"]],
      remove: [["schtasks", "/Delete", "/TN", TIMER_NAME, "/F"]],
    };
  }
  for (const a of command) if (/['"\\%$`\n]/.test(a)) throw new AgoraError(`the timer's command cannot carry ${JSON.stringify(a)} (a quote, backslash, % or $ in a path); move the file`, EXIT.usage);
  const line = `exec ${command.map(shArg).join(" ")}`;
  if (ctx.platform === "darwin") {
    const file = path.join(ctx.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const log = path.join(ctx.stateRoot, "residents", "cycle.log");
    const uid = ctx.uid ?? 0;
    const content = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      `  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>${xml(line)}</string></array>`,
      `  <key>StartInterval</key><integer>${seconds}</integer>`,
      `  <key>RunAtLoad</key><false/>`,
      `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n");
    return {
      kind: "launchd", name: LAUNCHD_LABEL, command, interval: `${seconds}s`, expect: null,
      files: [{ path: file, content, encoding: /** @type {const} */ ("utf8"), temporary: false }],
      install: [["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`], ["launchctl", "bootstrap", `gui/${uid}`, file]],
      check: [["launchctl", "print", `gui/${uid}/${LAUNCHD_LABEL}`]],
      remove: [["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`]],
    };
  }
  const unitDir = path.join(ctx.env?.XDG_CONFIG_HOME || path.join(ctx.home, ".config"), "systemd", "user");
  const service = [
    `[Unit]`,
    `Description=agora resident cycle --all`,
    ``,
    `[Service]`,
    `Type=oneshot`,
    `ExecStart=/bin/sh -lc "${line}"`,
    ``,
  ].join("\n");
  const timer = [
    `[Unit]`,
    `Description=agora resident cycle --all every ${minutes} minutes`,
    ``,
    `[Timer]`,
    `OnBootSec=${minutes}min`,
    `OnUnitActiveSec=${minutes}min`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n");
  return {
    kind: "systemd", name: `${TIMER_NAME}.timer`, command, interval: `${minutes}min`, expect: null,
    files: [
      { path: path.join(unitDir, `${TIMER_NAME}.service`), content: service, encoding: /** @type {const} */ ("utf8"), temporary: false },
      { path: path.join(unitDir, `${TIMER_NAME}.timer`), content: timer, encoding: /** @type {const} */ ("utf8"), temporary: false },
    ],
    install: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${TIMER_NAME}.timer`]],
    check: [["systemctl", "--user", "is-enabled", `${TIMER_NAME}.timer`], ["systemctl", "--user", "is-active", `${TIMER_NAME}.timer`]],
    remove: [["systemctl", "--user", "disable", "--now", `${TIMER_NAME}.timer`], ["systemctl", "--user", "daemon-reload"]],
  };
}

/** @typedef {ReturnType<typeof timerSpec>} TimerSpec */

/** The `<Command>`, `<Arguments>` and `<Interval>` of a scheduled task's XML. @param {string} doc */
export function parseTaskXml(doc) {
  const unxml = (/** @type {string | undefined} */ s) => s === undefined ? undefined : s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const tag = (/** @type {string} */ t) => unxml(doc.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim());
  return { command: tag("Command"), arguments: tag("Arguments"), interval: tag("Interval") };
}

/**
 * install | check | remove. `check` changes nothing and reports ok, missing or differs.
 * @param {'install' | 'check' | 'remove'} action @param {TimerSpec} spec
 * @param {{ run?: Runner, writeFile?: (file: string, data: Buffer | string) => Promise<void>, readFile?: (file: string) => Promise<string>, rm?: (file: string) => Promise<void>, mkdir?: (dir: string) => Promise<void> }} [deps]
 */
export async function runTimer(action, spec, deps = {}) {
  const exec = deps.run ?? runCommand;
  const write = deps.writeFile ?? ((f, d) => writeFile(f, d));
  const read = deps.readFile ?? ((f) => readFile(f, "utf8"));
  const remove = deps.rm ?? ((f) => rm(f, { force: true }));
  const mk = deps.mkdir ?? (async (d) => { await mkdir(d, { recursive: true }); });
  const base = { type: "resident-timer", action, kind: spec.kind, name: spec.name, interval: spec.interval, command: spec.command };
  /** @type {Array<{ argv: string[], code: number, stderr: string }>} */
  const ran = [];
  const go = async (/** @type {string[]} */ argv) => { const r = await exec(argv, { timeoutMs: 30_000 }); ran.push({ argv, code: r.code, stderr: r.stderr.trim().slice(0, 300) }); return r; };

  if (action === "check") {
    /** @type {string[]} */
    const problems = [];
    let present = true;
    if (spec.kind === "schtasks") {
      const r = await go(spec.check[0]);
      if (r.code !== 0) present = false;
      else {
        const got = parseTaskXml(r.stdout.replace(/\u0000/g, ""));
        const want = /** @type {NonNullable<TimerSpec['expect']>} */ (spec.expect);
        if (got.command !== want.command || got.arguments !== want.arguments) problems.push(`its command is ${got.command} ${got.arguments}, not ${want.command} ${want.arguments}`);
        if (got.interval !== want.interval) problems.push(`its interval is ${got.interval}, not ${want.interval}`);
      }
    } else {
      for (const f of spec.files) {
        let text = null;
        try { text = await read(f.path); } catch { /* absent */ }
        if (text === null) present = false;
        else if (text !== f.content) problems.push(`${f.path} differs from what install writes`);
      }
      if (present) for (const argv of spec.check) { const r = await go(argv); if (r.code !== 0) problems.push(`${argv.join(" ")}: exit ${r.code}${r.stdout.trim() ? ` (${r.stdout.trim()})` : ""}`); }
    }
    const state = !present ? "missing" : problems.length ? "differs" : "ok";
    return { ...base, state, problems, ran };
  }
  if (action === "install") {
    for (const f of spec.files) {
      await mk(path.dirname(f.path));
      await write(f.path, f.encoding === "utf16le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(f.content, "utf16le")]) : f.content);
    }
    let failed = null;
    try {
      for (const argv of spec.install) {
        const r = await go(argv);
        // launchd's bootout of an agent that is not loaded fails; that is the case it exists for
        if (r.code !== 0 && !(spec.kind === "launchd" && argv[1] === "bootout")) { failed = `${argv.join(" ")}: exit ${r.code} ${r.stderr.trim().slice(0, 300)}`; break; }
      }
    } finally {
      for (const f of spec.files) if (f.temporary) await remove(f.path);
    }
    return { ...base, state: failed ? "failed" : "installed", problems: failed ? [failed] : [], ran };
  }
  for (const argv of spec.remove) await go(argv);
  for (const f of spec.files) if (!f.temporary) await remove(f.path);
  return { ...base, state: "removed", problems: [], ran };
}
