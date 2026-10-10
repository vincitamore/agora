// @ts-check
/**
 * The page side of push: register the host's service worker, read the kit's VAPID key, subscribe,
 * and hand the subscription to `POST /chat/push/subscribe`.
 *
 * Not implemented in this build.
 */

/**
 * @param {{ base: string, serviceWorker: ServiceWorkerRegistration }} options
 * @returns {Promise<PushSubscription>}
 */
export async function subscribePush(options) {
  void options;
  throw new Error("not-implemented: chat push subscribePush");
}
