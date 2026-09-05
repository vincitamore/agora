// @ts-check
import { AgoraError, parseSignature } from "../core.mjs";
import { failedBeforeSend } from "./slack.mjs";

/** GitHub refuses an issue comment body past this many characters (a 422); a face refuses before the call. */
export const GITHUB_COMMENT_MAX = 65536;

/** Pages one reconciliation window walks; a face settles inside seconds, so a window is small. */
const GITHUB_HISTORY_WINDOW_PAGES = 3;

/**
 * A GitHub call that failed, carrying the one fact a face needs and the message alone cannot say:
 * whether GitHub ANSWERED. `answered` is true for a non-429 4xx (the request was refused; nothing
 * landed; a face records `refused`), false for a link death after send, a 5xx, or a 429 (the
 * request may have landed, or was throttled before it did; a face records `unknown` and
 * reconciles against the issue before any retry). `sent` is false only when no connection could be
 * made, which is the one failure that cannot have landed anything. The same facts as
 * `SlackApiError`, so the faces layer classifies both by the facts and never by the class.
 */
export class GitHubApiError extends AgoraError {
  /** @param {string} message @param {{ answered: boolean, sent?: boolean, status?: number, error?: string, method?: string }} facts */
  constructor(message, facts) {
    super(message);
    this.name = "GitHubApiError";
    this.answered = facts.answered;
    this.sent = facts.sent ?? true;
    this.status = facts.status;
    this.error = facts.error;
    this.method = facts.method;
  }
}

/**
 * The face half of the github transport (P5): what `src/faces.mjs` needs of this transport that the
 * shared contract does not say, keyed into its registry by transport name. Every function here reads
 * a raw comment object as the API returns it. GitHub has no per-comment metadata field, so there is
 * no rider: a lost response is reconciled by the seat's own account and the payload digest, and two
 * byte-identical bodies inside one window quarantine (the ladder the design names for a workspace
 * without the rider). Issue comments take no file upload through the API, so `pictures` here is the
 * honest text form: the attachment's link when it has a public one, else its digest.
 * @type {import('../faces.mjs').FaceHalf}
 */
export const githubFaceHalf = Object.freeze({
  transport: "github",
  textMax: GITHUB_COMMENT_MAX,
  encode: (text) => text,
  tooLong: (n) => `too-long: the github face is ${n} characters and the limit is ${GITHUB_COMMENT_MAX}`,
  threads: false,
  noThread: "thread: github rooms have no threads; the issue is the thread",
  uploads: false,
  noUpload: "picture not uploaded: github issue comments take no file upload through the API; the face carries the attachment's link or its digest as text",
  addHint: (alias) => `agora room faces ${alias} --add github --via <github room>`,
  postOptions: () => ({}),
  window: (oldestMs, latestMs) => ({ since: new Date(oldestMs).toISOString(), until: new Date(latestMs).toISOString() }),
  idOf: (raw) => String(raw?.id),
  rider: () => undefined,
  ownAccount: (raw, who) => Boolean(raw?.user) && (String(raw.user.id) === who.id || raw.user.login === who.name),
  textOf: (raw) => (typeof raw?.body === "string" ? raw.body : undefined),
  fileIds: () => [],
  pictureLine: (a, line) => `${line} ${typeof a.url === "string" && /^https?:\/\//.test(a.url) ? `<${a.url}>` : String(a.digest ?? "no digest")}`,
});

/**
 * The face half of the transport object (P5): what `src/faces.mjs` calls beyond the shared
 * Transport contract. Reachable only through a face; the CLI's verbs never call it.
 * @typedef {object} GitHubFaceTransport
 * @property {(window: { since: string, until: string }) => Promise<{ messages: any[], complete: boolean }>} history
 */

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
 * @returns {import('../core.mjs').Transport & GitHubFaceTransport}
 */
export function githubTransport(room, { token, fetch: f = globalThis.fetch, cache }) {
  const repo = String(room.repo ?? "");
  const issue = Number(room.issue);
  if (!REPO_RE.test(repo)) throw new AgoraError(`github room needs repo as "owner/name"`);
  if (!Number.isInteger(issue) || issue <= 0) throw new AgoraError(`github room needs an issue number`);
  const api = String(room.api ?? "https://api.github.com").replace(/\/$/, "");
  const roomName = `${repo}#${issue}`;

  /** @typedef {{ etag: string, body?: unknown }} Cached */
  /** @type {Map<string, Cached>} */
  const cached = new Map();

  /** @param {string} key */
  async function loadCached(key) {
    const hit = cached.get(key);
    if (hit) return hit;
    const raw = await cache?.get(key);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof parsed.etag === "string") {
        cached.set(key, parsed);
        return parsed;
      }
    } catch {
      /* legacy: the value was the etag itself */
    }
    const legacy = { etag: raw };
    cached.set(key, legacy);
    return legacy;
  }

  /** @param {string} key @param {Cached} entry */
  async function saveCached(key, entry) {
    cached.set(key, entry);
    await cache?.set(key, JSON.stringify(entry));
  }

  /** @param {string} pathname @param {{ method?: string, body?: unknown, params?: Record<string, string>, conditional?: boolean }} [opts] */
  async function call(pathname, { method = "GET", body, params, conditional = false } = {}) {
    const url = new URL(`${api}${pathname}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const key = url.toString();
    const prev = conditional ? await loadCached(key) : undefined;
    let res;
    try {
      res = await f(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "agora",
          ...(prev?.etag ? { "if-none-match": prev.etag } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // never echo the request: a fetch failure can carry the URL it was sent to
      throw new GitHubApiError(`github ${method} ${pathname}: ${failedBeforeSend(e) ? "unreachable" : "the link died during the request"}`,
        { answered: false, sent: !failedBeforeSend(e), method });
    }
    if (conditional && res.status === 304) {
      if (prev && "body" in prev) return prev.body;
      return NOT_MODIFIED;
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
      // a non-429 4xx is GitHub's answer to this request; a 5xx is a gateway that may have relayed
      // it, and a 429 was throttled before or after it landed: neither is proof of nothing
      throw new GitHubApiError(`github ${method} ${pathname}: ${res.status} ${msg}`, { answered: res.status < 500 && res.status !== 429, status: res.status, error: String(msg), method });
    }
    if (conditional) {
      const tag = res.headers.get("etag");
      if (tag) await saveCached(key, { etag: tag, body: json });
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

  return /** @type {import('../core.mjs').Transport & GitHubFaceTransport} */ ({
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
        if (batch === NOT_MODIFIED) break; // legacy etag-only cache: no body to re-filter
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const c of batch) {
          const created = String(c.created_at);
          // `since` filters on updated_at, so an edited old comment comes back; created_at + id keeps it out.
          if (from && (created < from.ts || (created === from.ts && Number(c.id) <= from.id))) continue;
          out.push(toMessage(c));
        }
        if (batch.length < 100) break;
      }
      out.sort((a, b) => {
        if (a.ts < b.ts) return -1;
        if (a.ts > b.ts) return 1;
        return Number(a.id) - Number(b.id);
      });
      return from ? out.slice(0, limit) : out.slice(-limit);
    },
    /**
     * The face half (P5). A bounded window of raw comments for reconciling a face whose response
     * was lost: every comment created inside `[since, until]`, as the API returns them, oldest
     * first. An unconditional read (no validator): the question is what the issue holds NOW.
     * Throws on a failed read; the caller never reposts on a throw.
     * @param {{ since: string, until: string }} window ISO-8601 bounds, inclusive
     */
    async history({ since, until }) {
      /** @type {any[]} */
      const raw = [];
      let complete = false;
      for (let page = 1; page <= GITHUB_HISTORY_WINDOW_PAGES; page++) {
        const batch = await call(`/repos/${repo}/issues/${issue}/comments`, { params: { per_page: "100", page: String(page), since } });
        if (!Array.isArray(batch)) throw new GitHubApiError(`github GET comments: not a list`, { answered: true, method: "GET" });
        // `since` filters on updated_at; the window is on created_at, so an edited old comment is dropped here
        for (const c of batch) {
          const created = new Date(String(c.created_at)).toISOString();
          if (created >= since && created <= until) raw.push(c);
        }
        if (batch.length < 100) { complete = true; break; }
      }
      raw.sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : String(a.created_at) > String(b.created_at) ? 1 : Number(a.id) - Number(b.id)));
      return { messages: raw, complete };
    },
    async post(text, { thread } = {}) {
      if (thread) throw new AgoraError(`github rooms have no threads; the issue is the thread`);
      const c = await call(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: { body: text } });
      return { id: String(c.id), cursor: encodeCursor(String(c.created_at), Number(c.id)), url: c.html_url };
    },
  });
}
