// @ts-check
/**
 * Grants: a position the operator named in the manifest (`grants["<room>.orchestrator"]`) stands
 * residents up within the caps written there, and the seat's supervisor keeps every start and stop
 * on the record.
 *
 *   want     admission. The holder asks for `<room>.<role>`; the want is refused by name past
 *            `maxLive`, for a model outside `models`, for a role outside `roles` (when it is a list),
 *            for a new role with no card, or when every slot of the role is held. A row's slots are
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
import { fileLock, formatAge, formatNotice } from "./messenger.mjs";
import { positionTurn, readInheritMarker, RESIDENT_SLUG_RE } from "./resident.mjs";
import { manifestRow, planResident, residentState, startResident, stopResident } from "./resident-start.mjs";
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
 * Admit or refuse one want. Pure but for `held` (is a slot's position running?) and the card files'
 * existence.
 * @param {{ manifest: Manifest, fold: Map<string, WantState>, requester: string | undefined, requesterRefusal?: string, session?: string | null,
 *   position: string, model?: string, cards?: string[], hours?: number, because: string, now: number, held: (slot: string) => Promise<boolean> }} a
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
 * @param {Omit<Parameters<typeof admitWant>[0], 'manifest' | 'fold' | 'held'> & { dryRun?: boolean }} a @param {{ held: (slot: string) => Promise<boolean> }} deps
 */
export async function recordWant(manifest, stateRoot, a, deps) {
  return withGrantsLock(stateRoot, async () => {
    const fold = foldLedger(await readLedger(stateRoot));
    const r = await admitWant({ ...a, manifest, fold, held: deps.held });
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

/**
 * @typedef {{
 *   start: (position: string, row: ManifestResident) => Promise<{ action: string, reason?: unknown }>,
 *   stop: (position: string) => Promise<{ action: string, reason?: unknown }>,
 *   state: (position: string) => Promise<{ running: boolean, run: unknown, reason: string | null }>,
 *   marker: (position: string) => Promise<boolean>,
 *   turn: (position: string) => ReturnType<typeof positionTurn>,
 *   post: (room: string, text: string) => Promise<{ id: string } | null>,
 *   now: () => number,
 * }} EnsureDeps
 */

/**
 * The supervisor's pass, under the grants lock. Returns one row per act or standing fact.
 * @param {Manifest} manifest @param {string} stateRoot @param {EnsureDeps} deps
 * @param {{ graceSeconds?: number, dryRun?: boolean }} [opts]
 */
export async function ensure(manifest, stateRoot, deps, opts = {}) {
  const grace = (opts.graceSeconds ?? DEFAULT_STOP_GRACE_SECONDS) * 1000;
  return withGrantsLock(stateRoot, async () => {
    /** @type {Record<string, unknown>[]} */
    const rows = [];
    const now = deps.now();
    const at = new Date(now).toISOString();
    /** @param {Record<string, unknown>} ev */
    const record = async (ev) => { if (!opts.dryRun) await appendLedger(stateRoot, { at, ...ev }); };
    /** @param {string} room @param {Record<string, string>} fields */
    const notice = async (room, fields) => {
      const text = formatNotice("N8", fields);
      // a record line owes no disposition; the trailer is also what lets the line be read back as N8
      try { const r = await deps.post(room, withTrailers(text, [{ key: "ack", value: "none" }])); return { notice: text, room, posted: r?.id ?? null }; }
      catch (e) { return { notice: text, room, posted: null, postError: e instanceof Error ? e.message : String(e) }; }
    };
    const base = (/** @type {string} */ position, /** @type {string | null} */ id) => ({ type: "resident-ensure", position, ...(id ? { want: id } : {}) });
    /** @param {unknown} e */
    const msg = (e) => (e instanceof Error ? e.message : String(e));

    for (const w of openWants(foldLedger(await readLedger(stateRoot)))) {
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
        if (opts.dryRun) { rows.push({ ...base(pos, id), action: started ? "would-restart" : "would-start" }); continue; }
        /** @type {{ action: string, reason?: unknown }} */
        let r;
        try { r = await deps.start(pos, row); } catch (e) { r = { action: "failed", reason: msg(e) }; }
        if (r.action === "running") { rows.push({ ...base(pos, id), action: "running", reason: r.reason }); continue; }
        const outcome = r.action === "started" ? "started" : "failed";
        await record({ ev: "start", id, position: pos, path: path_, outcome, ...(r.reason ? { reason: String(r.reason) } : {}) });
        const n = await notice(row.rooms[0], { position: pos, verdict: started ? "absent" : "wanted", attestor: started ? "host" : w.want.by,
          age: formatAge(started ? 0 : now - Date.parse(w.want.at)), path: path_, outcome });
        rows.push({ ...base(pos, id), action: outcome === "started" ? (started ? "restarted" : "started") : "failed", ...(r.reason ? { reason: String(r.reason) } : {}), ...n });
        continue;
      }

      const end = /** @type {Ending} */ (ending);
      if (!w.ending && !w.unwant) await record({ ev: "ending", id, position: pos, why: end.why, by: end.by });
      const endedAt = end.at ? Date.parse(end.at) : w.ending ? Date.parse(w.ending.at) : now;
      if (!st.running) {
        if (st.run && !opts.dryRun) await deps.stop(pos).catch(() => {}); // a dead host's leftovers
        await record({ ev: "end", id, position: pos, why: end.why });
        rows.push({ ...base(pos, id), action: opts.dryRun ? "would-end" : "ended", reason: `${end.why}; nothing runs at the position` });
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
      if (opts.dryRun) { rows.push({ ...base(pos, id), action: "would-stop", reason: end.why }); continue; }
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

    // a messenger row whose host died: restart it. One with no run record was stopped by its operator.
    for (const row of Object.values(manifest.residents)) {
      if (row.harness !== "agora") continue;
      const st = await deps.state(row.slug);
      if (st.running || !st.run) continue;
      if (opts.dryRun) { rows.push({ ...base(row.slug, null), action: "would-restart", reason: "its host is gone" }); continue; }
      /** @type {{ action: string, reason?: unknown }} */
      let r;
      try { r = await deps.start(row.slug, row); } catch (e) { r = { action: "failed", reason: msg(e) }; }
      if (r.action === "running") continue;
      const outcome = r.action === "started" ? "started" : "failed";
      await record({ ev: "start", position: row.slug, path: "restart", outcome, ...(r.reason ? { reason: String(r.reason) } : {}) });
      const n = await notice(row.rooms[0], { position: row.slug, verdict: "absent", attestor: "host", age: "0s", path: "restart", outcome });
      rows.push({ ...base(row.slug, null), action: outcome === "started" ? "restarted" : "failed", ...(r.reason ? { reason: String(r.reason) } : {}), ...n });
    }
    return rows;
  });
}

/**
 * The seat's own acts for `ensure`: start through the host the row names (never `none`, which has
 * no handle a supervisor can start into), stop by the recorded handle, the turn from the harness
 * transcript. `post` is the caller's: it signs and places the N8 line.
 * @param {{ manifest: Manifest, ctx: import("./resident-start.mjs").PlanContext, post: EnsureDeps['post'], home?: string,
 *   run?: import("./resident-start.mjs").Runner, now?: () => number }} a
 * @returns {EnsureDeps}
 */
export function seatEnsureDeps(a) {
  const stateRoot = a.ctx.stateRoot;
  return {
    start: async (position, row) => {
      const plan = planResident({ ...a.manifest, residents: { ...a.manifest.residents, [position]: row } }, position, a.ctx);
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
  };
}

/**
 * The Room subject: the pinned, titled root room business is posted under (the earliest pinned
 * root when none is titled). Null when the room pins none; the line then goes top level.
 * @param {any[]} messages @param {any[]} annotations @returns {string | null}
 */
export function roomSubject(messages, annotations) {
  const pinned = new Set();
  const titled = new Set();
  for (const a of annotations) {
    if (a?.act === "pin") pinned.add(String(a.target));
    else if (a?.act === "unpin") pinned.delete(String(a.target));
    else if (a?.act === "title") titled.add(String(a.target));
  }
  const roots = messages.filter((m) => !m.thread && pinned.has(String(m.id)));
  const pick = roots.find((m) => titled.has(String(m.id))) ?? roots[0];
  return pick ? String(pick.id) : null;
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
