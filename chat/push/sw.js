// @ts-check
/*
 * The chat kit's push handler, a classic worker script: the host's own service worker loads it with
 * importScripts. On a push it shows the notification; on a click it focuses or opens the thread
 * and acknowledges the push (POST /chat/push/ack with the push id).
 *
 * Not implemented in this build: it registers no handler.
 */
(function () {
  const worker = /** @type {any} */ (self);
  worker.agoraChatPush = { version: "1.0.0", implemented: false };
})();
