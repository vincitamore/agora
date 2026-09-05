/**
 * The seat's human: one name, in a private file under the agora state root, written once. The
 * shared config names the seat's bot and its bearers; it is never read for the human's identity
 * and never written by this surface. The file is created `wx` at mode 0600 and moved into place
 * by rename, so a torn write can never be read as a name.
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { HumanActor } from "./room-client";

export const HUMAN_FILE = path.join("native", "human.json");
export const HUMAN_NAME_MAX = 64;

/** Why a string is not a name here, or nothing. */
export function humanNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "a name is needed";
  if (n.length > HUMAN_NAME_MAX) return `a name is at most ${HUMAN_NAME_MAX} characters`;
  if (/[\r\n]/.test(n)) return "a name is one line";
  // the three dashes the CLI's SIGNATURE_RE accepts: two hyphens, U+2014, U+2013
  if (/^(--|\u2014|\u2013)/.test(n)) return "a name does not start with a signature dash";
  return undefined;
}

export function humanFile(stateRoot: string): string {
  return path.join(stateRoot, HUMAN_FILE);
}

/** The seat's human, or nothing when no name has been written yet. A malformed file is an error. */
export async function readHuman(stateRoot: string): Promise<HumanActor | undefined> {
  const file = humanFile(stateRoot);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  const rec = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  const name = rec && typeof rec.name === "string" ? rec.name : undefined;
  if (!name || humanNameProblem(name)) throw new Error(`${file}: not a human record (expected {"name": "..."}); fix it or remove it`);
  return { name: name.trim(), kind: "human" };
}

/**
 * Write the seat's human once. Refuses when a record already exists, so a second run can never
 * silently rename the person a room already knows.
 */
export async function writeHuman(stateRoot: string, name: string): Promise<HumanActor> {
  const problem = humanNameProblem(name);
  if (problem) throw new Error(problem);
  const file = humanFile(stateRoot);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ name: name.trim(), kind: "human", created: new Date().toISOString() }) + "\n";
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await readHuman(stateRoot)) throw new Error(`${file} already names this seat's human; remove it first to rename`);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { name: name.trim(), kind: "human" };
}
