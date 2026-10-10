// @ts-check
/**
 * Web Push with no dependency: VAPID keys (P-256, created into `vapidFile` on first start, mode
 * 0600), the ES256 JWT, RFC 8291 `aes128gcm` payload encryption with WebCrypto, delivery with TTL
 * and urgency, and a 404 or 410 from the push service removing the subscription. The notification
 * policy (mentions, a `waiting` naming the person, replies in threads they are in, or everything,
 * per their prefs) and the lock-screen text from the host's `notifyText`.
 *
 * Not implemented in this build.
 */

/**
 * @typedef {{ endpoint: string, keys: { p256dh: string, auth: string } }} PushSubscriptionRecord
 * @typedef {{ title: string, body: string, thread?: string, pushId?: string }} PushPayload
 */

/**
 * @param {{ vapidFile: string, subject: string }} options
 * @returns {Promise<{ publicKey: string, send(subscription: PushSubscriptionRecord, payload: PushPayload, opts?: { ttl?: number, urgency?: 'very-low' | 'low' | 'normal' | 'high' }): Promise<{ status: number, gone: boolean }> }>}
 */
export async function createPush(options) {
  void options;
  throw new Error("not-implemented: chat push createPush");
}
