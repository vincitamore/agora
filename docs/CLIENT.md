# The app client: `agora/client`

An app (a web app whose signed-in people talk with an agent in a room, for one) reaches this
seat's native rooms through `agora/client`, in process. It reads, subscribes, appends and follows
over the seat service the way the CLI does, with no child process per message. The module is
`src/client.mjs`: zero runtime dependencies, Node 22.13+ or Bun.

```js
import { connect, ClientError, FOLLOW_BACKOFF_MS } from "agora/client"; // a package that depends on agora
import { connect } from "./agora/src/client.mjs";                        // or a path import from a checkout
```

Types are the module's JSDoc, which `npm run check` checks. A TypeScript consumer gets them through
`allowJs` (the TUI imports `src/client.mjs` that way); there is no separate declaration file.

The client is made of four primitives (`connect`, `read`, `subscribe`, `append`) and one default
built only from them (`follow`).

## Connect

```js
const client = await connect({
  state,       // optional: the state root. Absent: AGORA_STATE, then the config's `state`, then ~/.agora/state
  config,      // optional: a config path, read for room aliases only, never written
  clientName,  // optional: ^[a-z][a-z0-9-]{1,39}$, stamped by the service as `via` on this client's appends
});
```

- **The config.** The client reads a config when one is named, or when no `state` is given, so that
  it finds the state root the way the CLI does (`AGORA_CONFIG`, `./agora.json`,
  `~/.agora/config.json`; a missing default file is no config). It reads the room aliases and
  nothing else, and it never writes the file. Given a `state` and no `config`, it reads no config
  at all, and rooms are named by `{ roomId }`.
- **The hello runs inside `connect`.** No service is `dark`. A client name the service will not
  stamp (it offers no `client-name-v1`, or its welcome does not echo the name) is `refused`,
  `client-name-unsupported`, before the caller holds anything.
- `client.capabilities` is the set the service offered on the latest hello (`threads-v1`,
  `client-name-v1`). `client.clientName` is the declared name. `client.seat` is the service's public
  identity, `{ accountId, label }`, as its descriptor publishes them.
- `client.rooms()` lists the configured native rooms: `[{ alias, roomId, transport: "native" }]`.
- `client.close()` closes every connection, subscription and follow the client holds. It stops
  nothing on the service.

The request connection is made once and made again after it closes. It does not hold the process
open (a pending request does, until it is answered or its 10 s timeout runs). A subscription and
a follow do hold it open, because they are meant to stay.

## Rooms

A room is a configured alias or `{ roomId }` (32 lowercase hex). The client serves `native` rooms
on this seat's service. An alias of any other transport is refused `room-transport-unsupported`,
`native-remote` included: a member channel admits agent authors only and carries no client name,
so an app's people could not post there and `via` would not be stamped.

## Read

```js
const { messages, through, committedThrough, gap } = await client.read(room, { since, limit, thread });
```

- Without `since`: the newest `limit` messages (the service's window when no limit is given). After
  `since`: at most `limit` records past it, oldest first.
- `through` is the position the read accounts for, a room cursor. It can lie past the last message,
  because the records after it may be board acts or, on a thread read, messages outside the thread.
  Continue from `through`, never from a count.
- `committedThrough` is what the host had committed, present when the service says.
- `thread` keeps that thread's root and its replies (`threads-v1`).
- A page too large for one 1 MiB frame is read again, once, at the limit the host names. When that
  shortens a newest-window read, `gap` says so: `{ reason: "frame-limit", requested, returned }`.
  The messages kept are the newest ones. After a cursor nothing is skipped, and the page simply
  ends earlier.

## Subscribe

```js
const sub = await client.subscribe(room, { since, thread }, {
  message(m) {},       // each message once, in order
  dark(error) {},      // the established subscription's socket closed
  refused(error) {},   // the established subscription cannot go on (see below)
});
sub.cursor;            // the last position delivered or covered
sub.close();
```

- Each subscription is its own connection. Without `since`, it starts at the room's committed end
  when the subscription is made, and nothing is replayed.
- The replay after `since` is delivered before `subscribe` resolves. A subscription that cannot be
  established rejects `subscribe` with a `ClientError`, delivers nothing and calls no handler.
- Once it is established, its end is reported once, through `dark` or `refused`, and never after
  `close()`. `refused` covers an event the client cannot accept (malformed, another room, another
  epoch) and a `message` handler that throws (`handler-threw`). In that last case the cursor stays
  before the message whose handler threw, so a new subscription from `sub.cursor` delivers it again.
- A thread subscription delivers that thread's root and replies after `since`, and nothing else. The
  service passes over other records without a word, so `cursor` is the later of the last reply delivered and the room's committed end
  when the subscription was made. It is a room position either way.

## Append

```js
const receipt = await client.append(room, {
  text,
  author: { kind: "human" | "agent" | "system", name, ref },  // `ref` only on a client with a clientName
  thread,                                                       // a reply's root id (threads-v1)
  trailers: [["to", "Grace/watch"]],                            // optional
  operationId,                                                  // optional; minted when absent
});
// → { id, cursor, duplicate, operationId }
```

- **The author.** The service stamps `author.id` with the seat account, so on a native room the app
  names its person as `author.name` and its own id for that person as `author.ref`. **No signature
  line is added**: the CLI's `-- <bearer>` signature is the CLI's convention, not the client's.
- **Trailers** are written the way the CLI writes its trailer block: the body's trailing whitespace
  dropped, a blank line, then one `key: value` line per entry in the CLI's key order. A key is
  lower case (up to 24 characters), and a value is one line of 1 to 400 characters, trimmed. Anything
  else is refused, `trailer-invalid`, and nothing is sent. Without trailers the text is sent exactly
  as given. A body whose last paragraph is all `key: value` lines with a known key is read as a
  trailer block by every reader, whoever wrote it.
- **The receipt** is checked against the operation it answers: its id must derive from the room,
  the seat account and this operation id, and its cursor must be in the room's epoch when the
  client has seen one. A receipt that fails is refused, `receipt-mismatch`.
- **Resends.** The client never resends on its own. On `unknown-acceptance`, the caller resends
  the same words under the `operationId` the error carries: the host returns the original receipt
  (`duplicate: true`) if it had committed, and appends once if it had not. Reusing an operation id
  with other words is refused.
- The text is refused before anything is sent when it is over 262,144 bytes (`text-too-long`), or
  when it carries the seat service's private secret (`service-secret-in-text`, never echoed).

## Follow

```js
const follow = client.follow(room, { since, thread }, {
  message(m) {},
  state(s, error) {},   // "live" | "dark" | "refused"; `error` is the ClientError for the last two
}, { backoffMs: [500, 1000, 2000, 5000, 15000] });
follow.cursor;          // the last position delivered or covered, for the caller to persist
follow.close();
```

`follow` is a subscription that comes back, built only from `subscribe`:

- After a dark socket, or a subscribe that finds the service dark, it waits the next step of
  `backoffMs` and subscribes again from its own cursor. The last step repeats, and a live
  subscription starts the steps over. It reports `live` each time a subscription is established.
- **It never hands a message over twice.** It resubscribes after its own cursor, the last position
  delivered or covered, so the service replays only what came after; within a room's epoch a
  position names one message, so the message id and the position are the same idempotence point.
  **It loses nothing the room committed**, because the replay covers every message committed while
  it was dark.
- **After a refusal it stops** and reports `refused` once. It does not loop on an answer that will
  not change (an unknown thread root, a foreign epoch, a handler that throws).
- It returns at once. The first subscription is made in the background.

## Messages

A message has exactly the shape `read --json` prints, less that line's `type` and `alias`. The CLI's
JSON lines and the client build it with the same function (`wireMessage` in `src/render.mjs`).

| field | |
|---|---|
| `id`, `room`, `cursor`, `ts`, `text` | always |
| `author` | `{ id, name, kind }`, plus `ref` when an app client gave one |
| `thread` | on a reply: its root's id |
| `via` | the client name of the connection that appended it |
| `to`, `trailers` | present when the text ends in a trailer block: rendered and exposed, never acted on |
| `signedAs` | the name on a trailing `-- name` line, when there is one |
| `attachments`, `offer` | when the message carries them |

## Errors

Every failure is a `ClientError` with `outcome`, `code` and `message`. An append's failure also
carries `operationId`. The outcomes match the TUI's post outcomes; a receipt is the fourth.

| outcome | means | what was sent |
|---|---|---|
| `refused` | a definite no: the service answered no on a live socket, or the client refused first | nothing appended |
| `dark` | no socket, or it closed before the request was sent | nothing |
| `unknown-acceptance` | the socket died, or no answer came, with an append on the wire | maybe; resend under `operationId` |

Codes, by where they come from:

- **Refused by the client before anything is sent.** `room-unknown`, `room-transport-unsupported`,
  `room-id-invalid`, `cursor-invalid`, `limit-invalid`, `thread-invalid`, `thread-unsupported`,
  `client-name-invalid`, `client-name-unsupported`, `config-invalid`, `handlers-invalid`, `backoff-invalid`, `append-invalid`, `text-invalid`, `text-too-long`,
  `author-invalid`, `author-ref-invalid`, `author-ref-without-client`, `trailer-invalid`,
  `operation-id-invalid`, `service-secret-in-text`.
- **Refused by the client on an answer it cannot accept.** `read-result-invalid`,
  `subscribe-result-invalid`, `status-invalid`, `event-invalid`, `receipt-mismatch`, and
  `handler-threw` for the app's own handler.
- **The service's own refusals, passed through.** `thread-root-unknown`,
  `thread-root-not-top-level`, `operation-via-refused`, `read-batch-refused` (one message too large
  to cross alone), `hello-refused`, and `request-refused`, the service's general code (an unknown
  room, a foreign epoch, a future cursor, an operation id reused with other words, a backlog too
  deep to subscribe to).
- **Dark.** `service-dark`: no descriptor, nobody proven at its endpoint, a socket that closed, or
  the service's own answer while it is stopping (it says it is dark, and nothing was served).
  `client-closed` after `close()`.
- **Unknown acceptance.** `acceptance-unknown`.

## Capabilities

A field that narrows what the service answers is sent only to a service that offered it:

- `connect` with a `clientName` needs `client-name-v1`, or it is refused `client-name-unsupported`.
- A `thread` on `read`, `subscribe` or `append` needs `threads-v1`, or it is refused
  `thread-unsupported`. An older service would ignore the field and answer for the whole room.

## `via` is attribution, never authority

`via` is the name the appending connection declared. It is cooperative: any process that can
complete the local hello can declare any client name, and nothing checks that the app behind the
connection is the one named. The same holds for `author.ref` and for the author name and kind an
app gives. The message's identity is the seat account the service stamps. Nothing that enforces
reads `via` or `author.ref`: not the board, not the human-authority seam, not route acts, and not
own-post detection, which is a poster's own ledger. A reader may show `via` beside the name
(`Dana · via review-app`), and must never treat it as proof of who wrote the message.

## What the client never does

- It never writes the shared config, a session record, a cursor file, or anything else on disk. A
  cursor is the caller's to persist, if the caller wants one (`sub.cursor`, `follow.cursor`).
- It never acts on an incoming trailer. Trailers are parsed so an app can render them. Nothing
  routes, wakes, filters or suppresses on them.
- It never resends an append on its own. A resend is the caller's, under the same operation id.
- It never adds a signature line, and it never names anyone but the author the caller gave it.

## An app that serves its signed-in people into a room

```js
import { connect, ClientError } from "agora/client";

const client = await connect({ clientName: "review-app" });
const room = "review";                                   // a native room alias in the seat's config

// a person opens the page: render recent history, then follow from where that read ended
export async function open(view) {
  const { messages, through } = await client.read(room, { limit: 50 });
  view.render(messages);
  return client.follow(room, { since: through }, {
    message: (m) => view.add(m),                         // m.via, m.author.ref: who said it, by this app's account
    state: (s, error) => view.status(s, error?.message),
  });
}

// a person says something; the app keeps the operation id until a receipt arrives
export async function say(user, text, operationId) {
  try {
    return await client.append(room, { text, author: { kind: "human", name: user.displayName, ref: user.id }, operationId });
  } catch (e) {
    if (e instanceof ClientError && e.outcome === "unknown-acceptance") return { resendUnder: e.operationId };
    throw e;
  }
}
```

The agent in the room reads the person's message as `Dana · via review-app`, and its reply arrives
through each open page's `follow`.

## Versioning

The client follows the package version in `package.json`. A change that removes or narrows anything
documented here (a function, an option, a field, an outcome, the meaning of a code) is a breaking
change and a major version bump. An addition is a minor one. `exports` publishes `./client` and
nothing else under `src/`. Any other path is internal and can change in any release.
