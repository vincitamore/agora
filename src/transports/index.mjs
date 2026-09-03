// @ts-check
import { AgoraError, ghToken, resolveToken } from "../core.mjs";
import { localTransport } from "./local.mjs";
import { githubTransport } from "./github.mjs";
import { githubEventsTransport } from "./github-events.mjs";
import { slackTransport } from "./slack.mjs";

export const TRANSPORTS = Object.freeze({
  local: { needsToken: false, describe: "an append-only NDJSON file; cursor = lines consumed" },
  github: { needsToken: true, describe: "one issue on a repo; comments are messages; no threads" },
  "github-events": { needsToken: true, describe: "a read-only feed of a repo's, an org's, or a user's activity; events are messages; cursor = event id; narrow it with events and refs" },
  slack: { needsToken: true, describe: "one channel; threads are Slack threads; bot token" },
});

/**
 * Build the transport for a configured room. Tokens resolve from tokenEnv, then tokenFile;
 * github falls back to the GitHub CLI's signed-in token.
 * @param {string} alias
 * @param {import('../core.mjs').RoomConfig} room
 * @param {import('../core.mjs').Config} cfg
 * @param {{ fetch?: typeof fetch, token?: string, cache?: { get: (key: string) => Promise<string | undefined>, set: (key: string, value: string) => Promise<void> } }} [deps]
 * @returns {Promise<import('../core.mjs').Transport>}
 */
export async function createTransport(alias, room, cfg, deps = {}) {
  switch (room.transport) {
    case "local":
      return localTransport(room, { actor: cfg.actor });
    case "github": {
      const token = deps.token ?? (await resolveToken(room)).token ?? (await ghToken());
      if (!token) throw new AgoraError(`room "${alias}": no token (tokenEnv/tokenFile, GITHUB_TOKEN, or gh auth login)`);
      return githubTransport(room, { token, fetch: deps.fetch, cache: deps.cache });
    }
    case "github-events": {
      const token = deps.token ?? (await resolveToken(room)).token ?? (await ghToken());
      if (!token) throw new AgoraError(`room "${alias}": no token (tokenEnv/tokenFile, GITHUB_TOKEN, or gh auth login)`);
      return githubEventsTransport(room, { token, fetch: deps.fetch, cache: deps.cache });
    }
    case "slack": {
      const token = deps.token ?? (await resolveToken(room)).token;
      if (!token) throw new AgoraError(`room "${alias}": no token (set tokenEnv or tokenFile to the bot token)`);
      return slackTransport(room, { token, fetch: deps.fetch });
    }
    default:
      throw new AgoraError(`room "${alias}": unknown transport "${room.transport}" (have: ${Object.keys(TRANSPORTS).join(", ")})`);
  }
}

/**
 * Where a room's token would come from, without reading it into anything that prints.
 * @param {import('../core.mjs').RoomConfig} room
 */
export async function tokenSource(room) {
  if (room.transport === "local") return "none";
  const { source } = await resolveToken(room);
  if (source !== "missing") return source;
  if (room.transport === "github" || room.transport === "github-events") {
    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return "env";
    if (await ghToken()) return "gh";
  }
  return "missing";
}
