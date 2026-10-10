// @ts-check
/**
 * The card registry. A message carries a card as a trailer `card: <type> <id>`; a registered
 * renderer loads the card's data from the host at render time and renders it, and an unregistered
 * type shows the message text. A card is a reference, never a payload.
 */

/**
 * @typedef {{
 *   load: (id: string, ctx: import("./index.js").ChatContext) => Promise<unknown>,
 *   render: (data: unknown, ctx: import("./index.js").ChatContext) => HTMLElement,
 *   actions?: Record<string, (data: unknown, ctx: import("./index.js").ChatContext) => Promise<void>>,
 * }} CardRenderer
 */

/** @type {Map<string, CardRenderer>} */
const cards = new Map();

/** @param {string} type @param {CardRenderer} renderer */
export function registerCard(type, renderer) {
  if (typeof type !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(type)) throw new TypeError("a card type is a lower-case word");
  if (!renderer || typeof renderer.load !== "function" || typeof renderer.render !== "function") throw new TypeError("a card renderer has load and render");
  cards.set(type, renderer);
}

/** @param {string} type @returns {CardRenderer | undefined} */
export function cardRenderer(type) {
  return cards.get(type);
}
