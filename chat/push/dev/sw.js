// @ts-check
// The dev host's service worker, shaped as a host's: it imports the kit's push handler, configures
// it, and (dev only) tells open pages each push it received, so the page shows the worker's side.
(function () {
  const worker = /** @type {any} */ (self);
  worker.importScripts("/chat/push/sw.js");
  worker.agoraChatPush.configure({ base: "/chat" });
  worker.addEventListener("install", () => worker.skipWaiting());
  worker.addEventListener("activate", (/** @type {any} */ e) => e.waitUntil(worker.clients.claim()));
  worker.addEventListener("push", (/** @type {any} */ event) => {
    /** @type {Record<string, any>} */
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = {};
    }
    event.waitUntil(worker.clients.matchAll({ type: "window", includeUncontrolled: true }).then((/** @type {any[]} */ cs) => {
      for (const c of cs) c.postMessage({ type: "dev-push-received", pushId: data.pushId, title: data.title, body: data.body, at: new Date().toISOString() });
    }));
  });
})();
