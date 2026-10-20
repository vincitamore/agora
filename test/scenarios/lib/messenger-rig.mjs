// @ts-check
/**
 * The messenger as a scenario drives it: one session on the seat holding the room's messenger
 * position, ticking through the real CLI (`agora messenger <room> --once --at <instant>`), so a
 * clock of minutes is executed at its configured value instead of being waited out. The notices
 * are counted from the room as `read --json` returns it, parsed by the messenger's own reader;
 * which tick posted each comes from that tick's own JSON line.
 */

import { parseNotice } from "../../../src/messenger.mjs";
import { Agent } from "./participants.mjs";
import { readRoom } from "./room.mjs";

export const MESSENGER_SESSION = "main.messenger";
export const MESSENGER_BEARER = "messenger/Code";
export const HOST_HUMAN = "Ada";

/**
 * @param {import("./seat.mjs").Seat} seat
 * @param {{ bounds?: string }} [opts]
 */
export async function messengerRig(seat, opts = {}) {
  const agent = await Agent.start(seat, { session: MESSENGER_SESSION, bearer: MESSENGER_BEARER, label: MESSENGER_SESSION });
  /** id of every notice posted -> the tick (ms since the rig's origin) that posted it */
  const postedAt = new Map();
  const args = ["--human-name", HOST_HUMAN, ...(opts.bounds ? ["--bounds", opts.bounds] : []), "--json"];
  return {
    agent,
    args,
    /** One tick at an instant. @param {number} at epoch ms */
    async tickAt(at) {
      const r = await agent.cli(["messenger", seat.alias, "--once", "--at", new Date(at).toISOString(), ...args]);
      if (r.code !== 0) throw new Error(`messenger tick exited ${r.code}: ${r.stderr}`);
      const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("{") && l.includes('"messenger-tick"'));
      if (!line) throw new Error(`messenger tick printed no messenger-tick line: ${r.stdout}${r.stderr}`);
      const tick = JSON.parse(line);
      for (const p of tick.posted) postedAt.set(p.id, at);
      return tick;
    },
    /** The notices the room holds, read back, with the tick instant that posted each (when this rig posted it). */
    async notices() {
      const room = await readRoom(seat);
      return room.messages.map((m) => ({ m, n: parseNotice(m.text) })).filter((x) => x.n !== null)
        .map(({ m, n }) => ({ id: m.id, thread: m.thread ?? null, kind: /** @type {any} */ (n).kind, fields: /** @type {any} */ (n).fields,
          re: /** @type {any} */ (n).re, to: /** @type {any} */ (n).to, at: postedAt.get(m.id) ?? null }));
    },
  };
}

/** A message's commit instant, read back from the room. @param {import("./seat.mjs").Seat} seat @param {string} id */
export async function postedTs(seat, id) {
  const room = await readRoom(seat);
  const m = /** @type {any} */ (room.byId.get(id));
  if (!m?.ts) throw new Error(`message ${id} is not in the room read`);
  return Date.parse(m.ts);
}

/**
 * Duplicate notices: incidents with more than one notice standing for them.
 * @param {Array<{ kind: string, fields: Record<string, string>, re?: string, to: string[] }>} notices
 */
export function duplicates(notices) {
  const seen = new Map();
  for (const n of notices) {
    const key = `${n.kind}:${JSON.stringify(n.fields.id ?? n.fields.subject ?? n.fields.root ?? n.fields.addr)}:${n.re ?? ""}:${n.kind === "N2" ? n.to[0] : ""}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter((c) => c > 1).length;
}
