// @ts-check
/**
 * Annotations, reactions and purge: `POST /chat/annotate` (edit, withdraw, pin, unpin),
 * `POST /chat/react` (names, never counts) and `POST /chat/purge` through `authorize(person, "purge")`.
 *
 * Not implemented in this build: every function throws.
 */

/**
 * @param {Request} req @param {import("./index.mjs").Person} person
 * @returns {Promise<Response>}
 */
export async function handleAnnotate(req, person) {
  void [req, person];
  throw new Error("not-implemented: chat server annotate.handleAnnotate");
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person
 * @returns {Promise<Response>}
 */
export async function handleReact(req, person) {
  void [req, person];
  throw new Error("not-implemented: chat server annotate.handleReact");
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person
 * @returns {Promise<Response>}
 */
export async function handlePurge(req, person) {
  void [req, person];
  throw new Error("not-implemented: chat server annotate.handlePurge");
}
