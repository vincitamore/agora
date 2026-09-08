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
  validateNativeEnvelope, validateNativeId, verifyNativeHandshakeProof,
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
   *  claim?: { path: string, generation: string }, build?: import("./harness.mjs").BuildIdentity,
   *  nonce?: string, seatLabel?: string, timeoutMs?: number }} options
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
    socket.on("close", () => { this.sockets.delete(socket); this.subscriptions.delete(socket); });
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
      const result = await client.subscribe(roomId, since, (message) => {
        // One remote subscription per local subscriber for now: the host serialises appends and the
        // consumer dedups on message id, so a fan-out that shares one upstream subscription is an
        // optimisation, not a correctness property, and it is not one this slice claims.
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
    sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: `${frame.type}-result`, requestId: frame.requestId,
      ...(result && typeof result === "object" ? result : {}) });
  }

  /**
   * A bounded stop, in the reverse order of start: readiness goes FIRST so no session routes to a
   * client that is tearing down, then the local sockets, then the endpoint, then the channel.
   * Never throws — the caller releases the key claim after this, and a teardown that throws would
   * strand the claim it was supposed to hand back.
   */
  async stop() {
    this.running = false;
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
