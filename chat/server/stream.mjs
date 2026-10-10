// @ts-check
/**
 * Server-sent events: `GET /chat/stream?thread=<root>|main`, history then live with duplicates
 * dropped by cursor, and `state` events (`live`, `dark`, `refused`) and `presence`.
 *
 * Not implemented in this build: every function throws.
 */

/**
 * @param {Request} req @param {import("./index.mjs").Person} person
 * @returns {Promise<Response>}
 */
export async function handleStream(req, person) {
  void [req, person];
  throw new Error("not-implemented: chat server stream.handleStream");
}
