// @ts-check
/**
 * Annotations, reactions and purge: `POST /chat/annotate` (edit, withdraw, pin, unpin),
 * `POST /chat/react` (names, never counts) and `POST /chat/purge` through `authorize(person, "purge")`.
 *
 * Annotate. `{ act, target, text?, operationId? }`; `authorize(person, act, { target, thread })`.
 * An edit or a withdrawal is the author's own: the kit holds every person of the host on one seat
 * account, so the room's own author check cannot tell two of them apart by account, and the kit
 * requires the target to carry the person's `author.ref` (a message the index does not hold is
 * 404, one of someone else's is 403). An edit's text goes through `scanText` exactly as a post's:
 * 422 `TEXT_REFUSED` on a refusal, `warn` beside the receipt. The answer is
 * `{ receipt: { id, cursor, duplicate, operationId } }` with a post's outcomes (202, 409, 503).
 *
 * React. `{ target, name, on }`: `name` is one short word (letters, digits, `_` or `-`, at most
 * 32), kept in the kit's store by person. The answer is `{ names: [personId], reactions }`: the people
 * who chose that name for that message, and the message's reactions as now folded, never a number.
 *
 * Reactions folded. Every message the kit serves (the thread and room routes, the thread list's
 * `root` and `last`, search hits, and the stream's `message` and `annotation` events) carries
 * `reactions: [{ name, people: [personId] }]` when it has any: each name once, in the order it was
 * first chosen, with the people who chose it in the order they did. No reactions, no field.
 *
 * Purge. `{ targets?, thread?, reason, operationId? }`; `authorize(person, "purge", { targets, thread })`.
 * The room's purge, signed with the person's name and ref; the kit's index forgets the purged text
 * on the receipt (and again, idempotently, when the purge record arrives on the room's follow). The
 * answer is `{ purged, facesOutOfReach, blobsRemoved, receipt }`.
 *
 * Operation ids. As for a post: a client's draft id (`operationId`) is turned into the room's
 * operation id with the person and the act, so a resend after a 202 under the same draft id lands
 * once; without one the kit mints one per request.
 */

import { createHash, randomUUID } from "node:crypto";
import { faultOf, asFault } from "./room.mjs";
import { MESSAGE_ID, NAME_MAX, TEXT_MAX_BYTES, postFault } from "./post.mjs";
import { forgetPurge } from "./search.mjs";
import { once } from "./uploads.mjs";

const ACTS = new Set(["edit", "withdraw", "pin", "unpin"]);
const DRAFT_ID = /^[A-Za-z0-9_-]{8,128}$/;
const REACTION = /^[\p{L}\p{N}_-]{1,32}$/u;
const BODY_MAX_BYTES = 1_048_576;
const PURGE_TARGETS_MAX = 1000;
const REASON_MAX = 1000;

/**
 * The JSON object a request carries, or a Response saying why not.
 * @param {Request} req @param {import("./index.mjs").ChatKit} kit
 * @returns {Promise<Record<string, any> | Response>}
 */
async function body(req, kit) {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_MAX_BYTES) return kit.fail(413, "TOO_LARGE", "The request is too large.");
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* below */ }
  return kit.fail(400, "BAD_REQUEST", "The body is a JSON object.");
}

/** @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit */
function authorOf(person, kit) {
  const name = (typeof person.name === "string" ? person.name : "").replace(/[\r\n\0]/g, " ").trim().slice(0, NAME_MAX).trim() || person.id;
  const ref = kit.personRef(person);
  return /** @type {import("./room.mjs").Author} */ ({ kind: "human", name, ...(ref ? { ref } : {}) });
}

/**
 * The client's draft id and the room's operation id for it.
 * @param {unknown} given @param {string} personId @param {string} act
 * @returns {{ draft: string, operationId: string } | null} null when `given` is not a draft id
 */
function operation(given, personId, act) {
  if (given !== undefined && given !== null && (typeof given !== "string" || !DRAFT_ID.test(given))) return null;
  const draft = typeof given === "string" ? given : randomUUID().replaceAll("-", "");
  return { draft, operationId: `chat-${createHash("sha256").update(`${personId}\0${draft}\0${act}`).digest("hex").slice(0, 48)}` };
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit
 * @returns {Promise<Response>}
 */
export async function handleAnnotate(req, person, kit) {
  const b = await body(req, kit);
  if (b instanceof Response) return b;
  const { act, target, text } = b;
  if (typeof act !== "string" || !ACTS.has(act)) return kit.fail(400, "BAD_REQUEST", "act is edit, withdraw, pin or unpin.");
  if (typeof target !== "string" || !MESSAGE_ID.test(target)) return kit.fail(400, "BAD_REQUEST", "target is a message's id.");
  if (act === "edit") {
    if (typeof text !== "string" || !text.trim()) return kit.fail(400, "BAD_REQUEST", "An edit carries the message's new words.");
    if (Buffer.byteLength(text, "utf8") > TEXT_MAX_BYTES) return kit.fail(413, "TOO_LARGE", `The text is over ${TEXT_MAX_BYTES} bytes.`);
  } else if (text !== undefined) return kit.fail(400, "BAD_REQUEST", `A ${act} carries no text.`);
  const op = operation(b.operationId, person.id, `annotate:${act}:${target}`);
  if (!op) return kit.fail(400, "BAD_REQUEST", "operationId is 8 to 128 letters, digits, - or _.");

  const held = kit.store.message(target);
  const thread = held ? kit.store.threadOf(target) ?? target : null;
  const act_ = /** @type {import("./index.mjs").ChatAct} */ (act === "unpin" ? "pin" : act);
  if (!kit.hooks.authorize(person, act_, { target, thread })) return kit.fail(403, "FORBIDDEN", "You cannot do that here.");
  if (act === "edit" || act === "withdraw") {
    if (!held) return kit.fail(404, "NOT_FOUND", "There is no such message.");
    const ref = kit.personRef(person);
    if (!ref || held.message.author?.ref !== ref) return kit.fail(403, "FORBIDDEN", `Only its author can ${act} a message.`);
  }

  /** @type {{ refuse?: string, warn?: string }} */
  let scan = {};
  if (act === "edit") {
    try { scan = kit.hooks.scanText(/** @type {string} */ (text)) ?? {}; }
    catch (e) {
      kit.log(`chat: the host's text scan threw: ${e instanceof Error ? e.message : String(e)}`);
      return kit.fail(422, "TEXT_REFUSED", "The text could not be checked, so the edit was not made.", { reason: "scan-failed" });
    }
    if (scan.refuse) return kit.fail(422, "TEXT_REFUSED", "The edit was not made.", { reason: scan.refuse });
  }
  try {
    const receipt = await kit.room.annotate({ act, target, ...(act === "edit" ? { text } : {}), author: authorOf(person, kit), operationId: op.operationId });
    return kit.json(200, { ok: true, data: { receipt: { id: receipt.id, cursor: receipt.cursor, duplicate: receipt.duplicate, operationId: op.draft }, ...(scan.warn ? { warn: scan.warn } : {}) } });
  } catch (e) {
    const f = faultOf(e) ?? asFault(e);
    kit.log(`chat: an annotation was not confirmed: ${f.outcome} (${f.code})`);
    return postFault(f, op.draft);
  }
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit
 * @returns {Promise<Response>}
 */
export async function handleReact(req, person, kit) {
  const b = await body(req, kit);
  if (b instanceof Response) return b;
  const { target, name, on } = b;
  if (typeof target !== "string" || !MESSAGE_ID.test(target)) return kit.fail(400, "BAD_REQUEST", "target is a message's id.");
  if (typeof name !== "string" || !REACTION.test(name)) return kit.fail(400, "BAD_REQUEST", "name is one short word: letters, digits, _ or -, at most 32.");
  if (typeof on !== "boolean") return kit.fail(400, "BAD_REQUEST", "on is true or false.");
  const thread = kit.store.threadOf(target);
  if (thread === undefined) return kit.fail(404, "NOT_FOUND", "There is no such message.");
  if (!kit.hooks.authorize(person, "react", { target, thread })) return kit.fail(403, "FORBIDDEN", "You cannot do that here.");
  // a withdrawn message takes no new reaction; one already given can still be taken back
  if (on && /** @type {{ withdrawn: number } | null} */ (once(kit.store.db, "select withdrawn from messages where id = ?", (st) => st.get(target)))?.withdrawn) {
    return kit.fail(409, "WITHDRAWN", "That message was withdrawn.");
  }
  kit.store.setReaction(target, name, person.id, on);
  kit.reacted(target, thread);
  const reactions = reactionsOf(kit.store, [target]).get(target) ?? [];
  return kit.json(200, { ok: true, data: { names: reactions.find((r) => r.name === name)?.people ?? [], reactions } });
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit
 * @returns {Promise<Response>}
 */
export async function handlePurge(req, person, kit) {
  const b = await body(req, kit);
  if (b instanceof Response) return b;
  const { targets, thread, reason } = b;
  if (targets !== undefined && (!Array.isArray(targets) || targets.length > PURGE_TARGETS_MAX || !targets.every((t) => typeof t === "string" && MESSAGE_ID.test(t)) || new Set(targets).size !== targets.length))
    return kit.fail(400, "BAD_REQUEST", `targets is a list of up to ${PURGE_TARGETS_MAX} distinct message ids.`);
  if (thread !== undefined && (typeof thread !== "string" || !MESSAGE_ID.test(thread))) return kit.fail(400, "BAD_REQUEST", "thread is a root message's id.");
  if (!targets?.length && thread === undefined) return kit.fail(400, "BAD_REQUEST", "A purge names at least one message or a thread.");
  if (typeof reason !== "string" || !reason.trim() || reason.length > REASON_MAX) return kit.fail(400, "BAD_REQUEST", `reason is 1 to ${REASON_MAX} characters.`);
  const op = operation(b.operationId, person.id, "purge");
  if (!op) return kit.fail(400, "BAD_REQUEST", "operationId is 8 to 128 letters, digits, - or _.");
  if (!kit.hooks.authorize(person, "purge", { targets: targets ?? [], thread: thread ?? null })) return kit.fail(403, "FORBIDDEN", "You cannot purge here.");
  try {
    const r = await kit.room.purge({ ...(targets?.length ? { targets } : {}), ...(thread !== undefined ? { thread } : {}), reason, author: authorOf(person, kit), operationId: op.operationId });
    forgetPurge(kit.store, r.purged, kit.log);
    return kit.json(200, { ok: true, data: {
      purged: r.purged, facesOutOfReach: r.facesOutOfReach, blobsRemoved: r.blobsRemoved,
      receipt: { id: r.id, cursor: r.cursor, duplicate: r.duplicate, operationId: op.draft },
    } });
  } catch (e) {
    const f = faultOf(e) ?? asFault(e);
    kit.log(`chat: a purge was not confirmed: ${f.outcome} (${f.code})`);
    if (f.outcome === "dark") return kit.fail(503, "ROOM_DARK", "The room is unreachable right now. Nothing was purged; try again in a moment.");
    if (f.outcome === "unknown-acceptance") return kit.json(202, { ok: false, error: { code: "ACCEPTANCE_UNKNOWN", operationId: op.draft, message: "The room did not confirm the purge. Send it again under the same operation id: it will not be applied twice." } });
    return kit.fail(409, "ROOM_REFUSED", `The room refused the purge (${f.code}).`, { refusal: f.code });
  }
}

/** @typedef {{ name: string, people: string[] }} Reaction */

/**
 * The reactions on these messages, by message id: each name once, in the order first chosen, with
 * the people who chose it. A message with none is absent from the map.
 * @param {import("./store.mjs").KitStore} store @param {readonly string[]} ids
 * @returns {Map<string, Reaction[]>}
 */
export function reactionsOf(store, ids) {
  /** @type {Map<string, Reaction[]>} */
  const out = new Map();
  const unique = [...new Set(ids)];
  for (let at = 0; at < unique.length; at += 500) {
    const chunk = unique.slice(at, at + 500);
    const rows = /** @type {Array<{ target: string, name: string, person: string }>} */ (once(store.db,
      `select target, name, person from reactions where target in (${chunk.map(() => "?").join(",")}) order by at, rowid`, (st) => st.all(...chunk)));
    for (const r of rows) {
      const list = out.get(r.target) ?? [];
      out.set(r.target, list);
      const entry = list.find((x) => x.name === r.name);
      if (entry) entry.people.push(r.person);
      else list.push({ name: r.name, people: [r.person] });
    }
  }
  return out;
}

/**
 * Messages with their reactions folded in (`reactions`, only when there are any).
 * @template {Record<string, any>} M
 * @param {import("./store.mjs").KitStore} store @param {M[]} messages
 * @returns {Array<M & { reactions?: Reaction[] }>}
 */
export function withReactions(store, messages) {
  const ids = messages.map((m) => m?.id).filter((id) => typeof id === "string");
  if (!ids.length) return messages;
  const map = reactionsOf(store, ids);
  return messages.map((m) => {
    const r = m && map.get(m.id);
    return r ? { ...m, reactions: r } : m;
  });
}
