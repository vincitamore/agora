// @ts-check
/**
 * Search: the FTS5 index over message text and file names, kept as messages arrive, and
 * `GET /chat/search` with its `coverage`.
 *
 * Not implemented in this build: every function throws.
 */

/**
 * @param {Request} req @param {import("./index.mjs").Person} person
 * @returns {Promise<Response>}
 */
export async function handleSearch(req, person) {
  void [req, person];
  throw new Error("not-implemented: chat server search.handleSearch");
}
