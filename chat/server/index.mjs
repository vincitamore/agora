// @ts-check
/**
 * The chat kit's server half: `createChat` and the route table. The contract is CONTRACT.md.
 *
 * The host mounts the kit inside its own `Bun.serve` fetch, after its own cross-site checks and
 * session: `const r = await chat.handle(req, person); if (r) return r;`. A path outside `/chat/`
 * answers `null` so the host falls through to its own routes.
 *
 * The modules beside this one each own one part: `room` (the room through agora/client), `stream`
 * (SSE fan-out), `post` (posting and its four outcomes), `store` (kit.sqlite), `uploads` (upload,
 * file and thumbnail), `annotate` (annotate, react, purge), `search` (the index and its route).
 *
 * In this build every `/chat/` route answers 501 `NOT_IMPLEMENTED`.
 */

/**
 * A person as the host knows them. `ref` is stamped on the person's messages as `author.ref`.
 * @typedef {{ id: string, name: string, ref?: string }} Person
 */
/** @typedef {'read' | 'post' | 'upload' | 'edit' | 'withdraw' | 'pin' | 'purge' | 'react'} ChatAct */
/** @typedef {{ state: 'ready' | 'busy' | 'away' | 'dark', lastSeen?: string, running?: string }} Presence */
/**
 * The host's side of the seam. Every hook is the host's knowledge; the kit never learns what it means.
 * @typedef {{
 *   identify: (req: Request) => Promise<Person | null>,
 *   authorize: (person: Person, act: ChatAct, ctx: Record<string, unknown>) => boolean,
 *   people: () => Promise<Person[]>,
 *   scanText: (text: string) => { refuse?: string, warn?: string },
 *   scanUpload: (file: { name: string, mimetype: string, bytes: Uint8Array }) => Promise<{ ok: true } | { ok: false, reason: string }>,
 *   notifyText: (event: { message: Record<string, any>, threadRoot?: Record<string, any> }) => { title: string, body: string },
 *   presence: () => Promise<Presence>,
 *   residentName: string,
 * }} ChatHooks
 */
/**
 * @typedef {{
 *   agoraDir: string,
 *   agoraState?: string,
 *   agoraConfig?: string,
 *   room: string,
 *   clientName: string,
 *   storeDir: string,
 *   hooks: ChatHooks,
 *   push: { vapidFile: string, subject: string } | null,
 * }} ChatOptions
 */
/** @typedef {'message' | 'annotation'} ChatEvent */
/**
 * @typedef {{
 *   handle: (req: Request, person: Person | null) => Promise<Response | null>,
 *   on: (event: ChatEvent, listener: (value: Record<string, any>) => void) => void,
 *   close: () => Promise<void>,
 *   version: string,
 * }} Chat
 */

/** The kit's own version, which a host checks against the major it was written for. */
export const CHAT_VERSION = "1.0.0";

/** The path every kit route lives under. */
export const CHAT_BASE = "/chat/";

/**
 * Every route the kit answers, as `METHOD path`; `:name` is one path segment.
 * @type {ReadonlyArray<string>}
 */
export const CHAT_ROUTES = Object.freeze([
  "GET /chat/state",
  "GET /chat/threads",
  "GET /chat/thread/:root",
  "GET /chat/stream",
  "POST /chat/post",
  "POST /chat/upload",
  "GET /chat/file/:id",
  "GET /chat/thumb/:digest",
  "POST /chat/annotate",
  "POST /chat/react",
  "POST /chat/purge",
  "POST /chat/position",
  "GET /chat/search",
  "GET /chat/push/key",
  "POST /chat/push/subscribe",
  "DELETE /chat/push/subscribe",
  "POST /chat/push/test",
  "POST /chat/push/ack",
  "GET /chat/prefs",
  "PUT /chat/prefs",
]);

/**
 * A JSON answer in the kit's envelope.
 * @param {number} status @param {{ ok: boolean, data?: unknown, error?: { code: string, message?: string } }} body
 */
export function chatJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Create the kit for one room.
 * @param {ChatOptions} options
 * @returns {Promise<Chat>}
 */
export async function createChat(options) {
  if (!options || typeof options !== "object") throw new TypeError("createChat takes { agoraDir, room, clientName, storeDir, hooks, push }");
  return {
    version: CHAT_VERSION,
    async handle(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith(CHAT_BASE)) return null;
      return chatJson(501, { ok: false, error: { code: "NOT_IMPLEMENTED", message: "this kit build serves no routes" } });
    },
    on() {},
    async close() {},
  };
}
