# Purge and retention

A native room is kept indefinitely. **Purge is the only removal**: it takes the text of named
messages (or of a whole thread) out of the room, and the attachment bytes no remaining message
references, while every record keeps its place in the chain. A reader that holds a checkpoint past
a purged record continues without refusal.

Purge needs a version 2 or 3 room (`docs/ANNOTATIONS.md`), whose record digest commits to the text by
its digest rather than to the text itself. A version 3 room commits to each message's attachment list
the same way, so a purge there takes the attachment entries off the disk with the text.

## The purge record

```js
{ purge: { targets: ["<message id>", ...], thread?: "<root id>", reason, by: { name, ref? } } }
```

- `thread` purges the root and every reply in it.
- The stored record is `{ purge: { id, targets, thread?, reason, by: { name, ref? }, via?, purged:
  [ids], ts, cursor, released? } }`. `released` (version 3 only, outside the digest, never served) is
  written by the rewrite: the custody digests of the attachment entries it dropped. `purged` is the resolved list in log order, less what an earlier purge
  took; scan recomputes it from `targets` and `thread` over the log before the record and refuses a
  mismatch.
- Appended on **local** connections only. A member session (a remote seat over a route) is refused
  `purge-refused-remote`.
- A version 1 room refuses `purge-unsupported-log-version`.

## What the host does

1. Commit the purge record, like any other.
2. Write generation N+1 of the log without the targets' text (at version 3, without their attachment
   entries either, whose custody digests go on the purge record as `released`), and without the
   attachment blobs that no unpurged record references.
3. Install the committed boundary naming N+1 by one atomic rename.
4. Remove generation N.

A purged record keeps its digest, sequence, cursor, author and thread, and gains `message.purged:
{ at, purge: "<purge record id>" }` outside the digested part. Readers' `(epoch, sequence, digest)`
checkpoints stay valid. An edit annotation on a purged message loses its text the same way
(`annotation.purged`).

**What a reader receives.** A purged message is served with its `purged` marker and neither its
text nor its attachments: no `attachments` key at all, as on a message that never had any, so no
name, size, kind, digest or id of a purged file reaches a read, a subscription's replay, a member
route, `foldPurges`, or the chat kit (whose index drops the entries with the text). The marker is
the redaction marker; the contract adds no other. This holds from the moment the purge record
commits, before the rewrite has run.

**What the log keeps.** A version 3 record digest covers `message.attachmentsDigest`, the digest of
the attachment list, and the list rides outside it, as the text does. The rewrite drops the list
with the text: no file name, size or kind of a purged attachment stays in the log. The digest stays
inside the record digest, and the custody digests go on the purge record as `released`, so the
collection below knows what to let go of after a crash.

A version 2 record digest covers `message.attachments` itself (only the text is committed by its
digest), so a version 2 room's stored record keeps its attachment entries: removing them would leave
a record whose digest no reader could recompute, and the room would refuse to open. The bytes go
(custody below); the entries stay on the host's disk, in the seat's private state, and are never
served. `agora room upgrade` rewrites a version 2 room as version 3 (`docs/NATIVE-ROOMS.md`), and
drops the entries of every message an earlier purge took as it does; the version 2 copy it keeps
holds them until `--prune-backup`.

Recovery: a crash before the boundary rename opens on generation N (the half-written N+1 is
discarded); a crash after it opens on N+1 and removes N. A reopen also finishes a purge whose texts
still stand, and a resend of the purge's operation id does the same. A crash between the rewrite and
the face records' scrub (§ Faces) is finished the same way.

Custody collection reads the room's references under the custody lock every install takes, and
passes over held digests: an upload holds its digest until an append names it or an hour passes. A
later collection (the next purge, or the next open of the room) takes what stays unreferenced.

On scan, every version 2 or 3 record without text must be named by a later purge record; a text-less
record no purge names is a damaged room, and it refuses to open. At version 3 a message's list must
hash to its `attachmentsDigest`, a digest without its list stands only on a message a purge took,
and a message a purge took keeps no list.

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
  // -> { id, cursor, duplicate, operationId, purged: [ids], blobsRemoved,
  //      facesOutOfReach: [{ transport, channel, ts? , file?, message, reason }] }
client.subscribe(room, opts, { message, annotation, purge /* optional */, dark, refused })
client.follow(room, opts, { message, annotation, purge, state })

import { foldPurges } from "agora/client";
foldPurges(messages, purges)
  // -> messages a purge took get text "", purged, no attachments, and lose what was read off
  //    the old text (trailers, to, signature, offer)
```

`client.purge` and a `purge` handler refuse `purge-unsupported` on a service without `purge-v1`.
`follow` hands each purge over once across a dark period.

## Faces

When the seat service runs faces, a committed purge deletes the copies of its messages that a face
already published (Slack: `chat.delete` for the text copy, `files.delete` for each uploaded picture;
GitHub: `DELETE` of the issue comment, where a comment already deleted counts as deleted),
one mirror row per copy in the seat's face record log, and waits for them a bounded few seconds
before its receipt. `facesOutOfReach` lists every copy it could not delete: `{ transport, channel,
ts }` for a text copy or `{ transport, channel, file }` for a picture, with `message` (the purged
message it copies) and `reason`. `ts` is optional because a picture has a file id and no ts; on a
GitHub face `channel` is `owner/name#issue` and `ts` the comment id. This entry shape is the
contract (ruled at integration: kept as widened from `{ transport, channel, ts }`). A copy is
listed when its face's policy no longer names it, when the face refused the delete, when its own publication is still unsettled, or when its deletion was not
confirmed by the receipt; that deletion goes on, and `agora faces <room> --for <id>` reads its
outcome. A message no face carried lists nothing. A resent purge does not delete twice what landed.

**The face records are scrubbed.** The seat keeps what its faces did with each message beside the
room: `faces.jsonl` (one row per copy and per act on it) and `face-inbound.jsonl` (what crossed in
from a face). A purge takes off every row of every purged message each field that names or describes
its attachments or fingerprints its text: a picture row's `name` (and any `title`, `size`, `kind`,
`mimetype` or `text`), and on a crossing that came in from the face, its files' names and reasons,
its metadata lines (`fileLines`, which carry name, kind and size) and its `textDigest`. Each row
keeps what the face needs to stay correct: transport, channel, status, the copy's `ts` (`id`) or
`fileId`, the `attachmentId`, the message id and cursor, a mirror row's act and target, and a
crossing's ts and author. The deletions, `facesOutOfReach`, the sweep and a later resend of the purge
all read those. After the purge, no file under the room's directory names a purged attachment (the
`upgrade-v2-backup/` copy an upgrade keeps excepted; `--prune-backup` removes it). A row the faces
write after the scrub, for a publication or deletion that was in flight, is written without those
fields.

The scrub runs inside the purge, after the log's rewrite and before custody collection, and again
whenever the seat service opens a room a purge has touched. Each file is rewritten whole to a temp
file, synced, and installed by one rename, the way the log's generations are: a crash leaves either
the old file, which the next purge or open scrubs again, or the scrubbed one, and the next run
removes a temp copy a crash left (it never holds more than the scrubbed text). A file with nothing to
take is not rewritten, so the scrub is idempotent. The service's own appends to these files queue
behind the scrub, and a file that grew during the rewrite (an append from the CLI) is read again
before the rename.

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

`agora room upgrade <room> --confirm <roomId> [--prune-backup]` is the offline rewrite of a version 2
room as version 3, and is described in `docs/NATIVE-ROOMS.md`.

## Retention

The room is kept indefinitely. Purge is the only removal, and attachments live and die with the
message or thread that references them. Withdraw removes no bytes: a withdrawn text stays in the
log until a purge takes it. Agora adds no timer and no expiry: a retention schedule is a
host application's decision, carried out through purge.
