// @ts-check
import { AgoraError, ghToken, resolveToken } from "../core.mjs";
import { localTransport } from "./local.mjs";
import { githubTransport } from "./github.mjs";
import { githubEventsTransport } from "./github-events.mjs";
import { slackTransport } from "./slack.mjs";
import { nativeTransport } from "./native.mjs";
import { nativeRemoteTransport } from "./native-remote.mjs";
import { openResidentMemberRoom } from "../native-member-client.mjs";
import { resolvePath, stateDir } from "../core.mjs";

/** GITHUB_TOKEN / GH_TOKEN, the same pair tokenSource reports as "env" for github rooms. */
function githubEnvToken() {
  const v = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return v && v.trim() ? v.trim() : undefined;
}

export const TRANSPORTS = Object.freeze({
  local: { needsToken: false, describe: "an append-only NDJSON file; cursor = lines consumed" },
  github: { needsToken: true, describe: "one issue on a repo; comments are messages; no threads" },
  "github-events": { needsToken: true, describe: "a read-only feed of a repo's, an org's, or a user's activity; events are messages; cursor = event id; narrow it with events and refs" },
  slack: { needsToken: true, describe: "one channel; threads are Slack threads; bot token" },
  native: { needsToken: false, describe: "a room hosted by this seat's native service; cursor = <epoch>:<sequence>; a watch subscribes to the service instead of polling" },
  "native-remote": { needsToken: false, describe: "a native room hosted by ANOTHER seat, reached over a Tailcat member channel named by a route descriptor; cursor = <epoch>:<sequence>; a watch subscribes over the channel instead of polling" },
});

/**
 * Build the transport for a configured room. Tokens resolve from tokenEnv, then tokenFile;
 * github falls back to the GitHub CLI's signed-in token.
 * @param {string} alias
 * @param {import('../core.mjs').RoomConfig} room
 * @param {import('../core.mjs').Config} cfg
 * @param {{ fetch?: typeof fetch, token?: string, mediaDir?: string, cache?: { get: (key: string) => Promise<string | undefined>, set: (key: string, value: string) => Promise<void> }, session?: string }} [deps]
 * @returns {Promise<import('../core.mjs').Transport>}
 */
export async function createTransport(alias, room, cfg, deps = {}) {
  switch (room.transport) {
    case "local":
      return localTransport(room, { actor: cfg.actor });
    case "github": {
      const token = deps.token ?? (await resolveToken(room)).token ?? githubEnvToken() ?? (await ghToken());
      if (!token) throw new AgoraError(`room "${alias}": no token (tokenEnv/tokenFile, GITHUB_TOKEN, or gh auth login)`);
      return githubTransport(room, { token, fetch: deps.fetch, cache: deps.cache });
    }
    case "github-events": {
      const token = deps.token ?? (await resolveToken(room)).token ?? githubEnvToken() ?? (await ghToken());
      if (!token) throw new AgoraError(`room "${alias}": no token (tokenEnv/tokenFile, GITHUB_TOKEN, or gh auth login)`);
      return githubEventsTransport(room, { token, fetch: deps.fetch, cache: deps.cache });
    }
    case "slack": {
      const token = deps.token ?? (await resolveToken(room)).token;
      if (!token) throw new AgoraError(`room "${alias}": no token (set tokenEnv or tokenFile to the bot token)`);
      return slackTransport(room, { token, fetch: deps.fetch, mediaDir: deps.mediaDir });
    }
    case "native":
      return nativeTransport(room, { actor: cfg.actor, stateRoot: stateDir(cfg), session: deps.session });
    case "native-remote": {
      // Resolving the room reads three files off this seat's own state (the descriptor, the
      // enrolled identity, the route secret) and dials nothing, so building the transport stays
      // offline and a missing or foreign descriptor is a named refusal here rather than a spawn
      // failure later. The room id comes from the descriptor's binding; there is no roomId key.
      const descriptor = /** @type {any} */ (room).descriptor;
      if (typeof descriptor !== "string" || !descriptor)
        throw new AgoraError(`room "${alias}": a native-remote room needs a descriptor (the path to the route descriptor the operator carried from the host)`);
      // L12 seam 5. The row's SHAPE is unchanged and its meaning has moved: it no longer means
      // "dial this descriptor from whatever process is asking", it means "reach the room this
      // descriptor names, through this machine's ONE resident member client". Sessions never dial;
      // there is no fallback branch to `openRemoteRoom` when the client is absent, because a
      // fallback is the defect returning under the name of robustness. The refusal names the
      // member descriptor and the start line.
      const remote = await openResidentMemberRoom(stateDir(cfg), alias);
      return nativeRemoteTransport(room, { actor: cfg.actor, remote: /** @type {any} */ (remote), session: deps.session });
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
  if (room.transport === "local" || room.transport === "native" || room.transport === "native-remote") return "none";
  const { source } = await resolveToken(room);
  if (source !== "missing") return source;
  if (room.transport === "github" || room.transport === "github-events") {
    if (githubEnvToken()) return "env";
    if (await ghToken()) return "gh";
  }
  return "missing";
}
