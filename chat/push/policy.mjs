// @ts-check
/**
 * Who a message notifies, and what their lock screen says. Pure functions: the server half supplies
 * the facts it already derives (the people a message mentions, the people who have posted in its
 * thread), the person's prefs come from the store, and nothing here reads the room.
 *
 * A person is notified when one of these holds and their prefs allow it:
 * - `mentions`: the message mentions them;
 * - `asks`: the message carries `waiting: <their id>`;
 * - `mine`: the message is a reply in a thread they have posted in (or rooted);
 * - `all`: any message at all.
 * Never for their own message. Each person is notified once, under the first reason in that order.
 */

/** @typedef {{ id: string, name: string, ref?: string }} Person */
/** @typedef {'mention' | 'ask' | 'mine' | 'all'} NotifyReason */
/** @typedef {import("./store.mjs").PushPrefs} PushPrefs */

/**
 * The person a message's author is, by the host's ref.
 * @param {Record<string, any>} message @param {Person[]} people @returns {Person | null}
 */
export function authorOf(message, people) {
  const ref = message?.author?.ref;
  if (typeof ref !== "string" || message?.author?.kind !== "human") return null;
  return people.find((p) => (p.ref ?? p.id) === ref) ?? null;
}

/**
 * The person ids a message's `waiting:` trailers name.
 * @param {Record<string, any>} message @returns {string[]}
 */
export function waitingOn(message) {
  const trailers = Array.isArray(message?.trailers) ? message.trailers : [];
  return trailers.filter((t) => Array.isArray(t) && t[0] === "waiting" && typeof t[1] === "string").map((t) => t[1].trim()).filter(Boolean);
}

/**
 * @param {{
 *   message: Record<string, any>,
 *   people: Person[],
 *   prefsOf: (personId: string) => PushPrefs,
 *   mentions?: string[],
 *   participants?: string[],
 * }} input
 * @returns {{ person: Person, reason: NotifyReason }[]}
 */
export function recipientsFor({ message, people, prefsOf, mentions = [], participants = [] }) {
  const author = authorOf(message, people);
  const asks = new Set(waitingOn(message));
  const mentioned = new Set(mentions);
  const inThread = typeof message?.thread === "string" ? new Set(participants) : new Set();
  /** @type {{ person: Person, reason: NotifyReason }[]} */
  const out = [];
  for (const person of people) {
    if (author && person.id === author.id) continue;
    const n = prefsOf(person.id).notify;
    /** @type {NotifyReason | null} */
    let reason = null;
    if (n.mentions && mentioned.has(person.id)) reason = "mention";
    else if (n.asks && asks.has(person.id)) reason = "ask";
    else if (n.mine && inThread.has(person.id)) reason = "mine";
    else if (n.all) reason = "all";
    if (reason) out.push({ person, reason });
  }
  return out;
}

/**
 * The lock-screen text. `generic` says only that something arrived; `title-line` is the host's
 * `notifyText`, trimmed to what a lock screen shows.
 * @param {{ prefs: PushPrefs, notifyText: (e: { message: Record<string, any>, threadRoot?: Record<string, any> }) => { title: string, body: string }, message: Record<string, any>, threadRoot?: Record<string, any> }} input
 */
export function lockScreenText({ prefs, notifyText, message, threadRoot }) {
  if (prefs.lockScreen === "generic") return { title: "New message", body: "" };
  const t = notifyText({ message, threadRoot });
  return { title: clip(String(t?.title ?? ""), 80), body: clip(String(t?.body ?? ""), 240) };
}

/** @param {string} s @param {number} n */
function clip(s, n) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

/**
 * Validate a prefs body from `PUT /chat/prefs`; unknown keys refuse.
 * @param {unknown} body @param {PushPrefs} current
 * @returns {{ ok: true, prefs: PushPrefs } | { ok: false, reason: string }}
 */
export function parsePrefs(body, current) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "prefs-not-object" };
  const b = /** @type {Record<string, any>} */ (body);
  for (const k of Object.keys(b)) if (k !== "notify" && k !== "lockScreen") return { ok: false, reason: `prefs-field-unknown: ${k}` };
  const notify = { ...current.notify };
  if (b.notify !== undefined) {
    if (!b.notify || typeof b.notify !== "object") return { ok: false, reason: "prefs-notify-not-object" };
    for (const [k, v] of Object.entries(b.notify)) {
      if (!(k in notify)) return { ok: false, reason: `prefs-notify-unknown: ${k}` };
      if (typeof v !== "boolean") return { ok: false, reason: `prefs-notify-not-boolean: ${k}` };
      notify[/** @type {keyof typeof notify} */ (k)] = v;
    }
  }
  let lockScreen = current.lockScreen;
  if (b.lockScreen !== undefined) {
    if (b.lockScreen !== "title-line" && b.lockScreen !== "generic") return { ok: false, reason: "prefs-lockscreen" };
    lockScreen = b.lockScreen;
  }
  return { ok: true, prefs: { notify, lockScreen } };
}
