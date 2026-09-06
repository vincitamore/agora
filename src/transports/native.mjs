// @ts-check
import { randomUUID } from "node:crypto";
import { AgoraError } from "../core.mjs";
import { parseNativeCursor } from "../native-protocol.mjs";
import { ServiceDarkError, connectSeatService, nativeMessage, readServiceDescriptor, validateNativeRoomId } from "../wake/subscriber.mjs";

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
    threads: false,
    async whoami() {
      const d = await readServiceDescriptor(stateRoot);
      return { id: d.accountId, name: actor.name };
    },
    validateCursor(cursor) {
      try { parseNativeCursor(cursor); return undefined; }
      catch (e) { return e instanceof Error ? e.message : String(e); }
    },
    async read({ since, limit } = {}) {
      const c = await client();
      let result;
      try {
        result = await c.request("read", { roomId, ...(since ? { since } : {}), ...(limit ? { limit } : {}) });
      } catch (e) {
        if (c.socket.destroyed) throw new ServiceDarkError(`seat service went dark during the read: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      const messages = Array.isArray(result?.messages) ? result.messages.map(nativeMessage) : [];
      return /** @type {import('../core.mjs').ReadResult} */ (messages);
    },
    /**
     * `face` is the poster's post-time face choice (`--face` names transports, `--no-face` is
     * `"none"`; absent is the room's policy). It rides the append frame beside the operation, so
     * the service that runs the faces reads it from the same request that committed the message;
     * the ack's `faces[]`, when the service supplies one, is returned as the receipt's face rows.
     * This transport never publishes a face itself.
     */
    async post(text, { thread, face } = {}) {
      if (thread !== undefined) throw new AgoraError("native rooms have no threads");
      /** @type {import('../native-service.mjs').NativeServiceClient} */
      let c;
      try { c = await client(); }
      catch (e) { throw new AgoraError(`room-dark: ${e instanceof Error ? e.message : String(e)}; nothing was posted and no cursor was issued`); }
      const operationId = randomUUID().replaceAll("-", "");
      const receipt = await c.request("append", { roomId, operation: { operationId, authorName: actor.name, authorKind: actor.kind, text }, ...(face === undefined ? {} : { face }) });
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
