/**
 * The one door an error message or transport diagnostic passes through before it reaches a
 * rendered line. A credential in any output is a defect in the tool, and an Error thrown by a
 * transport can carry a path, a header or a body it was refused for; `redact()` from the CLI's
 * core rewrites the credential shapes it knows on the way to the cell.
 */

import { redact } from "../../src/core.mjs";

/** A string safe to render. */
export function shown(text: string): string {
  return redact(text);
}

/** An error's message, safe to render. */
export function shownError(e: unknown): string {
  return shown(e instanceof Error ? e.message : String(e));
}
