// @ts-check
/**
 * `POST /chat/scan { text }`: the host's `scanText` and nothing else. No append, no index, no push,
 * no position. It answers what a post of the same words would: `{ warn }` when the scan warns, `{}`
 * when it passes, 422 `TEXT_REFUSED { reason }` when it refuses (`reason: "scan-failed"` when the
 * scan throws). A composer calls it before sending, so a warning reaches the person while they can
 * still change the words; `POST /chat/post` scans again and stays the authority. Asking needs the
 * right to post (`authorize(person, "post", { scan: true })`).
 */

import { TEXT_MAX_BYTES } from "./post.mjs";

/** The JSON body of a scan, at most. */
const BODY_MAX_BYTES = 1_048_576;

/**
 * @param {Request} req @param {import("./index.mjs").Person} person @param {import("./index.mjs").ChatKit} kit
 * @returns {Promise<Response>}
 */
export async function handleScan(req, person, kit) {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_MAX_BYTES) return kit.fail(413, "TOO_LARGE", "The request is too large.");
  /** @type {any} */
  let b;
  try { b = JSON.parse(raw); } catch { return kit.fail(400, "BAD_REQUEST", "The body is not JSON."); }
  if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.text !== "string") return kit.fail(400, "BAD_REQUEST", "The body is { text }.");
  if (Buffer.byteLength(b.text, "utf8") > TEXT_MAX_BYTES) return kit.fail(413, "TOO_LARGE", `The text is over ${TEXT_MAX_BYTES} bytes.`);
  if (!kit.hooks.authorize(person, "post", { scan: true })) return kit.fail(403, "FORBIDDEN", "You cannot post here.");
  /** @type {{ refuse?: string, warn?: string }} */
  let scan;
  try { scan = kit.hooks.scanText(b.text) ?? {}; }
  catch (e) {
    kit.log(`chat: the host's text scan threw: ${e instanceof Error ? e.message : String(e)}`);
    return kit.fail(422, "TEXT_REFUSED", "The text could not be checked.", { reason: "scan-failed" });
  }
  if (scan.refuse) return kit.fail(422, "TEXT_REFUSED", "The text would not be posted.", { reason: scan.refuse });
  return kit.json(200, { ok: true, data: scan.warn ? { warn: scan.warn } : {} });
}
