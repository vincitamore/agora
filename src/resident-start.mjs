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
 * a Windows scheduled task, a systemd user timer, or a launchd agent; on Windows also the startup
 * entries that bring Tern and the seat service up at logon. `check` reports and changes nothing.
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
import { ROOM_MECHANICS_DOC, RESIDENT_SLUG_RE, RUN_FILE, markSuccession, renderResidentPrompt, residentDir } from "./resident.mjs";
import { POSITION_RE, bootEpoch, listRecords, markRestarted, pidAlive, positionOf, roomOfKey, sessionScope } from "./session.mjs";
import { LINEAGE_RE, counterparts, differentFrom, lineageClash, modelFamily } from "./lineage.mjs";
import { modelLabel } from "../plugins/omp/agora-room/index.mjs";
import { ACTIVITY_FILE, livenessPath } from "./messenger.mjs";

export const MANIFEST_VERSION = 1;
export const HARNESSES = Object.freeze(["omp", "claude", "agora"]);
export const HOSTS = Object.freeze(["tern", "tmux", "none"]);
export const WAKES = Object.freeze(["all", "addressed", "mine"]);
const TOP_KEYS = new Set(["version", "models", "vars", "defaults", "residents", "grants"]);
const ROW_KEYS = new Set(["role", "harness", "model", "thinking", "rooms", "wake", "profile", "append", "workdir", "skills", "host", "env", "args", "preamble", "bearer", "restart", "command", "tenure", "max", "lineage", "context"]);
const REQUIRED = ["role", "harness", "model", "rooms", "profile", "host"];
/** `standing`: started by `start --all` and kept; `on-demand`: started only when a grant holder wants it. */
export const TENURES = Object.freeze(["standing", "on-demand"]);
/** The fields of one grant; `card` is the only optional one. */
export const GRANT_KEYS = Object.freeze(["roles", "models", "maxLive", "maxHours", "card"]);
/** A messenger row runs code, not a model: it names no model and no profile. */
const NOT_REQUIRED_FOR_AGORA = new Set(["model", "profile"]);
/** The model a messenger row records when it names none: its bearer is `<role>/Code`. */
export const MESSENGER_MODEL = "code";
/** What the verb itself sets for the harness; a manifest may not set these. */
export const RESERVED_ENV = Object.freeze(["AGORA_CONFIG", "AGORA_STATE", "AGORA_SESSION", "AGORA_LABEL", "AGORA_ACTOR", "AGORA_ROLE", "AGORA_MODEL", "AGORA_ROOM", "AGORA_ROOM_WAKE", "AGORA_ROOM_PREAMBLE", "AGORA_ROOM_CMD", "AGORA_CONTEXT_CEILING"]);
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
 *   restart: string | null, command: string[] | null, tenure: 'standing' | 'on-demand', max: number, lineage: string,
 *   context: { ceiling: number } | null,
 * }} ManifestResident
 */
/**
 * What a grant holder (a position, the key) may stand up: `roles` "open" or a list of role names,
 * `models` the aliases a want may name, `maxLive` the wants live at once, `maxHours` the longest a
 * want lasts, `card` the card a new role wears when the want names none. `room` is the holder's
 * position less its last segment: the prefix every granted position carries.
 * @typedef {{ holder: string, room: string, roles: 'open' | string[], models: string[], maxLive: number, maxHours: number, card: string | null }} Grant
 */
/**
 * @typedef {{ file: string, dir: string, models: Record<string, string>, vars: Record<string, string>,
 *   raw: Record<string, any>, residents: Record<string, ManifestResident>, grants: Record<string, Grant> }} Manifest
 */

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
    // which family this position may run on: "any", or "different-from-<role>" in its own room (src/lineage.mjs)
    const lineage = row.lineage === undefined ? "any" : row.lineage;
    if (typeof lineage !== "string" || !LINEAGE_RE.test(lineage)) bad(`${at}.lineage`, `lineage must be "any" or "different-from-<role>", not ${JSON.stringify(lineage)}`);

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
    const tenure = /** @type {'standing' | 'on-demand'} */ (oneOf("tenure", TENURES, "standing"));
    let max = 1;
    if (row.max !== undefined) {
      if (!Number.isInteger(row.max) || /** @type {number} */ (row.max) < 1) bad(`${at}.max`, "must be a whole number of positions, at least 1 (the row's own and -2, -3, ... for wants)");
      if (agoraRow && row.max !== 1) bad(`${at}.max`, "a messenger row (harness agora) is one per room");
      max = /** @type {number} */ (row.max);
    }
    // past `ceiling` tokens the cycle asks a succession for the position, honoured at its next idle
    /** @type {{ ceiling: number } | null} */
    let context = null;
    if (row.context !== undefined && !agoraRow) {
      if (!isObj(row.context)) bad(`${at}.context`, "must be an object { ceiling: <tokens> }");
      const c = /** @type {Record<string, unknown>} */ (row.context);
      for (const k of Object.keys(c)) if (k !== "ceiling") bad(`${at}.context.${k}`, "unknown field (have: ceiling)");
      if (c.ceiling === undefined) bad(`${at}.context.ceiling`, "is required");
      if (!Number.isInteger(c.ceiling) || /** @type {number} */ (c.ceiling) < 1) bad(`${at}.context.ceiling`, "must be a whole number of tokens, at least 1");
      context = { ceiling: /** @type {number} */ (c.ceiling) };
    }

    residents[slug] = {
      slug, role, harness, model: agoraRow ? MESSENGER_MODEL : str("model"), thinking: agoraRow ? null : optStr("thinking"), rooms: [...new Set(rooms)], wake,
      // a messenger row has no prompt: a profile or an append inherited from defaults is not read
      profile: agoraRow ? "" : resolveIn(str("profile")), append: agoraRow ? [] : strList("append", null).map(resolveIn), workdir, skills: agoraRow ? null : skills, host, env,
      args: strList("args", null), preamble, bearer, restart: optStr("restart"), command, tenure, max, lineage: /** @type {string} */ (lineage), context,
    };
  }

  // the rows' own models must keep their own lineage rules: what `start --all` would refuse, the file refuses first
  for (const slug of Object.keys(residents)) {
    const row = residents[slug];
    if (row.harness === "agora" || differentFrom(row.lineage) === null) continue;
    const mine = models[row.model] ?? row.model;
    for (const c of counterparts(lineageRows({ models, residents }), slug)) {
      const theirs = models[residents[c.position].model] ?? residents[c.position].model;
      if (modelFamily(theirs) === modelFamily(mine))
        bad(`residents.${slug}.lineage`, `${slug} runs ${mine}, family ${modelFamily(mine)}, the family of ${c.position} (${theirs}); the manifest says ${c.rule}`);
    }
  }

  /** @type {Record<string, Grant>} */
  const grants = {};
  if (top.grants !== undefined) {
    if (!isObj(top.grants)) bad("grants", "must be an object of <holder position>: { roles, models, maxLive, maxHours }");
    for (const [holder, gRaw] of Object.entries(/** @type {Record<string, unknown>} */ (top.grants))) {
      const at = `grants.${holder}`;
      if (!residents[holder]) bad(at, `a grant's key is the position that holds it, and names a resident row (have: ${Object.keys(residents).join(", ")})`);
      if (residents[holder].harness === "agora") bad(at, "a messenger row (harness agora) runs code and wants nothing");
      if (!isObj(gRaw)) bad(at, "must be an object { roles, models, maxLive, maxHours }");
      const g = /** @type {Record<string, unknown>} */ (gRaw);
      for (const k of Object.keys(g)) if (!GRANT_KEYS.includes(k)) bad(`${at}.${k}`, `unknown field (have: ${GRANT_KEYS.join(", ")})`);
      for (const k of GRANT_KEYS) if (k !== "card" && g[k] === undefined) bad(`${at}.${k}`, "is required");
      /** @type {'open' | string[]} */
      let roles;
      if (g.roles === "open") roles = "open";
      else if (Array.isArray(g.roles) && g.roles.length && g.roles.every((r) => typeof r === "string" && ROLE_RE.test(r))) roles = [...new Set(/** @type {string[]} */ (g.roles))];
      else bad(`${at}.roles`, `must be "open" or a non-empty list of role names (${ROLE_RE})`);
      if (!Array.isArray(g.models) || !g.models.length || g.models.some((m) => typeof m !== "string")) bad(`${at}.models`, "must be a non-empty list of model aliases");
      for (const m of /** @type {string[]} */ (g.models)) if (!Object.hasOwn(models, m)) bad(`${at}.models`, `${JSON.stringify(m)} is not an alias in models (have: ${Object.keys(models).join(", ") || "none"})`);
      if (!Number.isInteger(g.maxLive) || /** @type {number} */ (g.maxLive) < 0) bad(`${at}.maxLive`, "must be a whole number, 0 or more");
      if (!Number.isInteger(g.maxHours) || /** @type {number} */ (g.maxHours) < 1) bad(`${at}.maxHours`, "must be a whole number of hours, at least 1");
      let card = null;
      if (g.card !== undefined) {
        if (typeof g.card !== "string" || !g.card.trim()) bad(`${at}.card`, "must be a path (relative to the manifest)");
        card = resolveIn(/** @type {string} */ (g.card).trim());
      }
      const dot = holder.lastIndexOf(".");
      grants[holder] = { holder, room: dot < 0 ? "" : holder.slice(0, dot), roles: /** @type {'open' | string[]} */ (roles), models: [...new Set(/** @type {string[]} */ (g.models))],
        maxLive: /** @type {number} */ (g.maxLive), maxHours: /** @type {number} */ (g.maxHours), card };
    }
  }
  return { file: path.resolve(file), dir, models, vars, raw: top, residents, grants };
}

/**
 * One more row of a validated manifest, from fields as a manifest row would carry them over the
 * manifest's own defaults, checked exactly as the file's rows are. The way a granted position
 * becomes a row: nothing about it is accepted that the file itself would refuse.
 * @param {Manifest} manifest @param {string} slug @param {Record<string, unknown>} fields
 * @returns {ManifestResident}
 */
export function manifestRow(manifest, slug, fields) {
  const { grants: _g, residents: _r, ...rest } = manifest.raw;
  return validateManifest({ ...rest, residents: { [slug]: fields } }, manifest.file).residents[slug];
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

/** How long the cycle waits for a Tern it started to answer. */
export const TERN_WAIT_MS = 20_000;

/**
 * The program that runs Tern's session daemon: on Windows the windowed `tern.exe` beside the
 * console `tern.com` the CLI lookup finds (it opens no console window when started at logon or by a
 * headless cycle), else the CLI itself. Null when Tern is not installed.
 * @param {{ env?: Record<string, string | undefined>, platform?: string, exists?: (p: string) => boolean }} [deps]
 */
export function ternProgram(deps = {}) {
  const cli = findTern(deps);
  if (!cli) return null;
  const exists = deps.exists ?? ((/** @type {string} */ p) => { try { return statSync(p).isFile(); } catch { return false; } });
  if ((deps.platform ?? process.platform) === "win32" && /\.com$/i.test(cli)) {
    const gui = cli.replace(/\.com$/i, ".exe");
    if (exists(gui)) return gui;
  }
  return cli;
}

/**
 * Start a program that outlives this process: no shell, no window, nothing inherited. Resolves to
 * null once it has started, or to why it could not be.
 * @param {string[]} argv @returns {Promise<string | null>}
 */
export function launchDetached(argv) {
  return new Promise((resolve) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try { child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", windowsHide: true, shell: false }); }
    catch (e) { resolve(e instanceof Error ? e.message : String(e)); return; }
    child.once("error", (e) => resolve(e.message));
    child.once("spawn", () => { child.unref(); resolve(null); });
  });
}

/**
 * Tern up before residents are started into it: a Tern whose CLI answers `tern ls` is left; one
 * that does not is started the way Tern's own Start at login starts it (`tern daemon --login`: its
 * session daemon in the background, no window) and waited for. A dry run starts nothing.
 * @param {{ env?: Record<string, string | undefined>, platform?: string, exists?: (p: string) => boolean, run?: Runner,
 *   launch?: (argv: string[]) => Promise<string | null> | string | null | void, sleep?: (ms: number) => Promise<void>, waitMs?: number, dryRun?: boolean }} [deps]
 * @returns {Promise<{ up: boolean, started: boolean, reason: string | null }>}
 */
export async function ensureTern(deps = {}) {
  const cli = findTern(deps);
  if (!cli) return { up: false, started: false, reason: "tern is not installed (not on PATH, nor in the installer's folder)" };
  const exec = deps.run ?? runCommand;
  const answers = async () => (await exec([cli, "ls", "--json"], { timeoutMs: 10_000 })).code === 0;
  if (await answers()) return { up: true, started: false, reason: null };
  if (deps.dryRun) return { up: false, started: false, reason: "Tern is not running (dry run: not started)" };
  const program = /** @type {string} */ (ternProgram(deps));
  const failed = await (deps.launch ?? launchDetached)([program, "daemon", "--login"]);
  if (failed) return { up: false, started: false, reason: `Tern is not running, and ${program} daemon --login could not be started: ${failed}` };
  const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const waitMs = deps.waitMs ?? TERN_WAIT_MS;
  for (let waited = 0; waited < waitMs; waited += 500) {
    await sleep(500);
    if (await answers()) return { up: true, started: true, reason: null };
  }
  return { up: false, started: true, reason: `Tern did not answer within ${Math.round(waitMs / 1000)}s of ${program} daemon --login` };
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
 * The name a position's bearer carries: its role, or the slot when the position is one of the
 * role's numbered slots (`desk.coding-2` signs `coding-2/<Model>`), so two sessions of one role
 * never share a bearer, and an address or a signature names exactly one of them.
 * @param {string} slug @param {string} role
 */
export function bearerName(slug, role) {
  const segment = slug.slice(slug.lastIndexOf(".") + 1);
  return segment.startsWith(`${role}-`) && /^\d+$/.test(segment.slice(role.length + 1)) ? segment : role;
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
  return path.join(residentDir(stateRoot, slug), RUN_FILE);
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
  const signs = bearerName(slug, row.role);
  const bearer = row.bearer ?? defaultBearer(signs, model);
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
      // the model id the session runs: its registration records it, so the family is read from the id
      AGORA_MODEL: model,
    };
  if (!ctx.cfg.path) delete harnessEnv.AGORA_CONFIG;
  if (row.preamble && !messenger) harnessEnv.AGORA_ROOM_PREAMBLE = row.preamble;
  // the row's own context ceiling: the harness's agora-room watch compares its context with it at
  // every turn end and asks the succession itself, so the ceiling holds between cycle runs
  if (row.context && !messenger) harnessEnv.AGORA_CONTEXT_CEILING = String(row.context.ceiling);
  // omp's extension registers `<AGORA_ROLE>/<Model>` itself and follows a model change (AGORA_ROLE
  // carries the slot for a numbered slot); an explicit bearer, and every Claude Code session, signs
  // through AGORA_ACTOR.
  if (!messenger) {
    if (row.harness === "omp" && row.bearer === null) harnessEnv.AGORA_ROLE = signs;
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
    // the family this start runs and the positions the manifest's lineage rules bind it against
    lineage: { family: modelFamily(model), against: counterparts(lineageRows(manifest), slug) },
  };
}

/**
 * The rows as the lineage rules read them: each with its model id (the alias resolved).
 * @param {Pick<Manifest, 'models' | 'residents'>} manifest
 * @returns {Record<string, import("./lineage.mjs").LineageRow>}
 */
export function lineageRows(manifest) {
  return Object.fromEntries(Object.values(manifest.residents).map((r) => [r.slug, { slug: r.slug, role: r.role, harness: r.harness, lineage: r.lineage, model: manifest.models[r.model] ?? r.model }]));
}

/**
 * The counterparts in force, each with the model it runs: a session at the position that is not
 * gone (its record's model), else the run record the last start left (its model; a host that died
 * still counts, because the supervisor restarts it on that model), else nothing. A session with no
 * model recorded is read by its row's model.
 * @param {string} stateRoot @param {import("./lineage.mjs").Counterpart[]} against
 * @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 */
export async function modelsInForce(stateRoot, against, deps = {}) {
  if (!against.length) return [];
  const records = await listRecords(stateRoot, { kill: deps.kill, boot: deps.boot });
  /** @type {Array<import("./lineage.mjs").Counterpart & { model: string, source: string }>} */
  const out = [];
  for (const c of against) {
    const held = records.filter((r) => r.state !== "gone" && positionOf(r.record) === c.position)
      .sort((a, b) => String(b.record?.startedAt ?? "").localeCompare(String(a.record?.startedAt ?? "")))[0];
    if (held?.record?.model) { out.push({ ...c, model: held.record.model, source: `session ${held.slug}` }); continue; }
    const run = await readRun(stateRoot, c.position);
    if (run?.model) out.push({ ...c, model: run.model, source: "run record" });
    else if (held || run) out.push({ ...c, model: c.rowModel, source: "manifest row" });
  }
  return out;
}

/**
 * Why a start of `slug` on `model` (its row's model when omitted) would break a lineage rule of the
 * manifest, or null. What `start`, the cycle's relaunch and the grant's `want --model` all ask.
 * @param {Pick<Manifest, 'models' | 'residents'>} manifest @param {string} slug @param {string} stateRoot
 * @param {{ model?: string, kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 */
export async function lineageRefusal(manifest, slug, stateRoot, deps = {}) {
  const rows = lineageRows(manifest);
  const row = rows[slug];
  if (!row) return null;
  const model = deps.model === undefined ? row.model : manifest.models[deps.model] ?? deps.model;
  return lineageClash({ slug, model }, await modelsInForce(stateRoot, counterparts(rows, slug), deps));
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
 *   model?: string, hostInfo: Record<string, string>, handle: Record<string, unknown> | null, pid?: number, pidBoot?: number,
 *   exec: { argv: string[], env: Record<string, string>, cwd: string } }} RunRecord
 */

/**
 * The run record, with the harness pid the host's wrapper recorded beside it (a sidecar file, so the
 * wrapper and the starter never write the same file at once) and the boot that pid belongs to.
 * @param {string} stateRoot @param {string} slug @returns {Promise<RunRecord | null>}
 */
export async function readRun(stateRoot, slug) {
  const file = runFilePath(stateRoot, slug);
  try {
    const rec = JSON.parse(await readFile(file, "utf8"));
    if (rec?.type !== "resident-run") throw new AgoraError(`${file} is not a resident run record; remove it by hand`, EXIT.error);
    try {
      const side = JSON.parse(await readFile(`${file}.pid`, "utf8"));
      if (side?.id === rec.id && Number.isInteger(side.pid)) {
        rec.pid = side.pid;
        if (typeof side.bootEpoch === "number") rec.pidBoot = side.bootEpoch;
      }
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
 * Is the host's handle still running something? `unknown` when the host cannot be asked. Nothing a
 * start recorded outlives a reboot: a harness pid from another boot names whatever runs on it now,
 * and a tmux server or a foreground harness started before this boot is gone with it. A Tern
 * session is asked of Tern, which may keep sessions across a restart of its own.
 * @param {RunRecord} run @param {{ run?: Runner, kill?: (pid: number, sig: 0) => void, boot?: number }} [deps]
 * @returns {Promise<'live' | 'gone' | 'unknown'>}
 */
export async function hostAlive(run, deps = {}) {
  const exec = deps.run ?? runCommand;
  const boot = deps.boot ?? bootEpoch();
  // The harness's own pid, once the wrapper recorded it in this boot, settles it either way it answers.
  if (typeof run.pid === "number" && typeof run.pidBoot === "number" && Math.abs(boot - run.pidBoot) > 2) return "gone";
  if (typeof run.pid === "number" && !pidAlive(run.pid, deps.kill)) return "gone";
  if (run.host !== "tern" && Date.parse(run.startedAt) / 1000 < boot - 2) return "gone";
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
 * The Tern sessions in the plan's window that carry the plan's session name, each read by what its
 * live blocks run: `ours` (this position's wrapper on this run file: the host is up), `other` (a
 * resident wrapper on another run file: another state root's resident), or `stale` (no resident
 * wrapper at all). Tern keeps its sessions across its own restart and a reboot and restores each
 * as a bare shell in its folder under the old name: such a session holds no harness, yet the name
 * refuses `tern new`. On Windows Tern runs a command through `powershell -c`, so the wrapper is
 * read from the block's command line as well as its program and arguments. Null when Tern cannot
 * be asked.
 * @param {ResidentPlan} plan @param {{ run?: Runner }} [deps]
 * @returns {Promise<Array<{ id: string, kind: 'ours' | 'other' | 'stale' }> | null>}
 */
export async function ternNamesakes(plan, deps = {}) {
  if (!plan.hostInfo.tern) return null;
  const r = await (deps.run ?? runCommand)([plan.hostInfo.tern, "ls", "--json", ...(plan.hostInfo.window ? ["--window", plan.hostInfo.window] : [])], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  let doc;
  try { doc = JSON.parse(r.stdout); } catch { return null; }
  const norm = (/** @type {string} */ s) => s.replace(/\\/g, "/").toLowerCase();
  const file = norm(plan.runFile);
  return ternSessions(doc).filter((s) => s.name === plan.name).map((s) => {
    /** @type {string[]} */
    const lines = (Array.isArray(s.tabs) ? s.tabs : []).flatMap((/** @type {any} */ t) => (Array.isArray(t?.blocks) ? t.blocks : []))
      .filter((/** @type {any} */ b) => b?.live === true && (b.exited === null || b.exited === undefined))
      .map((/** @type {any} */ b) => norm([b.command ?? "", b.program ?? "", ...(Array.isArray(b.args) ? b.args : [])].join(" ")));
    const kind = lines.some((l) => l.includes(file)) ? "ours" : lines.some((l) => /\bresident\s+start\b/.test(l) && l.includes("--run")) ? "other" : "stale";
    return { id: String(s.id), kind: /** @type {'ours' | 'other' | 'stale'} */ (kind) };
  });
}

/**
 * Is this position held? A live session record labelled with it, or the host handle of the last
 * start still running (a session between its start and its registration holds no record yet). A
 * position not held whose last start left a run record also says since when it is absent and why
 * (`absenceOf`): what a supervisor's restart line reports.
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
  const absent = run && reason === null ? await absenceOf(stateRoot, slug, run, records, { boot: deps.boot }) : null;
  return { running: reason !== null, reason, sessions, run, host, ...(absent ? { absent } : {}) };
}

/**
 * Since when a position is absent, and why: the newest instant anything showed it live (its run
 * record's start; each of its sessions' record writes and watch heartbeats, the activity record's
 * `updatedAt`; a messenger stream's liveness file), and `reboot` when this machine booted after that
 * instant, else `host` (its host's handle ended within this boot).
 * @param {string} stateRoot @param {string} slug @param {RunRecord} run
 * @param {Array<{ slug: string, record?: any }>} records the seat's session records
 * @param {{ boot?: number }} [deps]
 * @returns {Promise<{ since: number, cause: 'reboot' | 'host' }>}
 */
export async function absenceOf(stateRoot, slug, run, records, deps = {}) {
  const at = (/** @type {unknown} */ v) => { const t = Date.parse(String(v ?? "")); return Number.isFinite(t) ? t : -Infinity; };
  const json = async (/** @type {string} */ f) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return null; } };
  let since = at(run.startedAt);
  for (const r of records) {
    if (positionOf(r.record) !== slug) continue;
    since = Math.max(since, at(r.record?.lastSeen), at((await json(path.join(stateRoot, "sessions", r.slug, ACTIVITY_FILE)))?.updatedAt));
  }
  const dir = path.join(stateRoot, "messenger");
  /** @type {string[]} */
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.startsWith(`${slug}.`) && n.endsWith(".json")); } catch { /* no messenger here */ }
  for (const n of names) {
    const doc = await json(path.join(dir, n));
    if (doc?.harness === "agora" && doc.session === slug) since = Math.max(since, at(doc.updatedAt));
  }
  const boot = (deps.boot ?? bootEpoch()) * 1000;
  // the boot epoch is read to the second and wobbles by one or two: a boot within 2 s of the last
  // sign of life is not taken for a reboot
  return { since, cause: Number.isFinite(since) && boot - 2000 > since ? "reboot" : "host" };
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
 * records its pid (and the boot it belongs to) beside the run record, and exits with its code.
 * @param {string} file @param {string} slug
 */
export async function execRun(file, slug) {
  const run = await readRunFile(file);
  if (run.resident !== slug) throw new AgoraError(`${file} records resident ${run.resident}, not ${slug}`, EXIT.usage);
  return runForeground(run.exec, async (pid) => {
    await writeFileAtomic(`${file}.pid`, JSON.stringify({ id: run.id, pid, bootEpoch: bootEpoch() }) + "\n");
  });
}

/**
 * @typedef {{ run?: Runner, kill?: (pid: number, sig?: any) => void, boot?: number, home?: string, checkout: string, now?: () => Date }} StartDeps
 */

/**
 * Start one resident unless its position is held. A model harness takes a new session key at every
 * launch, so a start at a position whose last session is gone writes the inherit marker naming that
 * session (`markSuccession`): a relaunch, a model swap or a restart after a death is a succession,
 * and the new session's agora-room extension or plugin inherits before its first read. `none`
 * returns an `exec` the caller awaits in the foreground; `tern` and `tmux` return once the host
 * reports its handle. The run record of the start that stood is replaced only by the next start's:
 * a start that is refused, or that the host refuses, leaves it, so the supervisor still reads the
 * position as one that stood and died (`stop` alone removes it).
 * @param {ResidentPlan} plan @param {string} stateRoot @param {StartDeps} deps
 * @returns {Promise<{ row: Record<string, unknown>, exec?: () => Promise<number> }>}
 */
export async function startResident(plan, stateRoot, deps) {
  /** @type {Record<string, unknown>} */
  const base = { type: "resident-start", resident: plan.resident, host: plan.host, bearer: plan.bearer, position: plan.position, rooms: plan.rooms, wake: plan.wake, harness: plan.harness, model: plan.model, workdir: plan.workdir };
  const release = await takeLock(plan.dir);
  let released = false;
  const unlock = async () => { if (!released) { released = true; await release(); } };
  try {
    const state = await residentState(stateRoot, plan.resident, deps);
    if (state.running) return { row: { ...base, action: "running", reason: state.reason, sessions: state.sessions } };
    // a finished host session left behind (an empty Tern session) is ended; its record stays until a new one replaces it
    const prior = state.run ? await readFile(plan.runFile, "utf8").catch(() => null) : null;
    if (state.run) await hostKill(state.run, deps).catch(() => {});
    // lineage: a start onto the family a counterpart in force runs is refused before anything is written
    const clash = lineageClash({ slug: plan.resident, model: plan.model }, await modelsInForce(stateRoot, plan.lineage.against, { kill: deps.kill, boot: deps.boot }));
    if (clash) return { row: { ...base, action: "refused", reason: clash } };
    // a messenger row runs as its position's own session key, so it has nothing to inherit
    const succession = plan.harness === "agora" ? null : await markSuccession(stateRoot, plan.resident, { kill: deps.kill, boot: deps.boot });
    if (succession) base.inherit = { from: succession.from, by: succession.by, at: succession.at };
    await prepareRun(plan, { checkout: deps.checkout, home: deps.home });
    /** @type {RunRecord} */
    const run = {
      type: "resident-run", id: randomUUID(), resident: plan.resident, host: plan.host, startedAt: (deps.now?.() ?? new Date()).toISOString(),
      model: plan.model, hostInfo: plan.hostInfo, handle: null, exec: { argv: plan.argv, env: plan.env, cwd: plan.workdir },
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
    const exec = deps.run ?? runCommand;
    let r = await exec(/** @type {string[]} */ (plan.hostArgv), { timeoutMs: 30_000 });
    /** @type {string[]} */
    const cleared = [];
    /** @type {string | null} */
    let namesake = null;
    if (r.code !== 0 && plan.host === "tern") {
      // a refused `tern new` may be a session already under this name: one Tern restored after its
      // own restart or a reboot holds no harness and is closed by its id; any other is said by name
      const namesakes = (await ternNamesakes(plan, deps)) ?? [];
      const ours = namesakes.find((x) => x.kind === "ours");
      const other = namesakes.find((x) => x.kind === "other");
      if (ours) {
        if (prior !== null) await writeFileAtomic(plan.runFile, prior);
        else await removeRun(plan.runFile);
        return { row: { ...base, action: "running", reason: `tern session ${ours.id} called ${plan.name} runs this position's host` } };
      }
      if (other) namesake = `tern session ${other.id} called ${plan.name} runs another resident's host (a wrapper on another run file, so another state root's): stop it there, never here`;
      else if (namesakes.length) {
        const window = plan.hostInfo.window ? ["--window", plan.hostInfo.window] : [];
        for (const x of namesakes) {
          const k = await exec([plan.hostInfo.tern, "kill", "session", x.id, "--json", ...window], { timeoutMs: 15_000 });
          if (k.code === 0) cleared.push(x.id);
        }
        if (cleared.length === namesakes.length) r = await exec(/** @type {string[]} */ (plan.hostArgv), { timeoutMs: 30_000 });
        else namesake = `tern session ${namesakes.filter((x) => !cleared.includes(x.id)).map((x) => x.id).join(", ")} called ${plan.name} holds no harness and would not close`;
      }
    }
    if (r.code !== 0) {
      if (prior !== null) await writeFileAtomic(plan.runFile, prior);
      else await removeRun(plan.runFile);
      throw new AgoraError(`resident ${plan.resident}: the ${plan.host} host refused the start (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}${namesake ? `; ${namesake}` : ""}`, EXIT.error);
    }
    if (cleared.length) base.cleared = cleared;
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
  await markStopped(stateRoot, slug, deps);
  return { ...base, action: "stopped", host: run.host, handle: run.handle };
}

/**
 * A stop is not a departure: the sessions that held the position (now gone or unknown) are marked
 * as handled in every room they held a place in, so no sibling's watch announces them later. The
 * stop's own record (the supervisor's N8 line, or the operator's act) is the account of it.
 * @param {string} stateRoot @param {string} slug @param {{ kill?: (pid: number, sig: 0) => void, boot?: number }} deps
 */
async function markStopped(stateRoot, slug, deps) {
  for (const r of await listRecords(stateRoot, { kill: deps.kill, boot: deps.boot })) {
    if (r.state === "live" || positionOf(r.record) !== slug) continue;
    const scope = await sessionScope(r.dir);
    const rooms = new Set([...scope.rooms, ...scope.armed.map((a) => a.key)].map(roomOfKey));
    for (const room of rooms) await markRestarted(r.dir, room, `resident stop ${slug}`, "stopped");
  }
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
    // a relaunch that would break lineage is refused before the running session is stopped
    const clash = lineageClash({ slug, model: plan.model }, await modelsInForce(ctx.stateRoot, plan.lineage.against, { kill: deps.kill, boot: deps.boot }));
    if (clash) return { code: EXIT.error, err: clash };
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
/**
 * One word of a `.cmd` line: quoted when cmd would split or act on it (or `always`), with `%`
 * doubled (a batch file expands it even inside quotes). A quote or a line break cannot be carried,
 * and no Windows path has one.
 * @param {string} a @param {boolean} [always]
 */
const cmdArg = (a, always = false) => {
  if (/["\r\n]/.test(a)) throw new AgoraError(`the timer's command cannot carry ${JSON.stringify(a)} (a quote or a line break); move the file`, EXIT.usage);
  const w = a.replace(/%/g, "%%");
  return always || !a || /[\s&|<>^(),;=!%]/.test(a) ? `"${w}"` : w;
};
/** A POSIX shell word. @param {string} a */
const shArg = (a) => `'${a.replace(/'/g, "'\\''")}'`;

/**
 * @typedef {{ platform: string, home: string, env?: Record<string, string | undefined>, node: string, entry: string,
 *   config?: string, manifest?: string, seconds?: number, uid?: number, stateRoot: string, user?: string, tern?: string | null,
 *   name?: string, service?: string[], serviceStart?: ServiceStartRead }} TimerContext
 * `user`: the Windows account the logon trigger fires for (`DOMAIN\user`); `tern`: the program that
 * starts Tern's session daemon at logon (`ternProgram`), when the manifest runs a row under Tern;
 * `name`: the entries' name (`timerNames`); `service`: the positions whose rooms include a room this
 * seat hosts (a native room), which need the seat service up before the cycle; `serviceStart`: the
 * seat's last recorded service start or stop, as `readServiceStart` (src/service-cli.mjs) read it.
 */
/** @typedef {{ file: string, record: { intent: 'up' | 'down', at: string, authorityId?: string | null, config?: string | null } | null, error?: string }} ServiceStartRead */

/** How long after a logon the task first runs (the seat service's start, then the cycle): the network comes up first. */
export const LOGON_DELAY_MINUTES = 2;
/** The Windows startup entry agora writes so Tern's session daemon starts at logon. */
export const TERN_LOGIN_NAME = "agora-tern-daemon";
/**
 * The Windows startup entry an older install wrote to start the seat service at logon. Explorer can
 * skip a Run entry at logon without a trace, so the task starts the service now; install and remove
 * take this entry out.
 */
export const SERVICE_LOGIN_NAME = "agora-seat-service";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const ENTRY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The names of the OS entries the timer keeps: the scheduled task or systemd unit, the launchd
 * label, Tern's Windows startup entry, and the seat service's startup entry an older install wrote
 * (`SERVICE_LOGIN_NAME`), which install and remove take out. The default is agora's own; another
 * name (`AGORA_TIMER_NAME`) gives a second agora on one account, or a test, entries of its own that
 * never touch the default ones.
 * @param {string} [name]
 */
export function timerNames(name) {
  if (name === undefined || name === "") return { task: TIMER_NAME, label: LAUNCHD_LABEL, tern: TERN_LOGIN_NAME, service: SERVICE_LOGIN_NAME };
  if (!ENTRY_NAME_RE.test(name)) throw new AgoraError(`the timer's name ${JSON.stringify(name)} must be 1-64 letters, digits, dot, dash or underscore, starting with a letter or digit`, EXIT.usage);
  return { task: name, label: name, tern: `${name}-tern-daemon`, service: `${name}-seat-service` };
}

/**
 * The scheduler entry for this OS, as data: the files it writes and the commands install, check,
 * run (one run now, by the scheduler, outside any session's process tree) and remove run. Nothing is
 * written here. The entry runs on its interval and once at each logon, so a seat recovers its
 * residents minutes after a reboot (a Windows logon trigger, a systemd user timer's
 * `OnStartupSec`, launchd's `RunAtLoad`).
 *
 * On Windows the task's program is `conhost.exe --headless`, so no window opens, running `cmd.exe`
 * on a wrapper written into the state root: Task Scheduler refuses to start node itself under
 * `conhost --headless` (0x80070005, access denied) and starts `cmd.exe` there. The wrapper sets
 * `AGORA_STATE` to this state root, so everything it runs acts on the root that holds it, runs the
 * cycle with its output appended to `<state>/residents/cycle.log`, then writes the cycle's exit code
 * to `<state>/residents/cycle.exit`. conhost does not pass its child's exit code on, so the task's
 * Last Result says only whether the scheduler could start it; the exit record says whether the
 * cycle ran and how it ended. `login` is the startup entry (the user's Run key) that starts Tern's
 * session daemon at logon, as Tern's own Start at login does; `data` is null when no row runs under
 * Tern, and then install writes none (remove still takes agora's).
 *
 * `service` is the seat service's start: when a row's rooms include a room this seat hosts
 * (`needs`), the wrapper runs `agora service start --logon` before the cycle, at logon and on every
 * interval, with its output appended to `<state>/residents/service-start.log`. The line names no
 * authority: it starts the service as the seat's last recorded start asked (its authority and
 * config), leaves a service that answers, or was stopped with `service stop`, as it is, and starts
 * nothing when no start is recorded. Its exit code is not the task's: the cycle's line follows it
 * whatever it did, and reports a dark service itself. `legacy` is the Run entry and wrapper an
 * older install wrote for the same start, which install and remove take out.
 * @param {TimerContext} ctx
 */
export function timerSpec(ctx) {
  const seconds = ctx.seconds ?? DEFAULT_TIMER_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 60 || seconds % 60 !== 0) throw new AgoraError(`--interval for the timer takes whole minutes in seconds (60, 900, ...), not ${seconds}`, EXIT.usage);
  const minutes = seconds / 60;
  const names = timerNames(ctx.name);
  const command = [ctx.node, ctx.entry, "resident", "cycle", "--all", ...(ctx.config ? ["--config", ctx.config] : []), ...(ctx.manifest ? ["--manifest", ctx.manifest] : [])];
  if (ctx.platform === "win32") {
    const wrapper = path.join(ctx.stateRoot, "residents", "cycle.cmd");
    const log = path.join(ctx.stateRoot, "residents", "cycle.log");
    const exitFile = path.join(ctx.stateRoot, "residents", "cycle.exit");
    // `cmd /c "<file>"` keeps the quotes (and so a path with spaces) only while nothing between them
    // is one of cmd's special characters; conhost mangles the `/s ""..""` form that would allow them
    if (/["\r\n&<>()@^|%]/.test(wrapper)) throw new AgoraError(`the timer's wrapper ${wrapper} cannot carry a quote or any of & < > ( ) @ ^ | %, which cmd /c reads; give agora a state root without them (AGORA_STATE, or the config's state)`, EXIT.usage);
    const needs = ctx.service ?? [];
    // the seat service, as the last recorded start asked for it, in this state root
    const serviceLog = path.join(ctx.stateRoot, "residents", "service-start.log");
    const serviceCommand = [ctx.node, ctx.entry, "service", "start", "--logon", ...(ctx.config ? ["--config", ctx.config] : [])];
    const script = [
      `@echo off`,
      // the batch file is UTF-8: a path outside the OEM code page reads as written
      `chcp 65001 >nul`,
      // the task belongs to the state root that holds its wrapper, logs and exit record
      `set "AGORA_STATE=${ctx.stateRoot}"`,
      // the service first, so the cycle that follows finds it up
      ...(needs.length ? [`${serviceCommand.map((a) => cmdArg(a)).join(" ")} >>${cmdArg(serviceLog, true)} 2>&1`] : []),
      `${command.map((a) => cmdArg(a)).join(" ")} >>${cmdArg(log, true)} 2>&1`,
      `>${cmdArg(exitFile, true)} echo %ERRORLEVEL%`,
      ``,
    ].join("\r\n");
    const args = `--headless cmd.exe /d /c "${wrapper}"`;
    const logon = `PT${LOGON_DELAY_MINUTES}M`;
    // the logon trigger names the account it fires for: one with no user is any user's, which only an administrator may register
    const doc = [
      `<?xml version="1.0" encoding="UTF-16"?>`,
      `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
      `  <RegistrationInfo><Description>agora resident cycle --all every ${minutes} minutes and at logon</Description></RegistrationInfo>`,
      `  <Triggers><TimeTrigger><Repetition><Interval>PT${minutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger><LogonTrigger><Enabled>true</Enabled>${ctx.user ? `<UserId>${xml(ctx.user)}</UserId>` : ""}<Delay>${logon}</Delay></LogonTrigger></Triggers>`,
      `  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      `  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>`,
      `  <Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>`,
      `</Task>`,
      ``,
    ].join("\r\n");
    const xmlFile = path.join(tmpdir(), `${names.task}-${process.pid}.xml`);
    if (ctx.tern && /["\r\n]/.test(ctx.tern)) throw new AgoraError(`the Tern program ${JSON.stringify(ctx.tern)} cannot be written into a startup entry (a quote or a line break); move it`, EXIT.usage);
    return {
      kind: "schtasks", name: names.task, command, interval: `PT${minutes}M`, triggers: [`every PT${minutes}M`, `at logon after ${logon}`], log, exitFile,
      expect: { command: "conhost.exe", arguments: args, interval: `PT${minutes}M`, logon },
      login: { name: names.tern, key: RUN_KEY, approved: APPROVED_KEY, data: ctx.tern ? `"${ctx.tern}" daemon --login` : null },
      service: {
        needs, command: serviceCommand, log: serviceLog,
        start: ctx.serviceStart ?? { file: path.join(ctx.stateRoot, "native", "service-start.json"), record: null },
        legacy: { name: names.service, key: RUN_KEY, approved: APPROVED_KEY, file: path.join(ctx.stateRoot, "residents", "service-start.cmd") },
      },
      files: [
        { path: xmlFile, content: doc, encoding: /** @type {const} */ ("utf16le"), temporary: true },
        { path: wrapper, content: script, encoding: /** @type {const} */ ("utf8"), temporary: false },
      ],
      // delete first: a task re-created over itself keeps the old entry's Last Run and Last Result
      install: [["schtasks", "/Delete", "/TN", names.task, "/F"], ["schtasks", "/Create", "/TN", names.task, "/XML", xmlFile, "/F"]],
      // the registered entry, then its last run: Last Result is the seventh column of the verbose CSV in every locale
      check: [["schtasks", "/Query", "/TN", names.task, "/XML", "ONE"], ["schtasks", "/Query", "/TN", names.task, "/V", "/FO", "CSV", "/NH"]],
      remove: [["schtasks", "/Delete", "/TN", names.task, "/F"]],
      run: [["schtasks", "/Run", "/TN", names.task]],
    };
  }
  for (const a of command) if (/['"\\%$`\n]/.test(a)) throw new AgoraError(`the timer's command cannot carry ${JSON.stringify(a)} (a quote, backslash, % or $ in a path); move the file`, EXIT.usage);
  const line = `exec ${command.map(shArg).join(" ")}`;
  if (ctx.platform === "darwin") {
    const file = path.join(ctx.home, "Library", "LaunchAgents", `${names.label}.plist`);
    const log = path.join(ctx.stateRoot, "residents", "cycle.log");
    const uid = ctx.uid ?? 0;
    const content = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key><string>${names.label}</string>`,
      `  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>${xml(line)}</string></array>`,
      `  <key>StartInterval</key><integer>${seconds}</integer>`,
      // loaded at login: the first run after a logon recovers the residents
      `  <key>RunAtLoad</key><true/>`,
      `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n");
    return {
      kind: "launchd", name: names.label, command, interval: `${seconds}s`, triggers: [`every ${seconds}s`, "at login"], log, exitFile: null, expect: null, login: null, service: null,
      files: [{ path: file, content, encoding: /** @type {const} */ ("utf8"), temporary: false }],
      install: [["launchctl", "bootout", `gui/${uid}/${names.label}`], ["launchctl", "bootstrap", `gui/${uid}`, file]],
      check: [["launchctl", "print", `gui/${uid}/${names.label}`]],
      remove: [["launchctl", "bootout", `gui/${uid}/${names.label}`]],
      run: [["launchctl", "kickstart", `gui/${uid}/${names.label}`]],
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
    // a user timer starts with the user's service manager, at login (or at boot with lingering)
    `OnStartupSec=${LOGON_DELAY_MINUTES}min`,
    `OnUnitActiveSec=${minutes}min`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n");
  return {
    kind: "systemd", name: `${names.task}.timer`, command, interval: `${minutes}min`, triggers: [`every ${minutes}min`, `at login after ${LOGON_DELAY_MINUTES}min`], log: null, exitFile: null, expect: null, login: null, service: null,
    files: [
      { path: path.join(unitDir, `${names.task}.service`), content: service, encoding: /** @type {const} */ ("utf8"), temporary: false },
      { path: path.join(unitDir, `${names.task}.timer`), content: timer, encoding: /** @type {const} */ ("utf8"), temporary: false },
    ],
    install: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${names.task}.timer`]],
    check: [["systemctl", "--user", "is-enabled", `${names.task}.timer`], ["systemctl", "--user", "is-active", `${names.task}.timer`]],
    remove: [["systemctl", "--user", "disable", "--now", `${names.task}.timer`], ["systemctl", "--user", "daemon-reload"]],
    run: [["systemctl", "--user", "start", "--no-block", `${names.task}.service`]],
  };
}

/** @typedef {ReturnType<typeof timerSpec>} TimerSpec */

/**
 * The `<Command>`, `<Arguments>` and `<Interval>` of a scheduled task's XML, and its logon trigger's
 * delay: `logon` is undefined when the task has no logon trigger, "" for one with no delay.
 * @param {string} doc
 */
export function parseTaskXml(doc) {
  const unxml = (/** @type {string | undefined} */ s) => s === undefined ? undefined : s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const tag = (/** @type {string} */ t, from = doc) => unxml(from.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim());
  const logonTrigger = doc.match(/<LogonTrigger\b[^>]*>([\s\S]*?)<\/LogonTrigger>/)?.[1];
  return { command: tag("Command"), arguments: tag("Arguments"), interval: tag("Interval"), logon: logonTrigger === undefined ? undefined : tag("Delay", logonTrigger) ?? "" };
}

/** The values of `reg query <key>`: one line each, `    <name>    <type>    <data>`. @param {string} text */
export function parseRegValues(text) {
  /** @type {Array<{ name: string, type: string, data: string }>} */
  const out = [];
  for (const line of text.replace(/\u0000/g, "").split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (m) out.push({ name: m[1], type: m[2], data: m[3] ?? "" });
  }
  return out;
}

/** Last Result codes that are not a failed run: the task is running now, or has not run yet. */
const TASK_NOT_FAILED = Object.freeze([0, 0x41301, 0x41303]);

/**
 * The Last Run Time and Last Result of `schtasks /Query /V /FO CSV /NH`: the sixth and seventh
 * columns of its first row (the column order is fixed; the header, which this omits, is localized).
 * @param {string} text @returns {{ lastRun: string, lastResult: number } | null}
 */
export function parseTaskCsv(text) {
  const row = text.replace(/\u0000/g, "").split(/\r?\n/).find((l) => l.startsWith('"'));
  if (!row) return null;
  const cols = [...row.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
  const lastResult = Number(cols[6]);
  return Number.isInteger(lastResult) ? { lastRun: cols[5], lastResult } : null;
}

/** A Task Scheduler result as Windows prints it, `0x80070005`. @param {number} code */
export const hresult = (code) => `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;

/** How long install waits for its first run to end, and how often it asks. */
const FIRST_RUN_MS = 120_000;
const FIRST_RUN_POLL_MS = 500;

/**
 * Where Tern's start at logon stands, read from the user's Run key: `agora` (agora's entry, on),
 * `tern` (Tern's own Start at login, which install prefers and never touches), `disabled` (agora's
 * entry, turned off in Task Manager's Startup apps), `differs` (agora's entry runs another
 * program), `missing` (a row runs under Tern and nothing starts it), or `not needed`.
 * @typedef {{ state: 'agora' | 'tern' | 'disabled' | 'differs' | 'missing' | 'not needed', name: string, data: string | null, problems: string[] }} LoginState
 */

/**
 * @param {NonNullable<TimerSpec['login']>} login
 * @param {(argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} go
 * @returns {Promise<LoginState & { ours: boolean }>}
 */
async function loginState(login, go) {
  const q = await go(["reg", "query", login.key]);
  const values = q.code === 0 ? parseRegValues(q.stdout) : [];
  const ours = values.find((v) => v.name === login.name);
  // Tern's own Start at login runs its daemon with --login: whatever it names its value
  const own = values.find((v) => v.name !== login.name && /\btern\.exe\b/i.test(v.data) && /\s--login\b/.test(v.data));
  if (ours) {
    if (await turnedOff(login, go))
      return { state: "disabled", name: login.name, data: ours.data, ours: true, problems: [`Tern's start at logon (${login.name}) is turned off in Task Manager's Startup apps; timer install turns it on again`] };
    if (login.data && ours.data !== login.data)
      return { state: "differs", name: login.name, data: ours.data, ours: true, problems: [`Tern's start at logon (${login.name}) runs ${ours.data}, not ${login.data}; timer install rewrites it`] };
    return { state: "agora", name: login.name, data: ours.data, ours: true, problems: [] };
  }
  if (own) return { state: "tern", name: own.name, data: own.data, ours: false, problems: [] };
  if (!login.data) return { state: "not needed", name: login.name, data: null, ours: false, problems: [] };
  return { state: "missing", name: login.name, data: null, ours: false, problems: ["Tern does not start at logon; timer install adds it (or turn on Start at login in Tern's Settings › Sessions)"] };
}

/**
 * Whether Task Manager's Startup apps turned a startup entry off: it records that with an odd first byte.
 * @param {{ approved: string, name: string }} entry @param {(argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} go
 */
async function turnedOff(entry, go) {
  const a = await go(["reg", "query", entry.approved, "/v", entry.name]);
  const first = a.code === 0 ? /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(a.stdout)?.[1] : undefined;
  return first !== undefined && parseInt(first, 16) % 2 === 1;
}

/**
 * Where the seat service's start stands. The task's wrapper starts it before each cycle, so its
 * state is read from the seat's service start record: `task` (a row needs the service and a start is
 * recorded, which the wrapper follows; `intent` down means it leaves the service dark), `unrecorded`
 * (a row needs it and no start is recorded, so the wrapper cannot know the authority and starts
 * nothing), or `not needed`. Whether the registered task and its wrapper are what install writes is
 * the task's own check. `leftover` is the Run entry an older install wrote for the same start (its
 * command), still in the user's Run key, or null.
 * @typedef {{ state: 'task' | 'unrecorded' | 'not needed', needs: string[], intent: 'up' | 'down' | null, authorityId?: string | null, at: string | null,
 *   log: string, leftover: string | null, problems: string[] }} ServiceState
 */

/**
 * The older install's startup entry for the seat service, when it is still in the Run key.
 * @param {NonNullable<TimerSpec['service']>['legacy']} legacy
 * @param {(argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} go
 */
async function legacyEntry(legacy, go) {
  const q = await go(["reg", "query", legacy.key]);
  return (q.code === 0 ? parseRegValues(q.stdout) : []).find((v) => v.name === legacy.name)?.data ?? null;
}

/**
 * @param {NonNullable<TimerSpec['service']>} sv
 * @param {(argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} go
 * @returns {Promise<ServiceState>}
 */
async function serviceState(sv, go) {
  const leftover = await legacyEntry(sv.legacy, go);
  const rec = sv.start.record;
  const base = { needs: sv.needs, intent: rec?.intent ?? null, ...(rec && rec.authorityId !== undefined ? { authorityId: rec.authorityId } : {}), at: rec?.at ?? null, log: sv.log, leftover };
  /** @type {string[]} */
  const problems = [];
  if (leftover !== null) problems.push(`an older install's startup entry ${sv.legacy.name} still starts the seat service from the Run key, which Explorer can skip at logon; timer install takes it out, since the task starts the service before each cycle`);
  if (!sv.needs.length) return { ...base, state: "not needed", problems };
  if (!rec) problems.push(`no service start is recorded on this seat (${sv.start.error ?? `${sv.start.file} is absent`}), so the task's start of the seat service cannot know its authority and starts nothing; start the service once with agora service start [--authority <a-64hex>]`);
  return { ...base, state: rec ? "task" : "unrecorded", problems };
}

/**
 * What `runTimer` returns: the entry's state (`installed`, `kicked`, `removed`, `failed`, `refused`, or a
 * check's `ok`, `missing`, `differs`, `failing`), why not, the commands it ran, and for install the check
 * after its first run. `triggers` names when the entry runs; `login` (Windows) is where Tern's start at
 * logon stands, `service` (Windows) the seat service's start by the task.
 * @typedef {{ type: string, action: string, kind: string, name: string, interval: string, triggers: string[], command: string[], state: string, problems: string[],
 *   ran: Array<{ argv: string[], code: number, stderr: string }>, lastResult?: number, lastRun?: string, cycleExit?: number | null,
 *   firstRun?: string, check?: TimerResult, login?: LoginState, service?: ServiceState }} TimerResult
 */

/**
 * install | check | run | remove. `check` changes nothing and reports ok, missing, differs (the
 * registered entry or its wrapper is not what install writes) or, for a Windows task, failing: the
 * scheduler could not start its last run (Last Result), or that run ended without running the cycle
 * or with the cycle exiting non-zero (the wrapper's exit record). A task not yet run, or running, is
 * ok. `run` asks the scheduler to run the installed entry once now (kicked), or names that none is
 * installed (missing); it never runs the cycle in this process. `install` writes the entry, runs it
 * once through the scheduler, waits for that run to end (`settleMs`, default two minutes) and returns
 * the `check` that follows as `check`: the install's state is `installed` only when that check is ok,
 * else the check's own state (`failing`, `differs`, `missing`), so a timer that cannot run the cycle
 * is never reported installed. A first run still going at the deadline is `firstRun: "running"`.
 * Install is `refused`, writing nothing, when a row needs the seat service and no service start is
 * recorded on this seat (`service-start-unrecorded`): the authority would be a guess. Once the task
 * is registered, install takes out the Run entry and wrapper an older install wrote for the service.
 * @param {'install' | 'check' | 'run' | 'remove'} action @param {TimerSpec} spec
 * @param {{ run?: Runner, writeFile?: (file: string, data: Buffer | string) => Promise<void>, readFile?: (file: string) => Promise<string>, rm?: (file: string) => Promise<void>, mkdir?: (dir: string) => Promise<void>,
 *   sleep?: (ms: number) => Promise<void>, settleMs?: number }} [deps]
 * @returns {Promise<TimerResult>}
 */
export async function runTimer(action, spec, deps = {}) {
  const exec = deps.run ?? runCommand;
  const write = deps.writeFile ?? ((f, d) => writeFile(f, d));
  const read = deps.readFile ?? ((f) => readFile(f, "utf8"));
  const remove = deps.rm ?? ((f) => rm(f, { force: true }));
  const mk = deps.mkdir ?? (async (d) => { await mkdir(d, { recursive: true }); });
  const base = { type: "resident-timer", action, kind: spec.kind, name: spec.name, interval: spec.interval, triggers: spec.triggers, command: spec.command };
  /** @type {Array<{ argv: string[], code: number, stderr: string }>} */
  const ran = [];
  const go = async (/** @type {string[]} */ argv) => { const r = await exec(argv, { timeoutMs: 30_000 }); ran.push({ argv, code: r.code, stderr: r.stderr.trim().slice(0, 300) }); return r; };

  if (action === "run") {
    for (const argv of spec.run) {
      const r = await go(argv);
      if (r.code !== 0) return { ...base, state: "missing", problems: [`no cycle timer is installed (${argv.join(" ")}: exit ${r.code} ${(r.stderr || r.stdout).trim().slice(0, 300)}); install it with agora resident timer install`], ran };
    }
    return { ...base, state: "kicked", problems: [], ran };
  }
  if (action === "check") {
    /** @type {string[]} */
    const problems = [];
    let present = true;
    /** @type {{ lastRun: string, lastResult: number } | null} */
    let last = null;
    /** @type {number | null} the cycle's own exit code, from the wrapper's record of its last run */
    let cycleExit = null;
    /** @type {string | null} */
    let failing = null;
    if (spec.kind === "schtasks") {
      const r = await go(spec.check[0]);
      if (r.code !== 0) present = false;
      else {
        const got = parseTaskXml(r.stdout.replace(/\u0000/g, ""));
        const want = /** @type {NonNullable<TimerSpec['expect']>} */ (spec.expect);
        if (got.command !== want.command || got.arguments !== want.arguments) problems.push(`its command is ${got.command} ${got.arguments}, not ${want.command} ${want.arguments}`);
        if (got.interval !== want.interval) problems.push(`its interval is ${got.interval}, not ${want.interval}`);
        if (got.logon === undefined) problems.push("it has no logon trigger; timer install adds one");
        else if (got.logon !== want.logon) problems.push(`its logon trigger's delay is ${got.logon || "none"}, not ${want.logon}`);
        // the program the task runs: a task whose wrapper is gone or stale cannot run the cycle
        for (const f of spec.files) {
          if (f.temporary) continue;
          let text = null;
          try { text = await read(f.path); } catch { /* absent */ }
          if (text === null) problems.push(`${f.path} is missing; timer install writes it`);
          else if (text !== f.content) problems.push(`${f.path} differs from what install writes`);
        }
        const q = await go(spec.check[1]);
        last = q.code === 0 ? parseTaskCsv(q.stdout) : null;
        if (!last) problems.push(`its last run cannot be read (${spec.check[1].join(" ")}: exit ${q.code})`);
        else if (!problems.length && !TASK_NOT_FAILED.includes(last.lastResult))
          failing = `its last run, at ${last.lastRun}, ended with ${hresult(last.lastResult)} (${last.lastResult}): the scheduler could not start it`;
        else if (!problems.length && last.lastResult === 0 && spec.exitFile) {
          // a run ended (conhost waits for its child): the wrapper left the cycle's exit code, or never ran
          let text = null;
          try { text = await read(spec.exitFile); } catch { /* absent */ }
          const code = text === null ? NaN : Number(text.trim());
          if (text === null || !Number.isInteger(code)) failing = `its last run, at ${last.lastRun}, did not run the cycle: ${spec.exitFile} is ${text === null ? "absent" : "unreadable"}`;
          else if ((cycleExit = code) !== 0) failing = `its last run, at ${last.lastRun}, ran the cycle, which exited ${code}; its own lines are in ${spec.log}`;
        }
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
    // Tern's start at logon, and the seat service's start by the task, where this OS has them
    const login = spec.login ? await loginState(spec.login, go) : null;
    if (login) problems.push(...login.problems);
    const service = spec.service ? await serviceState(spec.service, go) : null;
    if (service) problems.push(...service.problems);
    if (failing) problems.push(failing);
    const state = !present ? "missing" : failing ? "failing" : problems.length ? "differs" : "ok";
    return { ...base, state, problems, ran, ...(last ? { lastResult: last.lastResult, lastRun: last.lastRun, cycleExit } : {}), ...(login ? { login: { state: login.state, name: login.name, data: login.data, problems: login.problems } } : {}),
      ...(service ? { service } : {}) };
  }
  if (action === "install") {
    // the task starts the seat service as its last recorded start asked: with none recorded, the
    // authority is unknown and nothing is guessed, so nothing is installed
    const sv = spec.service;
    if (sv?.needs.length && !sv.start.record)
      return { ...base, state: "refused", problems: [`service-start-unrecorded: ${sv.needs.join(", ")} need${sv.needs.length === 1 ? "s" : ""} the seat service at logon, and no service start is recorded on this seat (${sv.start.error ?? `${sv.start.file} is absent`}), so its authority cannot be known; start the service once with agora service start [--authority <a-64hex>] (stop it first if it runs), then install again. Nothing was installed`], ran };
    for (const f of spec.files) {
      await mk(path.dirname(f.path));
      await write(f.path, f.encoding === "utf16le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(f.content, "utf16le")]) : f.content);
    }
    // a new entry has not run: an exit record left by an older one must not vouch for it
    if (spec.exitFile) await remove(spec.exitFile);
    let failed = null;
    try {
      for (const argv of spec.install) {
        const r = await go(argv);
        // launchd's bootout and schtasks' delete of an entry that is not there fail; that is the case they exist for
        if (r.code !== 0 && !(spec.kind === "launchd" && argv[1] === "bootout") && !(spec.kind === "schtasks" && argv[1] === "/Delete")) { failed = `${argv.join(" ")}: exit ${r.code} ${r.stderr.trim().slice(0, 300)}`; break; }
      }
    } finally {
      for (const f of spec.files) if (f.temporary) await remove(f.path);
    }
    if (failed) return { ...base, state: "failed", problems: [failed], ran };
    // Tern's session daemon at logon: Tern's own Start at login is preferred; else agora's entry, written on
    if (spec.login?.data) {
      const now = await loginState(spec.login, go);
      if (now.state !== "agora" && now.state !== "tern") {
        const add = await go(["reg", "add", spec.login.key, "/v", spec.login.name, "/t", "REG_SZ", "/d", spec.login.data, "/f"]);
        if (add.code !== 0) return { ...base, state: "failed", problems: [`reg add ${spec.login.key} /v ${spec.login.name}: exit ${add.code} ${add.stderr.trim().slice(0, 300)}`], ran };
        // a fresh entry is on: a record that Startup apps turned it off is the old entry's
        if (now.state === "disabled") await go(["reg", "delete", spec.login.approved, "/v", spec.login.name, "/f"]);
      }
    }
    // the task starts the seat service now: an older install's startup entry for it goes, with its
    // Startup apps record and its wrapper
    if (sv) {
      if ((await legacyEntry(sv.legacy, go)) !== null)
        for (const key of [sv.legacy.key, sv.legacy.approved]) await go(["reg", "delete", key, "/v", sv.legacy.name, "/f"]);
      await remove(sv.legacy.file);
    }
    // the proof: one run by the scheduler, waited for, then the same check `timer check` makes
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const settleMs = deps.settleMs ?? FIRST_RUN_MS;
    const first = await firstRun(spec, go, ran, exec, sleep, settleMs);
    const check = await runTimer("check", spec, deps);
    const state = first.failure ? "failing" : check.state === "ok" ? "installed" : check.state;
    return { ...base, state, problems: first.failure ? [first.failure] : [], ran, firstRun: first.running ? "running" : "ended", check };
  }
  for (const argv of spec.remove) await go(argv);
  // agora's own startup entries and their Startup apps records; Tern's own Start at login is Tern's
  for (const entry of [spec.login, spec.service?.legacy]) if (entry) for (const key of [entry.key, entry.approved]) await go(["reg", "delete", key, "/v", entry.name, "/f"]);
  for (const f of spec.files) if (!f.temporary) await remove(f.path);
  if (spec.service) await remove(spec.service.legacy.file);
  if (spec.exitFile) await remove(spec.exitFile);
  return { ...base, state: "removed", problems: [], ran };
}

/**
 * One run of an installed entry by its scheduler, waited for: `failure` names a scheduler that
 * refused the run (or, on launchd, a run that exited non-zero); `running` is a run still going at the
 * deadline. A Windows run's own outcome is left to the check that follows, which reads its exit record.
 * @param {TimerSpec} spec @param {(argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} go
 * @param {Array<{ argv: string[], code: number, stderr: string }>} ran @param {Runner} exec
 * @param {(ms: number) => Promise<void>} sleep @param {number} settleMs
 * @returns {Promise<{ failure: string | null, running: boolean }>}
 */
async function firstRun(spec, go, ran, exec, sleep, settleMs) {
  if (spec.kind === "systemd") {
    // a oneshot service: start without --no-block returns when the cycle has ended, non-zero when it failed
    const argv = spec.run[0].filter((/** @type {string} */ a) => a !== "--no-block");
    const r = await exec(argv, { timeoutMs: settleMs });
    ran.push({ argv, code: r.code, stderr: r.stderr.trim().slice(0, 300) });
    if (r.code === 0) return { failure: null, running: false };
    // killed at the deadline: the unit goes on running
    if (r.code === -1 && !r.stderr.trim()) return { failure: null, running: true };
    return { failure: `${argv.join(" ")}: exit ${r.code} ${(r.stderr || r.stdout).trim().slice(0, 300)}; its lines are in journalctl --user -u ${argv[argv.length - 1]}`, running: false };
  }
  for (const argv of spec.run) {
    const r = await go(argv);
    if (r.code !== 0) return { failure: `${argv.join(" ")}: exit ${r.code} ${(r.stderr || r.stdout).trim().slice(0, 300)}`, running: false };
  }
  const ask = spec.kind === "schtasks" ? spec.check[1] : spec.check[0];
  for (let waited = 0; ; waited += FIRST_RUN_POLL_MS) {
    const q = await go(ask);
    // a status that cannot be read ends the wait: the check that follows says why
    if (q.code !== 0) return { failure: null, running: false };
    if (spec.kind === "schtasks") {
      const last = parseTaskCsv(q.stdout);
      if (!last) return { failure: null, running: false };
      if (last.lastResult !== 0x41301 && last.lastResult !== 0x41303) return { failure: null, running: false };
    } else {
      // launchd: a job that has never exited, or is running, has not finished its run
      const state = q.stdout.match(/\bstate = ([^\r\n]+)/)?.[1]?.trim();
      const code = q.stdout.match(/\blast exit code = (-?\d+)/)?.[1];
      if (state !== "running" && code !== undefined) {
        return { failure: Number(code) === 0 ? null : `its run exited ${code}; its own lines are in ${spec.log}`, running: false };
      }
    }
    if (waited >= settleMs) return { failure: null, running: true };
    await sleep(FIRST_RUN_POLL_MS);
  }
}
