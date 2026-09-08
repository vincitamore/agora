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
import { pidAlive } from "./session.mjs";
import {
  NATIVE_PROTOCOL, NativeFrameDecoder, encodeNativeFrame, nativeHandshakeProof,
  parseNativeCursor, validateNativeEnvelope, validateNativeId, verifyNativeHandshakeProof,
} from "./native-protocol.mjs";
import { nativeServiceEndpoint } from "./native-service.mjs";
import { openRemoteRoom, openRemoteSubscription } from "./native-remote.mjs";
import { writeMemberDescriptor, removeMemberDescriptor } from "./native-member-descriptor.mjs";
import { clearClaimChildren, recordClaimChildren } from "./native-member-claim.mjs";
import { spawnTailcat } from "./tailcat-process.mjs";

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
   *  nonce?: string, seatLabel?: string, timeoutMs?: number, subscribeWindow?: number, idleMs?: number,
   *  maxReconnects?: number, backoffMs?: number,
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
    this.subscribeWindow = options.subscribeWindow;
    this.idleMs = options.idleMs;
    // The reconnect budget is the bound on DARK PROPAGATION: when it is spent every local
    // subscription ends `service-dark`, so a cell that means to measure that bound must be able
    // to set it rather than wait out the production default.
    this.maxReconnects = options.maxReconnects;
    this.backoffMs = options.backoffMs;
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
    /** The ONE upstream subscription this process holds for the room, fanned out to every local
     *  consumer. @type {any} */
    this.upstream = undefined;
    /** In-flight start of that subscription, so two sockets subscribing in one tick open one.
     *  @type {Promise<any> | undefined} */
    this.starting = undefined;
    /** Local consumers attached to the fan-out. `pending` is an array while that consumer's own
     *  backfill is still on the wire, and null once it is live. @type {Map<net.Socket, { pending: any[] | null }>} */
    this.liveSockets = new Map();
    /** Why the upstream gave up, once it has. @type {string | undefined} */
    this.darkReason = undefined;
    /** Tailcat children this process has spawned and not seen exit. Recorded beside the claim so
     *  a replacement can PROVE they are gone rather than assume a dead holder tore them down. */
    /** @type {Set<number>} */
    this.childPids = new Set();
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
      channelOptions: { ...(this.channelOptions ?? {}), spawn: this.#recordingSpawn() },
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

  /**
   * The ONE upstream subscription for this client's room, started on the first local subscriber and
   * shared by every later one. `openRemoteSubscription` owns everything a watch should never have
   * owned: the dial, the reconnect budget, the backoff, the idle clock that notices a channel which
   * stopped carrying without closing, and the dedup-on-id contract.
   *
   * Started once, under a promise, because two local sockets subscribing in the same tick would
   * otherwise open two member subscriptions on one channel.
   * @param {string} since the first subscriber's cursor; later ones backfill through `read`
   */
  async #upstream(since) {
    if (this.upstream) return this.upstream;
    if (!this.starting) {
      this.starting = (async () => {
        const room = this.room;
        if (!room) throw new AgoraError("the resident member client has no member channel");
        const subscription = await openRemoteSubscription({ room, since,
          ...(this.subscribeWindow ? { window: this.subscribeWindow } : {}),
          ...(this.idleMs ? { idleMs: this.idleMs } : {}),
          ...(this.maxReconnects !== undefined ? { maxReconnects: this.maxReconnects } : {}),
          ...(this.backoffMs !== undefined ? { backoffMs: this.backoffMs } : {}) });
        this.upstream = subscription;
        void this.#pump(subscription);
        return subscription;
      })().finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  /**
   * Drain the upstream and hand each message to every local consumer. This is the only reader of
   * the subscription, which is why the fan-out lives here: `read` drains, so a second reader would
   * silently take messages the first will never see.
   * @param {any} subscription
   */
  async #pump(subscription) {
    while (this.running && this.upstream === subscription) {
      /** @type {any[]} */
      let batch;
      try { batch = /** @type {any} */ (await subscription.read({})); }
      catch (error) {
        // The reconnect budget is spent, or the host refused. Either way this client can no longer
        // carry the room, and every local subscription must learn it — as DARKNESS, the same
        // `service-dark` a session gets from a seat service that stopped, because that is what a
        // subscriber's watch already knows how to end on.
        this.#goDark(error);
        return;
      }
      if (!batch.length) { await subscription.wait(250); continue; }
      for (const message of batch) this.#fanOut(message);
    }
  }

  /** @param {any} message */
  #fanOut(message) {
    const roomId = this.room?.binding.roomId;
    if (!roomId) return;
    for (const [socket, state] of this.liveSockets) {
      // A consumer still inside its backfill holds the message rather than receiving it early; the
      // subscribe path flushes what it held, in cursor order, once the backfill is on the wire.
      if (state.pending) { state.pending.push(message); continue; }
      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "event", requestId: message.id, roomId, message });
    }
  }

  /**
   * The upstream gave up. Destroying each local subscriber's socket is what turns that into
   * `service-dark` on their side: a session's `NativeServiceClient` reports a closed socket exactly
   * as it does for a seat service that stopped, and its watch ends `service-dark` with exit 1
   * rather than 0 — never a quiet room.
   * @param {unknown} error
   */
  #goDark(error) {
    this.darkReason = error instanceof Error ? error.message : String(error);
    const subscription = this.upstream;
    this.upstream = undefined;
    try { subscription?.close(); } catch { /* a corpse does not close cleanly and need not */ }
    for (const [socket] of this.liveSockets) { try { socket.destroy(); } catch { /* already gone */ } }
    this.liveSockets.clear();
  }

  /**
   * The channel's own spawn seam, wrapped so every Tailcat child this process starts is written
   * beside the claim while it lives. Nothing about the spawn changes: an injected `spawn` (a
   * cell's fake) is still the one called, and the wrapper only observes.
   *
   * A fake child has no `pid`, so nothing is recorded for it and no cell is forced to invent one;
   * that is honest rather than convenient, since the record exists to name REAL processes a
   * replacement can probe.
   */
  #recordingSpawn() {
    const base = this.channelOptions?.spawn ?? spawnTailcat;
    return async (/** @type {any} */ args, /** @type {any} */ runtime, /** @type {any} */ owner) => {
      const child = await base(args, runtime, owner);
      const pid = child?.pid;
      if (typeof pid === "number" && pid > 0) {
        this.childPids.add(pid);
        await this.#writeChildren();
        child.once?.("exit", () => {
          this.childPids.delete(pid);
          void this.#writeChildren();
        });
      }
      return child;
    };
  }

  /** @returns {Promise<void>} */
  async #writeChildren() {
    if (!this.claim?.dir) return;
    try { await recordClaimChildren(this.claim.dir, this.claim.generation, this.childPids); }
    catch { /* the record is evidence for the NEXT holder; failing to write it must not kill this one */ }
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
      this.sockets.delete(socket); this.subscriptions.delete(socket); this.liveSockets.delete(socket);
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

      // Seam 2. This process owns the member channel's lifetime, so it attaches through
      // `openRemoteSubscription` — which owns the dial, the reconnect budget, the idle clock and
      // the dedup-on-id contract — and NEVER through a raw `client.subscribe`.
      //
      // The defect that shape had: a listener registered on the client object that exists NOW is
      // silently attached to a dead client the moment the member channel drops and `RemoteRoom`
      // re-dials. The room is live, the host is appending, and nobody downstream hears anything
      // again. Reproduced by destroying the upstream socket and appending: two dials, and neither
      // local consumer received the new message, because recovery was owned by nobody.
      //
      // ONE upstream subscription per room, fanned out to every local consumer, because the
      // subscription's `read` DRAINS its queue and advances one `drained` cursor — two consumers
      // reading it directly would each take half the room and neither would know.
      const state = { pending: /** @type {any[] | null} */ ([]) };
      this.liveSockets.set(socket, state);
      /** @type {any} */
      let upstream;
      try { upstream = await this.#upstream(since); }
      catch (error) { this.liveSockets.delete(socket); throw error; }

      // The BACKFILL is this consumer's alone: the live stream starts wherever the first consumer
      // put it, and a later one asking for an earlier cursor must be served from the host. It runs
      // through the host's own `read`, which is one of the four requests a member may make.
      const backlog = /** @type {any} */ (await client.request("read", { roomId, since }));
      const replayed = Array.isArray(backlog?.messages) ? backlog.messages : [];
      /** @type {Set<string>} */
      const seen = new Set();
      let floor = parseNativeCursor(since).sequence;
      for (const message of replayed) {
        seen.add(message.id);
        floor = Math.max(floor, parseNativeCursor(message.cursor).sequence);
        sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "event", requestId: message.id, roomId, message });
      }
      // Anything the live stream produced WHILE that read was in flight is held rather than
      // dropped, then flushed in cursor order behind the backfill: delivery stays at-least-once as
      // the consumer sees it, cursors stay monotone, and an overlap is a duplicate by id — which is
      // the contract, not a defect. Dropping the window instead is how a message goes missing
      // exactly once per subscribe, which is the hardest kind to ever see again.
      const held = state.pending ?? [];
      state.pending = null;
      const flush = held
        .filter((message) => !seen.has(message.id) && parseNativeCursor(message.cursor).sequence > floor)
        .sort((a, b) => parseNativeCursor(a.cursor).sequence - parseNativeCursor(b.cursor).sequence);
      for (const message of flush)
        sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "event", requestId: message.id, roomId, message });

      sendFrame(socket, { protocol: NATIVE_PROTOCOL, type: "subscribe-result", requestId: frame.requestId,
        roomId, messages: [], checkpoint: backlog?.checkpoint });
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
    try { this.upstream?.close(); } catch { /* a teardown that throws hides what it tore down */ }
    this.upstream = undefined;
    this.liveSockets.clear();
    try { await this.room?.close(); } catch {}
    this.room = undefined;
    // Teardown is finished only when no child this process started is still answering. Clearing
    // the record is what licenses the release; leaving it is what refuses the next holder. A
    // teardown that timed out (`AGORA_CLEANUP_PENDING`) therefore leaves the record standing on
    // purpose, and the key stays fenced until the child is actually gone.
    for (const pid of [...this.childPids]) if (!pidAlive(pid)) this.childPids.delete(pid);
    if (this.claim?.dir) {
      if (this.childPids.size) await this.#writeChildren();
      else await clearClaimChildren(this.claim.dir, this.claim.generation).catch(() => {});
    }
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
