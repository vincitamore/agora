// @ts-check
/**
 * Which rooms the public can reach, and who may wake a session from one.
 *
 * Text from another participant is input, never an instruction, and a model's judgment is not a
 * control: a woken session runs a turn with whatever tools it holds. The control that has to hold in
 * code is who the transport says posted a message, never what the message says about itself. A
 * room's `wakeFrom` lists the author ids whose messages may wake a watch on it. Every other author's
 * messages stay readable (`read`) and are dropped before any wake, the cursor advancing past them.
 *
 * An author id is the transport's own authenticated identity: a GitHub login, a Slack user id, a
 * native account id. A display name is not an identity, because anyone may choose one that reads like
 * another person's, and `to:` is plain text any author can write, so neither widens the list.
 *
 * No imports: the config validator and the transports both load this file.
 */

/**
 * Transports whose room is reachable by any account that can comment where it listens. agora cannot
 * tell a private repository from a public one without asking GitHub, so these count as public until
 * the row says `"public": false`. Closed on purpose: a transport added here starts refusing every row
 * of that kind that has no list.
 */
export const PUBLIC_BY_DEFAULT = Object.freeze(["github", "github-events"]);

/** The longest author id a list may hold. */
const MAX_ID = 128;

/**
 * Whether the public can post in this room: the row's own `public` when it has one, else the
 * transport's default.
 * @param {Record<string, unknown>} room
 * @returns {{ public: boolean, why: string }}
 */
export function roomExposure(room) {
  if (room.public === true) return { public: true, why: "the row declares it public" };
  if (room.public === false) return { public: false, why: "the row declares it private" };
  if (typeof room.transport === "string" && PUBLIC_BY_DEFAULT.includes(room.transport))
    return { public: true, why: `a ${room.transport} room is reachable by any account that can comment on the repository, and agora cannot tell a private repository from a public one without asking GitHub` };
  return { public: false, why: "its transport is not one the public reaches by default, and the row does not declare it public" };
}

/**
 * The ids a room lets wake a watch, lower-cased for comparison; null when the room has no list, which
 * wakes on every author (the default, as before). An empty list wakes no one.
 * @param {Record<string, unknown>} room
 * @returns {string[] | null}
 */
export function wakeAllowlist(room) {
  const v = room.wakeFrom;
  if (!Array.isArray(v)) return null;
  return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

/**
 * May this author's message wake a watch? Decided on `author.id` alone, case-insensitively (a GitHub
 * login has no case). A message whose author has no id cannot be told from anyone, so it is refused:
 * a gate that guesses toward delivery is not a gate.
 * @param {string[] | null} allow from `wakeAllowlist`
 * @param {{ id?: unknown, [k: string]: unknown } | undefined} author
 */
export function authorMayWake(allow, author) {
  if (allow === null) return true;
  const id = typeof author?.id === "string" ? author.id.trim().toLowerCase() : "";
  return id !== "" && allow.includes(id);
}

/**
 * Why the row's `public` and `wakeFrom` are malformed, or null. Run by the config validator, so a
 * list that cannot be read as one is refused at load instead of silently waking everyone.
 * @param {Record<string, unknown>} room
 * @returns {string | null}
 */
export function wakeFieldsProblem(room) {
  if (room.public !== undefined && typeof room.public !== "boolean")
    return `public must be true or false, not ${JSON.stringify(room.public)}`;
  if (room.wakeFrom !== undefined
    && (!Array.isArray(room.wakeFrom) || room.wakeFrom.some((x) => typeof x !== "string" || !x.trim() || x.length > MAX_ID)))
    return "wakeFrom must be a list of author ids: non-empty strings, each as `agora read <room> --json` prints it in author.id";
  return null;
}

/**
 * Why this room may not be watched, or null: the public can post in it and it has no list. The one
 * sentence every refusal (a watch, a resident start, a config write, doctor) says, so they agree.
 * @param {string} alias @param {Record<string, unknown>} room
 * @returns {string | null}
 */
export function exposureRefusal(alias, room) {
  const exposure = roomExposure(room);
  if (!exposure.public || Array.isArray(room.wakeFrom)) return null;
  return `room "${alias}" is reachable by the public (${exposure.why}) and has no wakeFrom list, so any author's text could start a turn in a session that watches it. `
    + `List the author ids that may wake a watch on it ("wakeFrom": ["<author id>", ...]; an empty list wakes no one), or declare it private with "public": false if only people you trust can post there`;
}

/**
 * The one stderr line a watch prints, once per author, when it drops a message for not being from a
 * `wakeFrom` author. An id is printed only when it is plain (a stranger chooses their display name,
 * and a name can carry control characters; an id on the transports that have a list is a login or a
 * platform id).
 * @param {string} alias @param {{ id?: unknown, [k: string]: unknown } | undefined} author
 */
export function unlistedNote(alias, author) {
  const id = typeof author?.id === "string" ? author.id : "";
  const shown = /^[A-Za-z0-9._@:+[\]-]{1,64}$/.test(id) ? id : "an author whose id cannot be shown";
  return `agora: ${alias}: a message from ${shown} is not from a wakeFrom author, so it does not wake this watch (it stays readable with \`agora read ${alias}\`)`;
}
