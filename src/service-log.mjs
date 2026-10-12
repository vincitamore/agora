// @ts-check
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { redact } from "./core.mjs";

/**
 * The seat service's own log: `<state>/native/service.log`, for the warnings a detached daemon
 * would otherwise write to a stderr nobody holds (a service started by a oneshot unit, or by
 * `agora service start`, whose child's stdio is closed). One JSON object per line, `{ ts, level,
 * room?, message }`, mode 0600, rotated at `maxBytes` into `service.log.1` ... `service.log.<files-1>`,
 * so the whole log never holds more than `files` times the cap.
 *
 * What a line may carry: the time, the level, the native room id the warning names, and the
 * warning's own words, redacted (`redact` in core.mjs takes every token shape) and bounded. The
 * warnings are the service's sentences about its own work (a sweep that failed, a token a face
 * refused), never a message's text; the bound keeps an error that quoted more than it should from
 * filling the file with it.
 */

/** One file's cap before it rotates. */
export const SERVICE_LOG_MAX_BYTES = 1024 * 1024;
/** How many files the log keeps, the live one included. */
export const SERVICE_LOG_FILES = 3;
/** The longest message a line keeps. */
export const SERVICE_LOG_MESSAGE_MAX = 500;

const ROOM_ID = /\b[a-f0-9]{32}\b/;

/** @param {string} root */
export function serviceLogPath(root) { return path.join(path.resolve(root), "native", "service.log"); }

/** @typedef {{ ts: string, level: 'warn' | 'info', room?: string, message: string }} ServiceLogLine */

/**
 * A writer for the service log. `warn(line)` is the shape every warn hook in the service takes:
 * it appends one line and, when `echo` is given, still writes the redacted line there too. A
 * failure to write the log is swallowed after one attempt: a log is never the reason a service
 * stops.
 * @param {string} root
 * @param {{ maxBytes?: number, files?: number, now?: () => Date, echo?: (line: string) => void }} [options]
 */
export function createServiceLog(root, { maxBytes = SERVICE_LOG_MAX_BYTES, files = SERVICE_LOG_FILES, now = () => new Date(), echo } = {}) {
  const file = serviceLogPath(root);
  /** @param {'warn' | 'info'} level @param {string} text */
  const write = (level, text) => {
    const clean = redact(String(text)).replace(/\s+/g, " ").trim();
    const message = clean.length > SERVICE_LOG_MESSAGE_MAX ? `${clean.slice(0, SERVICE_LOG_MESSAGE_MAX - 1)}…` : clean;
    const room = ROOM_ID.exec(message)?.[0];
    /** @type {ServiceLogLine} */
    const line = { ts: now().toISOString(), level, ...(room ? { room } : {}), message };
    const bytes = Buffer.from(JSON.stringify(line) + "\n", "utf8");
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = statSync(file).size; } catch { /* no log yet */ }
      if (size > 0 && size + bytes.length > maxBytes) rotate(file, files);
      appendFileSync(file, bytes, { mode: 0o600 });
      // appendFile's mode applies only when it creates the file; a file left wider is narrowed
      if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    } catch { /* the log is best effort; the echo below still says it */ }
    if (echo) echo(`${message}`);
    return line;
  };
  return {
    path: file,
    /** @param {string} text */
    warn: (text) => write("warn", text),
    /** @param {string} text */
    info: (text) => write("info", text),
  };
}

/** @param {string} file @param {number} files */
function rotate(file, files) {
  rmSync(`${file}.${files - 1}`, { force: true });
  for (let n = files - 2; n >= 1; n--) {
    try { renameSync(`${file}.${n}`, `${file}.${n + 1}`); } catch { /* that generation is absent */ }
  }
  if (files > 1) renameSync(file, `${file}.1`);
  else rmSync(file, { force: true });
}

/**
 * The newest `last` lines of the service log, oldest first, read from the live file and as many
 * rotated ones as it takes. A torn or foreign line is skipped. An absent log is no lines.
 * @param {string} root @param {{ last?: number, files?: number }} [options]
 * @returns {ServiceLogLine[]}
 */
export function readServiceLog(root, { last = 5, files = SERVICE_LOG_FILES } = {}) {
  const file = serviceLogPath(root);
  /** @type {ServiceLogLine[]} */
  let out = [];
  for (let n = 0; n < files && out.length < last; n++) {
    let text;
    try { text = readFileSync(n === 0 ? file : `${file}.${n}`, "utf8"); }
    catch { continue; }
    /** @type {ServiceLogLine[]} */
    const lines = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        const l = JSON.parse(raw);
        if (l && typeof l.ts === "string" && typeof l.message === "string") lines.push(l);
      } catch { /* a torn line from a killed writer */ }
    }
    out = [...lines, ...out];
  }
  return out.slice(-last);
}
