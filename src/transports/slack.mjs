// @ts-check
import { AgoraError, parseSignature, sleep as defaultSleep } from "../core.mjs";

const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "group_join", "group_leave"]);

/**
 * A room that is one Slack channel; threads are Slack threads (`thread` = the parent ts).
 * Config: { transport: "slack", channel: "C0123ABC", tokenEnv | tokenFile }.
 * The token is a bot token (xoxb-…) whose app has been invited to the channel.
 * Scopes: channels:history, channels:read, chat:write, groups:history, groups:read, users:read.
 * @param {import('../core.mjs').RoomConfig} room
 * @param {{ token: string, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} deps
 * @returns {import('../core.mjs').Transport}
 */
export function slackTransport(room, { token, fetch: f = globalThis.fetch, sleep = defaultSleep }) {
  const channel = String(room.channel ?? "");
  if (!/^[A-Z][A-Z0-9]+$/.test(channel)) throw new AgoraError(`slack room needs a channel id (like C0123ABC), not a name`);
  const api = String(room.api ?? "https://slack.com/api").replace(/\/$/, "");
  /** @type {Map<string, string>} */
  const names = new Map();

  /** @param {string} method @param {Record<string, string>} params @param {{ post?: boolean }} [opts] */
  async function call(method, params, { post = false } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = post
        ? await f(`${api}/${method}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify(params),
          })
        : await f(`${api}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after") ?? "2");
        await sleep(Math.max(1, wait) * 1000);
        continue;
      }
      /** @type {any} */
      const body = await res.json();
      if (!body.ok) throw new AgoraError(`slack ${method}: ${body.error ?? "not ok"}`);
      return body;
    }
    throw new AgoraError(`slack ${method}: rate limited`);
  }

  /** @param {string} id */
  async function userName(id) {
    const cached = names.get(id);
    if (cached) return cached;
    try {
      const body = await call("users.info", { user: id });
      const name = body.user?.real_name || body.user?.name || id;
      names.set(id, name);
      return name;
    } catch {
      names.set(id, id);
      return id;
    }
  }

  /** @param {any} m @param {string | undefined} thread */
  async function toMessage(m, thread) {
    const isBot = Boolean(m.bot_id) || m.subtype === "bot_message";
    const id = String(m.user ?? m.bot_id ?? "unknown");
    let name = m.username ?? m.bot_profile?.name ?? m.user_profile?.real_name;
    if (!name) name = m.user ? await userName(m.user) : id;
    const text = String(m.text ?? "");
    return /** @type {import('../core.mjs').Message} */ ({
      id: String(m.ts),
      room: channel,
      thread: thread ?? (m.thread_ts && m.thread_ts !== m.ts ? String(m.thread_ts) : undefined),
      author: { id, name: String(name), kind: isBot ? "agent" : "human" },
      text,
      signedAs: parseSignature(text),
      ts: new Date(Number(m.ts) * 1000).toISOString(),
      cursor: String(m.ts),
      raw: m,
    });
  }

  return {
    kind: "slack",
    room: channel,
    threads: true,
    async whoami() {
      const body = await call("auth.test", {});
      return { id: String(body.user_id), name: String(body.user) };
    },
    async read({ thread, since, limit = 200 } = {}) {
      /** @type {Record<string, string>} */
      const base = { channel, limit: "200" };
      if (since) {
        base.oldest = since;
        base.inclusive = "false";
      }
      const method = thread ? "conversations.replies" : "conversations.history";
      if (thread) base.ts = thread;
      /** @type {any[]} */
      const raw = [];
      let cursor;
      for (let page = 0; page < 10; page++) {
        const body = await call(method, cursor ? { ...base, cursor } : base);
        for (const m of body.messages ?? []) {
          if (thread && m.ts === thread) continue; // the parent is not a reply
          if (since && Number(m.ts) <= Number(since)) continue;
          if (SKIP_SUBTYPES.has(m.subtype)) continue;
          if (!thread && m.thread_ts && m.thread_ts !== m.ts && m.subtype !== "thread_broadcast") continue; // replies live in their thread
          raw.push(m);
        }
        cursor = body.response_metadata?.next_cursor || undefined;
        if (!cursor || !body.has_more) break;
      }
      raw.sort((a, b) => Number(a.ts) - Number(b.ts));
      // After a cursor, the oldest `limit` come first so a watcher advances in order and the next
      // poll continues. Without one, the newest `limit`: a read to orient, or `cursor --now`,
      // wants the latest messages, not the oldest of the paged window.
      const window = since ? raw.slice(0, limit) : raw.slice(-limit);
      const out = [];
      for (const m of window) out.push(await toMessage(m, thread));
      return out;
    },
    async post(text, { thread } = {}) {
      /** @type {Record<string, string>} */
      const params = { channel, text };
      if (thread) params.thread_ts = thread;
      const body = await call("chat.postMessage", params, { post: true });
      return { id: String(body.ts), cursor: String(body.ts) };
    },
  };
}
