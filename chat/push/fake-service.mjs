// @ts-check
/**
 * A push service and a user agent on loopback, for tests and for checking a host's wiring without a
 * browser: it hands out subscriptions (a real P-256 key pair and auth secret per subscription, the
 * private half kept here), and its endpoint checks every request as a push service would (the VAPID
 * token and its audience, TTL, Urgency, Content-Encoding) and decrypts the body as the user agent
 * would. What arrived is kept in order; `respondWith` makes the next answers a chosen status.
 *
 * The kit's sender refuses any endpoint that is not a browser push service; a test passes
 * `allowEndpoint: fake.allows` to createPush.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { b64url, decryptAes128gcm, exportPublicRaw, verifyVapid } from "./crypto.mjs";

/**
 * @typedef {{
 *   subscriptionId: string, status: number, error?: string,
 *   headers: Record<string, string>, vapidKey?: string, payload?: Record<string, any>,
 * }} Arrival
 */

export async function startFakePushService() {
  /** @type {Map<string, { privateKey: CryptoKey, publicRaw: Uint8Array, authSecret: Uint8Array }>} */
  const subs = new Map();
  /** @type {Arrival[]} */
  const arrivals = [];
  /** @type {number[]} */
  const queued = [];
  /** @type {((a: Arrival) => void)[]} */
  const waiters = [];

  const server = createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const id = (req.url ?? "").replace(/^\/push\//, "");
      /** @type {Record<string, string>} */
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      /** @type {Arrival} */
      const arrival = { subscriptionId: id, status: 201, headers };
      const sub = subs.get(id);
      try {
        if (req.method !== "POST") throw Object.assign(new Error("method"), { status: 405 });
        if (!sub) throw Object.assign(new Error("no such subscription"), { status: 404 });
        const { publicKey } = await verifyVapid(req.headers.authorization ?? null, { audience: origin });
        arrival.vapidKey = publicKey;
        if (req.headers["content-encoding"] !== "aes128gcm") throw Object.assign(new Error("content-encoding"), { status: 400 });
        if (!/^\d+$/.test(String(req.headers.ttl ?? ""))) throw Object.assign(new Error("ttl"), { status: 400 });
        if (req.headers.urgency && !["very-low", "low", "normal", "high"].includes(String(req.headers.urgency))) throw Object.assign(new Error("urgency"), { status: 400 });
        const plain = await decryptAes128gcm({ body: new Uint8Array(Buffer.concat(chunks)), uaKeys: sub, authSecret: sub.authSecret });
        arrival.payload = JSON.parse(new TextDecoder().decode(plain));
        arrival.status = queued.length ? /** @type {number} */ (queued.shift()) : 201;
      } catch (e) {
        arrival.status = /** @type {any} */ (e).status ?? 400;
        arrival.error = String(/** @type {any} */ (e).message ?? e);
      }
      arrivals.push(arrival);
      for (const w of waiters.splice(0)) w(arrival);
      res.writeHead(arrival.status, { "content-type": "text/plain" });
      res.end(arrival.error ?? "");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    arrivals,
    /** @param {URL} url */
    allows: (url) => url.origin === origin,
    /** A new subscription, as a browser's `PushSubscription.toJSON()` gives it. */
    async subscribe() {
      const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
      const publicRaw = await exportPublicRaw(pair.publicKey);
      const authSecret = new Uint8Array(randomBytes(16));
      const id = randomBytes(8).toString("hex");
      subs.set(id, { privateKey: pair.privateKey, publicRaw, authSecret });
      return { endpoint: `${origin}/push/${id}`, expirationTime: null, keys: { p256dh: b64url(publicRaw), auth: b64url(authSecret) } };
    },
    /** Answer the next pushes with these statuses (after checking and decrypting them). @param {...number} statuses */
    respondWith(...statuses) {
      queued.push(...statuses);
    },
    /** @returns {Promise<Arrival>} */
    nextArrival() {
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
