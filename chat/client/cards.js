// @ts-check
/**
 * The card registry. A message carries a card as a trailer `card: <type> <id>`; a registered
 * renderer loads the card's data from the host at render time and renders it, and an unregistered
 * type shows the message text. A card is a reference, never a payload.
 *
 * Rendering is not acting. An element a renderer returns may carry `data-chat-action="<name>"` on
 * its buttons; a click there calls `actions[name](data, ctx)`, which goes through the host's own
 * route. The kit never reads a card's meaning: it frames what the renderer returns, and gives the
 * frame the `you` edge when the message's `waiting` trailer names the person reading, or when the
 * renderer marks its element `data-chat-you`.
 */

import { h } from "./markdown.js";

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

/**
 * Parse a `card` trailer value, `<type> <id>`, or null when it is not one.
 * @param {string} value @returns {{ type: string, id: string } | null}
 */
export function parseCardRef(value) {
  const m = String(value ?? "").trim().match(/^([a-z][a-z0-9-]{0,31})\s+(\S{1,128})$/);
  return m ? { type: m[1], id: m[2] } : null;
}

/**
 * Mount one card reference: a frame that loads and renders it, or null when the type has no
 * renderer (the message text is then the card's whole showing).
 * @param {{ type: string, id: string }} ref
 * @param {import("./index.js").ChatContext} ctx
 * @param {{ you?: boolean }} [opts]
 * @returns {HTMLElement | null}
 */
export function mountCard(ref, ctx, opts = {}) {
  const renderer = cards.get(ref.type);
  if (!renderer) return null;
  const frame = h("div", { class: "chat-card-frame" + (opts.you ? " is-you" : ""), "data-card-type": ref.type, "data-card-id": ref.id, "aria-busy": "true" },
    [h("div", { class: "chat-card-loading" }, [`${ref.type} ${ref.id} · reading`])]);
  /** @type {unknown} */
  let data;
  const show = (/** @type {Node} */ node) => {
    while (frame.firstChild) frame.removeChild(frame.firstChild);
    frame.appendChild(node);
    frame.removeAttribute("aria-busy");
  };
  (async () => {
    try {
      data = await renderer.load(ref.id, ctx);
      const el = renderer.render(data, ctx);
      if (!el || typeof el !== "object" || !("nodeType" in el)) throw new Error("the renderer returned no element");
      if (el.hasAttribute?.("data-chat-you")) frame.classList.add("is-you");
      show(el);
    } catch (e) {
      show(h("div", { class: "chat-card-failed", role: "status" }, [`${ref.type} ${ref.id} could not be read: ${e instanceof Error ? e.message : String(e)}`]));
    }
  })();
  frame.addEventListener("click", async (event) => {
    const target = /** @type {Element | null} */ (event.target);
    const button = target && typeof target.closest === "function" ? target.closest("[data-chat-action]") : null;
    if (!button || !frame.contains(button)) return;
    const name = button.getAttribute("data-chat-action") ?? "";
    const action = renderer.actions?.[name];
    if (!action || data === undefined) return;
    event.preventDefault();
    button.setAttribute("disabled", "");
    button.setAttribute("aria-busy", "true");
    const old = frame.querySelector(".chat-card-error");
    if (old) old.remove();
    try {
      await action(data, ctx);
    } catch (e) {
      frame.appendChild(h("div", { class: "chat-card-error", role: "alert" }, [e instanceof Error ? e.message : String(e)]));
    } finally {
      button.removeAttribute("disabled");
      button.removeAttribute("aria-busy");
    }
  });
  return frame;
}
