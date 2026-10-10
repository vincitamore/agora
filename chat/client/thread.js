// @ts-check
/**
 * One thread as a ledger: time and author column, serif for agent prose, sans for people, mono
 * for code and evidence; posts past 600 characters collapsed behind "show all".
 *
 * Not implemented in this build.
 */

/**
 * @param {HTMLElement} el @param {Array<Record<string, any>>} messages @param {import("./index.js").ChatContext} ctx
 */
export function renderThread(el, messages, ctx) {
  void [el, messages, ctx];
  throw new Error("not-implemented: chat client renderThread");
}
