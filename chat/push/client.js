// @ts-check
/**
 * The page side of push: ask for permission (only from a user gesture on iOS and in most browsers),
 * read the kit's VAPID key, subscribe through the host's service worker registration, and hand the
 * subscription to `POST <base>/push/subscribe`. Also the reverse, a test push, and the listener for
 * the worker's "open this thread" message.
 */

/** @typedef {{ base?: string, serviceWorker: ServiceWorkerRegistration, headers?: Record<string, string> }} PushClientOptions */

/** @param {string} text @returns {Uint8Array<ArrayBuffer>} */
function unb64url(text) {
  const std = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {PushClientOptions} o @param {string} path @param {RequestInit} [init] */
async function call(o, path, init = {}) {
  const base = (o.base ?? "/chat").replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(o.headers ?? {}), ...(/** @type {any} */ (init.headers) ?? {}) },
  });
  const body = await res.json().catch(() => ({ ok: false, error: { code: `HTTP_${res.status}` } }));
  if (!body.ok) throw Object.assign(new Error(body.error?.message ?? body.error?.code ?? `HTTP ${res.status}`), { code: body.error?.code, status: res.status });
  return body.data;
}

/** Whether this browser can take a push at all (an iPhone only from the installed home-screen app). */
export function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * Subscribe this browser for the signed-in person. Call from a user gesture: it may ask permission.
 * @param {PushClientOptions} options
 * @returns {Promise<PushSubscription>}
 */
export async function subscribePush(options) {
  if (!pushSupported()) throw Object.assign(new Error("push is not supported here"), { code: "PUSH_UNSUPPORTED" });
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") throw Object.assign(new Error("notifications are not allowed"), { code: "PUSH_DENIED" });
  const { publicKey } = await call(options, "/push/key");
  const key = unb64url(publicKey);
  const pm = options.serviceWorker.pushManager;
  let sub = await pm.getSubscription();
  // a subscription made under another key cannot be pushed to by this server: replace it
  if (sub && sub.options.applicationServerKey) {
    const held = new Uint8Array(sub.options.applicationServerKey);
    if (held.length !== key.length || held.some((b, i) => b !== key[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await pm.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await call(options, "/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
  return sub;
}

/** @param {PushClientOptions} options */
export async function unsubscribePush(options) {
  const sub = await options.serviceWorker.pushManager.getSubscription();
  if (!sub) return false;
  await call(options, "/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }) });
  return sub.unsubscribe();
}

/** @param {PushClientOptions} options */
export function sendTestPush(options) {
  return call(options, "/push/test", { method: "POST", body: "{}" });
}

/**
 * Open a thread when the worker says a notification was clicked in an open window.
 * @param {(thread: string | null, url: string) => void} open
 * @returns {() => void} stop listening
 */
export function onOpenThreadFromPush(open) {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return () => {};
  /** @param {MessageEvent} e */
  const listener = (e) => {
    if (e.data && e.data.type === "agora-chat-open-thread") open(e.data.thread ?? null, String(e.data.url ?? "/"));
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
