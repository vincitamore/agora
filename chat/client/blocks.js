// @ts-check
/**
 * The block registry. A fenced block whose language is registered is rendered by its renderer; any
 * other fenced block is a code block.
 */

/** @typedef {(source: string, ctx: import("./index.js").ChatContext) => HTMLElement} BlockRenderer */

/** @type {Map<string, BlockRenderer>} */
const blocks = new Map();

/** @param {string} language @param {BlockRenderer} render */
export function registerBlock(language, render) {
  if (typeof language !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(language)) throw new TypeError("a block language is a lower-case word");
  if (typeof render !== "function") throw new TypeError("a block renderer is a function");
  blocks.set(language, render);
}

/** @param {string} language @returns {BlockRenderer | undefined} */
export function blockRenderer(language) {
  return blocks.get(language);
}
