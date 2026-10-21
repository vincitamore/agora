// @ts-check
/**
 * Grants: a position the operator named in the manifest (`grants["<room>.orchestrator"]`) stands
 * residents up within the caps written there, and the seat's supervisor keeps every start and stop
 * on the record.
 *
 *   want     admission. The holder asks for `<room>.<role>`; the want is refused by name past
 *            `maxLive`, for a model outside `models`, for a role outside `roles` (when it is a list),
 *            for a new role with no card, for a new role one edit from a row's name family (the
 *            nearest name is given), or when every slot of the role is held. A row's slots are
 *            the row itself when it is `on-demand`, then `-2` .. `-<max>`.
 *   ensure   the one start authority. It starts each admitted want that is not running, restarts a
 *            granted position or a messenger row whose host died (a run record left, nothing
 *            running), and stops a granted position whose want ended (unwanted, expired, or revoked
 *            by the grant's removal or narrowing) at its next idle: its turn ended and quiet for the
 *            grace. Each start or stop posts one N8 line (the messenger's fixed form) in the room's
 *            Room subject. A stop by the operator's hand (no run record) ends the want; a death is the
 *            supervisor's to repair.
 *   ledger   `<state>/residents/grants.jsonl`, append-only: every want, refusal, unwant, ending,
 *            start, stop and end. State is a fold over it; nothing else is kept.
 *
 * The manifest and its grants are the operator's file: read here, never written. A granted
 * position becomes a row through `manifestRow`, so it is checked exactly as the file's own rows.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AgoraError, EXIT } from "./core.mjs";
import { annotationState, fileLock, formatAge, formatNotice, roomSubjectRoot } from "./messenger.mjs";
import { positionTurn, readInheritMarker, RESIDENT_SLUG_RE } from "./resident.mjs";
import { ensureTern, manifestRow, planResident, residentState, startResident, stopResident, which } from "./resident-start.mjs";
import { connectSeatService } from "./wake/subscriber.mjs";
import { oneEdit } from "./board-read.mjs";
import { POSITION_RE, listRecords, positionOf } from "./session.mjs";
import { withTrailers } from "./trailers.mjs";

/** A granted position whose want ended stops once its turn has ended and been quiet this long. */
export const DEFAULT_STOP_GRACE_SECONDS = 60;
/** How long a want or an ensure waits for another to release the grants lock. */
export const GRANT_LOCK_WAIT_MS = 30_000;

/** @typedef {import("./resident-start.mjs").Manifest} Manifest */
/** @typedef {import("./resident-start.mjs").ManifestResident} ManifestResident */
/**
 * @typedef {{ type: 'resident-grant', ev: 'want', id: string, at: string, by: string, session: string | null, grant: string,
 *   position: string, role: string, base: string | null, model: string, cards: string[], because: string, until: string }} Want
 * @typedef {{ want: Want, starts: any[], stops: any[], unwant: any | null, ending: any | null, end: any | null }} WantState
 * @typedef {{ why: 'unwanted' | 'expired' | 'revoked', by: string, at: string | null }} Ending
 */

/** @param {string} stateRoot */
export function ledgerPath(stateRoot) {
  return path.join(stateRoot, "residents", "grants.jsonl");
}

/** Every record of the ledger, in order; a line that is not one is skipped. @param {string} stateRoot */
export async function readLedger(stateRoot) {
  let text;
  try { text = await readFile(ledgerPath(stateRoot), "utf8"); }
  catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return []; throw e; }
  /** @type {any[]} */
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o?.type === "resident-grant" && typeof o.ev === "string") out.push(o); } catch { /* a torn line */ }
  }
  return out;
}

/** Append one record. @param {string} stateRoot @param {Record<string, unknown>} ev */
export async function appendLedger(stateRoot, ev) {
  const file = ledgerPath(stateRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const rec = { type: "resident-grant", ...ev };
  await appendFile(file, JSON.stringify(rec) + "\n");
  return rec;
}

/** Each want with what followed it. @param {any[]} events @returns {Map<string, WantState>} */
export function foldLedger(events) {
  /** @type {Map<string, WantState>} */
  const wants = new Map();
  for (const e of events) {
    if (e.ev === "want" && typeof e.id === "string") { wants.set(e.id, { want: e, starts: [], stops: [], unwant: null, ending: null, end: null }); continue; }
    const w = typeof e.id === "string" ? wants.get(e.id) : undefined;
    if (!w) continue;
    if (e.ev === "start") w.starts.push(e);
    else if (e.ev === "stop") w.stops.push(e);
    else if (e.ev === "unwant") w.unwant ??= e;
    else if (e.ev === "ending") w.ending ??= e;
    else if (e.ev === "end") w.end ??= e;
  }
  return wants;
}

/** The wants not yet ended: each holds a position, running or not. @param {Map<string, WantState>} fold */
export function openWants(fold) {
  return [...fold.values()].filter((w) => !w.end);
}

/**
 * Why a want no longer stands, or null while it does. Unwanted first, then the grant (removed, or
 * narrowed past the want's role or model, or its base row gone), then the clock (the want's own
 * `until`, cut to the grant's current `maxHours`).
 * @param {WantState} w @param {Manifest} manifest @param {number} now @returns {Ending | null}
 */
export function wantEnding(w, manifest, now) {
  if (w.unwant) return { why: "unwanted", by: String(w.unwant.by ?? "unknown"), at: w.unwant.at };
  const g = manifest.grants[w.want.grant];
  const revoked = { why: /** @type {const} */ ("revoked"), by: "manifest", at: w.ending?.why === "revoked" ? w.ending.at : null };
  if (!g) return revoked;
  if (g.roles !== "open" && !g.roles.includes(w.want.role)) return revoked;
  if (!g.models.includes(w.want.model)) return revoked;
  if (w.want.base && !manifest.residents[w.want.base]) return revoked;
  const until = Math.min(Date.parse(w.want.until), Date.parse(w.want.at) + g.maxHours * 3_600_000);
  if (now >= until) return { why: "expired", by: "clock", at: new Date(until).toISOString() };
  return null;
}

/**
 * The row a want stands up: its base row (when it names one) or the manifest's defaults, with the
 * want's role and model, the base's appended files then the want's cards, its own working folder,
 * the default bearer and no restart command of its own. Checked as a file row is.
 * @param {Manifest} manifest @param {Want} want @returns {ManifestResident}
 */
export function grantedRow(manifest, want) {
  const raw = /** @type {Record<string, any>} */ (manifest.raw);
  const baseRaw = want.base ? raw.residents?.[want.base] : undefined;
  if (want.base && !baseRaw) throw new AgoraError(`${want.position}: its base row ${want.base} is no longer in ${manifest.file}`, EXIT.error);
  const merged = { ...(raw.defaults ?? {}), ...(baseRaw ?? {}) };
  const files = merged.workdir && typeof merged.workdir === "object" ? merged.workdir.files : undefined;
  const append = [...(want.base ? manifest.residents[want.base].append : []), ...want.cards];
  return manifestRow(manifest, want.position, {
    ...(baseRaw ?? {}), role: want.role, model: want.model, tenure: "on-demand", max: 1, append,
    // a granted position keeps its own folder, signs as <role>/<Model> and is restarted by the seat
    workdir: files ? { files } : undefined, bearer: undefined, restart: undefined,
  });
}

/**
 * The manifest with every open want as a row, so start, stop, `--plan` and the cycle reach granted
 * positions as they reach the file's own. A want whose row no longer validates is left out.
 * @param {Manifest} manifest @param {Map<string, WantState>} fold @returns {Manifest}
 */
export function withGranted(manifest, fold) {
  /** @type {Record<string, ManifestResident>} */
  const residents = { ...manifest.residents };
  for (const w of openWants(fold)) {
    if (residents[w.want.position]) continue;
    try { residents[w.want.position] = grantedRow(manifest, w.want); } catch { /* reported by ensure */ }
  }
  return { ...manifest, residents };
}

/**
 * The rows of `room` whose name family a new role's segment is one edit from: the row's own name
 * (`codng`, `codings` for `coding`), or a numbered name of it (`coding2`, `coding_2` for
 * `coding-2`, whatever the row's `max`). A role that near a row would stand up beside it as an
 * ad-hoc role wearing another card, so a want for it is refused with the name it most likely meant.
 * Under three letters nothing is near: every short name is one letter from another.
 * @param {Manifest} manifest @param {string} room @param {string} segment
 * @returns {Array<{ name: string, row: string }>} the nearest name and the row it belongs to, full positions
 */
export function familyNear(manifest, room, segment) {
  /** @type {Array<{ name: string, row: string }>} */
  const near = [];
  const numbered = /^(.*?)[-_]?(\d+)$/.exec(segment);
  for (const slug of Object.keys(manifest.residents)) {
    const dot = slug.lastIndexOf(".");
    if ((dot < 0 ? "" : slug.slice(0, dot)) !== room) continue;
    const name = slug.slice(dot + 1);
    const at = (/** @type {string} */ n) => (room ? `${room}.${n}` : n);
    if (numbered && numbered[1] === name) near.push({ name: at(Number(numbered[2]) >= 2 ? `${name}-${Number(numbered[2])}` : name), row: slug });
    else if (segment.length >= 3 && name.length >= 3 && oneEdit(segment, name)) near.push({ name: slug, row: slug });
  }
  return near;
}

/**
 * Admit or refuse one want. Pure but for `held` (is a slot's position running?), the card files'
 * existence and `lineage` (would a start of the picked slot on the want's model break a lineage rule
 * against what runs now? `resident-start.mjs` `lineageRefusal`, asked of the manifest with every open
 * want and this one as rows).
 * @param {{ manifest: Manifest, fold: Map<string, WantState>, requester: string | undefined, requesterRefusal?: string, session?: string | null,
 *   position: string, model?: string, cards?: string[], hours?: number, because: string, now: number, held: (slot: string) => Promise<boolean>,
 *   lineage?: (manifest: Manifest, slot: string) => Promise<string | null> }} a
 * @returns {Promise<{ ok: true, want: Want } | { ok: false, reason: string }>}
 */
export async function admitWant(a) {
  /** @param {string} reason */
  const refuse = (reason) => /** @type {{ ok: false, reason: string }} */ ({ ok: false, reason });
  if (!a.because || !a.because.trim()) return refuse("a want says why: --because <text>");
  if (!a.requester) return refuse(a.requesterRefusal ?? "a want is asked by the session that holds a grant: run it from that position's session (its AGORA_LABEL, or session --label)");
  const grants = a.manifest.grants;
  const g = grants[a.requester];
  if (!g) return refuse(`${a.requester} holds no grant in ${a.manifest.file} (grants: ${Object.keys(grants).join(", ") || "none"})`);
  if (!POSITION_RE.test(a.position)) return refuse(`${JSON.stringify(a.position)} is not a position (<room>.<role>)`);
  const dot = a.position.lastIndexOf(".");
  const room = dot < 0 ? "" : a.position.slice(0, dot);
  const segment = a.position.slice(dot + 1);
  if (room !== g.room) return refuse(`${a.requester}'s grant stands residents up as ${g.room ? `${g.room}.` : ""}<role>; ${a.position} is outside it`);
  const slotOf = /^(.*)-(\d+)$/.exec(a.position);
  if (slotOf && a.manifest.residents[slotOf[1]]) return refuse(`${a.position} is a slot of ${slotOf[1]}: want ${slotOf[1]} and the seat picks the slot`);
  if (!a.manifest.residents[a.position]) {
    const near = familyNear(a.manifest, room, segment);
    if (near.length) return refuse(`${a.position} is not a row and is one edit from ${near.map((n) => n.name === n.row ? n.row : `${n.name}, a slot of ${n.row}`).join("; ")}: want ${[...new Set(near.map((n) => n.row))].join(" or ")}${near.some((n) => n.name !== n.row) ? " and the seat picks the slot" : ""}`);
  }
  if (a.position === a.requester) return refuse("a grant holder does not want its own position");
  const base = a.manifest.residents[a.position] ?? null;
  if (base?.harness === "agora") return refuse(`${a.position} is a messenger row (harness agora): it runs code and is never granted`);
  const role = base ? base.role : segment;
  if (g.roles !== "open" && !g.roles.includes(role)) return refuse(`role ${role} is not in ${a.requester}'s grant (roles: ${g.roles.join(", ")})`);
  const cards = [...(a.cards ?? [])];
  if (!base) {
    if (g.card) cards.unshift(g.card);
    if (!cards.length) return refuse(`${role} is a new role: it needs a card (--card <path>), and the grant names no default card`);
  }
  for (const c of cards) if (!existsSync(c)) return refuse(`the card ${c} does not exist`);
  const model = a.model ?? base?.model ?? (typeof a.manifest.raw.defaults?.model === "string" ? a.manifest.raw.defaults.model : undefined);
  if (!model || !g.models.includes(model)) return refuse(`model ${model ?? "(none)"} is outside ${a.requester}'s grant (models: ${g.models.join(", ")})`);
  const hours = a.hours ?? g.maxHours;
  if (!(Number.isFinite(hours) && hours > 0)) return refuse(`--hours takes a positive number, not ${hours}`);
  if (hours > g.maxHours) return refuse(`--hours ${hours} is past the grant's maxHours ${g.maxHours}`);
  const live = openWants(a.fold).filter((w) => w.want.grant === g.holder);
  if (live.length >= g.maxLive) return refuse(`past maxLive ${g.maxLive}: ${g.holder} already holds ${live.map((w) => w.want.position).join(", ") || "nothing (maxLive is 0)"}`);

  const max = base ? base.max : g.maxLive;
  const slots = [...(!base || base.tenure === "on-demand" ? [a.position] : [])];
  for (let i = 2; i <= max; i++) slots.push(`${a.position}-${i}`);
  const taken = new Set(openWants(a.fold).map((w) => w.want.position));
  let pick = null;
  for (const slot of slots) {
    if (!POSITION_RE.test(slot) || !RESIDENT_SLUG_RE.test(slot)) continue;
    if (slot !== a.position && a.manifest.residents[slot]) continue;
    if (taken.has(slot) || (await a.held(slot))) continue;
    pick = slot;
    break;
  }
  if (!pick) return refuse(base ? `every slot of ${a.position} is held (${slots.join(", ") || "none"}; max ${base.max}${base.tenure === "standing" ? ", the row itself is standing" : ""})` : `every slot of ${a.position} is held (${slots.join(", ")})`);
  const nowIso = new Date(a.now).toISOString();
  /** @type {Want} */
  const want = {
    type: "resident-grant", ev: "want", id: `w-${randomBytes(4).toString("hex")}`, at: nowIso, by: g.holder, session: a.session ?? null, grant: g.holder,
    position: pick, role, base: base ? a.position : null, model, cards, because: a.because.trim(), until: new Date(a.now + hours * 3_600_000).toISOString(),
  };
  try {
    const row = grantedRow(a.manifest, want);
    if (row.host === "none") return refuse(`${a.position} runs on host none: a supervisor has no handle to start it into`);
    if (a.lineage) {
      const granted = withGranted(a.manifest, a.fold);
      const why = await a.lineage({ ...granted, residents: { ...granted.residents, [pick]: row } }, pick);
      if (why) return refuse(why);
    }
  } catch (e) {
    return refuse(`the row ${pick} would not validate: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: true, want };
}

/** Run `fn` holding the seat's grants lock. @template T @param {string} stateRoot @param {() => Promise<T>} fn @returns {Promise<T>} */
export async function withGrantsLock(stateRoot, fn) {
  const lock = fileLock(path.join(stateRoot, "residents", "grants.lock"), { waitMs: GRANT_LOCK_WAIT_MS });
  /** @type {{ v: T } | undefined} */
  const out = await lock(async () => ({ v: await fn() }));
  if (!out) throw new AgoraError(`another want or ensure holds ${path.join(stateRoot, "residents", "grants.lock")}; retry in a moment`, EXIT.error);
  return out.v;
}

/**
 * Admit and record one want (or its refusal), under the grants lock. A dry run admits or refuses
 * exactly as a want would and records nothing, so it spends no part of the grant.
 * @param {Manifest} manifest @param {string} stateRoot
 * @param {Omit<Parameters<typeof admitWant>[0], 'manifest' | 'fold' | 'held' | 'lineage'> & { dryRun?: boolean }} a @param {{ held: (slot: string) => Promise<boolean>, lineage?: Parameters<typeof admitWant>[0]['lineage'] }} deps
 */
export async function recordWant(manifest, stateRoot, a, deps) {
  return withGrantsLock(stateRoot, async () => {
    const fold = foldLedger(await readLedger(stateRoot));
    const r = await admitWant({ ...a, manifest, fold, held: deps.held, lineage: deps.lineage });
    if (a.dryRun) return { ...r, dryRun: true };
    if (r.ok) await appendLedger(stateRoot, r.want);
    else await appendLedger(stateRoot, { ev: "refuse", at: new Date(a.now).toISOString(), by: a.requester ?? null, session: a.session ?? null, position: a.position, model: a.model ?? null, reason: r.reason });
    return { ...r, dryRun: false };
  });
}

/**
 * Who asks a want or an unwant: the position the asking session holds, read from its own session
 * record (the label it registered with), never from the call's environment, which any session can
 * set. That session must not be gone, and it must be the position's only holder that is not gone: a
 * second session that registers itself at the holder's position can neither spend the grant nor,
 * while it stands, let the holder spend it unnoticed. A refusal carries its reason for `admitWant`
 * and `recordUnwant`. `act: "unwant"` words the refusals for a release; the check is the same.
 * @param {string} stateRoot @param {{ slug: string }} session
 * @param {{ env?: Record<string, string | undefined>, kill?: (pid: number, sig: 0) => void, boot?: number, act?: "want" | "unwant" }} [deps]
 * @returns {Promise<{ ok: true, requester: string } | { ok: false, reason: string }>}
 */
export async function wantRequester(stateRoot, session, deps = {}) {
  const lead = deps.act === "unwant" ? "an unwant is asked by the session that holds the want's grant" : "a want is asked by the session that holds a grant";
  const records = await listRecords(stateRoot, { kill: deps.kill, boot: deps.boot });
  const mine = records.find((r) => r.slug === session.slug);
  const position = positionOf(mine?.record);
  const claimed = String(deps.env?.AGORA_LABEL ?? "").trim() || undefined;
  if (!position) {
    return { ok: false, reason: claimed
      ? `${lead}: this session (${session.slug}) names ${claimed} in AGORA_LABEL but holds no position on this seat; the holder's own session asks`
      : `${lead}: run it from that position's session (its AGORA_LABEL, or session --label)` };
  }
  if (claimed && claimed !== position) return { ok: false, reason: `${lead}: this session (${session.slug}) holds ${position}, not ${claimed}` };
  if (mine?.state === "gone") return { ok: false, reason: `${lead}: this session (${session.slug}) is gone (its process no longer runs)` };
  const holders = records.filter((r) => r.state !== "gone" && positionOf(r.record) === position).map((r) => r.slug);
  if (holders.length > 1) return { ok: false, reason: `${lead}: ${position} is held by ${holders.length} sessions (${holders.join(", ")}); a grant is spent by its one holder` };
  return { ok: true, requester: position };
}

/**
 * Release a want: by its id, or by the position it holds. The stop follows at the position's next
 * idle (ensure). Authorised as a want is: `requester` is the position the asking session holds
 * (`wantRequester`), and it must be the grant that asked the want. With no requester, or another
 * holder's, the want stands and the refusal is recorded with the asking session, as a refused want
 * is. The operator ends a want by the manifest (the grant removed or narrowed) or by stopping the
 * position by hand, never by a session that holds no grant.
 * @param {string} stateRoot
 * @param {{ target: string, by: string, because?: string, now: number, requester?: string, requesterRefusal?: string, session?: string | null }} a
 */
export async function recordUnwant(stateRoot, a) {
  return withGrantsLock(stateRoot, async () => {
    /** @param {string} reason */
    const refuse = async (reason) => {
      await appendLedger(stateRoot, { ev: "refuse", act: "unwant", at: new Date(a.now).toISOString(), by: a.requester ?? null, session: a.session ?? null, target: a.target, reason });
      return { ok: /** @type {const} */ (false), reason };
    };
    if (!a.requester) return refuse(a.requesterRefusal ?? "an unwant is asked by the session that holds the want's grant: run it from that position's session (its AGORA_LABEL, or session --label)");
    const open = openWants(foldLedger(await readLedger(stateRoot)));
    const w = open.find((x) => x.want.id === a.target) ?? open.find((x) => x.want.position === a.target);
    if (!w) return { ok: false, reason: `no open want ${a.target} (open: ${open.map((x) => `${x.want.id} ${x.want.position}`).join(", ") || "none"})` };
    if (w.want.grant !== a.requester) return refuse(`${a.requester} did not ask this want: ${w.want.grant} holds it`);
    if (w.unwant) return { ok: true, want: w.want, already: true };
    await appendLedger(stateRoot, { ev: "unwant", id: w.want.id, at: new Date(a.now).toISOString(), by: a.by, ...(a.because ? { because: a.because } : {}) });
    return { ok: true, want: w.want, already: false };
  });
}

/** A position is started this many times within the window by the supervisor, then held until a start by hand. */
export const RESTART_LIMIT = Object.freeze({ starts: 3, withinSeconds: 3600 });
/** Seconds between two starts in one pass: a reboot's recovery does not start every harness at once. */
export const DEFAULT_STAGGER_SECONDS = 10;

/**
 * `service` says whether the seat service a row's rooms need answers; `host` brings a host up
 * before a start into it (Tern) or says why it cannot; both absent mean always up, for a seat with
 * neither to ask. `sleep` paces the starts.
 * @typedef {{
 *   start: (position: string, row: ManifestResident) => Promise<{ action: string, reason?: unknown }>,
 *   stop: (position: string) => Promise<{ action: string, reason?: unknown }>,
 *   state: (position: string) => Promise<{ running: boolean, run: any, reason: string | null, host?: 'live' | 'gone' | 'unknown' | null }>,
 *   marker: (position: string) => Promise<boolean>,
 *   turn: (position: string) => ReturnType<typeof positionTurn>,
 *   post: (room: string, text: string) => Promise<{ id: string } | null>,
 *   now: () => number,
 *   service?: (row: ManifestResident) => Promise<{ up: boolean, reason: string | null }>,
 *   host?: (kind: string, opts: { dryRun: boolean }) => Promise<{ up: boolean, started: boolean, reason: string | null }>,
 *   sleep?: (ms: number) => Promise<void>,
 * }} EnsureDeps
 */

/**
 * The room's host human: the `--human-name` its messenger row runs with, else null.
 * @param {Manifest} manifest @param {string} room
 */
export function hostHuman(manifest, room) {
  const row = Object.values(manifest.residents).find((r) => r.harness === "agora" && r.rooms[0] === room);
  if (!row) return null;
  for (let i = 0; i < row.args.length; i++) {
    const a = row.args[i];
    if (a === "--human-name" && i + 1 < row.args.length) return row.args[i + 1];
    if (a.startsWith("--human-name=")) return a.slice("--human-name=".length);
  }
  return null;
}

/**
 * A position's supervisor restarts, as the ledger has them: the hold standing now (a `held` record
 * that no start by hand has followed: a run record started after it) and the restarts inside the
 * window since the last hold.
 * @param {any[]} events @param {string} position @param {number} now @param {{ starts: number, withinSeconds: number }} limit
 * @param {{ startedAt?: unknown } | null} run
 */
export function restartRecord(events, position, now, limit, run) {
  const runAt = run && typeof run.startedAt === "string" ? Date.parse(run.startedAt) : NaN;
  /** @type {number | null} */
  let heldAt = null;
  for (const e of events) if (e.ev === "held" && e.position === position && typeof e.at === "string") heldAt = Date.parse(e.at);
  const from = Math.max(now - limit.withinSeconds * 1000, heldAt ?? -Infinity);
  const starts = events.filter((e) => e.ev === "start" && e.position === position && e.path === "restart" && Date.parse(e.at) > from);
  return { held: heldAt !== null && !(runAt > heldAt), starts: starts.length, firstAt: starts.length ? Date.parse(starts[0].at) : null };
}

/**
 * The supervisor's pass, under the grants lock. Returns one row per act or standing fact.
 *
 * A standing row whose run record is left and whose host is gone died (a reboot, a crash): it is
 * started again, as a messenger row always was. A row with no run record was stopped by hand, or
 * never started here, and is left. A start goes through the gates in order: the seat service its
 * rooms need answers (a dark service starts nothing and is said once per episode, never spent as a
 * start); its host is up (Tern is brought up first); the position has not been started
 * `restartLimit.starts` times within the window (past it the host human is told once, by an N8 line
 * addressed to them, and starts stop until a start by hand). Starts in one pass are `staggerSeconds`
 * apart.
 * @param {Manifest} manifest @param {string} stateRoot @param {EnsureDeps} deps
 * @param {{ graceSeconds?: number, dryRun?: boolean, staggerSeconds?: number, restartLimit?: { starts?: number, withinSeconds?: number } }} [opts]
 */
export async function ensure(manifest, stateRoot, deps, opts = {}) {
  const grace = (opts.graceSeconds ?? DEFAULT_STOP_GRACE_SECONDS) * 1000;
  const limit = { ...RESTART_LIMIT, ...(opts.restartLimit ?? {}) };
  const staggerMs = (opts.staggerSeconds ?? DEFAULT_STAGGER_SECONDS) * 1000;
  const dryRun = Boolean(opts.dryRun);
  return withGrantsLock(stateRoot, async () => {
    /** @type {Record<string, unknown>[]} */
    const rows = [];
    const now = deps.now();
    const at = new Date(now).toISOString();
    const events = await readLedger(stateRoot);
    /** @param {Record<string, unknown>} ev */
    const record = async (ev) => { if (!dryRun) await appendLedger(stateRoot, { at, ...ev }); };
    /** @param {string} room @param {Record<string, string>} fields @param {string | null} [to] */
    const notice = async (room, fields, to = null) => {
      const text = formatNotice("N8", fields);
      // a record line owes no disposition; the trailer is also what lets the line be read back as N8
      const trailers = [...(to ? [{ key: "to", value: to }] : []), { key: "ack", value: "none" }];
      try { const r = await deps.post(room, withTrailers(text, trailers)); return { notice: text, room, posted: r?.id ?? null }; }
      catch (e) { return { notice: text, room, posted: null, postError: e instanceof Error ? e.message : String(e) }; }
    };
    const base = (/** @type {string} */ position, /** @type {string | null} */ id) => ({ type: "resident-ensure", position, ...(id ? { want: id } : {}) });
    /** @param {unknown} e */
    const msg = (e) => (e instanceof Error ? e.message : String(e));

    // ---- the gates every start passes ----
    const lastService = [...events].reverse().find((e) => e.ev === "dark" || e.ev === "light");
    let darkOpen = lastService?.ev === "dark";
    /** @type {string[]} */
    const dark = [];
    /** @type {string | null} */
    let darkReason = null;
    /** @type {Map<string, Promise<{ up: boolean, started: boolean, reason: string | null }>>} */
    const hosts = new Map();
    let ternStartedNoted = false;
    let starts = 0;
    const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
    /**
     * Whether a start of `pos` may go now: null when it may, else what stops it (`dark`: the pass
     * says so once for every such position; `host`: the start fails by name).
     * @param {string} pos @param {ManifestResident} row
     * @returns {Promise<{ dark: true } | { host: string } | null>}
     */
    const gate = async (pos, row) => {
      const svc = deps.service ? await deps.service(row) : { up: true, reason: null };
      if (!svc.up) { dark.push(pos); darkReason ??= svc.reason; return { dark: true }; }
      if (darkOpen) { await record({ ev: "light" }); darkOpen = false; }
      if (deps.host) {
        if (!hosts.has(row.host)) hosts.set(row.host, deps.host(row.host, { dryRun }));
        const h = await /** @type {Promise<{ up: boolean, started: boolean, reason: string | null }>} */ (hosts.get(row.host));
        if (!h.up) return { host: h.reason ?? `its host ${row.host} is not up` };
      }
      return null;
    };
    const pace = async () => { if (starts++ > 0 && staggerMs > 0) await sleep(staggerMs); };
    const ternNote = async (/** @type {ManifestResident} */ row) => {
      if (row.host !== "tern" || ternStartedNoted || !hosts.has("tern")) return {};
      if (!(await /** @type {Promise<{ started: boolean }>} */ (hosts.get("tern"))).started) return {};
      ternStartedNoted = true;
      return { host: "tern started" };
    };
    /**
     * The restart limit for a supervisor restart: null when a start may go, else the held row
     * (the host human told once, when the hold is new).
     * @param {string} pos @param {ManifestResident} row @param {any} run @param {string | null} id
     */
    const holdOf = async (pos, row, run, id) => {
      const rec = restartRecord(events, pos, now, limit, run);
      const reason = `restart limit: ${limit.starts} starts in ${formatAge(limit.withinSeconds * 1000)}; a start by hand (agora resident start ${pos}) clears it`;
      if (rec.held) return { ...base(pos, id), action: "held", reason };
      if (rec.starts < limit.starts) return null;
      if (dryRun) return { ...base(pos, id), action: "would-hold", reason };
      await record({ ev: "held", position: pos, starts: rec.starts, within: limit.withinSeconds });
      const n = await notice(row.rooms[0], { position: pos, verdict: "absent", attestor: "host", age: formatAge(Math.max(0, now - (rec.firstAt ?? now))), path: "restart", outcome: "held" }, hostHuman(manifest, row.rooms[0]));
      return { ...base(pos, id), action: "held", reason, ...n };
    };

    for (const w of openWants(foldLedger(events))) {
      const pos = w.want.position;
      const id = w.want.id;
      let ending = wantEnding(w, manifest, now);
      /** @type {ManifestResident | null} */
      let row = null;
      try { row = grantedRow(manifest, w.want); } catch (e) { ending ??= { why: "revoked", by: "manifest", at: null }; rows.push({ ...base(pos, id), note: msg(e) }); }
      const started = w.starts.some((s) => s.outcome === "started");
      const st = await deps.state(pos);

      if (!ending && row) {
        if (st.running) { rows.push({ ...base(pos, id), action: "running", reason: st.reason }); continue; }
        if (started && !st.run && !(await deps.marker(pos))) {
          // no run record and no successor pending: the operator stopped it by hand, and the want ends
          await record({ ev: "end", id, position: pos, why: "stopped" });
          rows.push({ ...base(pos, id), action: "ended", reason: "stopped by hand (no run record): the want ends" });
          continue;
        }
        const path_ = started ? "restart" : "grant";
        const held = started ? await holdOf(pos, row, st.run, id) : null;
        if (held) { rows.push(held); continue; }
        const g = await gate(pos, row);
        if (g && "dark" in g) continue;
        if (dryRun) { rows.push({ ...base(pos, id), action: started ? "would-restart" : "would-start", ...(g ? { reason: g.host } : {}) }); continue; }
        /** @type {{ action: string, reason?: unknown }} */
        let r;
        if (g) r = { action: "failed", reason: g.host };
        else {
          await pace();
          try { r = await deps.start(pos, row); } catch (e) { r = { action: "failed", reason: msg(e) }; }
        }
        if (r.action === "running") { rows.push({ ...base(pos, id), action: "running", reason: r.reason }); continue; }
        const outcome = r.action === "started" ? "started" : "failed";
        await record({ ev: "start", id, position: pos, path: path_, outcome, ...(r.reason ? { reason: String(r.reason) } : {}) });
        const n = await notice(row.rooms[0], { position: pos, verdict: started ? "absent" : "wanted", attestor: started ? "host" : w.want.by,
          age: formatAge(started ? 0 : now - Date.parse(w.want.at)), path: path_, outcome });
        rows.push({ ...base(pos, id), action: outcome === "started" ? (started ? "restarted" : "started") : "failed", ...(r.reason ? { reason: String(r.reason) } : {}), ...(await ternNote(row)), ...n });
        continue;
      }

      const end = /** @type {Ending} */ (ending);
      if (!w.ending && !w.unwant) await record({ ev: "ending", id, position: pos, why: end.why, by: end.by });
      const endedAt = end.at ? Date.parse(end.at) : w.ending ? Date.parse(w.ending.at) : now;
      if (!st.running) {
        if (st.run && !dryRun) await deps.stop(pos).catch(() => {}); // a dead host's leftovers
        await record({ ev: "end", id, position: pos, why: end.why });
        rows.push({ ...base(pos, id), action: dryRun ? "would-end" : "ended", reason: `${end.why}; nothing runs at the position` });
        continue;
      }
      const turn = await deps.turn(pos);
      const quiet = turn.status === "read" ? now - Date.parse(turn.at) : 0;
      const idle = turn.status === "none" || (turn.status === "read" && turn.turnEnded && quiet >= grace);
      if (!idle) {
        const why = turn.status === "unsupported" ? `its turn cannot be read (${turn.reason})` : turn.status === "read" && !turn.turnEnded ? "a turn is running" : `its turn ended ${formatAge(quiet)} ago, within the ${formatAge(grace)} grace`;
        rows.push({ ...base(pos, id), action: "held", reason: `${end.why}; stops at its next idle: ${why}` });
        continue;
      }
      if (dryRun) { rows.push({ ...base(pos, id), action: "would-stop", reason: end.why }); continue; }
      /** @type {{ action: string, reason?: unknown }} */
      let r;
      try { r = await deps.stop(pos); } catch (e) { r = { action: "failed", reason: msg(e) }; }
      const outcome = r.action === "stopped" || r.action === "not-running" ? "stopped" : "failed";
      await record({ ev: "stop", id, position: pos, why: end.why, outcome, ...(r.reason ? { reason: String(r.reason) } : {}) });
      if (outcome === "stopped") await record({ ev: "end", id, position: pos, why: end.why });
      const n = await notice(row ? row.rooms[0] : String(manifest.residents[w.want.grant]?.rooms[0] ?? ""), { position: pos, verdict: end.why, attestor: end.by,
        age: formatAge(Math.max(0, now - endedAt)), path: "grant", outcome });
      rows.push({ ...base(pos, id), action: outcome, ...(r.reason ? { reason: String(r.reason) } : {}), ...n });
    }

    // a standing row (the messenger's included) whose host died: start it again. One with no run
    // record was stopped by its operator, or never started here, and is left.
    for (const row of Object.values(manifest.residents)) {
      if (row.tenure !== "standing") continue;
      let st = await deps.state(row.slug);
      if (!st.run) continue;
      // a Tern host that does not answer cannot say whether its session runs: it is brought up, then asked again
      const unread = st.running && st.host === "unknown" && row.host === "tern";
      if (st.running && !unread) continue;
      const held = await holdOf(row.slug, row, st.run, null);
      if (held) { rows.push(held); continue; }
      const g = await gate(row.slug, row);
      if (g && "dark" in g) continue;
      if (!g && unread) { st = await deps.state(row.slug); if (st.running) continue; }
      if (dryRun) { rows.push({ ...base(row.slug, null), action: "would-restart", reason: g ? g.host : "its host is gone" }); continue; }
      /** @type {{ action: string, reason?: unknown }} */
      let r;
      if (g) r = { action: "failed", reason: g.host };
      else {
        await pace();
        try { r = await deps.start(row.slug, row); } catch (e) { r = { action: "failed", reason: msg(e) }; }
      }
      if (r.action === "running") continue;
      const outcome = r.action === "started" ? "started" : "failed";
      await record({ ev: "start", position: row.slug, path: "restart", outcome, ...(r.reason ? { reason: String(r.reason) } : {}) });
      const n = await notice(row.rooms[0], { position: row.slug, verdict: "absent", attestor: "host", age: "0s", path: "restart", outcome });
      rows.push({ ...base(row.slug, null), action: outcome === "started" ? "restarted" : "failed", ...(r.reason ? { reason: String(r.reason) } : {}), ...(await ternNote(row)), ...n });
    }

    // a dark seat service: nothing was started into it, said once for the episode
    if (dark.length && !darkOpen) {
      await record({ ev: "dark", positions: dark, reason: darkReason });
      rows.push({ type: "resident-ensure", position: "seat service", action: "dark", positions: dark,
        reason: `the seat service is dark (${darkReason ?? "no answer"}): nothing started for ${dark.join(", ")}; the first pass after it answers starts them` });
    }
    return rows;
  });
}

/**
 * The seat's own acts for `ensure`: start through the host the row names (never `none`, which has
 * no handle a supervisor can start into), stop by the recorded handle, the turn from the harness
 * transcript. `post` is the caller's: it signs and places the N8 line. `service` connects to this
 * seat's service once per pass when a row's rooms include a room it hosts (a native room); `host`
 * brings Tern up (`ensureTern`) or finds tmux.
 * @param {{ manifest: Manifest, ctx: import("./resident-start.mjs").PlanContext, post: EnsureDeps['post'], home?: string,
 *   run?: import("./resident-start.mjs").Runner, now?: () => number, launch?: (argv: string[]) => Promise<string | null>, sleep?: (ms: number) => Promise<void>,
 *   connect?: typeof connectSeatService }} a
 * @returns {EnsureDeps}
 */
export function seatEnsureDeps(a) {
  const stateRoot = a.ctx.stateRoot;
  /** @type {Promise<{ up: boolean, reason: string | null }> | null} */
  let serviceProbe = null;
  const probeService = async () => {
    try {
      const { client } = await (a.connect ?? connectSeatService)(stateRoot, { timeoutMs: 5000 });
      client.close();
      return { up: true, reason: null };
    } catch (e) { return { up: false, reason: e instanceof Error ? e.message : String(e) }; }
  };
  const hostDeps = { env: a.ctx.env, platform: a.ctx.platform, exists: a.ctx.exists, run: a.run, launch: a.launch, sleep: a.sleep };
  return {
    start: async (position, row) => {
      // the plan sees every open want as a row, so a granted slot's lineage is checked against the others
      const granted = withGranted(a.manifest, foldLedger(await readLedger(stateRoot)));
      const plan = planResident({ ...granted, residents: { ...granted.residents, [position]: row } }, position, a.ctx);
      if (plan.host === "none") return { action: "failed", reason: `${position} is on host none: a supervisor has no handle to start it into` };
      const { row: started } = await startResident(plan, stateRoot, { checkout: a.ctx.checkout, home: a.home, run: a.run });
      return { ...started, action: String(started.action) };
    },
    stop: (position) => stopResident(stateRoot, position, { run: a.run }),
    state: (position) => residentState(stateRoot, position, { run: a.run }),
    marker: async (position) => (await readInheritMarker(stateRoot, position)) !== null,
    turn: (position) => positionTurn(stateRoot, position, { home: a.home }),
    post: a.post,
    now: a.now ?? (() => Date.now()),
    service: async (row) => {
      // a room this seat hosts is served by this seat's service; another transport needs none
      const hosted = row.rooms.some((r) => /** @type {any} */ (a.ctx.cfg.rooms ?? {})[r]?.transport === "native");
      if (!hosted) return { up: true, reason: null };
      return (serviceProbe ??= probeService());
    },
    host: async (kind, opts) => {
      if (kind === "tern") return ensureTern({ ...hostDeps, dryRun: opts.dryRun });
      if (kind === "tmux") return which("tmux", hostDeps) ? { up: true, started: false, reason: null } : { up: false, started: false, reason: "tmux is not on PATH" };
      return { up: true, started: false, reason: null };
    },
    ...(a.sleep ? { sleep: a.sleep } : {}),
  };
}

/**
 * The Room subject: the pinned, titled root room business is posted under (the earliest pinned
 * root when none is titled). Null when the room pins none; the line then goes top level.
 * @param {any[]} messages @param {any[]} annotations @returns {string | null}
 */
export function roomSubject(messages, annotations) {
  const { titles, pinned } = annotationState(annotations);
  return roomSubjectRoot(messages, titles, pinned);
}

/**
 * The grants as they stand: per holder its caps and its open wants with where each stands.
 * @param {Manifest} manifest @param {Map<string, WantState>} fold @param {number} now
 */
export function grantView(manifest, fold, now) {
  return Object.values(manifest.grants).map((g) => ({
    type: "resident-grant-view", holder: g.holder, room: g.room, roles: g.roles, models: g.models, maxLive: g.maxLive, maxHours: g.maxHours, card: g.card,
    wants: openWants(fold).filter((w) => w.want.grant === g.holder).map((w) => {
      const e = wantEnding(w, manifest, now);
      return { id: w.want.id, position: w.want.position, role: w.want.role, model: w.want.model, at: w.want.at, until: w.want.until, because: w.want.because,
        started: w.starts.some((s) => s.outcome === "started"), state: e ? `ending: ${e.why}` : "open" };
    }),
  }));
}
