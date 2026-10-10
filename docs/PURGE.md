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
`(epoch, sequence, digest)` checkpoints stay valid.

Recovery: a crash before the boundary rename opens on generation N (the half-written N+1 is
discarded); a crash after it opens on N+1 and removes N.

On scan, every version 2 record without text must be named by a later purge record; a text-less
record no purge names is a damaged room, and it refuses to open.

## Client

```js
client.purge(room, { targets, thread, reason, author })
  // -> { id, cursor, purged: [ids], blobsRemoved, facesOutOfReach: [{ transport, channel, ts }] }
```

`facesOutOfReach` lists the copies of the purged messages a face already published (from the seat's
face records) that the purge cannot reach; it is empty for a room with no faces.

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
message or thread that references them. Agora adds no timer and no expiry: a retention schedule is a
host application's decision, carried out through purge.
