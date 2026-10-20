// @ts-check
/**
 * `agora config`: the one way this tool writes the shared config. Every other verb reads the
 * config and never writes it; these verbs write it on the operator's command (or his agent's), and
 * nothing else in the tool calls them.
 *
 * Every write: the same path the reader resolves (`configPath`); a lock beside the file so two
 * writers cannot interleave; read, apply, then the WHOLE result through `validateConfig`, refused
 * with nothing written on any error; no inline token anywhere in the result (tokens are references,
 * `tokenEnv` or `tokenFile`); a timestamped backup beside the file; a temp file and a rename, so a
 * reader sees the old bytes or the new ones; a unified diff printed. Untouched entries keep their
 * bytes: the edit is spliced into the text and the splice is checked against the parsed result, and
 * only when that check fails is the whole file re-serialized (in the indent it already used).
 */
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat, chmod } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgoraError, EXIT, configPath, redact, stateDir, validateConfig } from "./core.mjs";
import { TRANSPORTS } from "./transports/index.mjs";
import { assertResidentSlug, configuredResidents } from "./resident.mjs";
import { assertRemoteDescriptor, readRemoteDescriptor, resolveSeatIdentity } from "./native-remote.mjs";
import { readRouteSecret } from "./native-member.mjs";

/**
 * The top-level keys agora reads, with the JSON type each must have. `config set` and `config unset`
 * take only these: a key nothing reads is a typo that would sit in the file looking like a setting.
 * A key agora starts to read joins this table in the same change.
 */
export const CONFIG_KEYS = Object.freeze({
  actor: "object",
  rooms: "object",
  state: "string",
  sign: "boolean",
  session: "object",
  residents: "object",
  residentManifest: "string",
});

/** A room alias, as `room add-remote` takes it. */
export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Key names that hold a credential's value rather than a reference to one, at any depth. */
const INLINE_SECRET_KEY = /^(token|secret|password|passwd|apikey|api_key|bearer|accesstoken|access_token|privatekey|private_key|clientsecret|client_secret)$/i;

/** How long a writer waits for another writer's lock before refusing. */
export const LOCK_WAIT_MS = 5_000;
/** A lock older than this is a leftover: a config write takes milliseconds. */
export const LOCK_STALE_MS = 30_000;

/**
 * Where a config holds a credential inline: every JSON path whose key names a secret value, or
 * whose string value has a credential's shape (`redact` changes it). Paths only, never the values.
 * @param {unknown} value @param {string} [at] @returns {string[]}
 */
export function inlineSecrets(value, at = "") {
  /** @type {string[]} */
  const out = [];
  if (typeof value === "string") {
    if (redact(value) !== value) out.push(at || "(root)");
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...inlineSecrets(v, `${at}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const here = at ? `${at}.${k}` : k;
      if (INLINE_SECRET_KEY.test(k)) out.push(here);
      else out.push(...inlineSecrets(v, here));
    }
  }
  return out;
}

/** JSON with object keys sorted, for "is this the same row" whatever order its keys were typed in. @param {unknown} v @returns {string} */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(/** @type {any} */ (v)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} v */
const isContainer = (v) => v !== null && typeof v === "object";

/** A row for an error message; one that holds a credential inline is named, never printed. @param {unknown} v */
const shown = (v) => (inlineSecrets(v).length ? "a row holding a credential inline, not printed" : JSON.stringify(v));

/** @param {unknown} o @param {string} k */
const has = (o, k) => isObject(o) && Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- the splice

/**
 * One edit: set (`value` present) or delete (`value` absent) at a top-level key or at a member of
 * a top-level table (`rooms`, `residents`).
 * @typedef {{ path: [string] | [string, string], value?: unknown }} Op
 */

/** @param {Record<string, unknown>} cfg @param {Op[]} ops @returns {Record<string, unknown>} */
export function applyOps(cfg, ops) {
  /** @type {Record<string, unknown>} */
  const out = JSON.parse(JSON.stringify(cfg));
  for (const op of ops) {
    if (op.path.length === 1) {
      const [k] = op.path;
      if ("value" in op && op.value !== undefined) out[k] = op.value;
      else delete out[k];
      continue;
    }
    const [table, name] = op.path;
    if ("value" in op && op.value !== undefined) {
      if (!isObject(out[table])) out[table] = {};
      /** @type {Record<string, unknown>} */ (out[table])[name] = op.value;
    } else if (isObject(out[table])) delete /** @type {Record<string, unknown>} */ (out[table])[name];
  }
  return out;
}

/** @param {string} t @param {number} i */
function skipWs(t, i) {
  while (i < t.length && (t[i] === " " || t[i] === "\t" || t[i] === "\n" || t[i] === "\r")) i++;
  return i;
}
/** @param {string} t @param {number} i the opening quote */
function skipString(t, i) {
  for (i++; i < t.length; i++) {
    if (t[i] === "\\") i++;
    else if (t[i] === '"') return i + 1;
  }
  throw new Error("unterminated string");
}
/** @param {string} t @param {number} i */
function skipValue(t, i) {
  const c = t[i];
  if (c === '"') return skipString(t, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    while (i < t.length) {
      const ch = t[i];
      if (ch === '"') { i = skipString(t, i); continue; }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    throw new Error("unterminated container");
  }
  while (i < t.length && !/[\s,}\]]/.test(t[i])) i++;
  return i;
}
/**
 * The members of the object whose `{` is at `start`, with their spans. The text has already parsed
 * as JSON, so the scanner only finds boundaries.
 * @param {string} t @param {number} start
 */
function scanObject(t, start) {
  if (t[start] !== "{") throw new Error("not an object");
  /** @type {{ key: string, keyStart: number, keyEnd: number, valueStart: number, valueEnd: number }[]} */
  const members = [];
  let i = skipWs(t, start + 1);
  if (t[i] === "}") return { start, end: i + 1, members };
  for (;;) {
    const keyStart = i;
    const keyEnd = skipString(t, i);
    const key = JSON.parse(t.slice(keyStart, keyEnd));
    i = skipWs(t, keyEnd);
    if (t[i] !== ":") throw new Error("expected a colon");
    const valueStart = skipWs(t, i + 1);
    const valueEnd = skipValue(t, valueStart);
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    i = skipWs(t, valueEnd);
    if (t[i] === ",") { i = skipWs(t, i + 1); continue; }
    if (t[i] === "}") return { start, end: i + 1, members };
    throw new Error("expected a comma or a closing brace");
  }
}

/** The whitespace that opens the line `pos` is on. @param {string} t @param {number} pos */
function lineIndent(t, pos) {
  const from = t.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(t.slice(from))?.[0] ?? "";
}

/** The file's indent unit, or "" for a file written on one line. @param {string} t */
export function indentUnit(t) {
  return /\n([ \t]+)\S/.exec(t)?.[1] ?? "";
}

/**
 * Splice one op into the text. Throws when the text has a shape the splice does not handle; the
 * caller then re-serializes.
 * @param {string} t @param {Op} op @param {string} unit
 */
function spliceOne(t, op, unit) {
  const fmt = (/** @type {unknown} */ v, /** @type {string} */ indent, /** @type {boolean} */ oneLine) =>
    !unit || oneLine ? JSON.stringify(v) : JSON.stringify(v, null, unit).replace(/\n/g, `\n${indent}`);
  /** @param {ReturnType<typeof scanObject>} obj @param {string} key @param {unknown} value */
  const insert = (obj, key, value) => {
    const ms = obj.members;
    const last = ms[ms.length - 1];
    if (last) {
      const before = ms.length > 1 ? t.lastIndexOf(",", last.keyStart) : obj.start;
      const lead = t.slice(before + 1, last.keyStart);
      const colon = t.slice(last.keyEnd, last.valueStart);
      const indent = lead.slice(lead.lastIndexOf("\n") + 1);
      // a new member takes its siblings' shape: rows pasted one per line stay one per line
      const oneLine = ms.every((m) => !t.slice(m.valueStart, m.valueEnd).includes("\n"))
        && (!isContainer(value) || ms.some((m) => t[m.valueStart] === "{" || t[m.valueStart] === "["));
      return `${t.slice(0, last.valueEnd)},${lead}${JSON.stringify(key)}${colon}${fmt(value, indent, oneLine)}${t.slice(last.valueEnd)}`;
    }
    if (!unit) return `${t.slice(0, obj.start + 1)}${JSON.stringify(key)}:${JSON.stringify(value)}${t.slice(obj.end - 1)}`;
    const parent = lineIndent(t, obj.start);
    const child = parent + unit;
    return `${t.slice(0, obj.start + 1)}\n${child}${JSON.stringify(key)}: ${fmt(value, child, false)}\n${parent}${t.slice(obj.end - 1)}`;
  };
  /** @param {ReturnType<typeof scanObject>} obj @param {number} i */
  const remove = (obj, i) => {
    const ms = obj.members;
    if (ms.length === 1) return `${t.slice(0, obj.start + 1)}${t.slice(obj.end - 1)}`;
    if (i < ms.length - 1) return `${t.slice(0, ms[i].keyStart)}${t.slice(ms[i + 1].keyStart)}`;
    return `${t.slice(0, ms[i - 1].valueEnd)}${t.slice(ms[i].valueEnd)}`;
  };
  /** @param {ReturnType<typeof scanObject>} obj @param {string} key */
  const find = (obj, key) => {
    for (let i = obj.members.length - 1; i >= 0; i--) if (obj.members[i].key === key) return i;
    return -1;
  };
  /** @param {ReturnType<typeof scanObject>} obj @param {string} key @param {unknown} value */
  const setIn = (obj, key, value) => {
    const i = find(obj, key);
    if (value === undefined) return i < 0 ? t : remove(obj, i);
    if (i < 0) return insert(obj, key, value);
    const m = obj.members[i];
    const old = t.slice(m.valueStart, m.valueEnd);
    // a value written on one line stays on one line, unless it was an empty container growing contents
    const oneLine = !old.includes("\n") && (!isContainer(value) || (isContainer(JSON.parse(old)) && old.replace(/\s/g, "").length > 2));
    return `${t.slice(0, m.valueStart)}${fmt(value, lineIndent(t, m.keyStart), oneLine)}${t.slice(m.valueEnd)}`;
  };
  const root = scanObject(t, skipWs(t, 0));
  const value = "value" in op ? op.value : undefined;
  if (op.path.length === 1) return setIn(root, op.path[0], value);
  const [table, name] = op.path;
  const ti = find(root, table);
  if (ti < 0) return value === undefined ? t : insert(root, table, { [name]: value });
  const m = root.members[ti];
  if (t[m.valueStart] !== "{") return value === undefined ? t : setIn(root, table, { [name]: value });
  return setIn(scanObject(t, m.valueStart), name, value);
}

/**
 * The new file text: `ops` spliced into `text`, untouched entries byte for byte, when the splice
 * parses to exactly `after` (key order included); else `after` in the file's own indent.
 * @param {string} text @param {Op[]} ops @param {Record<string, unknown>} after
 */
export function spliceConfig(text, ops, after) {
  const unit = indentUnit(text);
  const trailing = /\r?\n$/.exec(text)?.[0] ?? (text.length ? "" : "\n");
  try {
    let t = text;
    for (const op of ops) t = spliceOne(t, op, unit);
    if (JSON.stringify(JSON.parse(t)) === JSON.stringify(after)) return t;
  } catch { /* re-serialize below */ }
  if (!text.trimEnd().includes("\n")) return JSON.stringify(after) + (trailing || "\n");
  return JSON.stringify(after, null, unit || 2) + (trailing || "\n");
}

// ---------------------------------------------------------------- the diff

/** @param {string} s */
const linesOf = (s) => {
  if (!s) return [];
  const ls = s.split(/\r?\n/);
  if (ls[ls.length - 1] === "") ls.pop();
  return ls;
};

/**
 * A unified diff of two texts, `context` lines around each change. Empty when they are the same.
 * @param {string} a @param {string} b @param {string} from @param {string} to @param {number} [context]
 */
export function unifiedDiff(a, b, from, to, context = 3) {
  const A = linesOf(a), B = linesOf(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  if (!a2.length && !b2.length) return "";
  /** @type {{ t: " " | "-" | "+", s: string }[]} */
  const mid = [];
  const n = a2.length, m = b2.length;
  if (n * m <= 4_000_000) {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = a2[i] === b2[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { mid.push({ t: " ", s: a2[i] }); i++; j++; }
      else if (i < n && (j === m || L[(i + 1) * w + j] >= L[i * w + j + 1])) { mid.push({ t: "-", s: a2[i] }); i++; }
      else { mid.push({ t: "+", s: b2[j] }); j++; }
    }
  } else {
    for (const s of a2) mid.push({ t: "-", s });
    for (const s of b2) mid.push({ t: "+", s });
  }
  /** @type {{ t: " " | "-" | "+", s: string }[]} */
  const all = [...A.slice(0, pre).map((s) => ({ t: /** @type {" "} */ (" "), s })), ...mid, ...A.slice(A.length - suf).map((s) => ({ t: /** @type {" "} */ (" "), s }))];
  const out = [`--- ${from}`, `+++ ${to}`];
  let k = 0;
  while (k < all.length) {
    while (k < all.length && all[k].t === " ") k++;
    if (k >= all.length) break;
    let start = Math.max(0, k - context);
    let end = k;
    for (;;) {
      while (end < all.length && all[end].t !== " ") end++;
      let run = end;
      while (run < all.length && all[run].t === " ") run++;
      if (run < all.length && run - end <= 2 * context) { end = run; continue; }
      end = Math.min(all.length, end + context);
      break;
    }
    let aStart = 0, bStart = 0;
    for (let x = 0; x < start; x++) { if (all[x].t !== "+") aStart++; if (all[x].t !== "-") bStart++; }
    const hunk = all.slice(start, end);
    const aLen = hunk.filter((x) => x.t !== "+").length, bLen = hunk.filter((x) => x.t !== "-").length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const x of hunk) out.push(`${x.t}${x.s}`);
    k = end;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- the lock and the write

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM"; }
}

/** @param {string} file @returns {Promise<{ pid: number, token: string, at: string, mtimeMs: number } | null>} */
async function readLock(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      const [raw, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      /** @type {any} */
      let v = {};
      try { v = JSON.parse(raw); } catch { /* a lock being written this instant is judged by its age */ }
      return { pid: Number(v.pid), token: String(v.token ?? ""), at: String(v.at ?? ""), mtimeMs: st.mtimeMs };
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === "ENOENT") return null;
      // Windows refuses a file another process is renaming or deleting for a moment
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 20) { await new Promise((r) => setTimeout(r, 10)); continue; }
      throw e;
    }
  }
}

/**
 * The writer lock beside the config: an exclusive create holds it. A lock whose pid is gone, or that
 * is older than LOCK_STALE_MS, is moved aside and taken. A live holder is waited for up to `waitMs`,
 * then refused `config-locked` with nothing written.
 * @param {string} target @param {{ waitMs?: number }} [o]
 */
export async function takeConfigLock(target, o = {}) {
  const file = `${target}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + (o.waitMs ?? LOCK_WAIT_MS);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const h = await open(file, "wx", 0o600);
      try { await h.writeFile(`${JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })}\n`, "utf8"); }
      finally { await h.close(); }
      return {
        file,
        token,
        owned: async () => (await readLock(file))?.token === token,
        release: async () => { if ((await readLock(file))?.token === token) await rm(file, { force: true }); },
      };
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
    }
    const holder = await readLock(file);
    if (!holder) continue;
    // a lock with no readable pid yet is one being written this instant: judged by its age alone
    const dead = Number.isInteger(holder.pid) && holder.pid > 0 ? !pidAlive(holder.pid) : false;
    if (dead || Date.now() - holder.mtimeMs > LOCK_STALE_MS) {
      const aside = `${file}.stale-${process.pid}-${randomUUID()}`;
      try { await rename(file, aside); await rm(aside, { force: true }); }
      catch (e) {
        const code = /** @type {NodeJS.ErrnoException} */ (e).code;
        // gone already (another writer took it), or held open for a moment on Windows: look again
        if (code !== "ENOENT" && code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw e;
        await new Promise((r) => setTimeout(r, 10));
      }
      continue;
    }
    if (Date.now() >= deadline)
      throw Object.assign(new AgoraError(`config-locked: ${file} is held by pid ${holder.pid} since ${holder.at || "an unknown time"}; another agora config write is in progress. Nothing was written; run the command again`), { code: "config-locked" });
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** @param {Date} d */
const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Copy `target` beside itself as `<file>.bak-<time>`, never over an earlier backup. @param {string} target @param {Date} now */
async function backup(target, now) {
  const base = `${target}.bak-${stamp(now)}`;
  for (let n = 1; ; n++) {
    const file = n === 1 ? base : `${base}-${n}`;
    try { await copyFile(target, file, constants.COPYFILE_EXCL); return file; }
    catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST" || n > 99) throw e; }
  }
}

/**
 * A temp file beside `target` with `mode`, synced, then renamed over it (retrying the transient
 * Windows refusals), after `beforeRename` confirms the lock is still ours.
 * @param {string} target @param {string} text @param {number} mode @param {() => Promise<boolean>} stillOurs
 */
async function writeAtomic(target, text, mode, stillOurs) {
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const h = await open(tmp, "wx", mode);
    try { await h.writeFile(text, "utf8"); await h.sync(); }
    finally { await h.close(); }
    await chmod(tmp, mode).catch(() => {});
    if (!(await stillOurs()))
      throw Object.assign(new AgoraError(`config-lock-lost: ${target}.lock was taken over before this write committed; nothing was written, run the command again`), { code: "config-lock-lost" });
    let last;
    for (let attempt = 0; attempt < 8; attempt++) {
      try { await rename(tmp, target); return; }
      catch (e) {
        last = e;
        const code = /** @type {NodeJS.ErrnoException} */ (e).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw e;
        await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
      }
    }
    throw last;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * What a plan decides from the config as it is under the lock: the ops, or a no-op with the reason,
 * and lines to print beside the diff.
 * @typedef {{ ops: Op[], noop?: undefined, notes?: string[] } | { noop: string, ops?: undefined, notes?: string[] }} Plan
 */

/**
 * @typedef {object} EditResult
 * @property {string} path the file written (or that would be)
 * @property {boolean} existed
 * @property {boolean} written
 * @property {boolean} dryRun
 * @property {string} [noop] why nothing was written, when nothing needed to be
 * @property {string} [backup]
 * @property {Record<string, unknown> | null} before
 * @property {Record<string, unknown> | null} after
 * @property {string} diff
 * @property {string[]} notes
 * @property {string[]} [withheld] paths where the file before held a credential inline; its before and diff are not returned
 */

/**
 * Read the config under the writer lock, let `plan` decide, apply, validate the whole result, and
 * write it with a backup, or (dry run) only say what would change. Nothing is written on any refusal.
 * @param {string} file the config path as `configPath` resolved it
 * @param {(before: Record<string, unknown> | null, ctx: { path: string }) => Promise<Plan> | Plan} plan
 * @param {{ dryRun?: boolean, lockWaitMs?: number, now?: () => Date }} [o]
 * @returns {Promise<EditResult>}
 */
export async function editConfig(file, plan, o = {}) {
  // a link is followed: the rename replaces the file the link names, and the link stays a link
  const target = existsSync(file) ? await realpath(file) : file;
  const lock = o.dryRun ? undefined : await takeConfigLock(target, { waitMs: o.lockWaitMs });
  try {
    /** @type {string | null} */
    let text = null;
    try { text = await readFile(target, "utf8"); }
    catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
    /** @type {Record<string, unknown> | null} */
    let before = null;
    if (text !== null) {
      /** @type {unknown} */
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { throw new AgoraError(`${target} is not JSON (${e instanceof Error ? e.message : String(e)}); fix it by hand first. Nothing was written`); }
      if (!isObject(parsed)) throw new AgoraError(`${target} is not a JSON object; fix it by hand first. Nothing was written`);
      before = parsed;
    }
    const decided = await plan(before, { path: target });
    const notes = decided.notes ?? [];
    // a file that already holds a credential inline (the fix may be this very edit) never has its
    // old bytes printed: neither the before nor a diff that would carry the value out
    const withheld = inlineSecrets(before);
    const base = { path: target, existed: text !== null, dryRun: Boolean(o.dryRun), before: withheld.length ? null : before, notes, ...(withheld.length ? { withheld } : {}) };
    if (decided.noop !== undefined) return { ...base, written: false, noop: decided.noop, after: base.before, diff: "" };
    const after = applyOps(before ?? {}, decided.ops);
    const secrets = inlineSecrets(after);
    if (secrets.length)
      throw Object.assign(new AgoraError(`inline-token: the result would hold a credential inline at ${secrets.join(", ")}; a config names a token by reference (tokenEnv: an env var name, tokenFile: a path), never its value. Nothing was written`), { code: "inline-token" });
    try {
      validateConfig(after, target);
      configuredResidents(after);
    } catch (e) {
      throw Object.assign(new AgoraError(`config-invalid: ${e instanceof Error ? e.message : String(e)}; nothing was written`), { code: "config-invalid" });
    }
    const next = text === null ? `${JSON.stringify(after, null, 2)}\n` : spliceConfig(text, decided.ops, after);
    if (next === text) return { ...base, written: false, noop: "the file already says this", after, diff: "" };
    const diff = withheld.length ? "" : unifiedDiff(text ?? "", next, text === null ? "/dev/null" : `${target} (before)`, `${target} (after)`);
    if (o.dryRun) return { ...base, written: false, after, diff };
    const mode = text === null ? 0o600 : ((await stat(target)).mode & 0o777);
    const kept = text === null ? undefined : await backup(target, (o.now ?? (() => new Date()))());
    const l = /** @type {NonNullable<typeof lock>} */ (lock);
    await writeAtomic(target, next, mode, l.owned);
    return { ...base, written: true, ...(kept ? { backup: kept } : {}), after, diff };
  } finally {
    await lock?.release();
  }
}

// ---------------------------------------------------------------- rows

/**
 * Verify a route descriptor the operator carried from another seat's host, as this seat's own, and
 * return the native-remote row that names it. The row carries no roomId: the room is the
 * descriptor's `binding.roomId`, which its digest covers, and a second source beside it could
 * disagree in silence. `room add-remote` prints this row; `config room add --from-descriptor` writes it.
 * @param {string} file an absolute descriptor path @param {string} stateRoot
 */
export async function verifiedRemoteRow(file, stateRoot) {
  const descriptor = await readRemoteDescriptor(file);
  const seat = await resolveSeatIdentity(stateRoot);
  assertRemoteDescriptor(descriptor, { stateRoot, nodeKey: seat.nodeKey });
  // the secret arrives by a different path than the descriptor, so it is the half whose mode is
  // actually wrong; finding that here beats finding it on the first dial
  await readRouteSecret(stateRoot, descriptor.binding, descriptor.proofRef);
  return { row: { transport: "native-remote", descriptor: file }, descriptor };
}

/** @param {string} alias @param {unknown} row */
function checkRoomRow(alias, row) {
  if (!isObject(row)) throw new AgoraError(`the row for room "${alias}" must be a JSON object`, EXIT.usage);
  const transport = row.transport;
  if (typeof transport !== "string" || !(transport in TRANSPORTS))
    throw new AgoraError(`the row for room "${alias}" needs a transport, one of ${Object.keys(TRANSPORTS).join(", ")}${typeof transport === "string" ? ` (not "${transport}")` : ""}`, EXIT.usage);
  if (transport === "native" && !/^[a-f0-9]{32}$/.test(String(row.roomId ?? "")))
    throw new AgoraError(`a native room row needs roomId, the 32-hex id agora service room create printed`, EXIT.usage);
  if (transport === "native-remote" && (typeof row.descriptor !== "string" || !row.descriptor.trim()))
    throw new AgoraError(`a native-remote room row needs descriptor, the path of the route descriptor (agora config room add <alias> --from-descriptor <path> verifies it)`, EXIT.usage);
}

/** @param {string} raw @param {string} what */
function parseJsonArg(raw, what) {
  try { return JSON.parse(raw); }
  catch (e) { throw new AgoraError(`${what} is not JSON (${e instanceof Error ? e.message : String(e)}); quote it for your shell, e.g. '{"transport":"local","path":"room.jsonl"}'`, EXIT.usage); }
}

/** The state root a plan reads (a hosted native room, a seat identity): as every verb resolves it. @param {Record<string, unknown> | null} before */
const stateOf = (before) => stateDir(/** @type {any} */ (before ?? {}));

// ---------------------------------------------------------------- the verb

const USAGE = "agora config show | room add <alias> <row-json> | room add <alias> --from-descriptor <path> | room remove <alias> | resident add <slug> [<row-json>] | resident remove <slug> | set <key> <json> [<key> <json> ...] | unset <key> [...]";

/**
 * @param {{ sub: string | undefined, rest: string[], values: Record<string, unknown>, out?: (line: string) => void, err?: (line: string) => void, lockWaitMs?: number, now?: () => Date }} a
 * @returns {Promise<number>} the exit code
 */
export async function configVerb(a) {
  const out = a.out ?? ((/** @type {string} */ l) => { console.log(l); });
  const err = a.err ?? ((/** @type {string} */ l) => { console.error(l); });
  const { sub, rest, values } = a;
  const json = Boolean(values.json);
  const dryRun = Boolean(values["dry-run"]);
  const replace = Boolean(values.replace);
  const force = Boolean(values.force);
  const fromDescriptor = values["from-descriptor"] === undefined ? undefined : String(values["from-descriptor"]);
  const usage = (/** @type {string} */ m) => new AgoraError(`${m} (${USAGE})`, EXIT.usage);
  const file = configPath(values.config === undefined ? undefined : String(values.config));
  const [kind, name, rowRaw, ...extra] = rest;

  if (fromDescriptor !== undefined && !(sub === "room" && kind === "add")) throw usage("--from-descriptor goes with config room add");
  if (replace && !(kind === "add" && (sub === "room" || sub === "resident"))) throw usage("--replace goes with config room add or config resident add");
  if (force && !(sub === "room" && kind === "remove")) throw usage("--force goes with config room remove");

  if (sub === "show") {
    if (rest.length) throw usage("config show takes no arguments");
    if (dryRun) throw usage("--dry-run goes with a write");
    let text;
    try { text = await readFile(file, "utf8"); }
    catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") throw new AgoraError(`no config at ${file} (set AGORA_CONFIG, or write ./agora.json or ~/.agora/config.json; agora config set writes one)`);
      throw e;
    }
    /** @type {unknown} */
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new AgoraError(`${file} is not JSON (${e instanceof Error ? e.message : String(e)})`); }
    // the file holds token references only, so show redacts nothing; a file that breaks that is
    // refused rather than printed, and the paths are named without their values
    const secrets = inlineSecrets(parsed);
    if (secrets.length)
      throw Object.assign(new AgoraError(`inline-token: ${file} holds a credential inline at ${secrets.join(", ")}; it is not printed. Move the value to a file or an env var and name it with tokenFile or tokenEnv`), { code: "inline-token" });
    /** @type {string | undefined} */
    let invalid;
    try { validateConfig(parsed, file); } catch (e) { invalid = e instanceof Error ? e.message : String(e); }
    if (json) out(JSON.stringify({ type: "config", action: "show", path: file, valid: invalid === undefined, ...(invalid ? { error: invalid } : {}), config: parsed }));
    else {
      err(`agora: config ${file}${invalid ? ` (invalid: ${invalid})` : ""}`);
      out(text.replace(/\r?\n$/, ""));
    }
    return EXIT.ok;
  }

  /** @type {string} */
  let action;
  /** @type {(before: Record<string, unknown> | null) => Promise<Plan> | Plan} */
  let plan;

  if (sub === "room" && kind === "add") {
    if (name === undefined) throw usage("config room add needs <alias>");
    if (!ALIAS_RE.test(name)) throw usage("a room alias starts with a letter or digit and carries letters, digits, dot, underscore or hyphen");
    if (extra.length || (fromDescriptor !== undefined && rowRaw !== undefined)) throw usage("config room add takes <alias> and one of <row-json> or --from-descriptor <path>");
    if (fromDescriptor === undefined && rowRaw === undefined) throw usage("config room add needs <row-json> or --from-descriptor <path>");
    if (fromDescriptor !== undefined && !fromDescriptor.trim()) throw usage("--from-descriptor needs a path");
    const given = rowRaw === undefined ? undefined : parseJsonArg(rowRaw, "the room row");
    if (given !== undefined) checkRoomRow(name, given);
    action = "room-add";
    plan = async (before) => {
      /** @type {string[]} */
      const notes = [];
      let row = given;
      if (fromDescriptor !== undefined) {
        const verified = await verifiedRemoteRow(path.resolve(fromDescriptor), stateOf(before));
        row = verified.row;
        const b = verified.descriptor.binding;
        notes.push(`descriptor verified: room ${b.roomId} on host ${b.host.id}, this seat posts as ${b.accountId}`);
        const author = b.author;
        const actor = isObject(before?.actor) ? before.actor : undefined;
        if (author && !(actor?.kind === "human" && String(actor?.name ?? "").trim() === author.name))
          notes.push(`this is a HUMAN route: the host stamps every post on it as the human ${JSON.stringify(author.name)} and refuses any other actor; set it with: agora config set actor ${JSON.stringify(JSON.stringify({ name: author.name, kind: "human" }))}`);
      }
      const rooms = before?.rooms;
      if (has(rooms, name)) {
        const have = /** @type {Record<string, unknown>} */ (rooms)[name];
        if (canonical(have) === canonical(row)) return { noop: `rooms.${name} is already this row`, notes };
        if (!replace)
          throw Object.assign(new AgoraError(`room-conflict: rooms.${name} is already ${isObject(have) && typeof have.transport === "string" ? `a ${have.transport} room` : "set"} with another row (${shown(have)}); pass --replace to replace it, or choose another alias. Nothing was written`), { code: "room-conflict" });
      }
      return { ops: [{ path: ["rooms", name], value: row }], notes };
    };
  } else if (sub === "room" && kind === "remove") {
    if (name === undefined || rowRaw !== undefined) throw usage("config room remove takes one <alias>");
    action = "room-remove";
    plan = (before) => {
      const rooms = before?.rooms;
      if (!has(rooms, name)) return { noop: `no room "${name}" in the config; nothing to remove` };
      const have = /** @type {Record<string, any>} */ (rooms)[name];
      const stateRoot = stateOf(before);
      if (isObject(have) && have.transport === "native" && typeof have.roomId === "string" && /^[a-f0-9]{32}$/.test(have.roomId)) {
        const hosted = path.join(path.resolve(stateRoot), "native", "rooms", have.roomId);
        if (existsSync(hosted) && !force)
          throw Object.assign(new AgoraError(`room-hosted: rooms.${name} is native room ${have.roomId}, which this seat still hosts (${hosted}); removing the row leaves the room with no alias. To retire the room: agora config room remove ${name} --force, then agora service room delete ${have.roomId} --confirm ${have.roomId}. To drop only the alias, the same --force. Nothing was written`), { code: "room-hosted" });
      }
      return {
        ops: [{ path: ["rooms", name] }],
        notes: [`only the row goes: this seat's state for the room (cursors, sessions, ${have?.transport === "native-remote" ? "the installed route" : have?.transport === "native" ? "the hosted room" : "any cached reads"}) under ${stateRoot} stays, and nothing on the transport is touched`],
      };
    };
  } else if (sub === "resident" && kind === "add") {
    if (name === undefined || extra.length) throw usage("config resident add takes <slug> and an optional <row-json>");
    assertResidentSlug(name);
    const row = rowRaw === undefined ? {} : parseJsonArg(rowRaw, "the resident row");
    if (!isObject(row)) throw usage("a resident row is a JSON object, e.g. '{\"restart\":\"systemctl --user restart resident-{slug}.service\"}'");
    if (row.restart !== undefined && typeof row.restart !== "string") throw usage("a resident row's restart is a command string ({slug} is the resident)");
    action = "resident-add";
    plan = (before) => {
      const table = before?.residents;
      if (table !== undefined && !isObject(table)) throw new AgoraError(`residents in the config is not an object; fix it by hand (or agora config set residents '{}'). Nothing was written`);
      if (has(table, name)) {
        const have = /** @type {Record<string, unknown>} */ (table)[name];
        if (canonical(have) === canonical(row)) return { noop: `residents.${name} is already this row` };
        if (!replace) throw Object.assign(new AgoraError(`resident-conflict: residents.${name} is already ${shown(have)}; pass --replace to replace it. Nothing was written`), { code: "resident-conflict" });
      }
      return { ops: [{ path: ["residents", name], value: row }] };
    };
  } else if (sub === "resident" && kind === "remove") {
    if (name === undefined || rowRaw !== undefined) throw usage("config resident remove takes one <slug>");
    action = "resident-remove";
    plan = (before) => has(before?.residents, name)
      ? { ops: [{ path: ["residents", name] }] }
      : { noop: `no resident "${name}" in the config; nothing to remove` };
  } else if (sub === "set") {
    if (rest.length < 2 || rest.length % 2) throw usage("config set takes <key> <json> pairs");
    /** @type {[string, unknown][]} */
    const pairs = [];
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i];
      if (!(key in CONFIG_KEYS)) throw usage(`"${key}" is not a config key agora reads (have: ${Object.keys(CONFIG_KEYS).join(", ")})`);
      if (pairs.some(([k]) => k === key)) throw usage(`"${key}" is given twice`);
      const value = parseJsonArg(rest[i + 1], `the value for ${key}`);
      const want = CONFIG_KEYS[/** @type {keyof typeof CONFIG_KEYS} */ (key)];
      const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      if (got !== want) throw usage(`${key} takes a JSON ${want}, not ${got === "string" ? `a string (${JSON.stringify(value)})` : `${got === "array" || got === "object" ? "an" : "a"} ${got}`}`);
      pairs.push([key, value]);
    }
    action = "set";
    plan = (before) => {
      const changed = pairs.filter(([k, v]) => !has(before, k) || canonical(/** @type {any} */ (before)[k]) !== canonical(v));
      if (!changed.length) return { noop: `${pairs.map(([k]) => k).join(", ")} already ${pairs.length === 1 ? "has" : "have"} this value` };
      /** @type {string[]} */
      const notes = [];
      if (changed.some(([k]) => k === "actor"))
        notes.push("actor.name is the signature of every session on this seat that registered no bearer (agora session --as): their next posts sign as the new name");
      return { ops: changed.map(([k, v]) => /** @type {Op} */ ({ path: [k], value: v })), notes };
    };
  } else if (sub === "unset") {
    if (!rest.length) throw usage("config unset takes one or more keys");
    for (const key of rest) if (!(key in CONFIG_KEYS)) throw usage(`"${key}" is not a config key agora reads (have: ${Object.keys(CONFIG_KEYS).join(", ")})`);
    action = "unset";
    plan = (before) => {
      const present = rest.filter((k) => has(before, k));
      if (!present.length) return { noop: `${rest.join(", ")} ${rest.length === 1 ? "is" : "are"} not set; nothing to remove` };
      return { ops: present.map((k) => /** @type {Op} */ ({ path: [k] })) };
    };
  } else {
    throw usage(sub === undefined ? "config needs a subverb" : `config takes show, room add|remove, resident add|remove, set or unset, not "${[sub, kind].filter(Boolean).join(" ")}"`);
  }

  const r = await editConfig(file, plan, { dryRun, lockWaitMs: a.lockWaitMs, now: a.now });
  if (json) {
    out(JSON.stringify({ type: "config", action, path: r.path, written: r.written, dryRun: r.dryRun, ...(r.noop ? { noop: r.noop } : {}),
      ...(r.backup ? { backup: r.backup } : {}), ...(r.withheld ? { withheld: r.withheld } : {}), before: r.before, after: r.after, diff: r.diff, notes: r.notes }));
    return EXIT.ok;
  }
  out(`config ${r.path}${r.existed ? "" : " (new file)"}`);
  for (const n of r.notes) out(n);
  if (r.noop) { out(`${r.noop}: nothing written`); return EXIT.ok; }
  out(r.withheld ? `the file before holds a credential inline at ${r.withheld.join(", ")}, so no diff is printed` : r.diff);
  out(r.dryRun ? "dry run: nothing written" : `wrote ${r.path}${r.backup ? `; the file before is kept as ${r.backup}` : ""}`);
  return EXIT.ok;
}
