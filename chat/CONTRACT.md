# The chat kit's host contract

`@agora/chat` is a chat kit for a web app whose signed-in people talk with agents in one agora
native room. It has two halves:

- a **server half** the host mounts inside its own HTTP server (`Bun.serve`), behind the host's
  own session and cross-site checks; it holds the room through `agora/client`, in process;
- a **client half**: ES modules and one stylesheet, no build step, phone-first at 360 px, which the
  host serves and themes.

The host owns people, sign-in, roles and everything its domain knows. The kit owns the room: the
thread list, the thread, posting, files, annotations, purge, search, read positions and push. The
seam between them is the hooks below; the kit never learns what the host's records mean.

Package: `chat/package.json` (`name: "@agora/chat"`, its own version starting `1.0.0`, engines
`bun >=1.1`, no dependencies: `bun:sqlite` and WebCrypto only). The types are the JSDoc in
`server/index.mjs` and `client/index.js`. A host checks the kit's major version at start and refuses
a major it was not written against.

## Server half

```js
import { createChat } from "<agora>/chat/server/index.mjs";

const chat = await createChat({
  agoraDir, agoraState, agoraConfig,    // the agora checkout, its state root and config, as the host resolves them
  room: "main", clientName: "example-app",
  storeDir,                              // the kit's own store: kit.sqlite, thumbs/
  hooks: {
    identify: async (req) => person | null,        // person = { id, name, ref }; ref goes to author.ref
    authorize: (person, act, ctx) => boolean,      // act: read | post | upload | edit | withdraw | pin | purge | react
    people: async () => person[],                  // mentions, push targets, waiting
    scanText: (text) => ({ refuse?: string, warn?: string }),
    scanUpload: async ({ name, mimetype, bytes }) => ({ ok: true } | { ok: false, reason }),
    notifyText: ({ message, threadRoot }) => ({ title, body }),   // lock-screen text
    presence: async () => ({ state: "ready" | "busy" | "away" | "dark", lastSeen?, running? }),
    residentName: "the resident",
  },
  push: { vapidFile, subject, threadUrl? } | null,
});

// in Bun.serve's fetch, after the host's own checks and session:
const r = await chat.handle(req, person); if (r) return r;

chat.on("message", (m) => {});
chat.on("annotation", (a) => {});
await chat.close();
```

`chat.handle` answers a request under `/chat/` and returns `null` for any other path, so the host
falls through to its own routes. With no `person` given, the kit asks `hooks.identify(req)`; no person
from either is 401 `UNAUTHENTICATED`.

`chat.on("message" | "annotation", (value, meta) => {})` hears each new record once, in the browser's
shape, with `meta = { thread, mentions: [personId], waiting: [personId] }`; it returns an
unsubscribe. A record that predates the kit's start is indexed and never emitted.

`push.threadUrl` is the page a notification opens: a same-origin path that names `{root}` once, where
the thread's root id is URL-encoded. The default is `/?thread={root}`. A push with no thread (a test
or a probe) opens the template's path before `{root}`, so `/app/?thread={root}` opens `/app/`. Any
other value is refused when `createChat` starts.

## Routes

All under `/chat/`. JSON answers are `{ ok, data?, error? }`; an error is `{ code, message?, ... }`.
The host's cross-site checks and session sit in front of every route.

| Route | Body / query | Answer |
|---|---|---|
| `GET /chat/state` | | `{ room, me: { id, name, ref? }, resident: { name, ...presence }, capabilities: [service capabilities], version, link: { state: "live" \| "dark" \| "refused", reason? } }` |
| `GET /chat/threads` | `scope=all\|mine`, `context=<k>=<v>` (repeatable, all must match), `before=<lastCursor>`, `limit` (1-200, default 50) | `{ threads: [summary], through }` |
| `GET /chat/thread/:root` | `:root` is a root id or `main`; `since` | `{ messages (folded), annotations, through }`; `annotations` are those whose target is not in `messages` |
| `GET /chat/stream` | `thread=<root>\|main` (SSE); `Last-Event-ID` or `since` resumes | events below |
| `POST /chat/post` | `{ text, thread?, operationId?, trailers?: [[key, value]], attachments?, alsoToRoom? }` | 200 `{ receipt: { id, cursor, duplicate, operationId, thread }, alsoToRoom?: { id, cursor, duplicate }, warn? }`; 202 `ACCEPTANCE_UNKNOWN { operationId }`; 409 `ROOM_REFUSED { refusal }`; 422 `TEXT_REFUSED { reason }`; 503 `ROOM_DARK` |
| `POST /chat/scan` | `{ text }` | `{ warn? }`; 422 `TEXT_REFUSED { reason }` |
| `POST /chat/upload` | raw body, `X-File-Name` (percent-encoded), `Content-Type`, optional `X-Image-Width`/`X-Image-Height`; or `X-Thumb-For: <digest>` with a thumbnail's bytes | `{ attachment, thumb? }`, or `{ thumb }` for a thumbnail; 413 `TOO_LARGE`; 422 `UPLOAD_REFUSED { reason }`; 409 `ROOM_REFUSED { refusal }`; 503 `ROOM_DARK` |
| `GET /chat/file/:id` | `digest` | the bytes, only while a message with its words carries it and the reader may read its thread (404 otherwise); `X-Content-Type-Options: nosniff`; non-images as `application/octet-stream` with `Content-Disposition: attachment`; `Cache-Control: private` |
| `GET /chat/thumb/:digest` | | the kit's thumbnail, or 404 |
| `POST /chat/annotate` | `{ act, target, text?, operationId? }` | `{ receipt, warn? }`; edit and withdraw are the author's own (by ref), 403 otherwise |
| `POST /chat/react` | `{ target, name: "<short word>", on: bool }` | `{ names: [personId], reactions }`: the people who chose that name, and the message's reactions as now folded (kit store, names only); 409 `WITHDRAWN` for a new reaction on a withdrawn message (taking one back still answers) |
| `POST /chat/purge` | `{ targets?, thread?, reason, operationId? }` | `{ purged, facesOutOfReach, blobsRemoved, receipt }` (authorize `purge`); 202/409/503 as post |
| `POST /chat/position` | `{ thread: <root>\|"main", cursor }` | `{}`; a position never moves back within an epoch |
| `GET /chat/search` | `q`, `scope=messages\|files`, `context`, `limit` (1-200, default 50) | `{ hits: [{ message, snippet }], coverage: { through, at } }`; `at` is the time of the newest record the index holds through `through` (`null` while it holds none), which the search sheet prints as "searched through <day> <time>"; every word as a prefix; `messages` searches the words, `files` the names; the words are the message's body alone, so a trailer block and a signature line are never matched and never in a `snippet` (a trailer is metadata: `context` filters by it) |
| `GET /chat/push/key` | | `{ publicKey }`, the VAPID public key |
| `POST /chat/push/subscribe` | a push subscription | stored |
| `DELETE /chat/push/subscribe` | `{ endpoint }` | `{ removed }` |
| `POST /chat/push/test` | | a test push to the caller; 409 with no subscription |
| `POST /chat/push/ack` | `{ pushId, event?: "shown" \| "clicked" }` | recorded; 404 for a push that was not sent to the caller |
| `GET\|PUT /chat/prefs` | `{ notify: { mentions, asks, mine, all }, lockScreen: "title-line" \| "generic" }` | the person's prefs |

Other answers on any route: 400 `BAD_REQUEST`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN` (`authorize`
said no), 404 `NOT_FOUND` (an unknown thread root carries `refusal`), 405 `METHOD_NOT_ALLOWED`,
413 `TOO_LARGE`, 501 `NOT_IMPLEMENTED`, 503 `STOPPED` (the kit is closing). With `push: null` the
`/chat/push/*` routes answer 404 `PUSH_OFF` and `/chat/prefs` still answers.

The four post outcomes follow `agora/client`'s three (`refused`, `dark`, `unknown-acceptance`) plus
the host's own text scan: a 202 is resent by the client under the same `operationId`, never by the
kit on its own. The kit derives the room's operation id from the person and the draft id, so one
person's draft id never answers for another's. With no `operationId` the kit mints a draft id per
person, thread and words until a definite answer. An "also send to the room" copy that fails after
the reply landed answers with the copy's outcome and `error.posted` naming the reply; a resend under
the same id answers the reply as a duplicate and retries the copy.

`POST /chat/scan` runs `hooks.scanText` and nothing else: no append, no index, no push, no position.
It answers what a post of the same text would: `{ warn }` when the scan warns, `{}` when it passes,
422 `TEXT_REFUSED { reason }` when it refuses (`reason: "scan-failed"` when the scan throws). A
composer calls it before sending, so a warning reaches the person while they can still change the
words; `POST /chat/post` scans again and stays the authority.

### Shapes

A **message**, as the browser receives it, is agora's wire message without `room` and `author.id`:
`{ id, cursor, ts, text, author: { name, kind, ref? }, thread?, via?, to?, trailers?: [{ key, value }],
attachments?, edited?, withdrawn?, pinned?, purged?, reactions? }`. It arrives folded: an edit's text
replaces the original, and a withdrawal or a purge empties it.

`reactions: [{ name, people: [personId] }]` is folded in from the kit's store on every message the
kit serves (the thread and room routes, the thread list's `root` and `last`, search hits, the
stream's `message` and the `message` of an `annotation` event): each name once, in the order first
chosen, with the people who chose it in the order they did; absent when there are none. Names,
never counts. It is an array, not an object keyed by name, because a name is the person's word.

A **thread summary**: `{ root, last, lastAt, lastBy: { name, kind, ref? }, lastCursor, unread: bool,
waiting: [personId], cards: [{ type, id }] }`. `root` is the root message and `last` the newest
message, both folded message objects; on a thread with no reply `last` is the root. `scope=mine` is
the threads the person posted in, is mentioned in, or is named in by a `waiting:` that stands. A
thread is unread when its last record is past the person's position, except when the last word is
the person's own.

### Stream events

`GET /chat/stream` sends history and then live records, each once, with `retry: 5000` and keep-alive
comments. `main` carries the whole room, replies included; a root carries that thread.

| event | `id:` | data |
|---|---|---|
| `message` | its cursor | a message |
| `annotation` | its cursor | `{ id, cursor, ts, act, target, text?, author, via?, message }`; `message` is the target folded with it, or `null` when the kit does not hold it |
| `purge` | its cursor | `{ id, cursor, ts, purged: [messageId], thread?, reason, by: { name, ref? } }`; a root's stream receives only its thread's ids, and nothing for a purge that took none |
| `reaction` | none | `{ target, reactions: [{ name, people }] }`, the message's reactions as they now stand (`[]` when the last was taken back), sent to every live stream on its thread when anyone reacts; a reaction is the kit's, not a room record, so it carries no `id:` and moves no resume point, and a reconnecting stream reads reactions folded into the messages again |
| `state` | the history's `through`, on the first | `{ state: "live" \| "dark" \| "refused", reason?, through? }`; the first after history carries `through` |
| `presence` | | `{ name, state, lastSeen?, running? }`, from the host's `presence` hook, refreshed while a stream is open |

The server never sends `reconnecting`: that is the client's own state while its EventSource
reconnects. `refused` with `reason: "room-reset"` means the room's epoch changed and the client
reloads.

### Purge in the kit

The kit's room follow passes a `purge` handler to `agora/client`, which then subscribes with
`purges: true` on a service that offers `purge-v1`. Each purge, whoever appended it (the kit's own
`POST /chat/purge`, the CLI's `agora room purge`, another app), removes the purged messages' text
from the kit's index (`forgetText`), so search and the thread list stop showing it, and goes to every
open stream as a `purge` event; the client strikes the text it already shows. A purge appended
while the kit was stopped reaches the index when it starts: on a `purge-v1` service the follow
resumes where the index stood, and the purges it replays are applied. A service without `purge-v1`
sends no purge events; the kit then learns of a purge only when its index is rebuilt.

## Client half

```js
import { mountChat, registerCard, registerBlock } from "/chat/client/index.js";

registerCard("plan", {
  load: async (id, ctx) => data,
  render: (data, ctx) => HTMLElement,
  actions: { approve: async (data, ctx) => {} },
});
registerBlock("evidence", (source, ctx) => HTMLElement);

const view = mountChat(el, {
  base: "/chat",
  context: () => [["context", "item=alpha; screen=detail"]],
  onOpenThread, people,
  thread,        // optional: open this thread at mount
  now,           // optional: the clock the ledger reads; a fixed one renders the same page twice
});
// view = { unmount(), open(root), back(), refresh() }
// ctx = { person, thread, post(text, trailers?), theme, now() }
```

`open(root)` shows a thread (opening the thread already open only shows it, so an `onOpenThread` that
routes back into `open` cannot loop); `back()` returns to the list on a phone; `refresh()` reloads the
list.

A card renderer marks its controls and its state with attributes and classes the kit owns:

- `data-chat-action="<name>"` on a button runs that card's `actions[name]`;
- `data-chat-you` on the rendered element (or `waiting: <me>` on the message) marks the card as
  waiting on the viewer;
- classes `chat-card`, `chat-card--edge`, `chat-card--receipt`, `chat-risk-2` (a 2 px ink edge),
  `chat-risk-3` (a double edge), `chat-card-head`, `chat-card-id`, `chat-card-kind`,
  `chat-card-status` (`.is-you`), `chat-card-body`, `chat-card-title`, `chat-card-lines`,
  `chat-card-foot`, `chat-card-actions`, `chat-btn`, `chat-btn-go`, `chat-btn-locked`,
  `chat-line-add`, `chat-line-del`, `chat-evidence`, `chat-ev-line`, `chat-ev-cmd`, `chat-ev-age`,
  `chat-faint`. Risk is shown by line weight, never colour.

The thread pane carries a `.chat-composer` slot the composer mounts into.

### The writing half

```js
import { configureComposer, registerAttachAction, composerIn } from "/chat/client/composer.js";
import { mountSearch } from "/chat/client/search.js";

configureComposer({ reactions?, storage?, onPosted?, messageOf? });   // optional: options every composer mounted later uses
registerAttachAction("handover", { label: "hand over a password", note: "never posted", run: (ctx) => {} });
composerIn(el.querySelector(".chat-composer"))                  // the mounted composer's handle, or undefined
// handle = { unmount(), focus(), setText(text), sheet("attach" | null), addFiles(files), edit(id), actions(id), reaction(event), purge(event), annotation(event) }

const search = mountSearch(el, { base: "/chat", onOpen: (root, messageId) => view.open(root), onClose, context?, now? });
// search = { unmount(), focus(), search(q) }
```

`mountChat` mounts the composer in each thread it opens with its own `base`, `people` and
`context`, lends it the ledger's own messages (`messageOf`), and hands the open thread's `reaction`,
`purge` and `annotation` events to it, so a host that calls
`mountChat` calls nothing else to post, react or see a purge struck; `configureComposer` is only for
what `mountChat` does not carry. The composer's and the search sheet's styles are in `chat.css`.

The composer posts through an outbox kept in `localStorage` per base: a 200 removes a post, a 202,
an offline send, a 503 or a 5xx keeps it and resends under the same `operationId`, any other answer
hands it back to the composer with the reason, never resent. It calls `POST /chat/scan` before a
send and before an edit's save; a warning offers "send anyway", a refusal never does. Edit and
withdraw are offered only on the reader's own message, matched by `author.ref`, never by name.
An edit starts from the words the page already shows (`messageOf(id)`, else the composer's own
copy), so the box is filled in the same turn as the click; only a message the page does not hold is
read from the room, and the box is read-only until its words are in it. Nothing the person typed is
overwritten: when the room's words differ from the box (something reached it while it waited, or an
edit from elsewhere arrives), the composer says so and offers "use the room's words". A withdrawn
message shows no reactions line and no "more" control, and its actions are not offered.
Reactions are one word each (`seen`, `thanks`, `agreed`, `done` unless `reactions` names others). A
registered attach action is a dashed button in the composer row and the attach sheet; what it does
never passes through the room. Images are re-encoded before upload (metadata dropped, longest edge
2560, a 320 px thumbnail sent by `X-Thumb-For`).

`registerAttachAction` throws unless it is given `{ label, run }`. The search sheet's status says
how far the record was searched, never how many hits.

## Push

`push/sw.js` is a classic worker the host's own service worker imports:

```js
importScripts("/chat/push/sw.js");
self.agoraChatPush.configure({ base: "/chat", headers: { "<host header>": "1" } });
```

A push's payload is `{ v: 1, pushId, kind: "message" | "test" | "probe", title, body, thread?, url }`,
encrypted per RFC 8291 and signed with the VAPID key in `push.vapidFile`. The worker shows it, tagged
by thread, and posts `POST /chat/push/ack { pushId, event: "shown" }`. A click posts
`{ pushId, event: "clicked" }`, then focuses an open window of the app and sends it
`{ type: "agora-chat-open-thread", thread, url }`, or opens `url` when none is open. A `url` that
resolves to another origin opens the app's root instead.

The client half's push helpers: `import { subscribePush, unsubscribePush, sendTestPush,
onOpenThreadFromPush, pushSupported } from "/chat/push/client.js"`; subscribe only from a user
gesture.

Policy: one push per person per message, under the first reason that applies (a mention, a
`waiting:` naming them, a reply in a thread they posted in, everything), as their prefs allow; never
to the author. The lock screen shows `notifyText`, clipped, or under `lockScreen: "generic"` "New
message" and no body. A message push is `Urgency: high`, a test push `normal`; TTL 24 hours.
Subscription endpoints are limited to the browsers' push services.

## Rules the kit owns

- **The thread is a ledger**: a time and author column; serif for agent prose, sans for people,
  mono for code, evidence and addresses.
- **A markdown subset**: paragraphs, lists, emphasis, code, fenced blocks, and links only to
  `https:` and the same origin. Never an image from text, never raw HTML, never a `javascript:`
  link.
- **Text from outside is inert**: escaped, never interpreted.
- Posts past 600 characters are collapsed behind "show all".
- **A card is a reference, never a payload.** A message carries a card as a trailer
  `card: <type> <id>`; its body is the readable fallback any reader without the renderer shows. The
  renderer loads the card's data from the host's source of truth at render time, so a card is never
  stale and never forged by text. Rendering is not acting: an action on a card goes through the
  host's own route, which re-reads its record, never through the trailer.
- **A block is a fenced-code convention.** `registerBlock(language, render)` renders a fenced block
  of that language; any other reader shows a code block.
- An unregistered card or block shows the message text.
- **"Also send to the room"** is two appends by the kit: the reply in its thread, then a top-level
  message carrying `re: <root id>`. No broadcast flag in agora.
- **No counts.** The kit exposes unread as a position and a boolean, reactions as lists of names,
  never numbers. A host may show its own counts of its own facts.
- The kit's trailers (`card`, `waiting`, `context`) are rendered and indexed, never acted on.
  `waiting: <person id>` stands until that person posts in the thread; `context: <k>=<v>; ...` marks
  where in the host a post was written, and filters the thread list.

## Theme

CSS variables the host maps its own tokens onto:

```text
--chat-bg --chat-panel --chat-raised --chat-rule --chat-rule2 --chat-card-rule --chat-btn-rule
--chat-ink --chat-ink2 --chat-ink3 --chat-evbg --chat-ev --chat-you --chat-warn --chat-add
--chat-go-bg --chat-go-ink --chat-font-prose --chat-font-mono --chat-font-ui
```

`client/chat.css` declares every one with a neutral default and uses nothing else for colour or
type.

## Kit store

`kit.sqlite` under `storeDir`: read positions, reactions (names), push subscriptions and prefs, the
message index (FTS5) with the trailers `context`, `waiting` and `card` indexed, and thumbnails by
digest under `thumbs/`. Everything is rebuildable from the room except subscriptions, prefs and
reactions. Push keeps its own tables (`push_*`, versioned in `push_meta`); the index's schema is
`PRAGMA user_version`. The index catches up from the room before its follow starts, and rebuilds
when the room's epoch changes.

## Serving the client half

The host reads the kit's client files into memory at start and serves that snapshot, so a moving
agora checkout never serves a client half that disagrees with the server half the host loaded.
`push/sw.js` is a classic worker the host's own service worker imports with `importScripts`.

## Containment

The kit carries no host vocabulary: no domain, product or person names. `test/containment.test.mjs`
fails on any.
