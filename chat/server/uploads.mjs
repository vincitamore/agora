// @ts-check
/**
 * Files: `POST /chat/upload` through the host's `scanUpload` and the size caps into the room's
 * custody, `GET /chat/file/:id` streamed from custody with the stated headers, and
 * `GET /chat/thumb/:digest`.
 *
 * Not implemented in this build: every function throws.
 */

/**
 * @param {Request} req @param {import("./index.mjs").Person} person
 * @returns {Promise<Response>}
 */
export async function handleUpload(req, person) {
  void [req, person];
  throw new Error("not-implemented: chat server uploads.handleUpload");
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person
 * @returns {Promise<Response>}
 */
export async function handleFile(req, person) {
  void [req, person];
  throw new Error("not-implemented: chat server uploads.handleFile");
}

/**
 * @param {Request} req @param {import("./index.mjs").Person} person
 * @returns {Promise<Response>}
 */
export async function handleThumb(req, person) {
  void [req, person];
  throw new Error("not-implemented: chat server uploads.handleThumb");
}
