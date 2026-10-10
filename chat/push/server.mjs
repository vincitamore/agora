// @ts-check
/**
 * Web Push with no dependency: VAPID keys (P-256, created into `vapidFile` on first start, mode
 * 0600), the ES256 JWT, RFC 8291 `aes128gcm` payload encryption with WebCrypto, delivery with TTL
 * and urgency, and a 404 or 410 from the push service removing the subscription. The notification
 * policy (mentions, a `waiting` naming the person, replies in threads they are in, or everything,
 * per their prefs) and the lock-screen text from the host's `notifyText`.
 *
 * Two layers:
 * - `createPush({ vapidFile, subject })`: the sender. Keys, the token, encryption, one POST.
 * - `createPushService({ store, push, hooks })`: the kit's push routes (`/chat/push/*`, `/chat/prefs`),
 *   the policy applied to a room message (`notify`), and the record of every push sent and
 *   acknowledged in the store's `push_*` tables (`store.mjs`).
 */

import { open, readFile, chmod, link, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { unb64url, encryptAes128gcm, generateVapidKeys, importVapidPrivate, vapidJwt, MAX_PLAINTEXT } from "./crypto.mjs";
import { recipientsFor, lockScreenText, parsePrefs } from "./policy.mjs";

/**
 * @typedef {{ endpoint: string, keys: { p256dh: string, auth: string } }} PushSubscriptionRecord
 * @typedef {{ title: string, body: string, thread?: string, pushId?: string, url?: string }} PushPayload
 * @typedef {'very-low' | 'low' | 'normal' | 'high'} Urgency
 * @typedef {{ status: number, gone: boolean, answer: string }} SendResult
 */

/**
 * The push services browsers subscribe to. A subscription naming any other host is refused: the
 * endpoint comes from a browser, and the server POSTs to it, so an open endpoint is a request
 * forger aimed at whatever the server can reach.
 */
export const PUSH_SERVICE_HOSTS = Object.freeze([
  "fcm.googleapis.com", "android.googleapis.com", // Chrome, Edge on Android, Chromium builds
  ".push.services.mozilla.com", // Firefox
  ".notify.windows.com", // Edge on Windows
  ".push.apple.com", // Safari, iOS home-screen apps
]);

/** @param {URL} url */
export function isKnownPushService(url) {
  if (url.protocol !== "https:" || url.port !== "") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
}

/**
 * Read the VAPID key file, or create it at mode 0600. Two processes starting together end up with
 * one key: the loser reads the winner's.
 * @param {string} vapidFile
 * @returns {Promise<{ publicKey: string, privateJwk: JsonWebKey, created: boolean }>}
 */
export async function loadOrCreateVapid(vapidFile) {
  try {
    return { ...parseVapid(await readFile(vapidFile, "utf8"), vapidFile), created: false };
  } catch (e) {
    if (/** @type {any} */ (e).code !== "ENOENT") throw e;
  }
  const keys = await generateVapidKeys();
  // written whole to a private temporary name, then linked into place: the link fails if the name
  // exists, so the key file is never seen half-written and two racing starts keep the first key
  const tmp = `${vapidFile}.${randomBytes(6).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(JSON.stringify({ kind: "agora-chat-vapid", version: 1, publicKey: keys.publicKey, privateJwk: keys.privateJwk }) + "\n", "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    // the umask may have narrowed the mode further, never widened it; say it exactly where modes exist
    if (process.platform !== "win32") await chmod(tmp, 0o600);
    await link(tmp, vapidFile);
  } catch (e) {
    if (/** @type {any} */ (e).code === "EEXIST") return { ...parseVapid(await readFile(vapidFile, "utf8"), vapidFile), created: false };
    throw e;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  return { ...keys, created: true };
}

/** @param {string} text @param {string} file */
function parseVapid(text, file) {
  const v = JSON.parse(text);
  if (v?.kind !== "agora-chat-vapid" || typeof v.publicKey !== "string" || !v.privateJwk || v.privateJwk.crv !== "P-256") {
    throw new Error(`vapid-file-invalid: ${file} is not a chat kit VAPID key file`);
  }
  return { publicKey: v.publicKey, privateJwk: /** @type {JsonWebKey} */ (v.privateJwk) };
}

/**
 * The sender.
 * @param {{
 *   vapidFile: string,
 *   subject: string,
 *   fetch?: typeof fetch,
 *   allowEndpoint?: (url: URL) => boolean,
 *   now?: () => number,
 * }} options
 */
export async function createPush(options) {
  const { vapidFile, subject } = options;
  if (typeof vapidFile !== "string" || !vapidFile) throw new TypeError("createPush needs a vapidFile");
  if (typeof subject !== "string" || !/^(mailto:|https:)/.test(subject)) throw new TypeError("the VAPID subject is a mailto: or https: URL");
  const doFetch = options.fetch ?? globalThis.fetch;
  const allow = options.allowEndpoint ?? isKnownPushService;
  const now = options.now ?? Date.now;
  const keys = await loadOrCreateVapid(vapidFile);
  const privateKey = await importVapidPrivate(keys.privateJwk);
  /** @type {Map<string, { token: string, until: number }>} */
  const tokens = new Map();

  /** @param {string} audience */
  async function tokenFor(audience) {
    const t = tokens.get(audience);
    if (t && t.until > now()) return t.token;
    const token = await vapidJwt({ privateKey, audience, subject, expiresIn: 12 * 3600, now: now() });
    tokens.set(audience, { token, until: now() + 11 * 3600 * 1000 });
    return token;
  }

  return {
    publicKey: keys.publicKey,
    created: keys.created,
    /** @param {string} endpoint */
    allows(endpoint) {
      try { return allow(new URL(endpoint)); } catch { return false; }
    },
    /**
     * Encrypt and POST one push. A 404 or 410 means the subscription is gone; the caller removes it.
     * @param {PushSubscriptionRecord} subscription @param {PushPayload} payload
     * @param {{ ttl?: number, urgency?: Urgency, topic?: string }} [opts]
     * @returns {Promise<SendResult>}
     */
    async send(subscription, payload, opts = {}) {
      const url = new URL(subscription.endpoint);
      if (!allow(url)) throw new Error(`push-endpoint-refused: ${url.origin} is not a push service`);
      const plaintext = new TextEncoder().encode(JSON.stringify(payload));
      if (plaintext.length > MAX_PLAINTEXT) throw new RangeError("push-payload-too-large");
      const body = await encryptAes128gcm({ plaintext, uaPublic: unb64url(subscription.keys.p256dh), authSecret: unb64url(subscription.keys.auth) });
      /** @type {Record<string, string>} */
      const headers = {
        "content-type": "application/octet-stream",
        "content-encoding": "aes128gcm",
        ttl: String(Math.max(0, Math.floor(opts.ttl ?? 24 * 3600))),
        urgency: opts.urgency ?? "normal",
        authorization: `vapid t=${await tokenFor(url.origin)}, k=${keys.publicKey}`,
      };
      if (opts.topic) {
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) throw new TypeError("a push topic is up to 32 base64url characters");
        headers.topic = opts.topic;
      }
      const res = await doFetch(url, { method: "POST", headers, body });
      const answer = (await res.text().catch(() => "")).slice(0, 300);
      return { status: res.status, gone: res.status === 404 || res.status === 410, answer };
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof createPush>>} Push */
/** @typedef {{ id: string, name: string, ref?: string }} Person */

/**
 * @param {number} status @param {{ ok: boolean, data?: unknown, error?: { code: string, message?: string } }} body
 */
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
/** @param {number} status @param {string} code @param {string} [message] */
const fail = (status, code, message) => json(status, { ok: false, error: message ? { code, message } : { code } });
/** @param {unknown} data */
const ok = (data) => json(200, { ok: true, data });

/** @param {Request} req @param {number} limit */
async function readJson(req, limit) {
  const text = await req.text();
  if (text.length > limit) throw Object.assign(new Error("too large"), { status: 413 });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("not JSON"), { status: 400 });
  }
}

/**
 * The subscription a browser sends (`PushSubscription.toJSON()`), checked.
 * @param {unknown} body @param {Push} push
 * @returns {{ ok: true, sub: { endpoint: string, p256dh: string, auth: string } } | { ok: false, reason: string }}
 */
export function parseSubscription(body, push) {
  const b = /** @type {any} */ (body);
  if (!b || typeof b.endpoint !== "string" || b.endpoint.length > 2048) return { ok: false, reason: "subscription-endpoint" };
  if (!push.allows(b.endpoint)) return { ok: false, reason: "subscription-endpoint-not-push-service" };
  const p256dh = b.keys?.p256dh, auth = b.keys?.auth;
  try {
    const pk = unb64url(p256dh), a = unb64url(auth);
    if (pk.length !== 65 || pk[0] !== 4) return { ok: false, reason: "subscription-p256dh" };
    if (a.length !== 16) return { ok: false, reason: "subscription-auth" };
  } catch {
    return { ok: false, reason: "subscription-keys" };
  }
  return { ok: true, sub: { endpoint: b.endpoint, p256dh, auth } };
}

/**
 * The kit's push routes and the policy, over one store and one sender. With `push: null` (a host that
 * turned push off) the prefs route still answers and every `/push/` route is 404 `PUSH_OFF`.
 * @param {{
 *   store: import("./store.mjs").PushStore,
 *   push: Push | null,
 *   hooks: {
 *     people: () => Promise<Person[]>,
 *     notifyText: (e: { message: Record<string, any>, threadRoot?: Record<string, any> }) => { title: string, body: string },
 *   },
 *   base?: string,
 *   threadUrl?: (root: string | null) => string,
 *   ttl?: number,
 * }} options
 */
export function createPushService(options) {
  const { store, push, hooks } = options;
  const base = (options.base ?? "/chat").replace(/\/$/, "");
  const threadUrl = options.threadUrl ?? ((root) => (root ? `/?thread=${encodeURIComponent(root)}` : "/"));
  const ttl = options.ttl ?? 24 * 3600;

  /**
   * Send one payload to every subscription a person holds, recording each push and its answer, and
   * dropping a subscription its push service says is gone.
   * @param {string} personId
   * @param {{ title: string, body: string, thread?: string | null, kind: 'message' | 'test' | 'probe', run?: string, seq?: number, urgency?: Urgency }} what
   */
  async function sendTo(personId, what) {
    /** @type {{ pushId: string, endpoint: string, status: number | null, gone: boolean, error?: string }[]} */
    const results = [];
    if (!push) return results;
    for (const sub of store.subscriptionsOf(personId)) {
      const pushId = randomBytes(16).toString("hex");
      store.recordSent({ id: pushId, person: personId, endpoint: sub.endpoint, kind: what.kind, run: what.run ?? null, seq: what.seq ?? null });
      /** @type {PushPayload & { v: number, kind: string, seq?: number }} */
      const payload = { v: 1, pushId, kind: what.kind, title: what.title, body: what.body, url: threadUrl(what.thread ?? null) };
      if (what.thread) payload.thread = what.thread;
      if (what.seq != null) payload.seq = what.seq;
      try {
        const r = await push.send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload,
          { ttl, urgency: what.urgency ?? (what.kind === "message" ? "high" : "normal") });
        store.recordAnswer(pushId, r.status, r.answer);
        if (r.gone) store.removeSubscription(sub.endpoint);
        results.push({ pushId, endpoint: sub.endpoint, status: r.status, gone: r.gone });
      } catch (e) {
        const message = String(/** @type {any} */ (e)?.message ?? e);
        store.recordAnswer(pushId, null, `error: ${message}`);
        results.push({ pushId, endpoint: sub.endpoint, status: null, gone: false, error: message });
      }
    }
    return results;
  }

  return {
    publicKey: push ? push.publicKey : null,
    sendTo,
    /**
     * Apply the policy to one room message. The server half calls this for each new message with the
     * mentions it parsed against `people()` and the people who have posted in the message's thread.
     * @param {{ message: Record<string, any>, threadRoot?: Record<string, any>, mentions?: string[], participants?: string[] }} event
     */
    async notify(event) {
      const people = await hooks.people();
      const recipients = recipientsFor({ message: event.message, people, prefsOf: store.prefsOf, mentions: event.mentions, participants: event.participants });
      const out = [];
      for (const { person, reason } of recipients) {
        const text = lockScreenText({ prefs: store.prefsOf(person.id), notifyText: hooks.notifyText, message: event.message, threadRoot: event.threadRoot });
        const thread = typeof event.message.thread === "string" ? event.message.thread : (typeof event.message.id === "string" ? event.message.id : null);
        out.push({ person: person.id, reason, results: await sendTo(person.id, { ...text, thread, kind: "message" }) });
      }
      return out;
    },
    /**
     * `/chat/push/*` and `/chat/prefs`; `null` for any other path.
     * @param {Request} req @param {Person | null} person
     * @returns {Promise<Response | null>}
     */
    async handle(req, person) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p !== `${base}/prefs` && !p.startsWith(`${base}/push/`)) return null;
      if (!person) return fail(401, "UNAUTHENTICATED");
      const route = `${req.method} ${p.slice(base.length)}`;
      if (!push && route !== "GET /prefs" && route !== "PUT /prefs") return fail(404, "PUSH_OFF");
      const sender = /** @type {Push} */ (push);
      try {
        switch (route) {
          case "GET /push/key":
            return ok({ publicKey: sender.publicKey });
          case "POST /push/subscribe": {
            const parsed = parseSubscription(await readJson(req, 8192), sender);
            if (!parsed.ok) return fail(422, "SUBSCRIPTION_REFUSED", parsed.reason);
            store.saveSubscription(person.id, parsed.sub);
            return ok({ endpoint: parsed.sub.endpoint });
          }
          case "DELETE /push/subscribe": {
            const b = await readJson(req, 4096);
            if (typeof b?.endpoint !== "string") return fail(400, "BAD_REQUEST", "endpoint");
            return ok({ removed: store.removeSubscription(b.endpoint, person.id) });
          }
          case "POST /push/test": {
            const results = await sendTo(person.id, { title: "Test notification", body: "Notifications reach this device.", kind: "test", urgency: "normal" });
            if (results.length === 0) return fail(409, "NO_SUBSCRIPTION");
            return ok({ results });
          }
          case "POST /push/ack": {
            const b = await readJson(req, 1024);
            const pushId = b?.pushId;
            const event = b?.event ?? "shown";
            if (typeof pushId !== "string" || !/^[a-f0-9]{32}$/.test(pushId)) return fail(400, "BAD_REQUEST", "pushId");
            if (event !== "shown" && event !== "clicked") return fail(400, "BAD_REQUEST", "event");
            if (!store.recordAck(pushId, person.id, event)) return fail(404, "UNKNOWN_PUSH");
            return ok({});
          }
          case "GET /prefs":
            return ok(store.prefsOf(person.id));
          case "PUT /prefs": {
            const parsed = parsePrefs(await readJson(req, 4096), store.prefsOf(person.id));
            if (!parsed.ok) return fail(422, "PREFS_REFUSED", parsed.reason);
            store.savePrefs(person.id, parsed.prefs);
            return ok(parsed.prefs);
          }
          default:
            return fail(404, "NOT_FOUND");
        }
      } catch (e) {
        const status = /** @type {any} */ (e)?.status;
        if (status === 413) return fail(413, "TOO_LARGE");
        if (status === 400) return fail(400, "BAD_REQUEST", "body is not JSON");
        throw e;
      }
    },
  };
}
