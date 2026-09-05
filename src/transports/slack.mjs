// @ts-check
import { AgoraError, EXIT, jitter, parseSignature, sleep as defaultSleep } from "../core.mjs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "group_join", "group_leave"]);
/** Subtypes that are still a person (or bot) speaking, not a platform event. */
const SPEECH_SUBTYPES = new Set(["bot_message", "thread_broadcast", "me_message", "file_share"]);

/** Slack splits a chat.postMessage around this many characters; refuse past it unless the caller chunks. */
export const SLACK_TEXT_MAX = 3900;

/**
 * Pages of history one read walks before it gives up, unless the caller asks for more (`--pages`).
 * Ten pages is 2,000 messages: enough for any live room, and a bearer that knows it is further
 * behind than that walks deeper deliberately rather than having the tool decide for it.
 */
export const SLACK_READ_PAGES = 10;

/** A screenshot is useful; an unbounded authenticated download is a disk-fill primitive. */
export const SLACK_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const SLACK_IMAGE_MAX_PER_MESSAGE = 8;

/** @param {any} file */
function attachmentMeta(file) {
  const mimetype = typeof file.mimetype === "string" ? file.mimetype : undefined;
  const size = Number(file.size);
  return /** @type {import('../core.mjs').Attachment} */ ({
    id: String(file.id ?? "unknown"),
    name: String(file.name ?? file.title ?? file.id ?? "attachment"),
    kind: mimetype?.startsWith("image/") ? "image" : "file",
    ...(mimetype ? { mimetype } : {}),
    ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
    ...(Number.isFinite(Number(file.original_w)) ? { width: Number(file.original_w) } : {}),
    ...(Number.isFinite(Number(file.original_h)) ? { height: Number(file.original_h) } : {}),
    ...(typeof file.permalink === "string" ? { url: file.permalink } : {}),
  });
}

/**
 * Slack's file object contains credential-gated download and thumbnail URLs. `raw` is part of the
 * public JSON message contract, so preserve the diagnostic record without turning those transport
 * URLs into output. The human-facing permalink remains available in attachment metadata.
 * @param {any} file
 */
function publicFile(file) {
  return Object.fromEntries(
    Object.entries(file ?? {}).filter(([key]) => key !== "url_private" && key !== "url_private_download" && !key.startsWith("thumb_")),
  );
}

/** @param {any} message */
function publicRaw(message) {
  if (!Array.isArray(message.files)) return message;
  return {
    ...message,
    files: message.files.map(publicFile),
  };
}

/** @param {any} file */
function imageExtension(file) {
  const byMime = new Map([
    ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/gif", ".gif"],
    ["image/webp", ".webp"], ["image/bmp", ".bmp"], ["image/tiff", ".tiff"],
    ["image/heic", ".heic"], ["image/heif", ".heif"], ["image/svg+xml", ".svg"],
  ]);
  const mime = String(file.mimetype ?? "").toLowerCase();
  const known = byMime.get(mime);
  if (known) return known;
  const ext = path.extname(String(file.name ?? "")).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".image";
}

/** Read a response without letting a false or absent Content-Length bypass the cap. @param {Response} res @param {number} max */
async function boundedBody(res, max) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new AgoraError(`image exceeds the ${max}-byte materialization limit`);
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > max) {
      await reader.cancel();
      throw new AgoraError(`image exceeds the ${max}-byte materialization limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** Split text so each piece is at most `budget` characters, preferring line boundaries. @param {string} text @param {number} budget */
export function chunkAtLines(text, budget) {
  if (budget < 1) throw new AgoraError(`chunk budget must be positive`, EXIT.usage);
  if (text.length <= budget) return [text];
  const lines = text.split(/\n/);
  /** @type {string[]} */
  const out = [];
  let cur = "";
  for (const line of lines) {
    const candidate = cur.length ? `${cur}\n${line}` : line;
    if (candidate.length <= budget) {
      cur = candidate;
      continue;
    }
    if (cur) out.push(cur);
    if (line.length <= budget) cur = line;
    else {
      for (let i = 0; i < line.length; i += budget) out.push(line.slice(i, i + budget));
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

const KEEP_TOKEN = /<@U[A-Z0-9]+(?:\|[^>]*)?>|<#C[A-Z0-9]+(?:\|[^>]*)?>|<https?:\/\/[^>]+>/g;
const THREAD_TS = /^\d{10}\.\d{6}$/;

/**
 * Why `id` is not a Slack thread id (the parent message's ts: 10 digits, a dot, 6 digits), or
 * nothing when it is one. The Transport hook contract: a reason string names the malformation so
 * the caller boundary (`--thread`, `--re`) can refuse with it, and a follow set or a carry fold
 * can report it, before any read is spent on an id Slack cannot resolve. `read()` itself never
 * refuses. The reason does not repeat the id; the caller prefixes it.
 *
 * The malformation this exists for: PowerShell parses an unquoted `1788589282.659969` as a
 * number and hands the tool `1788589282.65997`, which is a `thread_not_found` on every read.
 * @param {unknown} id
 * @returns {string | undefined}
 */
export function validateThread(id) {
  const shape = "a Slack thread id is the parent message's ts: 10 digits, a dot, 6 digits (like 1788589282.659969)";
  if (typeof id !== "string") return `${shape}; got ${id === undefined || id === null ? "nothing" : `a ${typeof id}`}`;
  if (!id.trim()) return `${shape}; got an empty string`;
  if (THREAD_TS.test(id)) return undefined;
  const m = /^(\d+)\.(\d+)$/.exec(id);
  if (!m) return `${shape}; ${JSON.stringify(id)} is not a ts at all`;
  const [, secs, frac] = m;
  if (secs.length !== 10) return `${shape}; ${secs.length} digit${secs.length === 1 ? "" : "s"} before the dot, not 10`;
  const n = frac.length;
  const digits = `${n} digit${n === 1 ? "" : "s"} after the dot, not 6`;
  // fewer digits than Slack ever emits is the shell's doing, not a typo: the cure is quoting
  return n < 6 ? `${shape}; ${digits} (an unquoted ts loses its trailing digits under PowerShell; quote it)` : `${shape}; ${digits}`;
}

/** Slack's API entity-encodes & < > on the way out. Decode so a reader sees the text that was posted. @param {string} text */
export function decodeSlackText(text) {
  return String(text).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Escape & < > on the way in, except recognised mention / channel / URL tokens. @param {string} text */
export function encodeSlackText(text) {
  const s = String(text);
  /** @param {string} plain */
  const esc = (plain) => plain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = "";
  let last = 0;
  for (const m of s.matchAll(KEEP_TOKEN)) {
    out += esc(s.slice(last, m.index));
    out += m[0];
    last = /** @type {number} */ (m.index) + m[0].length;
  }
  return out + esc(s.slice(last));
}

/**
 * A room that is one Slack channel; threads are Slack threads (`thread` = the parent ts).
 * Config: { transport: "slack", channel: "C0123ABC", tokenEnv | tokenFile }.
 * The token is a bot token (xoxb-…) whose app has been invited to the channel.
 * Scopes: channels:history, channels:read, chat:write, groups:history, groups:read, users:read.
 * @param {import('../core.mjs').RoomConfig} room
 * @param {{ token: string, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, random?: () => number, mediaDir?: string, imageMaxBytes?: number }} deps
 * @returns {import('../core.mjs').Transport}
 */
export function slackTransport(room, { token, fetch: f = globalThis.fetch, sleep = defaultSleep, random = Math.random, mediaDir, imageMaxBytes = SLACK_IMAGE_MAX_BYTES }) {
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
        // every rate-limited watcher is handed the same retry-after, so the wait is jittered:
        // without it a loose herd comes back as a tight one and limits itself again
        const wait = Number(res.headers.get("retry-after") ?? "2");
        await sleep(jitter(Math.max(1, wait) * 1000, random));
        continue;
      }
      if (!res.ok) {
        throw new AgoraError(`slack ${method}: HTTP ${res.status}`);
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

  /**
   * Materialize only images: screenshots become inspectable local paths while arbitrary shared
   * binaries remain inert metadata. Slack file URLs require the same Bearer token plus files:read;
   * the token is used on the request and never written beside the bytes or returned in a message.
   * @param {any} file
   * @param {number} imageIndex
   */
  async function attachment(file, imageIndex) {
    const meta = attachmentMeta(file);
    if (meta.kind !== "image" || !mediaDir) return meta;
    if (imageIndex >= SLACK_IMAGE_MAX_PER_MESSAGE)
      return { ...meta, error: `not materialized: more than ${SLACK_IMAGE_MAX_PER_MESSAGE} images on one message` };
    if (typeof file.url_private_download !== "string" && typeof file.url_private !== "string")
      return { ...meta, error: "not materialized: Slack supplied no private download URL" };
    if (typeof meta.size === "number" && meta.size > imageMaxBytes)
      return { ...meta, error: `not materialized: image exceeds the ${imageMaxBytes}-byte limit` };
    const safeId = String(file.id ?? "attachment").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "attachment";
    const target = path.resolve(mediaDir, `${safeId}${imageExtension(file)}`);
    try {
      const existing = await stat(target).catch(() => undefined);
      if (existing?.isFile() && existing.size > 0 && (meta.size === undefined || existing.size === meta.size)) return { ...meta, path: target };
      const res = await f(String(file.url_private_download ?? file.url_private), { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const hint = res.status === 403 ? "; reinstall the Slack app with files:read" : "";
        return { ...meta, error: `not materialized: Slack file download returned HTTP ${res.status}${hint}` };
      }
      const contentType = res.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType && !contentType.startsWith("image/"))
        return { ...meta, error: `not materialized: Slack returned ${contentType} for an image` };
      const bytes = await boundedBody(res, imageMaxBytes);
      await mkdir(mediaDir, { recursive: true });
      const temp = `${target}.${process.pid}.${Date.now()}.part`;
      await writeFile(temp, bytes, { flag: "wx" });
      try {
        await rename(temp, target);
      } catch (e) {
        await rm(temp, { force: true });
        const won = await stat(target).catch(() => undefined);
        if (!won?.isFile()) throw e;
      }
      // Stat once after the atomic rename: a zero-byte proxy response is not a viewable image.
      const saved = await stat(target);
      if (!saved.size) {
        await rm(target, { force: true });
        return { ...meta, error: "not materialized: Slack returned an empty image" };
      }
      return { ...meta, path: target };
    } catch (e) {
      // Network errors can include the private URL in their message. Never echo them.
      return { ...meta, error: e instanceof AgoraError ? `not materialized: ${e.message}` : "not materialized: authenticated download failed" };
    }
  }

  /** @param {any} m @param {string | undefined} thread */
  async function toMessage(m, thread) {
    const subtype = typeof m.subtype === "string" ? m.subtype : undefined;
    const isBot = Boolean(m.bot_id) || subtype === "bot_message";
    const isSystem = Boolean(subtype) && !SPEECH_SUBTYPES.has(subtype);
    const id = String(m.user ?? m.bot_id ?? "unknown");
    let name = m.username ?? m.bot_profile?.name ?? m.user_profile?.real_name;
    if (!name) name = m.user ? await userName(m.user) : id;
    const text = decodeSlackText(String(m.text ?? ""));
    const files = Array.isArray(m.files) ? m.files : [];
    let imageIndex = 0;
    const attachments = [];
    for (const file of files) {
      const isImage = String(file?.mimetype ?? "").startsWith("image/");
      attachments.push(await attachment(file, isImage ? imageIndex++ : -1));
    }
    return /** @type {import('../core.mjs').Message} */ ({
      id: String(m.ts),
      room: channel,
      thread: thread ?? (m.thread_ts && m.thread_ts !== m.ts ? String(m.thread_ts) : undefined),
      author: { id, name: String(name), kind: isSystem ? "system" : isBot ? "agent" : "human" },
      text,
      signedAs: parseSignature(text),
      ts: new Date(Number(m.ts) * 1000).toISOString(),
      cursor: String(m.ts),
      raw: publicRaw(m),
      ...(subtype ? { subtype } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
  }

  return {
    kind: "slack",
    room: channel,
    threads: true,
    // the boundary guard the CLI, the watch and carry consult; a transport that does not carry it
    // is one whose malformed ids reach the API and come back as thread_not_found
    validateThread,
    async whoami() {
      const body = await call("auth.test", {});
      return { id: String(body.user_id), name: String(body.user) };
    },
    async read({ thread, since, limit = 200, pages = SLACK_READ_PAGES } = {}) {
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
      /** the deepest position the walk reached: the oldest message of the last page it took */
      let oldestFetched;
      /** true while Slack still has older messages beyond the page just taken */
      let deeper = false;
      /** why the walk stopped before the cursor, when something other than the cap stopped it */
      let stopped;
      let walked = 0;
      for (let page = 0; page < pages; page++) {
        /** @type {any} */
        let body;
        try {
          body = await call(method, cursor ? { ...base, cursor } : base);
        } catch (e) {
          // nothing collected yet is a failed read and stays a thrown error; a walk cut short after
          // real pages is the same fact as the cap -- an unreached cursor, reported as a gap
          if (!walked) throw e;
          stopped = e instanceof Error ? e.message : String(e);
          break;
        }
        walked++;
        const pageMessages = body.messages ?? [];
        if (pageMessages.length) oldestFetched = String(pageMessages[pageMessages.length - 1].ts);
        for (const m of pageMessages) {
          if (thread && m.ts === thread) continue; // the parent is not a reply
          if (since && Number(m.ts) <= Number(since)) continue;
          if (SKIP_SUBTYPES.has(m.subtype)) continue;
          if (!thread && m.thread_ts && m.thread_ts !== m.ts && m.subtype !== "thread_broadcast") continue; // replies live in their thread
          raw.push(m);
        }
        cursor = body.response_metadata?.next_cursor || undefined;
        deeper = Boolean(cursor && body.has_more);
        if (!deeper) break;
      }
      // A read after a cursor pages until it reaches that cursor. When it cannot -- the page cap, or
      // a walk cut short -- the oldest `limit` of what it did collect is NOT the oldest unseen: it is
      // a window from the middle of the backlog that looks exactly like a complete one, and the
      // watcher that saves its last cursor steps over everything below it, permanently and silently.
      // So the read returns nothing and says why. Never a silent jump.
      if (since && (deeper || stopped)) {
        const out = /** @type {import('../core.mjs').ReadResult} */ ([]);
        out.gap = {
          reason: stopped ? `the walk stopped after ${walked} of ${pages} pages: ${stopped}` : `backlog deeper than ${pages} pages`,
          ...(oldestFetched ? { oldestFetched } : {}),
          pages,
        };
        return out;
      }
      raw.sort((a, b) => Number(a.ts) - Number(b.ts));
      // After a cursor, the oldest `limit` come first so a watcher advances in order and the next
      // poll continues. Without one, the newest `limit`: a read to orient, or `cursor --now`,
      // wants the latest messages, not the oldest of the paged window.
      const window = since ? raw.slice(0, limit) : raw.slice(-limit);
      const out = /** @type {import('../core.mjs').ReadResult} */ ([]);
      for (const m of window) out.push(await toMessage(m, thread));
      return out;
    },
    async post(text, { thread } = {}) {
      const payload = encodeSlackText(text);
      if (payload.length > SLACK_TEXT_MAX) {
        throw new AgoraError(`slack post is ${payload.length} rendered characters (trailers and signature included); the limit is ${SLACK_TEXT_MAX}`, EXIT.usage);
      }
      /** @type {Record<string, string>} */
      const params = { channel, text: payload };
      if (thread) params.thread_ts = thread;
      const body = await call("chat.postMessage", params, { post: true });
      return { id: String(body.ts), cursor: String(body.ts) };
    },
  };
}
