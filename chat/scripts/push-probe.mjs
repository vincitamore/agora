#!/usr/bin/env bun
// @ts-check
/**
 * The push probe: does a push sent now reach these people's devices, and how often over days?
 *
 *   bun chat/scripts/push-probe.mjs --store <dir> --vapid <file> --subject <mailto:|https:> \
 *     --people alice,bob --every 1h --for 72h [--run <name>] [--json]
 *   bun chat/scripts/push-probe.mjs --store <dir> ... --people alice --once
 *   bun chat/scripts/push-probe.mjs --store <dir> --report [--run <name>] [--json]
 *
 * Each round sends one numbered test push to every subscription each person holds and records, in
 * the kit store's push tables, that it was sent, the push service's answer, and (when the device's
 * service worker shows it and the host relays `POST /chat/push/ack`) the acknowledgement. `--store`
 * and `--vapid` are the host's own kit store and key file, so the pushes are signed with the key
 * the devices subscribed under and the acks land beside the sends. `--report` prints, per person,
 * what was sent, what the push service accepted, what was acknowledged, and which numbers never were.
 *
 * Bun only (the store is bun:sqlite). Stop a running probe with Ctrl-C; what was sent stays recorded.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createPush, createPushService } from "../push/server.mjs";
import { openPushStore } from "../push/store.mjs";

/** @param {string} text @returns {number} milliseconds */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(text ?? "").trim());
  if (!m) throw new Error(`a duration is a number and a unit (ms, s, m, h, d): ${text}`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[/** @type {'ms'|'s'|'m'|'h'|'d'} */ (m[2])];
  const ms = Number(m[1]) * unit;
  if (!(ms > 0)) throw new Error(`a duration is positive: ${text}`);
  return ms;
}

/**
 * One round: one numbered push to every subscription of each person. A person with no subscription
 * is recorded as such, so the report shows the gap instead of silence.
 * @param {{ service: ReturnType<typeof createPushService>, store: import("../push/store.mjs").PushStore, people: string[], run: string, seq: number, total?: number }} input
 */
export async function probeRound({ service, store, people, run, seq, total }) {
  const at = new Date().toISOString().slice(11, 16);
  const out = [];
  for (const person of people) {
    const results = await service.sendTo(person, {
      title: `Test push ${seq}`,
      body: `Delivery check ${seq}${total ? ` of ${total}` : ""}, sent ${at} UTC. Nothing to do.`,
      kind: "probe", run, seq, urgency: "normal",
    });
    if (results.length === 0) {
      const id = randomBytes(16).toString("hex");
      store.recordSent({ id, person, endpoint: "", kind: "probe", run, seq });
      store.recordAnswer(id, null, "no-subscription");
    }
    out.push({ person, seq, results });
  }
  return out;
}

/**
 * Per person: sent, accepted by the push service (201), acknowledged as shown, clicked, rounds with
 * no subscription, and the numbers never acknowledged.
 * @param {import("../push/store.mjs").PushStore} store @param {string} run
 */
export function probeReport(store, run) {
  const rows = store.runRecords(run);
  /** @type {Map<string, { person: string, sent: number, accepted: number, acked: number, clicked: number, noSubscription: number, unacked: number[], answers: Record<string, number>, lastSent: string | null, lastAck: string | null }>} */
  const by = new Map();
  for (const r of rows) {
    let p = by.get(r.person);
    if (!p) by.set(r.person, p = { person: r.person, sent: 0, accepted: 0, acked: 0, clicked: 0, noSubscription: 0, unacked: [], answers: {}, lastSent: null, lastAck: null });
    if (!r.endpoint) {
      p.noSubscription++;
      continue;
    }
    p.sent++;
    const key = r.status == null ? (r.answer ?? "none").slice(0, 40) : String(r.status);
    p.answers[key] = (p.answers[key] ?? 0) + 1;
    if (r.status === 201) p.accepted++;
    if (r.ackedAt) p.acked++;
    else if (r.seq != null) p.unacked.push(r.seq);
    if (r.clickedAt) p.clicked++;
    if (!p.lastSent || r.sentAt > p.lastSent) p.lastSent = r.sentAt;
    if (r.ackedAt && (!p.lastAck || r.ackedAt > p.lastAck)) p.lastAck = r.ackedAt;
  }
  return { run, people: [...by.values()] };
}

/** @param {ReturnType<typeof probeReport>} report */
export function renderReport(report) {
  const lines = [`probe run ${report.run}`];
  if (report.people.length === 0) lines.push("  nothing recorded");
  for (const p of report.people) {
    const answers = Object.entries(p.answers).map(([k, v]) => `${k}x${v}`).join(" ") || "none";
    lines.push(`  ${p.person}: sent ${p.sent}, push service accepted ${p.accepted} (${answers}), acked ${p.acked}, clicked ${p.clicked}` +
      (p.noSubscription ? `, ${p.noSubscription} round(s) with no subscription` : ""));
    lines.push(`    last sent ${p.lastSent ?? "never"}, last ack ${p.lastAck ?? "never"}` +
      (p.unacked.length ? `; never acked: ${p.unacked.join(", ")}` : ""));
  }
  return lines.join("\n");
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const a = {};
  const flags = new Set(["once", "report", "json", "help"]);
  const values = new Set(["store", "vapid", "subject", "people", "every", "for", "run"]);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)$/.exec(argv[i]);
    if (!m) throw new Error(`unexpected argument: ${argv[i]}`);
    if (flags.has(m[1])) a[m[1]] = true;
    else if (values.has(m[1])) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${m[1]} takes a value`);
      a[m[1]] = v;
    } else throw new Error(`unknown option --${m[1]}`);
  }
  return a;
}

const USAGE = `usage:
  push-probe --store <dir> --vapid <file> --subject <mailto:|https:> --people <id,id> --every <dur> --for <dur> [--run <name>] [--json]
  push-probe --store <dir> --vapid <file> --subject <mailto:|https:> --people <id,id> --once [--run <name>] [--json]
  push-probe --store <dir> --report [--run <name>] [--json]
durations: 90s, 30m, 1h, 3d`;

/** @param {string[]} argv @returns {Promise<number>} exit code */
export async function main(argv) {
  /** @type {Record<string, string | boolean>} */
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${/** @type {Error} */ (e).message}\n${USAGE}\n`);
    return 2;
  }
  if (a.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (typeof a.store !== "string") {
    process.stderr.write(`--store is required\n${USAGE}\n`);
    return 2;
  }
  const store = await openPushStore({ storeDir: path.resolve(a.store) });
  try {
    if (a.report) {
      const run = typeof a.run === "string" ? a.run : store.probeRuns()[0];
      if (!run) {
        process.stderr.write("no probe run recorded in this store\n");
        return 1;
      }
      const report = probeReport(store, run);
      process.stdout.write(a.json ? `${JSON.stringify(report)}\n` : `${renderReport(report)}\n`);
      return 0;
    }
    if (typeof a.vapid !== "string" || typeof a.subject !== "string" || typeof a.people !== "string") {
      process.stderr.write(`--vapid, --subject and --people are required to send\n${USAGE}\n`);
      return 2;
    }
    const people = a.people.split(",").map((s) => s.trim()).filter(Boolean);
    if (people.length === 0) {
      process.stderr.write("--people names no one\n");
      return 2;
    }
    let every = 0, span = 0;
    if (!a.once) {
      if (typeof a.every !== "string" || typeof a.for !== "string") {
        process.stderr.write(`--every and --for, or --once\n${USAGE}\n`);
        return 2;
      }
      every = parseDuration(a.every);
      span = parseDuration(a.for);
    }
    const push = await createPush({ vapidFile: path.resolve(a.vapid), subject: a.subject });
    if (push.created) process.stderr.write(`created a new VAPID key at ${a.vapid}: no device is subscribed under it yet\n`);
    const service = createPushService({ store, push, hooks: { people: async () => [], notifyText: () => ({ title: "", body: "" }) } });
    const run = typeof a.run === "string" ? a.run : `probe-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const total = a.once ? 1 : Math.floor(span / every);
    const started = Date.now();
    let stopping = false;
    /** @type {(() => void) | null} */
    let wake = null;
    const stop = () => { stopping = true; wake?.(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      for (let round = 0; !stopping; round++) {
        const seq = store.nextSeq(run);
        for (const r of await probeRound({ service, store, people, run, seq, total })) {
          const line = { run, seq: r.seq, person: r.person, results: r.results.map((x) => ({ pushId: x.pushId, status: x.status, gone: x.gone, error: x.error })) };
          process.stdout.write(a.json ? `${JSON.stringify(line)}\n`
            : `${run} #${r.seq} ${r.person}: ${r.results.length ? r.results.map((x) => x.status ?? x.error).join(", ") : "no subscription"}\n`);
        }
        if (a.once) break;
        const next = started + (round + 1) * every;
        if (next >= started + span) break;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, next - Date.now()));
          wake = () => { clearTimeout(timer); resolve(undefined); };
        });
        wake = null;
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    process.stderr.write(`probe run ${run}: report with --report --run ${run}\n`);
    return 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
