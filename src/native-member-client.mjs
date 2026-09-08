/**
 * The resident member client: ONE process per machine holds the enrolled key's member channel to
 * the host, and every session on the machine subscribes to IT over a local socket.
 *
 * Seam 1 is the whole design constraint: this speaks the seat service's own protocol on its local
 * side, so a session that subscribes to it cannot tell it from the seat service — same handshake,
 * same frames, same `service-dark` semantics. Seam 2 is the other half: the member channel's
 * lifetime (dial, handshake, reconnect budget, the idle clock, the at-least-once/dedup-on-id
 * contract) belongs to this process, never to a watch, which should never have owned it.
 *
 * What it is NOT: an admission point. It holds one route to one host room and forwards the four
 * things a member session may ask for. It mints nothing, admits nobody, and adds no authority of
 * its own — the host's `member-server` proof is still what authenticates the far side, and the
 * per-route secret still never leaves this machine.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { AgoraError } from "./core.mjs";
import {
  NATIVE_PROTOCOL, NativeFrameDecoder, encodeNativeFrame, nativeHandshakeProof,
  parseNativeCursor, validateNativeEnvelope, validateNativeId, verifyNativeHandshakeProof,
} from "./native-protocol.mjs";
import { nativeServiceEndpoint } from "./native-service.mjs";
import { openRemoteRoom } from "./native-remote.mjs";
import { writeMemberDescriptor, removeMemberDescriptor } from "./native-member-descriptor.mjs";

/** Exactly what a member session may ask the host for; this process adds nothing to the list. */
export const MEMBER_CLIENT_REQUESTS = Object.freeze(["status", "read", "subscribe", "append"]);

/** @param {net.Socket} socket @param {unknown} frame */
function sendFrame(socket, frame) {
  if (socket.destroyed || !socket.writable) return false;
  try { socket.write(encodeNativeFrame(frame)); return true; }
  catch { return false; }
}

/** @param {unknown} value @param {string} label */
function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new AgoraError(`member client request needs a ${label}`);
  return value;
}

export class MemberClientService {
  /**
   * @param {{ stateRoot: string, alias: string, descriptorPath: string, keyDigest: string,
   *  claim?: { dir?: string, path: string, generation: number }, build?: import("./harness.mjs").BuildIdentity,
   *  nonce?: string, seatLabel?: string, timeoutMs?: number,
   *  channelOptions?: any, identity?: any }} options
   */
  constructor(options) {
    this.stateRoot = options.stateRoot;
    this.alias = options.alias;
    this.descriptorPath = options.descriptorPath;
    this.keyDigest = options.keyDigest;
    this.claim = options.claim;
    this.build = options.build;
    this.seatLabel = options.seatLabel ?? "member";
    this.timeoutMs = options.timeoutMs;
    // The member channel's own options, threaded so a cell can count at the real spawn seam
    // (`options.spawn ?? spawnTailcat`, src/tailcat-routes.mjs). A contest cell that counted at a
    // seam of its own invention would prove its own wiring, not this one.
    this.channelOptions = options.channelOptions;
    this.identity = options.identity;
    // The seat-local service secret. It authenticates local sessions to this process and NEVER
    // travels: not to the host, not into the descriptor's public projection, not into a log.
    this.nonce = options.nonce ?? randomUUID().replaceAll("-", "");
    validateNativeId(this.nonce, "member client nonce");
    this.bootEpoch = randomUUID().replaceAll("-", "");
    /** @type {net.Server | undefined} */
    this.server = undefined;
    /** @type {Set<net.Socket>} */
    this.sockets = new Set();
    /** @type {Map<net.Socket, Set<string>>} rooms each local socket has subscribed to */
    this.subscriptions = new Map();
    /** @type {import("./native-remote.mjs").RemoteRoom | undefined} */
    this.room = undefined;
    this.endpointPath = "";
    this.running = false;
    this.stopping = false;
    this.startedAt = "";
  }

  /**
   * Claim first (the caller's, before this object exists), then the member channel, then the local
   * bind, then readiness. The descriptor is LAST because it is what sessions route on: publishing
   * it before the channel is up would advertise a client that cannot serve, and publishing it
   * before the bind would advertise an endpoint nobody is listening on.
   */
  async start() {
    this.room = await openRemoteRoom({
      descriptorPath: this.descriptorPath,
      stateRoot: this.stateRoot,
      ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
      ...(this.channelOptions ? { channelOptions: this.channelOptions } : {}),
      ...(this.identity ? { identity: this.identity } : {}),
    });
    // Prove the channel before anything local exists: a failed dial must leave no endpoint and no
    // descriptor behind, so a session's next read still refuses with the start line rather than
    // connecting to a client that has no host.
    const client = await this.room.client();
    const roomId = this.room.binding.roomId;
    await client.request("status", { roomId });

    this.endpointPath = await nativeServiceEndpoint(this.stateRoot, this.room.binding.accountId,
      process.platform, "/tmp", `member-${this.alias}`);
    await this.#listen();

    this.startedAt = new Date().toISOString();
    await writeMemberDescriptor(this.stateRoot, {
      path: this.endpointPath,
      nonce: this.nonce,
      alias: this.alias,
      roomId,
      keyDigest: this.keyDigest,
      accountId: this.room.binding.accountId,
      seatLabel: this.seatLabel,
      bootEpoch: this.bootEpoch,
      pid: process.pid,
      startedAt: this.startedAt,
      ...(this.claim ? { claim: this.claim } : {}),
      ...(this.build ? { build: this.build } : {}),
    });
    this.running = true;
    return { endpoint: this.endpointPath, roomId, alias: this.alias, pid: process.pid };
  }

  async #listen() {
    const server = net.createServer((socket) => this.#accept(socket));
    server.maxConnections = 128;
    this.server = server;
    await new Promise((resolve, reject) => {
      const onError = (/** @type {Error} */ error) => { server.removeListener("listening", onListening); reject(error); };
      const onListening = () => { server.removeListener("error", onError); resolve(undefined); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.endpointPath);
    });
  }

  /**
   * The seat service's handshake, verbatim in shape: server-auth-first and transcript-bound, so a
   * local session's `NativeServiceClient.connect` works against this process unchanged. That is
   * seam 1 — indistinguishable, not merely similar.
   * @param {net.Socket} socket
   */
  #accept(socket) {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    this.subscriptions.set(socket, new Set());
    const decoder = new NativeFrameDecoder();
    let greeted = false;
    let chain = Promise.resolve();
    const requestId = randomUUID().replaceAll("-", "");
    const serverChallenge = randomUUID().replaceAll("-", "");
    const serverTranscript = { bootEpoch: this.bootEpoch, requestId, serverChallenge,
      accountId: this.room?.binding.accountId ?? "", seatLabel: this.seatLabel };
    if (!sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "server-hello", ...serverTranscript,
      proof: nativeHandshakeProof(this.nonce, "server", serverTranscript) })) return;

    const fail = (/** @type {unknown} */ error, /** @type {string | undefined} */ id) => {
      const message = error instanceof Error ? error.message : "member client request failed";
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "error", requestId: id ?? randomUUID().replaceAll("-", ""),
        reason: greeted ? "request-refused" : "hello-refused", message: message.slice(0, 500) });
    };

    socket.on("data", (bytes) => {
      /** @type {unknown[]} */
      let frames;
      try { frames = decoder.push(bytes); }
      catch (error) { fail(error, undefined); socket.destroy(); return; }
      for (const raw of frames) {
        chain = chain.then(async () => {
          const frame = validateNativeEnvelope(raw);
          if (!greeted) {
            if (frame.type !== "client-hello" || frame.requestId !== requestId
              || /** @type {any} */ (frame).bootEpoch !== this.bootEpoch
              || /** @type {any} */ (frame).serverChallenge !== serverChallenge)
              throw new AgoraError("member client hello did not match this handshake");
            const clientChallenge = requiredString(/** @type {any} */ (frame).clientChallenge, "client challenge");
            validateNativeId(clientChallenge, "client challenge");
            const transcript = { ...serverTranscript, clientChallenge };
            if (!verifyNativeHandshakeProof(/** @type {any} */ (frame).proof, this.nonce, "client", transcript))
              throw new AgoraError("member client session did not prove the transcript");
            greeted = true;
            sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "welcome", ...transcript,
              proof: nativeHandshakeProof(this.nonce, "welcome", transcript) });
            return;
          }
          await this.#dispatch(socket, frame);
        }).catch((error) => {
          const id = raw && typeof raw === "object" && "requestId" in raw
            && typeof (/** @type {any} */ (raw).requestId) === "string" ? /** @type {any} */ (raw).requestId : undefined;
          fail(error, id);
          if (!greeted) socket.end();
        });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket); this.subscriptions.delete(socket);
    });
  }

  /**
   * Forward a local request to the host over the member channel. The allowlist is the host's own
   * member allowlist and nothing is added to it here: a local session gets exactly the authority
   * the route grants, so this process cannot become a way to ask the host for more than a member
   * may ask. A room other than the one this client is bound to is refused by name rather than
   * forwarded, because the binding is the route's, not the caller's.
   * @param {net.Socket} socket @param {any} frame
   */
  async #dispatch(socket, frame) {
    if (!MEMBER_CLIENT_REQUESTS.includes(frame.type))
      throw new AgoraError(`the resident member client does not forward request type ${JSON.stringify(frame.type)}`);
    const roomId = requiredString(frame.roomId, "room id");
    const bound = this.room?.binding.roomId;
    if (roomId !== bound)
      throw new AgoraError(`the resident member client for "${this.alias}" is bound to one room and was asked for another`);
    const room = this.room;
    if (!room) throw new AgoraError("the resident member client has no member channel");
    const client = await room.client();

    if (frame.type === "subscribe") {
      const since = requiredString(frame.since, "cursor");
      this.subscriptions.get(socket)?.add(roomId);
      // KNOWN GAP, owed to r2 and NOT papered over: this attaches a listener to the client object
      // that exists NOW, so when the member channel drops and RemoteRoom re-dials, every local
      // consumer is silently attached to a dead client — the room is live, the host is appending,
      // and nobody downstream hears anything again. Brief r8 seam 2 requires attaching through
      // `openRemoteSubscription`, which owns reconnect, the idle clock and the dedup-on-id
      // contract. Exhibited by Astra/verifier (backroom 1788839927): close the upstream socket,
      // re-dial, append — dials 2 and neither consumer receives the new message. The rewrite is
      // started and is not green (the pump attaches but receives nothing), so it is NOT shipped
      // half-done: the defect stands, named, with its exhibit, rather than being replaced by a
      // second defect that looks like a fix.
      const result = await client.subscribe(roomId, since, (message) => {
        sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "event",
          requestId: /** @type {any} */ (message).id, roomId, message });
      });
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "subscribe-result", requestId: frame.requestId,
        roomId, messages: [], checkpoint: /** @type {any} */ (result)?.checkpoint });
      return;
    }

    const fields = { ...frame };
    delete fields.protocol; delete fields.type; delete fields.requestId;
    const result = await client.request(frame.type, fields);
    // The upstream envelope carries the UPSTREAM `requestId`. Spreading it after the local one
    // overwrites the correlation the local caller is waiting on, and its request then times out
    // against a perfectly healthy host — a proxy that forwards the answer to nobody. So the
    // upstream envelope's own frame fields are stripped and the local correlation is written LAST.
    // (Found by Astra/verifier on the frozen head, backroom 1788839927: `status` timed out at 5 s
    // while `subscribe` worked, because subscribe's reply was built by hand and never spread.)
    const payload = result && typeof result === "object" ? { ...(/** @type {any} */ (result)) } : {};
    delete payload.protocol; delete payload.type; delete payload.requestId;
    sendFrame(socket, { protocol: NATIVE_PROTOCOL, ...payload,
      type: `${frame.type}-result`, requestId: frame.requestId });
  }

  /**
   * A bounded stop, in the reverse order of start: readiness goes FIRST so no session routes to a
   * client that is tearing down, then the local sockets, then the endpoint, then the channel.
   * Never throws — the caller releases the key claim after this, and a teardown that throws would
   * strand the claim it was supposed to hand back.
   */
  async stop() {
    this.running = false;
    this.stopping = true;
    await removeMemberDescriptor(this.stateRoot, this.alias).catch(() => {});
    for (const socket of this.sockets) { try { socket.destroy(); } catch {} }
    this.sockets.clear();
    this.subscriptions.clear();
    if (this.server?.listening) await new Promise((resolve) => this.server?.close(() => resolve(undefined)));
    if (this.endpointPath && process.platform !== "win32") await rm(this.endpointPath, { force: true }).catch(() => {});
    try { await this.room?.close(); } catch {}
    this.room = undefined;
  }
}

/**
 * A `RemoteRoom`-shaped handle onto the RESIDENT client, for the transport to use in place of its
 * own dial. Seam 5: a `native-remote` row resolves to the resident client when its readiness
 * descriptor is present, and refuses with the start line when it is not.
 *
 * This is where per-session direct dialing leaves the product. It is not discouraged here, it is
 * absent: there is no branch that falls back to `openRemoteRoom` when the descriptor is missing,
 * because a fallback is the defect returning under the name of robustness. A session with no
 * resident client gets a refusal that tells it to start one.
 *
 * The surface is exactly what `nativeRemoteTransport` consumes — `binding.roomId`,
 * `binding.accountId`, `client()`, `close()`, `closeFailure` — so the transport above it does not
 * change and cannot tell which side it is talking to.
 * @param {string} stateRoot @param {string} alias
 * @param {{ connect?: any, timeoutMs?: number }} [deps]
 */
export async function openResidentMemberRoom(stateRoot, alias, deps = {}) {
  const { readMemberDescriptor } = await import("./native-member-descriptor.mjs");
  // Throws ServiceDarkError naming the descriptor AND the start line when there is no resident
  // client. That refusal is the whole of seam 5's "refuse with the start line".
  const descriptor = await readMemberDescriptor(stateRoot, alias);
  const { NativeServiceClient } = await import("./native-service.mjs");
  const connect = deps.connect ?? NativeServiceClient.connect;
  /** @type {any} */
  let cached;
  return {
    binding: { roomId: descriptor.roomId, accountId: descriptor.accountId },
    descriptor,
    /** @type {unknown} */
    closeFailure: undefined,
    async client() {
      if (cached && !cached.socket?.destroyed) return cached;
      cached = await connect({ ...descriptor, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) });
      return cached;
    },
    async close() {
      try { cached?.close(); } catch { /* a teardown that throws hides what it tore down */ }
      cached = undefined;
    },
  };
}
