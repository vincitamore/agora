// @ts-check
/**
 * Posting: `POST /chat/post` and its four outcomes (200 receipt, 202 acceptance unknown, 409 the
 * room refused, 422 the text refused, 503 the room dark); the operation id kept per person and draft
 * for resends; "also send to the room" as two appends.
 *
 * Not implemented in this build: every function throws.
 */

/**
 * @param {Request} req @param {import("./index.mjs").Person} person
 * @returns {Promise<Response>}
 */
export async function handlePost(req, person) {
  void [req, person];
  throw new Error("not-implemented: chat server post.handlePost");
}
