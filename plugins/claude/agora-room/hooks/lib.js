// @ts-check
// Plain helpers for the agora-room Claude Code mod. Nothing here touches the mods API object (`$`):
// a hooks module may not bind, pass or store `$`, so everything that needs it lives in register.js
// and everything that can be decided from data lives here, where `node --test` reaches it.

export const PLUGIN = "agora-room";
export const TOOL_NAME = "room_post";
export const TOOL_FULL = `mcp__${PLUGIN}__${TOOL_NAME}`;
export const PANE_ID = "agora-room";
export const COMMAND = "agora-room";

export const WAKE_MODES = Object.freeze(["all", "addressed", "mine"]);
export const DEFAULT_WAKE = "addressed";
export const DEFAULT_INTERVAL_MS = 2000;
export const MIN_INTERVAL_MS = 500;
export const MAX_INTERVAL_MS = 600000;
export const MAX_POST_CHARS = 20000;
export const DELIVERED_KEEP = 500;

/** A session key is one safe directory name (src/session.mjs SESSION_RE). */
export const SESSION_RE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,64}$/;
const ROOM_RE = /^[A-Za-z0-9][^\s\u0000-\u001f]{0,127}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ADDR_RE = /^(?:\*|[A-Za-z0-9][A-Za-z0-9._/@*-]{0,63})$/;

/** @typedef {{ room: string, id: string, thread: string | null, from: string, text: string, cursor: string | null, ts: string | null, to: string[], title: string | null, signedAs: string | null }} Msg */

// ---- configuration ----

/** @param {unknown} v @returns {string[]} */
export function parseList(v) {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,]+/) : [];
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}

/** @param {unknown} v @returns {boolean | undefined} true = on, false = off, undefined = not said */
export function parseSwitch(v) {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim().toLowerCase();
  if (["off", "0", "false", "no", "disabled"].includes(s)) return false;
  if (["on", "1", "true", "yes", "enabled"].includes(s)) return true;
  return undefined;
}

/** An argv prefix from a JSON array text, an array, or one executable path. @param {unknown} v @returns {string[] | undefined} */
export function parseCommand(v) {
  if (Array.isArray(v)) {
    const a = v.map(String).filter(Boolean);
    return a.length ? a : undefined;
  }
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  if (s.startsWith("[")) {
    try {
      const a = JSON.parse(s);
      if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string" && x)) return a;
    } catch { /* fall through: not JSON, treat as a path */ }
  }
  return [s];
}

/**
 * Precedence, highest first: environment, the project file (.agora-room.json in the session's
 * folder), the plugin's userConfig values, the defaults. Each field is taken whole from the first
 * layer that sets it.
 * @param {{ env?: Record<string, string | undefined>, file?: Record<string, any> | null, options?: Record<string, any> | null, sessionId?: string | null }} layers
 */
export function resolveConfig({ env = {}, file = null, options = null, sessionId = null }) {
  const f = file ?? {};
  const o = options ?? {};
  /** @type {string[]} */
  const problems = [];
  /** @param {unknown} v */
  const set = (v) => v !== undefined && v !== null && !(typeof v === "string" && !v.trim());
  /** @param {unknown[]} vs */
  const first = (...vs) => vs.find(set);

  const rooms = parseList(first(env.AGORA_ROOM, f.rooms, f.room, o.rooms));
  for (const r of rooms) if (!ROOM_RE.test(r)) problems.push(`room ${JSON.stringify(r)} is not a room alias`);
  const badRooms = rooms.filter((r) => !ROOM_RE.test(r));

  const fallbackKey = `claude-${String(sessionId ?? "session").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 8) || "session"}`;
  let session = String(first(env.AGORA_SESSION, f.session, o.session) ?? fallbackKey);
  if (!SESSION_RE.test(session)) {
    problems.push(`session key ${JSON.stringify(session)} does not match ${SESSION_RE}; using ${fallbackKey}`);
    session = fallbackKey;
  }

  let wake = String(first(env.AGORA_ROOM_WAKE, f.wake, o.wake) ?? DEFAULT_WAKE);
  if (!WAKE_MODES.includes(wake)) {
    problems.push(`wake ${JSON.stringify(wake)} is not one of ${WAKE_MODES.join("|")}; using ${DEFAULT_WAKE}`);
    wake = DEFAULT_WAKE;
  }

  let intervalMs = Number(first(env.AGORA_ROOM_INTERVAL_MS, f.intervalMs, o.interval_ms) ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(intervalMs)) intervalMs = DEFAULT_INTERVAL_MS;
  intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(intervalMs)));

  const command = parseCommand(first(env.AGORA_ROOM_CMD, f.command, o.agora_command)) ?? ["agora"];
  const watchSwitch = parseSwitch(first(env.AGORA_ROOM_WATCH, f.watch));
  const actor = first(env.AGORA_ACTOR, f.actor, o.actor);
  const paneAs = first(env.AGORA_ROOM_PANE_AS, f.paneAs, o.pane_as);
  const liveness = first(env.AGORA_ROOM_LIVENESS, f.liveness);
  /** @type {Record<string, string>} */
  const childEnv = {};
  if (f.env && typeof f.env === "object") for (const [k, v] of Object.entries(f.env)) if (typeof v === "string") childEnv[k] = v;

  return {
    rooms: rooms.filter((r) => !badRooms.includes(r)),
    session,
    wake,
    intervalMs,
    command,
    watchEnabled: watchSwitch !== false,
    actor: actor === undefined ? null : String(actor),
    paneAs: paneAs === undefined ? null : String(paneAs),
    liveness: liveness === undefined ? null : String(liveness),
    childEnv,
    problems,
  };
}

/** The key the pane posts under, so a post addressed to this session still wakes its watch. @param {string} session */
export function paneSessionKey(session) {
  return `${session.slice(0, 57)}-pane`;
}

/** The environment given to every agora child. @param {{ session: string, actor: string | null, childEnv: Record<string, string> }} cfg @param {{ pane?: boolean, as?: string | null }} [opts] */
export function childEnvFor(cfg, opts = {}) {
  /** @type {Record<string, string>} */
  const env = { ...cfg.childEnv, AGORA_SESSION: opts.pane ? paneSessionKey(cfg.session) : cfg.session };
  const who = opts.pane ? opts.as ?? cfg.actor : cfg.actor;
  if (who) env.AGORA_ACTOR = who;
  return env;
}

// ---- the CLI's output ----

/** @param {any} j @param {string} room @returns {Msg | null} */
export function normaliseMessage(j, room) {
  if (!j || j.type !== "message" || !j.id) return null;
  const titleText = typeof j.title === "string" ? j.title : typeof j.title?.text === "string" ? j.title.text : null;
  return {
    room,
    id: String(j.id),
    thread: j.thread ?? j.threadId ?? null,
    from: String(j.author?.name ?? j.signedAs ?? "unknown"),
    text: typeof j.text === "string" ? j.text : "",
    cursor: j.cursor ?? null,
    ts: j.ts ?? null,
    to: Array.isArray(j.to) ? j.to.map(String) : [],
    title: titleText,
    signedAs: j.signedAs ?? null,
  };
}

/** The `{...}` lines of a --json run, parsed; a line that does not parse is skipped. @param {string} stdout @returns {any[]} */
export function jsonLines(stdout) {
  /** @type {any[]} */
  const out = [];
  for (const l of String(stdout).split("\n")) {
    const s = l.trim();
    if (!s.startsWith("{")) continue;
    try { out.push(JSON.parse(s)); } catch { /* a partial line from a killed child */ }
  }
  return out;
}

/** What `agora watch --once --json` printed: the messages, and the closing watch-result line. @param {string} stdout @param {string} room */
export function parseWatchOutput(stdout, room) {
  const lines = jsonLines(stdout);
  /** @type {Msg[]} */
  const messages = [];
  let result = null;
  for (const j of lines) {
    if (j.type === "watch-result") result = j;
    else {
      const m = normaliseMessage(j, room);
      if (m) messages.push(m);
    }
  }
  return { messages, result };
}

/** @param {string} stdout @param {string} room @returns {Msg[]} */
export function parseReadOutput(stdout, room) {
  const out = [];
  for (const j of jsonLines(stdout)) {
    const m = normaliseMessage(j, room);
    if (m) out.push(m);
  }
  return out;
}

// ---- what the session reads ----

/** The one line a delivered message becomes. @param {Pick<Msg, 'room' | 'id' | 'thread' | 'from' | 'text'>} m */
export function formatLine(m) {
  const text = String(m.text).replace(/\r?\n+/g, " / ");
  return `agora ${m.room} ${m.id} thread=${m.thread ?? "none"} from=${m.from}: ${text}`;
}

// ---- the delivery queue ----

/**
 * Messages read and not yet handed to the session, plus the ids already handed over, so that a
 * message is submitted at most once whatever re-reads happen. Pure data; register.js persists it.
 */
export class DeliveryQueue {
  /** @param {{ queue?: any[], delivered?: string[], deliveredCount?: number, droppedCount?: number } | null} [snap] */
  constructor(snap = null) {
    /** @type {Array<Msg & { maybeSent?: boolean }>} */
    this.queue = Array.isArray(snap?.queue) ? snap.queue.filter((m) => m && m.id && m.room) : [];
    /** @type {string[]} */
    this.delivered = Array.isArray(snap?.delivered) ? snap.delivered.map(String) : [];
    this.deliveredCount = Number(snap?.deliveredCount) || 0;
    this.droppedCount = Number(snap?.droppedCount) || 0;
  }

  /** @param {Pick<Msg, 'room' | 'id'>} m */
  static keyOf(m) { return `${m.room} ${m.id}`; }

  /** @param {Msg} m @returns {boolean} true when queued, false when it was already seen */
  add(m) {
    const k = DeliveryQueue.keyOf(m);
    if (this.delivered.includes(k) || this.queue.some((q) => DeliveryQueue.keyOf(q) === k)) return false;
    this.queue.push(m);
    return true;
  }

  /** @returns {(Msg & { maybeSent?: boolean }) | null} */
  head() { return this.queue[0] ?? null; }

  /** @param {Pick<Msg, 'room' | 'id'>} m */
  markDelivered(m) {
    const k = DeliveryQueue.keyOf(m);
    this.queue = this.queue.filter((q) => DeliveryQueue.keyOf(q) !== k);
    this.delivered.push(k);
    if (this.delivered.length > DELIVERED_KEEP) this.delivered.splice(0, this.delivered.length - DELIVERED_KEEP);
    this.deliveredCount += 1;
  }

  /** @param {Pick<Msg, 'room' | 'id'>} m */
  drop(m) {
    const k = DeliveryQueue.keyOf(m);
    this.queue = this.queue.filter((q) => DeliveryQueue.keyOf(q) !== k);
    this.droppedCount += 1;
  }

  snapshot() {
    return { queue: this.queue, delivered: this.delivered, deliveredCount: this.deliveredCount, droppedCount: this.droppedCount };
  }
}

/** The refusal reasons that mean the user stopped a turn: park the queue until the turn is over. */
export const STOPPED_REASONS = Object.freeze([
  "the session was stopped and nobody has sent input since",
  "was removed from the queue before it ran",
]);

/** @param {string} reason */
export const isStopReason = (reason) => STOPPED_REASONS.some((s) => reason.includes(s));

// ---- the status line ----

/** @param {string | number | Date | null} t @param {number} now @returns {string} */
export function ago(t, now) {
  const ms = t === null ? NaN : typeof t === "number" ? t : new Date(t).getTime();
  if (!Number.isFinite(ms)) return "?";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** `<room> · read Ns ago`, one per room. @param {Array<{ room: string, lastRead: string | null, failing: boolean }>} rooms @param {number} now */
export function statusLine(rooms, now) {
  return rooms
    .map((r) => `${r.room} · ${r.lastRead ? `read ${ago(r.lastRead, now)} ago` : "not read yet"}${r.failing ? " · last poll failed" : ""}`)
    .join(" · ");
}

// ---- posting ----

/**
 * The argv tail for one post. Every option comes before the `--` terminator and the text after it,
 * so text that starts with a dash is text and never an option.
 * @param {{ room: string, text: string, thread?: string | null, replyTo?: string | null, to?: string[] }} p
 * @returns {{ ok: true, args: string[] } | { ok: false, error: string }}
 */
export function postArgs({ room, text, thread = null, replyTo = null, to = [] }) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "text is empty" };
  if (text.length > MAX_POST_CHARS) return { ok: false, error: `text is ${text.length} characters; the most one post carries here is ${MAX_POST_CHARS}` };
  if (thread && !ID_RE.test(thread)) return { ok: false, error: `thread ${JSON.stringify(thread)} is not a message id` };
  if (replyTo && !ID_RE.test(replyTo)) return { ok: false, error: `reply_to ${JSON.stringify(replyTo)} is not a message id` };
  for (const a of to) if (!ADDR_RE.test(a)) return { ok: false, error: `to ${JSON.stringify(a)} is not a bearer, a seat or *` };
  const args = ["post", room, "--json"];
  if (thread) args.push("--thread", thread);
  if (replyTo) args.push("--re", replyTo);
  for (const a of to) args.push("--to", a);
  args.push("--", text);
  return { ok: true, args };
}

/** Which configured room a post goes to. @param {string[]} rooms @param {unknown} asked @returns {{ ok: true, room: string } | { ok: false, error: string }} */
export function chooseRoom(rooms, asked) {
  if (!rooms.length) return { ok: false, error: "no room is configured for this session" };
  if (asked === undefined || asked === null || asked === "") {
    return rooms.length === 1 ? { ok: true, room: /** @type {string} */ (rooms[0]) } : { ok: false, error: `name the room: one of ${rooms.join(", ")}` };
  }
  const r = String(asked);
  return rooms.includes(r) ? { ok: true, room: r } : { ok: false, error: `room ${JSON.stringify(r)} is not configured for this session (${rooms.join(", ")})` };
}

/** What the model is told about the post receipt. @param {string} stdout */
export function receiptText(stdout) {
  const lines = jsonLines(stdout);
  const receipt = lines.find((j) => j.id && j.cursor !== undefined) ?? lines[0];
  return receipt ? JSON.stringify(receipt) : String(stdout).trim();
}

// ---- subjects and threads for the pane ----

/** The text without its trailing signature line. @param {Pick<Msg, 'text' | 'signedAs' | 'from'>} m */
export function bodyText(m) {
  const t = String(m.text).replace(/\s+$/, "");
  const name = m.signedAs ?? m.from;
  const sig = `\n\n-- ${name}`;
  return t.endsWith(sig) ? t.slice(0, -sig.length) : t;
}

/** One line to name a subject by. @param {Msg} m @param {number} [max] */
export function subjectTitle(m, max = 80) {
  const base = m.title ?? bodyText(m).split("\n").find((l) => l.trim()) ?? "(empty)";
  const one = base.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The room's subjects, newest activity first. A subject is a top-level message and the replies in
 * its thread. `seen` maps a subject id to the last message id the reader has seen in it;
 * `baselineId` is the newest message that existed the first time the pane was opened, so a first
 * open does not mark the whole room unread. A message the reader wrote is never unread.
 * @param {Msg[]} messages ascending @param {{ self?: string | null, seen?: Record<string, string>, baselineId?: string | null }} [opts]
 */
export function buildSubjects(messages, { self = null, seen = {}, baselineId = null } = {}) {
  /** @type {Map<string, Msg[]>} */
  const groups = new Map();
  const index = new Map(messages.map((m, i) => [m.id, i]));
  for (const m of messages) {
    const id = m.thread ?? m.id;
    const g = groups.get(id);
    if (g) g.push(m); else groups.set(id, [m]);
  }
  const baseIdx = baselineId !== null && index.has(baselineId) ? /** @type {number} */ (index.get(baselineId)) : -1;
  const subjects = [...groups.entries()].map(([id, msgs]) => {
    const root = msgs.find((m) => m.id === id) ?? msgs[0];
    const markId = seen[id];
    const markIdx = markId !== undefined && index.has(markId) ? /** @type {number} */ (index.get(markId)) : -1;
    const floor = Math.max(markIdx, baseIdx);
    const unread = msgs.filter((m) => /** @type {number} */ (index.get(m.id)) > floor && m.from !== self && m.signedAs !== self).length;
    const last = /** @type {Msg} */ (msgs[msgs.length - 1]);
    return {
      id,
      title: subjectTitle(/** @type {Msg} */ (root)),
      rootInWindow: msgs.some((m) => m.id === id),
      count: msgs.length,
      unread,
      latestId: last.id,
      latestTs: last.ts,
      lastIndex: /** @type {number} */ (index.get(last.id)),
      messages: msgs,
    };
  });
  subjects.sort((a, b) => b.lastIndex - a.lastIndex);
  return subjects;
}

/** Who has spoken, newest first, from the `who` rows. @param {any[]} lines @returns {Array<{ name: string, last: string | null, count: number }>} */
export function whoRows(lines) {
  return lines
    .filter((j) => j && j.type === "who" && j.name)
    .map((j) => ({ name: String(j.name), last: j.last ?? null, count: Number(j.count) || 0 }))
    .sort((a, b) => String(b.last ?? "").localeCompare(String(a.last ?? "")));
}

// ---- the pane ----

/** The value the "to:" selector holds for no one in particular. */
export const TO_NOBODY = "__nobody__";

/**
 * @typedef {{
 *   rooms: string[], room: string | null, loading: boolean, error: string | null,
 *   subjects: ReturnType<typeof buildSubjects>, thread: string | null, who: ReturnType<typeof whoRows>,
 *   to: string, now: number,
 * }} PaneModel
 * @typedef {{
 *   open(id: string): unknown, back(): unknown, newSubject(): unknown, setTo(v: string): unknown,
 *   setRoom(r: string): unknown, refresh(): unknown, submit(text: string): unknown,
 * }} PaneActions
 */

/** The line that names where a post would go. @param {PaneModel} m */
export function targetLine(m) {
  const subject = m.thread ? m.subjects.find((s) => s.id === m.thread) : null;
  const where = m.thread ? `reply in "${subject ? subject.title : m.thread}"` : "a new subject";
  const to = m.to === TO_NOBODY ? "no one in particular" : m.to === "*" ? "everyone (*)" : m.to;
  return `Post → room ${m.room ?? "?"} · ${where} · to: ${to}`;
}

/**
 * The pane's element tree. `els` is what `$.ui.resolve(e)` returned; only Box, Text, Button, Input
 * and Select are used, the five the reference marks as drawing in the terminal and the desktop app.
 * A surface that lacks Input or Select gets the same pane without that control, and says so.
 * @param {Record<string, any>} els @param {PaneModel} m @param {PaneActions} act
 */
export function paneTree(els, m, act) {
  const { Box, Text, Button, Input, Select } = els;
  if (!Box || !Text || !Button) return null;
  const col = (/** @type {any[]} */ children, /** @type {Record<string, any>} */ extra = {}) => Box({ flexDirection: "column", ...extra, children });
  const row = (/** @type {any[]} */ children) => Box({ flexDirection: "row", columnGap: 2, children });
  const dim = (/** @type {string} */ s) => Text({ dimColor: true, wrap: "truncate", children: [s] });

  /** @type {any[]} */
  const out = [];

  /** @type {any[]} */
  const head = [];
  if (m.rooms.length > 1) {
    for (const r of m.rooms) head.push(Button({ key: `room-${r}`, label: r === m.room ? `[${r}]` : r, plain: true, dimColor: r !== m.room, onPress: () => act.setRoom(r) }));
  } else head.push(Text({ weight: "semibold", children: [m.room ?? "no room configured"] }));
  head.push(Button({ key: "refresh", label: "refresh", hotkey: "r", plain: true, onPress: () => act.refresh() }));
  const who = m.who.slice(0, 8).map((w) => `${w.name} ${ago(w.last, m.now)}`).join(" · ");
  head.push(dim(who ? `here: ${who}` : m.loading ? "here: …" : "here: nobody has spoken yet"));
  out.push(row(head));
  if (m.error) out.push(Text({ color: "red", wrap: "wrap", children: [m.error] }));
  // The compose controls sit above the list so they stay in view when the pane is short; the list scrolls.
  /** @type {any[]} */
  const body = [];
  /** @type {any[]} */
  const compose = [];

  if (m.thread === null) {
    body.push(Text({ weight: "semibold", children: [`Subjects (${m.subjects.length}), latest activity first`] }));
    if (!m.subjects.length) body.push(dim(m.loading ? "reading the room…" : "no messages in the window"));
    m.subjects.slice(0, 30).forEach((s, i) => {
      const mark = s.unread > 0 ? `● ${s.unread}` : "  ";
      body.push(Button({
        key: `subject-${s.id}`,
        label: `${mark} ${s.title} · ${s.count} msg · ${ago(s.latestTs, m.now)}`,
        ...(i < 9 ? { hotkey: String(i + 1) } : {}),
        plain: true,
        onPress: () => act.open(s.id),
      }));
    });
  } else {
    const subject = m.subjects.find((s) => s.id === m.thread);
    body.push(Button({ key: "back", label: "← subjects", hotkey: "b", plain: true, onPress: () => act.back() }));
    body.push(Text({ weight: "semibold", wrap: "truncate", children: [subject ? subject.title : `thread ${m.thread}`] }));
    for (const msg of (subject?.messages ?? []).slice(-40)) {
      body.push(col([
        Text({ weight: "semibold", wrap: "truncate", children: [`${msg.from} · ${ago(msg.ts, m.now)}${msg.to.length ? ` · to ${msg.to.join(", ")}` : ""}`] }),
        Text({ wrap: "wrap", children: [bodyText(msg)] }),
      ], { marginBottom: 1 }));
    }
  }

  compose.push(Text({ weight: "semibold", wrap: "wrap", children: [targetLine(m)] }));
  const controls = [];
  controls.push(Button({ key: "new-subject", label: "new subject", hotkey: "n", plain: true, dimColor: m.thread === null, onPress: () => act.newSubject() }));
  if (Select) {
    const names = [...new Set(m.who.map((w) => w.name))].slice(0, 20);
    const options = [{ value: TO_NOBODY, label: "no one in particular" }, { value: "*", label: "everyone (*)" }, ...names.map((n) => ({ value: n, label: n }))];
    if (!options.some((o) => o.value === m.to)) options.push({ value: m.to, label: m.to });
    controls.push(Select({ key: "to", label: "to", options, value: m.to, onSelect: (/** @type {string} */ v) => act.setTo(v) }));
  } else controls.push(dim("(this surface has no selector: addressing is not available here)"));
  compose.push(row(controls));
  if (Input) {
    compose.push(Input({ key: "compose", label: "say", placeholder: "type a message and press Enter", value: "", submitLabel: "post", onSubmit: (/** @type {string} */ v) => act.submit(v) }));
  } else compose.push(dim("(this surface has no text field: post with the room_post tool)"));

  return col([...out, ...compose, ...body]);
}
