// @ts-check
import { randomUUID } from "node:crypto";
import { AgoraError, redact } from "../core.mjs";
import { parseNativeCursor } from "../native-protocol.mjs";
import { ServiceDarkError, nativeMessage } from "../wake/subscriber.mjs";

/**
 * One line an operator can act on, or nothing. Redacted, because a teardown error can carry a path
 * or a token-shaped string and this one is printed on a path nobody is inspecting closely.
 * The cleanup-pending case is named as ITSELF rather than as a failure: it is a documented state
 * with its own 10 s budget, and counting it as a defect is how a real defect gets ignored.
 * @param {unknown} error
 */
function describeCloseFailure(error) {
  const message = redact(error instanceof Error ? error.message : String(error));
  return /** @type {any} */ (error)?.cleanupPending
    ? `channel cleanup is still pending (${message})`
    : message;
}

/**
 * A native room hosted by ANOTHER seat, reached over a Tailcat member channel.
 *
 * Deliberately the same adapter as `native.mjs` with one substitution: where that one connects to
 * this seat's own service over a named pipe and proves the seat nonce, this one dials the host's
 * route and proves a per-route secret. Everything after the handshake is identical, because it is
 * literally the same `NativeServiceClient` speaking the same frames — so cursors are the host's
 * `<epoch>:<sequence>`, a foreign epoch or a future sequence is refused by the host without
 * advancing, and a watch on this room is pushed rather than polled.
 *
 * The room id is NOT a config key. It comes from `descriptor.binding.roomId`, which the
 * descriptor's own digest covers; a `roomId` beside the descriptor would be a second source that
 * could disagree with the first, silently, on every read.
 *
 * @param {import('../core.mjs').RoomConfig} room
 * @param {{ actor: import('../core.mjs').Actor, remote: import('../native-remote.mjs').RemoteRoom, session?: string }} deps
 * @returns {import('../core.mjs').Transport}
 */
export function nativeRemoteTransport(room, { actor, remote, session }) {
  const roomId = remote.binding.roomId;
  /** @param {unknown} e */
  const dark = (e) => new AgoraError(`room-dark: ${e instanceof Error ? e.message : String(e)}; nothing was posted and no cursor was issued`);
  /** @type {import('../core.mjs').Transport} */
  const transport = {
    kind: "native-remote",
    room: roomId,
    threads: false,
    /**
     * Opens the channel and asks the host for the room's status.
     *
     * A `whoami` answered from the descriptor alone would report a live identity for a route the
     * host has since closed — a number where a failure belongs. So this one measures, and `doctor`
     * shows the member principal it would post as, or the named reason the channel will not open.
     * `doctor --offline` skips it through the same gate that skips every other room's identity.
     */
    async whoami() {
      const client = await remote.client();
      await client.request("status", { roomId });
      return { id: remote.binding.accountId, name: actor.name };
    },
    validateCursor(cursor) {
      try { parseNativeCursor(cursor); return undefined; }
      catch (e) { return e instanceof Error ? e.message : String(e); }
    },
    async read({ since, limit } = {}) {
      const client = await remote.client();
      let result;
      try {
        result = await client.request("read", { roomId, ...(since ? { since } : {}), ...(limit ? { limit } : {}) });
      } catch (e) {
        if (client.socket.destroyed) throw new ServiceDarkError(`the member channel went dark during the read: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      const messages = Array.isArray(result?.messages) ? result.messages.map(nativeMessage) : [];
      return /** @type {import('../core.mjs').ReadResult} */ (messages);
    },
    /**
     * The host's single writer appends this; the member session never takes `writer.lock` and never
     * touches the board directly, so ordering and the one-writer invariant are the host's exactly as
     * they are for a local caller. `authorKind` is the actor's, and the host refuses anything but
     * `agent` from a member session — a remote may not claim to be a human.
     */
    async post(text, { thread, face } = {}) {
      if (thread !== undefined) throw new AgoraError("native rooms have no threads");
      if (face !== undefined) throw new AgoraError("a face is the HOST's policy and is published by the host's own service; a remote seat cannot choose one for it");
      let client;
      try { client = await remote.client(); }
      catch (e) { throw dark(e); }
      const operationId = randomUUID().replaceAll("-", "");
      const receipt = await client.request("append", { roomId,
        operation: { operationId, authorName: actor.name, authorKind: actor.kind, text } });
      return { id: String(receipt.id), cursor: String(receipt.cursor),
        ...(Array.isArray(receipt.faces) ? { faces: receipt.faces } : {}) };
    },
    /** @param {{ action: string, subject: string, because?: string, leaseId?: string, fence?: string, leaseMs?: number }} payload */
    async board(payload) {
      let client;
      try { client = await remote.client(); }
      catch (e) { throw dark(e); }
      const operationId = randomUUID().replaceAll("-", "");
      return client.request("append", { roomId, operation: { kind: "board", operationId, payload,
        authorKind: actor.kind, authorName: actor.name, session: session ?? "default" } });
    },
  };
  // The live channel rides beside the Transport rather than inside it: a watch subscribes over the
  // same channel instead of opening a second Tailcat child, and the watch's own branch is the only
  // consumer. Attached by assignment so the shared `Transport` type in core.mjs — which belongs to
  // every transport and not to this one — does not have to grow a field only this one has.
  // The only transport in the tool that owns a CHILD PROCESS. Its stdio pipes are referenced
  // handles, so without this the CLI cannot exit after a verb succeeds — not a hang in the dial,
  // which is what three of us read off the code before anyone stamped the output: the handshake
  // completes in about a second, every row prints, and then nothing ends. The room is closed here
  // rather than by each verb because a verb added later cannot forget what it never had to write.
  // Never throws, and no longer discards. `close()` runs after the verb's answer is written, so a
  // throw here would fail work that succeeded — but a swallowed teardown failure that reaches
  // nobody is a leak with no witness, which is the note Opus/design left on L3. The failure is
  // recorded and the CALLER decides where the operator is looking: `doctor` prints it in the
  // room's row (it closes each transport before building that row), and every other verb gets one
  // stderr line at the drain.
  //
  // `closeFailed` is a reason, not a count. A counter that reads 0 both when nothing failed and
  // when something failed unreported is the silent default one layer up, so absence is the only
  // thing that means "clean".
  transport.close = async () => {
    try {
      await remote.close();
      if (remote.closeFailure !== undefined) transport.closeFailed = describeCloseFailure(remote.closeFailure);
    } catch (error) {
      // The transport's own await failing is a second, distinct path from the room recording one.
      transport.closeFailed = describeCloseFailure(error);
    }
  };
  return Object.assign(transport, { remote });
}
