// @ts-check
import { randomUUID } from "node:crypto";
import { AgoraError } from "../core.mjs";
import { nativeMessageId, parseNativeCursor } from "../native-protocol.mjs";
import { ServiceDarkError, connectSeatService, nativeMessage, readServiceDescriptor, requireThreads, validateNativeRoomId } from "../wake/subscriber.mjs";

/**
 * Why `id` is not a native thread id, or nothing. A thread is named by its root message's id,
 * which is 64 lowercase hexadecimal characters; refused at the caller boundary (`--thread`).
 * @param {string} id
 */
export function validateNativeThread(id) {
  return /^[a-f0-9]{64}$/.test(id) ? undefined : "a native thread id is its root message's id: 64 lowercase hexadecimal characters (the id `read --json` prints)";
}

/**
 * What a `read-batch-refused` names when the host could fit part of the page in one frame: how
 * many messages it selected and the largest limit that fits. Nothing for any other error, or for
 * the refusal that names no limit (one message that cannot cross alone). The host says it only in
 * its words, so this is the one place they are read.
 * @param {unknown} error
 * @returns {{ selected: number, fits: number } | undefined}
 */
export function fittingReadLimit(error) {
  const named = /read-batch-refused:\s*(\d+) messages[\s\S]*re-read with limit (\d+)/.exec(String(/** @type {any} */ (error)?.message ?? ""));
  if (!named) return undefined;
  const selected = Number(named[1]);
  const fits = Number(named[2]);
  if (!Number.isInteger(fits) || fits < 1) return undefined;
  return { selected, fits };
}

/**
 * A native read result as every transport reports one. For a thread read the host's checkpoint is
 * where its scan ended, which can lie past the last reply; it rides on the array as
 * `scannedThrough` (a room cursor), the way a gap does, so a caller that needs it reads it and every
 * other caller keeps a plain list.
 * @param {any} result @param {string | undefined} thread
 */
export function nativeReadResult(result, thread) {
  const messages = /** @type {import('../core.mjs').ReadResult} */ (Array.isArray(result?.messages) ? result.messages.map(nativeMessage) : []);
  const checkpoint = result?.checkpoint;
  if (thread !== undefined && checkpoint && typeof checkpoint.epoch === "string" && Number.isSafeInteger(checkpoint.sequence))
    messages.scannedThrough = `${checkpoint.epoch}:${checkpoint.sequence}`;
  return messages;
}

/**
 * A room hosted by this seat's native service, reached over the service's path endpoint. The
 * smallest adapter the shared verb path needs: `whoami` from the descriptor, `read` and `post` as
 * one request each. Cursors are the host's `<epoch>:<sequence>`; a foreign epoch or a future
 * sequence is refused by the host without advancing. A watch on this room does not poll it: the
 * subscriber in `src/wake/subscriber.mjs` rides the same socket and receives `event` frames.
 *
 * A dark service refuses a post with `room-dark` and no cursor, as the native contract says; a read
 * against a dark service is dark too (retained history labelled dark is the service's later work).
 * @param {import('../core.mjs').RoomConfig} room
 * @param {{ actor: import('../core.mjs').Actor, stateRoot: string, session?: string, connect?: typeof import('../native-service.mjs').NativeServiceClient.connect }} deps
 * @returns {import('../core.mjs').Transport}
 */
export function nativeTransport(room, { actor, stateRoot, session, connect }) {
  const roomId = validateNativeRoomId(room.roomId, "native room needs a roomId that");
  /** @type {Promise<import('../native-service.mjs').NativeServiceClient> | undefined} */
  let connecting;
  const client = () => {
    if (!connecting) {
      connecting = connectSeatService(stateRoot, { connect }).then(({ client: c }) => {
        // an idle connection must not hold a one-shot verb open: a pending request keeps the loop
        // alive through its own timer, and the subscriber holds its own, referenced, socket
        c.socket.unref();
        c.socket.once("close", () => { connecting = undefined; });
        return c;
      }, (e) => { connecting = undefined; throw e; });
    }
    return connecting;
  };
  return {
    kind: "native",
    room: roomId,
    threads: true,
    repliesInRoom: true,
    validateThread: validateNativeThread,
    async whoami() {
      const d = await readServiceDescriptor(stateRoot);
      return { id: d.accountId, name: actor.name };
    },
    validateCursor(cursor) {
      try { parseNativeCursor(cursor); return undefined; }
      catch (e) { return e instanceof Error ? e.message : String(e); }
    },
    /**
     * A `thread` narrows the read to that thread's root and replies, ascending. With `since`, the
     * limit bounds the records the host scans rather than the messages it returns, and the result
     * carries `scannedThrough`, the room position the scan accounts for, so a caller can go on from
     * there when the thread was quiet in that stretch.
     */
    async read({ thread, since, limit } = {}) {
      const c = await client();
      if (thread !== undefined) requireThreads(c, "this seat's service");
      let result;
      try {
        result = await c.request("read", { roomId, ...(thread !== undefined ? { thread } : {}), ...(since ? { since } : {}), ...(limit ? { limit } : {}) });
      } catch (e) {
        if (c.socket.destroyed) throw new ServiceDarkError(`seat service went dark during the read: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      return nativeReadResult(result, thread);
    },
    /**
     * `face` is the poster's post-time face choice (`--face` names transports, `--no-face` is
     * `"none"`; absent is the room's policy). It rides the append frame beside the operation, so
     * the service that runs the faces reads it from the same request that committed the message;
     * the ack's `faces[]`, when the service supplies one, is returned as the receipt's face rows.
     * This transport never publishes a face itself.
     *
     * `beforeSend(id)` runs, awaited, once the message id is known and before the append is
     * sent: the id is a digest of the room, this seat's account and the client-minted operation
     * id, so the poster can record it in its own ledger first. A watch subscribed on the same
     * session receives the service's push before this request returns, and a ledger written
     * after the receipt lost that race (measured: a session's own posts delivered back to it).
     */
    async post(text, { thread, face, beforeSend, attachments } = {}) {
      /** @type {import('../native-service.mjs').NativeServiceClient} */
      let c;
      try { c = await client(); }
      catch (e) { throw new AgoraError(`room-dark: ${e instanceof Error ? e.message : String(e)}; nothing was posted and no cursor was issued`); }
      // a reply goes only to a service that checks its root; an older one would store any id
      if (thread !== undefined) requireThreads(c, "this seat's service");
      const operationId = randomUUID().replaceAll("-", "");
      if (beforeSend) await beforeSend(nativeMessageId(roomId, (await readServiceDescriptor(stateRoot)).accountId, operationId));
      const receipt = await c.request("append", { roomId, operation: { operationId, authorName: actor.name, authorKind: actor.kind, text, ...(thread !== undefined ? { thread } : {}), ...(attachments?.length ? { attachments } : {}) }, ...(face === undefined ? {} : { face }) });
      return { id: String(receipt.id), cursor: String(receipt.cursor), ...(Array.isArray(receipt.faces) ? { faces: receipt.faces } : {}) };
    },
    /**
     * A board event is not a chat message. Check-and-acquire is the host's
     * serialized append: a held subject is refused with the holder's cursor.
     * @param {{ action: string, subject: string, because?: string, leaseId?: string, fence?: string, leaseMs?: number }} payload
     */
    async board(payload) {
      /** @type {import('../native-service.mjs').NativeServiceClient} */
      let c;
      try { c = await client(); }
      catch (e) { throw new AgoraError(`room-dark: ${e instanceof Error ? e.message : String(e)}; nothing was posted and no cursor was issued`); }
      const operationId = randomUUID().replaceAll("-", "");
      return c.request("append", { roomId, operation: { kind: "board", operationId, payload,
        authorKind: actor.kind, authorName: actor.name, session: session ?? "default" } });
    },
  };
}
