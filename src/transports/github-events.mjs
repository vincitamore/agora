// @ts-check
import { AgoraError, EXIT, parseSignature } from "../core.mjs";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const NOT_MODIFIED = Symbol("not-modified");

/**
 * A room that is a feed of GitHub activity, read-only: one repository, an org, or a user. Every
 * event in the scope is a message (the actor as author, a one-line summary and the details as
 * text, the object's URL where there is one); the cursor is the event id. Scope narrows in the
 * room's config, never with a verb: `events` lists the event types to keep, `refs` the branches
 * or tags (for pushes, creates, deletes, and a pull request's base or head). Several rooms of
 * different scope sit side by side, each with its own cursor.
 * Config: { transport: "github-events", repo: "owner/name" | org: "name" | user: "login",
 *           events?: ["PushEvent", ...], refs?: ["main", "refs/heads/main", ...], tokenEnv | tokenFile }.
 * Reads are conditional (the platform asks for it and a not-modified answer is free). `post` is
 * a usage error: a feed cannot be posted to; the issue or the pull request is the room for that.
 * @param {import('../core.mjs').RoomConfig} room
 * @param {{ token: string, fetch?: typeof fetch, cache?: { get: (key: string) => Promise<string | undefined>, set: (key: string, value: string) => Promise<void> } }} deps
 * @returns {import('../core.mjs').Transport}
 */
export function githubEventsTransport(room, { token, fetch: f = globalThis.fetch, cache }) {
  const scopes = ["repo", "org", "user"].filter((k) => typeof room[k] === "string" && room[k]);
  if (scopes.length !== 1) throw new AgoraError(`github-events room needs exactly one of repo ("owner/name"), org, or user`);
  const scope = scopes[0];
  const target = String(room[scope]);
  if (scope === "repo" ? !REPO_RE.test(target) : !NAME_RE.test(target)) throw new AgoraError(`github-events ${scope} "${target}" is not a valid name`);
  const api = String(room.api ?? "https://api.github.com").replace(/\/$/, "");
  const feedPath = scope === "repo" ? `/repos/${target}/events` : scope === "org" ? `/orgs/${target}/events` : `/users/${target}/events`;
  const roomName = `${scope === "repo" ? "" : `${scope}:`}${target} events`;
  const wantTypes = Array.isArray(room.events) ? new Set(room.events.map(String)) : undefined;
  const wantRefs = Array.isArray(room.refs) ? room.refs.map(String) : undefined;

  /** @type {Map<string, string>} */
  const validators = new Map();
  /** @param {string} key */
  async function validator(key) {
    if (validators.has(key)) return validators.get(key);
    const v = await cache?.get(key);
    if (v) validators.set(key, v);
    return v;
  }

  /** @param {string} pathname @param {Record<string, string>} [params] */
  async function get(pathname, params = {}) {
    const url = new URL(`${api}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const key = url.toString();
    const etag = await validator(key);
    const res = await f(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agora",
        ...(etag ? { "if-none-match": etag } : {}),
      },
    });
    if (res.status === 304) return NOT_MODIFIED;
    const tag = res.headers.get("etag");
    if (tag && validators.get(key) !== tag) {
      validators.set(key, tag);
      await cache?.set(key, tag);
    }
    const text = await res.text();
    /** @type {any} */
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) throw new AgoraError(`github GET ${pathname}: ${res.status} ${json?.message ?? text.slice(0, 200)}`);
    return json;
  }

  /** A branch or tag name matches a configured ref by full name or by its last segment. @param {string | undefined} ref */
  function refWanted(ref) {
    if (!wantRefs) return true;
    if (!ref) return false;
    const short = ref.replace(/^refs\/(heads|tags)\//, "");
    return wantRefs.some((w) => w === ref || w.replace(/^refs\/(heads|tags)\//, "") === short);
  }

  /** The refs an event touches, so `refs` can narrow it. @param {any} e */
  function refsOf(e) {
    const p = e.payload ?? {};
    switch (e.type) {
      case "PushEvent":
      case "CreateEvent":
      case "DeleteEvent":
        return [p.ref].filter(Boolean);
      case "PullRequestEvent":
      case "PullRequestReviewEvent":
      case "PullRequestReviewCommentEvent":
        return [p.pull_request?.base?.ref, p.pull_request?.head?.ref].filter(Boolean);
      default:
        return [];
    }
  }

  /** @param {any} e */
  function wanted(e) {
    if (wantTypes && !wantTypes.has(e.type)) return false;
    if (wantRefs) {
      const refs = refsOf(e);
      if (!refs.length || !refs.some(refWanted)) return false;
    }
    return true;
  }

  /** @param {string | undefined} s */
  const firstLine = (s) => String(s ?? "").split(/\r?\n/)[0].trim();

  /** One line saying what happened, then the details; and where it happened. @param {any} e */
  function describe(e) {
    const p = e.payload ?? {};
    const repo = e.repo?.name ?? target;
    const short = (/** @type {string | undefined} */ ref) => String(ref ?? "").replace(/^refs\/(heads|tags)\//, "");
    switch (e.type) {
      case "PushEvent": {
        const commits = Array.isArray(p.commits) ? p.commits : [];
        const head = `pushed ${commits.length || "?"} commit${commits.length === 1 ? "" : "s"} to ${short(p.ref)} in ${repo}`;
        const lines = commits.map((/** @type {any} */ c) => `  ${String(c.sha ?? "").slice(0, 7)} ${firstLine(c.message)}`);
        return { text: [head, ...lines].join("\n"), url: p.before && p.head ? `https://github.com/${repo}/compare/${p.before}...${p.head}` : undefined, body: undefined };
      }
      case "CreateEvent":
        return { text: `created ${p.ref_type} ${p.ref ?? repo} in ${repo}`, url: p.ref_type === "branch" && p.ref ? `https://github.com/${repo}/tree/${p.ref}` : undefined, body: undefined };
      case "DeleteEvent":
        return { text: `deleted ${p.ref_type} ${p.ref} in ${repo}`, url: undefined, body: undefined };
      case "PullRequestEvent": {
        const pr = p.pull_request ?? {};
        return { text: `${p.action} pull request #${p.number ?? pr.number}: ${firstLine(pr.title)} (${short(pr.head?.ref)} -> ${short(pr.base?.ref)}) in ${repo}`, url: pr.html_url, body: undefined };
      }
      case "PullRequestReviewEvent": {
        const pr = p.pull_request ?? {};
        const r = p.review ?? {};
        return { text: `reviewed pull request #${pr.number}: ${String(r.state ?? "").toLowerCase()}${r.body ? `\n  ${firstLine(r.body)}` : ""} in ${repo}`, url: r.html_url ?? pr.html_url, body: r.body };
      }
      case "PullRequestReviewCommentEvent": {
        const pr = p.pull_request ?? {};
        const c = p.comment ?? {};
        return { text: `commented on pull request #${pr.number} at ${c.path ?? "?"}: ${firstLine(c.body)} in ${repo}`, url: c.html_url, body: c.body };
      }
      case "IssuesEvent": {
        const i = p.issue ?? {};
        return { text: `${p.action} issue #${i.number}: ${firstLine(i.title)} in ${repo}`, url: i.html_url, body: undefined };
      }
      case "IssueCommentEvent": {
        const i = p.issue ?? {};
        const c = p.comment ?? {};
        return { text: `commented on #${i.number}: ${firstLine(c.body)} in ${repo}`, url: c.html_url, body: c.body };
      }
      case "ReleaseEvent": {
        const r = p.release ?? {};
        return { text: `${p.action} release ${r.tag_name ?? ""}${r.name ? ` (${firstLine(r.name)})` : ""} in ${repo}`, url: r.html_url, body: undefined };
      }
      case "ForkEvent":
        return { text: `forked ${repo} to ${p.forkee?.full_name ?? "?"}`, url: p.forkee?.html_url, body: undefined };
      default:
        return { text: `${e.type}${p.action ? ` ${p.action}` : ""} in ${repo}`, url: undefined, body: undefined };
    }
  }

  /** @param {any} e */
  function toMessage(e) {
    const login = String(e.actor?.login ?? "unknown");
    const { text, url, body } = describe(e);
    return /** @type {import('../core.mjs').Message} */ ({
      id: String(e.id),
      room: roomName,
      author: { id: login, name: login, kind: /\[bot\]$/.test(login) ? "agent" : "human" },
      text,
      signedAs: body ? parseSignature(String(body)) : undefined,
      ts: String(e.created_at),
      cursor: String(e.id),
      url,
      raw: e,
    });
  }

  return {
    kind: "github-events",
    room: roomName,
    threads: false,
    async whoami() {
      const u = await get("/user");
      return { id: String(u.id), name: String(u.login) };
    },
    async read({ thread, since, limit = 100 } = {}) {
      if (thread) throw new AgoraError(`a feed has no threads`, EXIT.usage);
      const floor = since ? BigInt(since) : undefined;
      /** @type {any[]} */
      const raw = [];
      for (let page = 1; page <= 3; page++) {
        const batch = await get(feedPath, { per_page: "100", page: String(page) });
        if (batch === NOT_MODIFIED || !Array.isArray(batch) || batch.length === 0) break;
        let past = false;
        for (const e of batch) {
          if (floor !== undefined && BigInt(String(e.id)) <= floor) {
            past = true;
            continue;
          }
          if (wanted(e)) raw.push(e);
        }
        if (past || batch.length < 100) break;
      }
      raw.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
      const window = since ? raw.slice(0, limit) : raw.slice(-limit);
      return window.map(toMessage);
    },
    async post() {
      throw new AgoraError(`a feed is read-only; post to the issue or the pull request instead`, EXIT.usage);
    },
  };
}
