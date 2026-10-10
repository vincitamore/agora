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
  push: { vapidFile, subject } | null,
});

// in Bun.serve's fetch, after the host's own checks and session:
const r = await chat.handle(req, person); if (r) return r;

chat.on("message", (m) => {});
chat.on("annotation", (a) => {});
await chat.close();
```

`chat.handle` answers a request under `/chat/` and returns `null` for any other path, so the host
falls through to its own routes.

## Routes

All under `/chat/`. JSON answers are `{ ok, data?, error? }`. The host's cross-site checks and
session sit in front of every route.

| Route | Body / query | Answer |
|---|---|---|
| `GET /chat/state` | | `{ room, me, resident: presence, capabilities, version }` |
| `GET /chat/threads` | `scope=all\|mine`, `context=<k=v>`, `before`, `limit` | `{ threads: [{ root, lastAt, lastBy, unread: bool, waiting: [personId], cards: [{ type, id }] }] }` |
| `GET /chat/thread/:root` | `since` | `{ messages (folded), through }` |
| `GET /chat/stream` | `thread=<root>\|main` (SSE) | events `message`, `annotation`, `state` (`live\|dark\|refused`), `presence` |
| `POST /chat/post` | `{ text, thread?, operationId, trailers?, attachments?, alsoToRoom? }` | 200 `{ receipt }`; 202 `ACCEPTANCE_UNKNOWN { operationId }`; 409 `ROOM_REFUSED { code }`; 422 `TEXT_REFUSED { reason }`; 503 `ROOM_DARK` |
| `POST /chat/upload` | raw body, `X-File-Name`, `Content-Type` | `{ attachment, thumb? }`; 413 `TOO_LARGE`; 422 `UPLOAD_REFUSED { reason }` |
| `GET /chat/file/:id` | `digest` | the bytes; `X-Content-Type-Options: nosniff`; non-images `Content-Disposition: attachment`; `Cache-Control: private` |
| `GET /chat/thumb/:digest` | | the kit's thumbnail, or 404 |
| `POST /chat/annotate` | `{ act, target, text? }` | `{ receipt }` |
| `POST /chat/react` | `{ target, name: "<short word>", on: bool }` | `{ names: [personId] }` (kit store, names only) |
| `POST /chat/purge` | `{ targets?, thread?, reason }` | `{ purged, facesOutOfReach }` (authorize `purge`) |
| `POST /chat/position` | `{ thread, cursor }` | `{}` |
| `GET /chat/search` | `q`, `scope=messages\|files`, `context` | `{ hits: [{ message, snippet }], coverage: { through } }` |
| `GET /chat/push/key` | | the VAPID public key |
| `POST /chat/push/subscribe` | a push subscription | stored |
| `DELETE /chat/push/subscribe` | the subscription's endpoint | removed |
| `POST /chat/push/test` | | a test push to the caller |
| `POST /chat/push/ack` | `{ push id }` | the receipt a delivered push was shown |
| `GET\|PUT /chat/prefs` | `{ notify: { mentions, asks, mine, all }, lockScreen: "title-line" \| "generic" }` | the person's prefs |

The four post outcomes follow `agora/client`'s three (`refused`, `dark`, `unknown-acceptance`) plus
the host's own text scan: a 202 is resent by the client under the same `operationId`, never by the
kit on its own.

## Client half

```js
import { mountChat, registerCard, registerBlock } from "/chat/client/index.js";

registerCard("plan", {
  load: async (id, ctx) => data,
  render: (data, ctx) => HTMLElement,
  actions: { approve: async (data, ctx) => {} },
});
registerBlock("evidence", (source, ctx) => HTMLElement);

mountChat(el, {
  base: "/chat",
  context: () => [["context", "item=alpha; screen=detail"]],
  onOpenThread, people,
});
// ctx = { person, thread, post(text, trailers?), theme, now() }
```

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
reactions.

## Serving the client half

The host reads the kit's client files into memory at start and serves that snapshot, so a moving
agora checkout never serves a client half that disagrees with the server half the host loaded.
`push/sw.js` is a classic worker the host's own service worker imports with `importScripts`.

## Containment

The kit carries no host vocabulary: no domain, product or person names. `test/containment.test.mjs`
fails on any.
