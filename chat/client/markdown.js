// @ts-check
/**
 * The markdown subset: paragraphs, lists, emphasis, code, fenced blocks, and links only to
 * `https:` and the same origin; never an image from text, never raw HTML.
 *
 * Not implemented in this build.
 */

/**
 * @param {string} text @param {import("./index.js").ChatContext} ctx @returns {DocumentFragment}
 */
export function renderMarkdown(text, ctx) {
  void [text, ctx];
  throw new Error("not-implemented: chat client renderMarkdown");
}
