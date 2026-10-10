// @ts-check
/*
 * The chat kit's push handler, a classic worker script: the host's own service worker loads it with
 * importScripts("/chat/push/sw.js") (or wherever the host serves it). On a push it shows the
 * notification and acknowledges it (POST <base>/push/ack, event "shown"); on a click it focuses a
 * window of the app and tells it which thread to open, or opens the thread's URL, and acknowledges
 * the click.
 *
 * The host may configure it after importScripts:
 *   self.agoraChatPush.configure({ base: "/chat", headers: { "X-Example-App": "1" } });
 * `headers` are added to the acknowledgement, for a host whose cross-site check wants its own header.
 *
 * A focused window receives a message { type: "agora-chat-open-thread", thread, url } to open the
 * thread itself; the kit's client half listens for it.
 *
 * The payload (JSON, encrypted by the server half): { v: 1, pushId, kind, title, body, thread?, url }.
 */
(function () {
  const worker = /** @type {any} */ (self);
  const config = { base: "/chat", headers: /** @type {Record<string, string>} */ ({}) };

  /** @param {string} pushId @param {"shown" | "clicked"} event */
  function ack(pushId, event) {
    if (typeof pushId !== "string" || !pushId) return Promise.resolve();
    return fetch(`${config.base}/push/ack`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...config.headers },
      body: JSON.stringify({ pushId, event }),
    }).then(() => undefined, () => undefined);
  }

  worker.addEventListener("push", (/** @type {any} */ event) => {
    /** @type {Record<string, any>} */
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = { title: "New message", body: "" };
    }
    const title = typeof data.title === "string" && data.title ? data.title : "New message";
    const options = {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.thread === "string" ? `thread-${data.thread}` : undefined,
      renotify: typeof data.thread === "string",
      data: { pushId: data.pushId, thread: data.thread ?? null, url: typeof data.url === "string" ? data.url : "/" },
    };
    event.waitUntil(Promise.all([
      worker.registration.showNotification(title, options),
      ack(data.pushId, "shown"),
    ]));
  });

  worker.addEventListener("notificationclick", (/** @type {any} */ event) => {
    const data = (event.notification && event.notification.data) || {};
    event.notification.close();
    const url = new URL(typeof data.url === "string" ? data.url : "/", worker.location.origin).href;
    event.waitUntil((async () => {
      const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = windows.find((/** @type {any} */ c) => new URL(c.url).origin === worker.location.origin);
      if (same) {
        await same.focus();
        same.postMessage({ type: "agora-chat-open-thread", thread: data.thread ?? null, url });
      } else {
        await worker.clients.openWindow(url);
      }
      await ack(data.pushId, "clicked");
    })());
  });

  worker.agoraChatPush = {
    version: "1.0.0",
    implemented: true,
    /** @param {{ base?: string, headers?: Record<string, string> }} options */
    configure(options) {
      if (options && typeof options.base === "string") config.base = options.base.replace(/\/$/, "");
      if (options && options.headers && typeof options.headers === "object") config.headers = { ...options.headers };
    },
  };
})();
