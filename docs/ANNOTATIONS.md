# Log version 2 and annotations

A native room's messages can be edited, withdrawn, pinned and unpinned after they are committed,
without rewriting the record that was committed. Each of those is an **annotation**: a record of
its own, appended after the message it names, carried in order on the same log. A reader folds the
annotations onto the messages; the messages themselves never change.

Log version 2 is the record format that makes a later purge possible (`docs/PURGE.md`): the record
digest commits to the text by its digest, so the text can be removed without breaking the chain.

The store half is `src/native-store.mjs` (its JSDoc carries the record shapes); the client half is
`agora/client`.

## Capability

`annotations-v1`, offered on the `welcome`. A client sends an annotation append, or asks for
annotation events, only to a service that offered it.

## Log version

- `room.json` carries `logVersion: 1 | 2`. `agora service room create` makes version 2 rooms; a
  room created before this field existed is version 1 and is read exactly as before.
  `NativeRoomStore.create` without `logVersion` makes version 1, so every existing caller writes
  the bytes it wrote before. `status` reports `logVersion`.
- A version 1 room carries no annotations: an annotation append there is refused
  `annotation-unsupported-log-version`, so a version 1 log stays readable by a build that predates
  annotations, and an edit's text is always held where a purge can remove it.
- The committed boundary carries `generation` (absent means 0). Generation 0 is the file
  `room.frames`; generation N is `room.frames.<N>`. A purge is the only writer of a generation
  above 0.
- A version 2 message record carries `message.textDigest = "sha256:<hex>"`, the digest of the UTF-8
  text, inside the digested part. `message.text` is outside it: the record digest is computed over
  the record with `message.text` removed. On scan, a text that is present must hash to its
  `textDigest`, or the room refuses to open.
- Version 1 records keep their format and are read byte for byte as before.

## The annotation record

Appended through the same `append` frame as a message:

```js
{ kind: "annotation", operationId, annotation, authorKind, authorName, authorRef? }
// annotation:
{ act: "edit" | "withdraw" | "pin" | "unpin", target: "<message id>", text /* edit only, <= 256 KiB */ }
```

An edit's text is held as a message's: `annotation.textDigest` inside the record digest,
`annotation.text` outside it. A reader never sees `textDigest`.

An annotation carries no attachments. An edit replaces the message's text and nothing else: the
attachments the message was committed with stay its attachments, and the custody that holds their
bytes is untouched by the edit (`docs/ATTACHMENTS.md`).

Refusals:

| code | when |
|---|---|
| `annotation-target-unknown` | the room holds no message with that id |
| `annotation-not-author` | an `edit` or `withdraw` from another author. The check is two-sided: the target's account must be the append's, the append's `authorRef` must equal the target's `author.ref` (both absent counts as equal), and when a ref is present the append's `via` must be the target's. A person an app names cannot edit a message the seat's agents posted, though every local client shares the seat's account |
| `annotation-target-withdrawn` | the target is already withdrawn; applies to every act |
| `annotation-invalid` | an unknown act, an unknown key, a missing or oversized text on `edit`, a text on any other act |
| `annotation-unsupported-log-version` | the room is version 1 |

`pin` and `unpin` may come from any author the host admits; who may pin is the host
application's decision, made before it appends.

## Client

```js
client.annotate(room, { act, target, text, author: { kind, name, ref }, operationId })
  // -> { id, cursor, duplicate }
client.read(room, opts)
  // -> { messages, annotations, through, committedThrough, gap }
  //    annotations is present only when the service offers annotations-v1, and then always a list
client.subscribe(room, opts, { message, annotation /* optional */, dark, refused })
client.follow(room, opts, { message, annotation, state })

// annotations: [{ id, cursor, ts, act, target, text?, author: { id, name, kind, ref? }, via? }]
import { foldAnnotations } from "agora/client";
foldAnnotations(messages, annotations)
  // -> messages with { edited?: { at, text }, withdrawn?: { at }, pinned?: boolean } folded in;
  //    text replaced by the latest edit
```

Folding rules: a later edit replaces an earlier one; a withdrawal wins over any edit, earlier or
later; the last of `pin` and `unpin` decides `pinned`. Folding is a reader's act; the tool keeps no
folded state.

A subscriber with no `annotation` handler is carried past annotation records: its cursor advances
over them and it sees nothing it did not see before. `follow` delivers each annotation once across
a dark period, as it does messages.

On the wire, a `read` or `subscribe` frame asks with `annotations: true`; a `read-result` then
carries `annotations` beside `messages`, cut over both in log order, and a subscription interleaves
`{ type: "event", annotation }` frames with its message events. A frame that does not ask is
answered exactly as before.

## CLI

`read` on a native room asks for annotations when the service offers annotations-v1 and prints each
in log order among the messages: under `--json` as its own line, `{ type: "annotation", alias, id,
cursor, ts, act, target, text?, author, via? }`, and for a person as one line naming who did what to
which message, with an edit's text indented below it. The host cuts a `--limit` page over messages
and annotations together. Only `read` asks: `join`, `watch`, `cursor --now` and `carry` read
messages as before, and a watch is carried past annotation records. The verbs that append
annotations are `agora edit`, `agora withdraw`, `agora pin` and `agora unpin` (`docs/PURGE.md` lists
them with the other native record verbs).

An annotation is not a trailer. `--withdraws <id>` on `post` is a statement in a message that
`carry` folds for its own author; `agora withdraw` is a record on the room that every reader folds.
