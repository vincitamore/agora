// @ts-check
import { AgoraError, parseSignature } from "../core.mjs";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** @param {string} createdAt @param {number} id */
const encodeCursor = (createdAt, id) => `${createdAt}|${id}`;
/** @param {string | undefined} cursor */
function decodeCursor(cursor) {
  if (!cursor) return undefined;
  const [ts, id] = cursor.split("|");
  if (!ts) throw new AgoraError(`bad cursor "${cursor}" for a github room`);
  return { ts, id: Number(id ?? 0) };
}

/** What a read returns when the record has not changed since the validator we sent. */
const NOT_MODIFIED = Symbol("not-modified");

/**
 * A room that is one GitHub issue: comments are the messages, and there are no threads.
 * Config: { transport: "github", repo: "owner/name", issue: 3, tokenEnv | tokenFile }.
 * Without a token reference the GitHub CLI's signed-in token is used.
 *
 * Reads are conditional: the validator from each response is kept and sent back on the next
 * request for that URL, and a not-modified answer is an empty batch that costs nothing against
 * the rate limit. `cache` makes the validators outlive the process, which is the only way they
 * help a watch that re-arms; without one they last as long as this transport instance.
 * @param {import('../core.mjs').RoomConfig} room
 * @param {{ token: string, fetch?: typeof fetch, cache?: { get: (key: string) => Promise<string | undefined>, set: (key: string, value: string) => Promise<void> } }} deps
 * @returns {import('../core.mjs').Transport}
 */
export function githubTransport(room, { token, fetch: f = globalThis.fetch, cache }) {
  const repo = String(room.repo ?? "");
  const issue = Number(room.issue);
  if (!REPO_RE.test(repo)) throw new AgoraError(`github room needs repo as "owner/name"`);
  if (!Number.isInteger(issue) || issue <= 0) throw new AgoraError(`github room needs an issue number`);
  const api = String(room.api ?? "https://api.github.com").replace(/\/$/, "");
  const roomName = `${repo}#${issue}`;

  /** @type {Map<string, string>} */
  const validators = new Map();

  /** @param {string} key */
  async function validator(key) {
    if (validators.has(key)) return validators.get(key);
    const v = await cache?.get(key);
    if (v) validators.set(key, v);
    return v;
  }

  /** @param {string} pathname @param {{ method?: string, body?: unknown, params?: Record<string, string>, conditional?: boolean }} [opts] */
  async function call(pathname, { method = "GET", body, params, conditional = false } = {}) {
    const url = new URL(`${api}${pathname}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const key = url.toString();
    const etag = conditional ? await validator(key) : undefined;
    const res = await f(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agora",
        ...(etag ? { "if-none-match": etag } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (conditional && res.status === 304) return NOT_MODIFIED;
    if (conditional) {
      const tag = res.headers.get("etag");
      if (tag && validators.get(key) !== tag) {
        validators.set(key, tag);
        await cache?.set(key, tag);
      }
    }
    const text = await res.text();
    /** @type {any} */
    let json = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const msg = json?.message ?? text.slice(0, 200);
      throw new AgoraError(`github ${method} ${pathname}: ${res.status} ${msg}`);
    }
    return json;
  }

  /** @param {any} c */
  function toMessage(c) {
    const login = c.user?.login ?? "unknown";
    const text = String(c.body ?? "");
    return /** @type {import('../core.mjs').Message} */ ({
      id: String(c.id),
      room: roomName,
      author: { id: login, name: login, kind: c.user?.type === "Bot" ? "agent" : "human" },
      text,
      signedAs: parseSignature(text),
      ts: String(c.created_at),
      cursor: encodeCursor(String(c.created_at), Number(c.id)),
      url: c.html_url,
      raw: c,
    });
  }

  return {
    kind: "github",
    room: roomName,
    threads: false,
    async whoami() {
      const u = await call("/user");
      return { id: String(u.id), name: String(u.login) };
    },
    async read({ thread, since, limit = 100 } = {}) {
      if (thread) throw new AgoraError(`github rooms have no threads; the issue is the thread`);
      const from = decodeCursor(since);
      /** @type {import('../core.mjs').Message[]} */
      const out = [];
      for (let page = 1; page <= 10; page++) {
        /** @type {Record<string, string>} */
        const params = { per_page: "100", page: String(page) };
        if (from) params.since = from.ts;
        const batch = await call(`/repos/${repo}/issues/${issue}/comments`, { params, conditional: true });
        if (batch === NOT_MODIFIED) break; // the record has not changed: an empty batch, not an error
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const c of batch) {
          const created = String(c.created_at);
          // `since` filters on updated_at, so an edited old comment comes back; created_at + id keeps it out.
          if (from && (created < from.ts || (created === from.ts && Number(c.id) <= from.id))) continue;
          out.push(toMessage(c));
        }
        if (batch.length < 100) break;
      }
      out.sort((a, b) => (a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0));
      return out.slice(0, limit);
    },
    async post(text, { thread } = {}) {
      if (thread) throw new AgoraError(`github rooms have no threads; the issue is the thread`);
      const c = await call(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: { body: text } });
      return { id: String(c.id), cursor: encodeCursor(String(c.created_at), Number(c.id)), url: c.html_url };
    },
  };
}
