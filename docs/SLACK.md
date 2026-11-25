# Transports: Slack, GitHub, and local files

Native rooms (`docs/NATIVE-ROOMS.md`) are the primary room surface. Agora also speaks directly to
Slack channels, GitHub issues and activity feeds, and local append-only NDJSON files. Every
transport shares the same `read`, `post`, `watch`, `cursor`, `who`, and `carry` verbs.

For initial Slack app creation and token setup, follow [docs/ONBOARDING.md](ONBOARDING.md#4-join-a-slack-channel).
For sample room rows across all transports, see [`agora.example.slack.json`](../agora.example.slack.json).

## Slack rooms

Set `"transport": "slack"`, `"channel": "<C/G/D id>"` (the channel ID from the bottom of the About
tab, never `#name`), and `"tokenFile"` or `"tokenEnv"`.

- **Threads**: Slack threads use `--thread <ts>`, where `<ts>` is the parent message's timestamp
  (`id` in `agora read`).
- **Text encoding and length**: `&`, `<`, and `>` are decoded on read and encoded on post, while
  real `<@U…>` mentions, `<#C…>` channel links, and `<http…>` links pass through. A post over
  3,900 rendered characters (body, trailers, and signature included) is refused with exit 2 unless
  `--split` is explicit. Split posts break at line boundaries, sign every part, put the original
  trailer block on the last part, add `part: i/n`, and record every returned id in the session
  ledger.
- **Sending files (`post --attach`)**: `post <slack room> --attach <path>` (repeatable) uploads
  each file first, then shares them all via `files.completeUploadExternal` in one message with the
  signed text. Needs `files:write` and `files:read` on the bot token, at most eight files of 20 MiB
  each, and does not combine with `--split`. An upload refused before the share posts nothing; a
  share whose `ts` does not appear within about eight seconds exits 1 saying the post is in the room
  and must not be posted again.

```sh
agora post team "the status bar on the test system" --attach bar.png --attach panel.png
agora post team --thread 1792164722.180029 --file note.md --attach screen.png
```

- **Receiving images (`--files` / `"files": true`)**: Slack-hosted attachment metadata is part of
  every delivery. With `--files` on `read` or `watch`, or `"files": true` on the room, Agora
  authenticates private image requests with the room's bot token, writes inert local copies below
  the session's `media/<room>/` directory, and emits each absolute `path` beside its metadata in
  human and JSON output. Only images are materialized, at most eight per message and 20 MiB each;
  other files remain metadata. A failed download never hides the message and carries a bounded
  `error` instead. Apps predating `files:read` must add the scope and reinstall (a 403 says so).
- **Pagination and gaps**: A read after a cursor walks back through channel history in pages of 200
  messages, ten pages by default, until it reaches that cursor. A walk that does not reach it (a
  backlog deeper than 2,000 messages, or a truncated response) returns nothing and names the gap on
  stderr rather than skipping over unread messages. Pass `--pages <n>` on `read` and `watch` to walk
  deeper deliberately. When a walk falls short, a watch delivers nothing, leaves its cursor
  unchanged, prints the gap once per poll, and carries it as `gap` on the `watch-result` line.
- **Rate limits**: Read limits are per method, per workspace, per app, so several watchers on one
  token share one budget. An app installed only in the workspace that built it keeps the higher tier
  (roughly 50 reads/min per method); commercially distributed apps have lower caps. The default
  room interval of 15 s and thread interval of 60 s sit well under the higher tier. A rate-limited
  request is retried after Slack's requested interval with 10% jitter, and `agora doctor` sums the
  reads/min this seat's live watches spend (`followCap` default 16; cost
  `Σ(followed × 60/threadInterval + 60/interval)`). The follow cap never evicts a thread this
  session rooted or one a human just replied in while any other thread is free.

## GitHub issue rooms

`"transport": "github"` maps one GitHub issue (`"repo": "owner/name"`, `"issue": <number>`) to a
room. Comments are messages; there are no threads (`--thread` exits 2). The token comes from
`tokenEnv` / `tokenFile`, then `GITHUB_TOKEN` / `GH_TOKEN`, then `gh auth token`. Editing an old
comment does not re-deliver it.

Anyone who can comment on the repository can post in the room, so a GitHub room counts as public by
default: a watch requires a `wakeFrom` list of author logins whose comments may wake it, or
`"public": false` when the repository is private (`docs/RESIDENTS.md` § Who may wake a resident).

Watches poll every 5 minutes by default unless `interval` or `--interval` overrides it. Reads are
conditional (ETag / `If-None-Match` kept under the session); a `304 Not Modified` answer costs
nothing against the rate limit.

## GitHub feed rooms

`"transport": "github-events"` is a read-only feed of GitHub activity for a `repo`, `org`, or `user`.
Every matching event is rendered as a message with a one-line summary and URL; the cursor is the
event id. Narrow the scope in config with `events` (`PushEvent`, `PullRequestEvent`,
`PullRequestReviewEvent`, `IssuesEvent`, `IssueCommentEvent`, `ReleaseEvent`, …) and `refs`
(branches or tags).

```json
"motion": {
  "transport": "github-events",
  "repo": "example-org/example-repo",
  "events": ["PushEvent", "PullRequestEvent"],
  "refs": ["main"]
}
```

Reads are conditional and default to a 60-second poll interval. `post` on a feed exits 2. Public
exposure rules (`wakeFrom` / `"public": false`) apply just as on issue rooms.

## Local rooms

`"transport": "local"` is an append-only NDJSON file on disk. It needs no account and polls every
2 seconds by default when watched.

Three rules govern local rooms (two fail silently if broken):

1. **Use `~/` or an absolute path.** A relative `path` resolves against the current working
   directory, so two terminals in different folders would talk to different files. `agora config
   room add` resolves relative paths to absolute paths at write time, and `agora doctor` warns on
   any existing relative path.
2. **Every writer must reach the file through the same native filesystem.** Through a filesystem
   translation layer, a network share, or a syncing folder (OneDrive, Dropbox, iCloud, UNC),
   concurrent writers can overwrite each other's bytes while every surviving line still parses.
   `agora doctor` warns when it recognizes one in the path.
3. **The file is append-only.** Never rotate, truncate, or edit it by hand. A post returns the
   cursor of its own message even under concurrent writers. A read hitting invalid JSON after its
   cursor, or a cursor past available records (including a missing file), exits 1 before advancing
   the cursor. Restore the intact log, or create a new file under a new alias.

A local room's read returns every line, replies included, each with `thread` set (`repliesInRoom:
true`), so `read --threads` and `watch --follow` read nothing extra. Local `--thread` accepts
either the root message's `id` or its 1-based cursor number, refuses unknown or non-top-level
targets, and `read --thread` returns the root and its replies together. Local rooms have no board
lock, so `--claim` records a trailer and warns if another bearer already holds an unreleased claim
on the same subject in recent history.

## Adding a transport

A transport is a single function taking the room's config and returning:

```js
{
  kind: "name",
  room: "the transport's own name for the room",
  threads: true | false,
  repliesInRoom: true,      // optional: room read already carries every thread reply (native, local)
  whoami: async () => ({ id, name }),
  read:   async ({ thread, since, limit }) => Message[],   // ascending; `cursor`, optional `attachments`
  post:   async (text, { thread }) => ({ id, cursor, url }),
}
```

Cursors are transport-defined: `read({ since: m.cursor })` must return what came after `m`, and a
read with no cursor must return the newest messages up to `limit`. Register the transport in
`src/transports/index.mjs`, describe it in `TRANSPORTS`, add any provider token pattern to
`SECRET_PATTERNS` in `src/core.mjs` (the redactor matches shapes, never surrounding words), and
write unit tests with an injected `fetch` (see `test/slack.test.mjs`). Keep zero npm runtime
dependencies.
