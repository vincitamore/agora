# Purge and retention

A native room is kept indefinitely. **Purge is the only removal**: it takes the text of named
messages (or of a whole thread) out of the room, and the attachment bytes no remaining message
references, while every record keeps its place in the chain. A reader that holds a checkpoint past
a purged record continues without refusal.

Purge needs a version 2 room (`docs/ANNOTATIONS.md`), whose record digest commits to the text by its
digest rather than to the text itself.

## The purge record

```js
{ purge: { targets: ["<message id>", ...], thread?: "<root id>", reason, by: { name, ref? } } }
```

- `thread` purges the root and every reply in it.
- The stored record is `{ purge: { id, targets, thread?, reason, by: { name, ref? }, via?, purged:
  [ids], ts, cursor } }`. `purged` is the resolved list in log order, less what an earlier purge
  took; scan recomputes it from `targets` and `thread` over the log before the record and refuses a
  mismatch.
- Appended on **local** connections only. A member session (a remote seat over a route) is refused
  `purge-refused-remote`.
- A version 1 room refuses `purge-unsupported-log-version`.

## What the host does

1. Commit the purge record, like any other.
2. Write generation N+1 of the log without the targets' text, and without the attachment blobs that
   no unpurged record references.
3. Install the committed boundary naming N+1 by one atomic rename.
4. Remove generation N.

A purged record keeps its digest, sequence, cursor, author, thread and attachment metadata, and
gains `message.purged: { at, purge: "<purge record id>" }` outside the digested part. Readers'
`(epoch, sequence, digest)` checkpoints stay valid. An edit annotation on a purged message loses
its text the same way (`annotation.purged`).

Recovery: a crash before the boundary rename opens on generation N (the half-written N+1 is
discarded); a crash after it opens on N+1 and removes N. A reopen also finishes a purge whose texts
still stand, and a resend of the purge's operation id does the same.

Custody collection reads the room's references under the custody lock every install takes, and
passes over held digests: an upload holds its digest until an append names it or an hour passes. A
later collection (the next purge, or the next open of the room) takes what stays unreferenced.

On scan, every version 2 record without text must be named by a later purge record; a text-less
record no purge names is a damaged room, and it refuses to open.

## Refusals

| code | when |
|---|---|
| `purge-unsupported-log-version` | the room is version 1 |
| `purge-refused-remote` | the append came from a member session |
| `purge-invalid` | an unknown key, no author label, neither targets nor a thread, a target named twice, a reason outside 1-1000 characters |
| `purge-target-unknown` | the room holds no message with a named id |
| `thread-root-unknown` | the room holds no message with the thread's root id |
| `thread-root-not-top-level` | the named root is itself a reply |
| `attachment-invalid` | a purge, annotation or board record names attachments |
| `purge-rewrite-failed` | the record is committed, but the generation rewrite failed; the texts remain until a reopen or a resend of the operation id finishes it |
| `annotation-target-purged` | any annotation of a purged message |

## Live subscribers

A subscription that asks for purges (`purges: true`, capability `purge-v1`) receives each purge as an
event `{ id, cursor, ts, purged, thread?, reason, by, via? }`, in log order among its messages, in
replay and live. A thread subscription receives `purged` narrowed to its thread, and nothing for a
purge that took none of it. A subscription that does not ask is carried past the record. A read
result carries no purges; its messages carry the markers.

## Client

```js
client.purge(room, { targets, thread, reason, author, operationId })
  // -> { id, cursor, duplicate, operationId, purged: [ids], blobsRemoved, facesOutOfReach: [] }
client.subscribe(room, opts, { message, annotation, purge /* optional */, dark, refused })
client.follow(room, opts, { message, annotation, purge, state })

import { foldPurges } from "agora/client";
foldPurges(messages, purges)
  // -> messages a purge took get text "", purged, and lose what was read off the old text
  //    (trailers, to, signature, offer)
```

`client.purge` and a `purge` handler refuse `purge-unsupported` on a service without `purge-v1`.
`follow` hands each purge over once across a dark period. `facesOutOfReach` is `[]` until the seat's
face record log is read; it will list the copies of the purged messages a face already published
that the purge cannot reach.

## CLI

The native record verbs, all in `src/cli-native-records.mjs`:

```text
agora post <room> --attach <path> [--attach <path> ...]    native rooms; images and files
agora attachment get <room> <attachment id> --out <path>
agora edit <room> <message id> (--stdin | --text "...")
agora withdraw <room> <message id>
agora pin <room> <message id>
agora unpin <room> <message id>
agora room purge <room> (--message <id> ... | --thread <root id>) --reason "..."
```

## Retention

The room is kept indefinitely. Purge is the only removal, and attachments live and die with the
message or thread that references them. Withdraw removes no bytes: a withdrawn text stays in the
log until a purge takes it. Agora adds no timer and no expiry: a retention schedule is a
host application's decision, carried out through purge.
