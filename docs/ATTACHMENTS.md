# Attachments in native rooms

A native room carries files and images as **durable attachments**: bytes the seat service holds in
its own custody, named by digest, and referenced from a message. The message carries the
reference (`WireAttachment`); the bytes never ride the message record, and a record never names a
sender-local path or a transport URL.

This is distinct from a transfer offer (`agora share` / `agora fetch`, `docs/TRANSFERS.md`), which
is live, recipient-restricted and expiring. A durable attachment lives and dies with its message.

The types are `src/protocol/attachment.mjs`; the service half is `src/native-attachments.mjs`; the
client half is `src/client-attachments.mjs`, re-exported by `agora/client`.

## Capability

`attachments-v1`, offered on the `welcome` of a **local** connection. A member session (a remote
seat over a route) is never offered it and never reaches the frames below. A client sends an
attachment frame only to a service that offered the capability; a service that does not offer it
refuses every `attachment-*` frame `attachments-unsupported`, and refuses an append naming a
`durable` attachment the same way.

## Frames

Four-byte length-prefixed JSON, `protocol: "agora-native/1"`, on the local connection, each with a
`requestId` the answer echoes:

```text
attachment-begin  { requestId, roomId, name, size, mimetype?, digest: "sha256:<hex>" }
  -> attachment-ready { requestId, uploadId, chunkMax }            (chunkMax = 262144)
attachment-chunk  { requestId, uploadId, offset, data: <base64> }
  -> attachment-progress { requestId, received }
attachment-commit { requestId, uploadId }
  -> attachment-ack { requestId, attachment: WireAttachment }      (lifetime "durable")
attachment-read   { requestId, roomId, id, digest, offset, length } (length <= chunkMax)
  -> attachment-data { requestId, offset, data: <base64>, size, eof, kind, mimetype }
```

Refusal codes, each on an `error` frame with the request's id:

| code | meaning |
|---|---|
| `attachment-too-large` | the declared or received size passes the per-attachment limit |
| `attachment-quota` | installing it would pass the room's attachment quota |
| `attachment-digest-mismatch` | the received bytes do not hash to the declared digest |
| `attachment-size-mismatch` | the received byte count is not the declared size |
| `attachment-upload-unknown` | no upload with that id on this connection |
| `attachment-upload-expired` | the upload was not committed in time and was dropped |
| `attachment-unknown` | no installed attachment with that id and digest (read), or an append names one whose bytes are not installed |
| `attachments-unsupported` | this service does not serve attachments |

Every refusal leaves nothing installed. A declared size past the limit, a chunk past the declared
size, and a frame larger than one protocol frame are refused before any allocation sized by the
request.

## Limits

Constants in `src/native-attachments.mjs`:

- one attachment: 25 MiB;
- attachments per message: 10 when the list names at least one `durable` attachment (refused
  `attachment-quota` past it); a list of metadata-only references keeps the store's own ceiling of 32;
- room quota: 2 GiB, set per room in `room.json` as `attachmentQuota`;
- an upload not committed within 10 minutes is dropped;
- at most 4 uploads in flight per connection.

## Kind and type

The kind is detected from the bytes, never from the name or the declared type: PNG, JPEG, GIF and
WebP magic bytes are `image`; everything else is `file`. A PNG named `report.vsdx` is an image; a
text file named `photo.png` is a file.

The type custody records is an image's detected type, and a file's declared type unless that
claims an image the bytes do not prove (then, and when none was declared, `application/octet-stream`).
It is recorded once, at the first install of those bytes; a later upload of the same bytes cannot
retype them. Every `attachment-data` frame carries the recorded `kind` and `mimetype`, so a reader
learns them from the first, and `client.attachment` returns them. An append whose reference names
another kind or type than custody recorded is refused `attachment-unknown`.

## Storage

```text
native/rooms/<roomId>/attachments/sha256-<hex>        the bytes
native/rooms/<roomId>/attachments/sha256-<hex>.type   the custody record: { kind, mimetype }
```

The blob has no extension, mode 0600, installed by temp file, fsync and rename (the same retrying
rename the store uses on Windows). Its record is written the same way before the blob's rename
and removed if that rename fails, so an installed blob always has one. Identical bytes are one
file and one record. A crash between the temp write and the
rename leaves no installed blob. An append that names a `durable` attachment whose blob is not
installed is refused `attachment-unknown`; nothing is appended.

## Client

```js
import { connect } from "agora/client";
const client = await connect({ clientName: "example-app" });

/** @returns {Promise<WireAttachment>} */
const a = await client.upload(room, { bytes /* Uint8Array */, name, mimetype /* optional */,
  width, height /* optional, images */ });

await client.append(room, { text, author, thread, trailers, operationId, attachments: [a] });

/** local connections only; the bytes are verified against the digest before the last chunk resolves */
const { stream, size, kind, mimetype } = await client.attachment(room, { id: a.id, digest: a.digest });
```

`append` validates every attachment with `validateWireAttachment` before anything is sent; an
invalid one is `refused`, `attachment-invalid`.

`WireAttachment` is `{ id, digest, lifetime, name, kind, size, mimetype?, width?, height? }`. A
message read back carries `attachments[]` as before. A reader on the host seat that asks with
`--files` also gets `attachments[].path`: the verified custody file, read-only.

## Removal

An attachment has no removal of its own. It is removed when the message or thread that references
it is purged and no other unpurged record references it (`docs/PURGE.md`).
