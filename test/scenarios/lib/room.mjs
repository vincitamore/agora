// @ts-check
/**
 * The room as the real CLI reads it back (`read --json`): messages and annotations in log order,
 * and the facts the scenarios count off them. Every count a scenario reports comes from here or
 * from another record the CLI or service wrote; never from what the runner meant to post.
 */

/** @typedef {import("./participants.mjs").WireMessage} WireMessage */
/** @typedef {{ id: string, cursor: string, act: string, target: string, text?: string, author: { name: string, kind: string } }} WireAnnotation */

/**
 * The fixed forms of the CLI's departure line (`departuresLine` / `departureLine` in src/session.mjs).
 * A room-business line the tool posts itself, counted by its form.
 */
export const DEPARTURE_RE = /\bno longer running\b|\bprocesses stopped for\b/;

/** @param {{ cli: (args: string[], env?: Record<string, string>) => Promise<{ code: number, stdout: string, stderr: string }>, alias: string }} seat */
export async function readRoom(seat) {
  const r = await seat.cli(["read", seat.alias, "--json", "--limit", "1000"]);
  if (r.code !== 0) throw new Error(`read failed: ${r.stderr}`);
  /** @type {WireMessage[]} */
  const messages = [];
  /** @type {WireAnnotation[]} */
  const annotations = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    const o = JSON.parse(line);
    if (o.type === "message") messages.push(o);
    else if (o.type === "annotation") annotations.push(o);
  }
  /** @type {Map<string, string>} */
  const titles = new Map();
  for (const a of annotations) if (a.act === "title" && typeof a.text === "string") titles.set(a.target, a.text);
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    messages,
    annotations,
    titles,
    byId,
    /** Top-level: a message that is no reply. Every one is a thread head on a surface. */
    topLevel: () => messages.filter((m) => !m.thread),
    /** @param {WireMessage} m */
    re: (m) => m.trailers?.find((t) => t.key === "re")?.value,
    /** @param {WireMessage} m */
    isDeparture: (m) => DEPARTURE_RE.test(bodyOf(m)),
  };
}

/** A message's body without its signature line and trailer block. @param {{ text: string, signedAs?: string }} m */
export function bodyOf(m) {
  let text = String(m.text ?? "");
  if (m.signedAs) {
    const sig = `\n\n-- ${m.signedAs}`;
    if (text.endsWith(sig)) text = text.slice(0, -sig.length);
  }
  // the trailer block is the last paragraph when every line in it is `key: value`
  const paras = text.replace(/\s+$/, "").split(/\n\s*\n/);
  const last = paras[paras.length - 1] ?? "";
  if (paras.length > 1 && last.split(/\r?\n/).every((l) => /^[A-Za-z][A-Za-z0-9-]{0,23}[ \t]*:[ \t].+$/.test(l))) paras.pop();
  return paras.join("\n\n");
}
