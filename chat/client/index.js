// @ts-check
/**
 * The chat kit's client half: `mountChat`, `registerCard`, `registerBlock`. ES modules, no build
 * step, phone-first at 360 px. The contract is CONTRACT.md.
 *
 * The modules beside this one each own one part: `list` (the thread list), `thread` (one thread as
 * a ledger), `cards` and `blocks` (the registries), `markdown` (the rendered subset), `composer`,
 * `upload` and `search`.
 *
 * In this build `mountChat` is not implemented; the registries record what a host registers.
 */

export { registerCard } from "./cards.js";
export { registerBlock } from "./blocks.js";

/**
 * What a card or block renderer is handed.
 * @typedef {{
 *   person: { id: string, name: string } | null,
 *   thread: string | null,
 *   post: (text: string, trailers?: Array<[string, string]>) => Promise<unknown>,
 *   theme: string,
 *   now: () => Date,
 * }} ChatContext
 */
/**
 * @typedef {{
 *   base: string,
 *   context?: () => Array<[string, string]>,
 *   onOpenThread?: (root: string) => void,
 *   people?: () => Promise<Array<{ id: string, name: string }>>,
 * }} MountOptions
 */

/**
 * Mount the chat into an element.
 * @param {HTMLElement} el @param {MountOptions} options
 * @returns {{ unmount(): void }}
 */
export function mountChat(el, options) {
  void el; void options;
  throw new Error("not-implemented: chat client mountChat");
}
