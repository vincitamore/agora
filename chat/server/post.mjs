// @ts-check
/**
 * Posting: `POST /chat/post` and its outcomes (200 receipt, 202 acceptance unknown, 409 the room
 * refused, 422 the text refused, 503 the room dark); the operation id kept per person and draft for
 * resends; "also send to the room" as two appends.
 *
 * The operation id. The client names a draft with its own `operationId` and resends a 202 under
 * the same one. The id the room sees is derived from the person and that draft, never taken as
 * given, so one person's draft id can never answer for, or collide with, another person's
 * (the room keys an operation by its seat account, which every person of one host shares). A post
 * that arrives with no `operationId` is given one, kept per (person, thread, words) until the room
 * answers definitely, so a plain resend of the same words is still posted once.
 *
 * Only the person's own name and ref are ever put on a message: `author.kind` is `human`,
 * `author.name` the host's name for them, `author.ref` their ref (or id). No signature line.
 */

import { createHash, randomUUID } from "node:crypto";
import { asFault, faultOf } from "./room.mjs";

/** The author name the room takes, at most. */
export const NAME_MAX = 120;
/** A post's text, at most, in UTF-8 bytes (the room's own ceiling). */
export const TEXT_MAX_BYTES = 262_144;
/** The JSON body of a post, at most. */
const BODY_MAX_BYTES = 1_048_576;
/** A client's draft id. */
const DRAFT_ID = /^[A-Za-z0-9_-]{8,128}$/;
/** A message id: a thread root. */
export const MESSAGE_ID = /^[a-f0-9]{64}$/;
/** What the room takes as `author.ref`. */
const AUTHOR_REF = /^[A-Za-z0-9._@+-]{1,64}$/;
/** Operation ids kept for a resend of a post that came without one; the oldest go first past this. */
const RETAINED_MAX = 1000;
const TRAILERS_MAX = 16;

/**
 * The ref a person's messages carry as `author.ref`: the host's `ref`, else the person's id, when
 * the room can take it; otherwise none.
 * @param {{ id: string, ref?: string }} person
 * @returns {string | undefined}
 */
export function personRef(person) {
  const ref = typeof person.ref === "string" && person.ref ? person.ref : person.id;
  return typeof ref === "string" && AUTHOR_REF.test(ref) ? ref : undefined;
}

/**
 * A JSON answer in the kit's envelope.
 * @param {number} status @param {Record<string, unknown>} body
 */
export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
export function fail(status, code, message, extra = {}) {
  return json(status, { ok: false, error: { code, message, ...extra } });
}

/**
 * A failed append as HTTP. The words are for the person; the room's own message goes to the log.
 * @param {import("./room.mjs").Fault} f @param {string} draft the client's operation id
 */
export function postFault(f, draft) {
  if (f.outcome === "dark") return fail(503, "ROOM_DARK", "The room is unreachable right now. Nothing was posted; try again in a moment.");
  if (f.outcome === "unknown-acceptance") return json(202, { ok: false, error: { code: "ACCEPTANCE_UNKNOWN", operationId: draft, message: "The room did not confirm the message. Send it again under the same operation id: it will not be posted twice." } });
  return fail(409, "ROOM_REFUSED", `The room refused the message (${f.code}).`, { refusal: f.code });
}

/** @param {string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * The operation id the room sees for one part of a person's draft.
 * @param {string} personId @param {string} draft @param {'reply' | 'room'} part
 */
export function roomOperationId(personId, draft, part) {
  return `chat-${sha256(`${personId}\0${draft}\0${part}`).slice(0, 48)}`;
}

/**
 * @typedef {{
 *   room: import("./room.mjs").Room,
 *   hooks: import("./index.mjs").ChatHooks,
 *   log: (line: string) => void,
 * }} PostingOptions
 */

/**
 * @param {PostingOptions} o
 */
export function createPosting(o) {
  /** @type {Map<string, string>} draft ids minted for posts that came without one */
  const retained = new Map();

  /** @param {string} key */
  function retain(key) {
    const have = retained.get(key);
    if (have) return have;
    const id = randomUUID().replaceAll("-", "");
    retained.set(key, id);
    while (retained.size > RETAINED_MAX) {
      const oldest = retained.keys().next().value;
      if (oldest === undefined) break;
      retained.delete(oldest);
    }
    return id;
  }

  /**
   * @param {Request} req @param {import("./index.mjs").Person} person
   * @returns {Promise<Response>}
   */
  async function handle(req, person) {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > BODY_MAX_BYTES) return fail(413, "TOO_LARGE", "The post is too large.");
    /** @type {any} */
    let body;
    try { body = JSON.parse(raw); } catch { return fail(400, "BAD_REQUEST", "The body is not JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "BAD_REQUEST", "The body is a JSON object.");
    const { text, thread, operationId, trailers, attachments, alsoToRoom } = body;
    if (typeof text !== "string" || !text.trim()) return fail(400, "BAD_REQUEST", "text is the message's words.");
    if (Buffer.byteLength(text, "utf8") > TEXT_MAX_BYTES) return fail(413, "TOO_LARGE", `The text is over ${TEXT_MAX_BYTES} bytes.`);
    if (thread !== undefined && thread !== null && (typeof thread !== "string" || !MESSAGE_ID.test(thread))) return fail(400, "BAD_REQUEST", "thread is a root message's id.");
    if (operationId !== undefined && operationId !== null && (typeof operationId !== "string" || !DRAFT_ID.test(operationId))) return fail(400, "BAD_REQUEST", "operationId is 8 to 128 letters, digits, - or _.");
    if (alsoToRoom !== undefined && typeof alsoToRoom !== "boolean") return fail(400, "BAD_REQUEST", "alsoToRoom is true or false.");
    if (alsoToRoom && !thread) return fail(400, "BAD_REQUEST", "alsoToRoom is for a reply in a thread.");
    /** @type {Array<[string, string]>} */
    const pairs = [];
    if (trailers !== undefined && trailers !== null) {
      if (!Array.isArray(trailers) || trailers.length > TRAILERS_MAX) return fail(400, "BAD_REQUEST", `trailers is a list of at most ${TRAILERS_MAX} [key, value] pairs.`);
      for (const t of trailers) {
        if (!Array.isArray(t) || t.length !== 2 || typeof t[0] !== "string" || typeof t[1] !== "string") return fail(400, "BAD_REQUEST", "each trailer is a [key, value] pair of strings.");
        pairs.push([t[0], t[1]]);
      }
    }
    if (attachments !== undefined && attachments !== null && !Array.isArray(attachments)) return fail(400, "BAD_REQUEST", "attachments is a list of uploaded files.");
    const where = typeof thread === "string" ? thread : undefined;

    if (!o.hooks.authorize(person, "post", { thread: where ?? null, alsoToRoom: alsoToRoom === true })) return fail(403, "FORBIDDEN", "You cannot post here.");

    /** @type {{ refuse?: string, warn?: string }} */
    let scan;
    try { scan = o.hooks.scanText(text) ?? {}; }
    catch (e) {
      o.log(`chat: the host's text scan threw: ${e instanceof Error ? e.message : String(e)}`);
      return fail(422, "TEXT_REFUSED", "The text could not be checked, so it was not posted.", { reason: "scan-failed" });
    }
    if (scan.refuse) return fail(422, "TEXT_REFUSED", "The text was not posted.", { reason: scan.refuse });

    const retainedKey = typeof operationId === "string" ? null : sha256(`${person.id}\0${where ?? "main"}\0${text}`);
    const draft = typeof operationId === "string" ? operationId : retain(/** @type {string} */ (retainedKey));
    const name = (typeof person.name === "string" ? person.name : "").replace(/[\r\n\0]/g, " ").trim().slice(0, NAME_MAX).trim() || person.id;
    const ref = personRef(person);
    /** @type {import("./room.mjs").Author} */
    const author = { kind: "human", name, ...(ref ? { ref } : {}) };

    return o.room.serial(`${person.id}\0${draft}`, async () => {
      /** @type {import("./room.mjs").Receipt} */
      let receipt;
      try {
        receipt = await o.room.append({
          text, author, operationId: roomOperationId(person.id, draft, "reply"),
          ...(where ? { thread: where } : {}),
          ...(pairs.length ? { trailers: pairs } : {}),
          ...(attachments?.length ? { attachments } : {}),
        });
      } catch (e) {
        const f = faultOf(e) ?? asFault(e);
        if (f.outcome === "refused" && retainedKey) retained.delete(retainedKey);
        o.log(`chat: a post was not confirmed: ${f.outcome} (${f.code})`);
        return postFault(f, draft);
      }
      const answer = { id: receipt.id, cursor: receipt.cursor, duplicate: receipt.duplicate, operationId: draft, thread: where ?? null };
      /** @type {Record<string, unknown>} */
      const data = { receipt: answer, ...(scan.warn ? { warn: scan.warn } : {}) };
      if (alsoToRoom && where) {
        // the second of two appends: the same words at the top level, pointing back at the thread
        try {
          const copy = await o.room.append({
            text, author, operationId: roomOperationId(person.id, draft, "room"),
            trailers: [...pairs.filter(([k]) => k !== "re"), ["re", where]],
            ...(attachments?.length ? { attachments } : {}),
          });
          data.alsoToRoom = { id: copy.id, cursor: copy.cursor, duplicate: copy.duplicate };
        } catch (e) {
          const f = faultOf(e) ?? asFault(e);
          o.log(`chat: a post's copy to the room was not confirmed: ${f.outcome} (${f.code})`);
          // the reply stands; a resend under the same operation id answers it as a duplicate and tries the copy again
          const r = postFault(f, draft);
          const out = /** @type {any} */ (await r.json());
          out.error.posted = answer;
          return json(r.status, out);
        }
      }
      if (retainedKey) retained.delete(retainedKey);
      return json(200, { ok: true, data });
    });
  }

  return { handle };
}
