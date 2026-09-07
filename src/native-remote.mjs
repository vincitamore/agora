// @ts-check
// T2 remote client: the far half of native membership over Tailcat.
//
// The host (T1) admits an enrolled NODE KEY on a per-route secret. This file is what dials it: it
// resolves the descriptor and the secret from THIS seat's own state, proves the member transcript
// over the member phases, and then hands the Tailcat child's stdio to the SAME request machine a
// local native room uses. There is no second protocol here and no second proof construction.
//
// Two sentences that govern everything below, because they are the ones easiest to lose:
//
//   The descriptor is REACH, not authentication, in both directions. Its digest covers its own
//   contents, so it catches a mangled carry and nothing an adversary who can rewrite the file
//   could not recompute. What authenticates the HOST to this seat is the `member-server` proof in
//   the first frame: only the host that minted the route secret can produce it.
//
//   Nothing here mints a key, reads an ambient Tailcat identity, or takes a path from the
//   descriptor. The private key is this seat's enrolled Agora identity and nothing else.
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { AgoraError } from "./core.mjs";
import { MEMBER_PHASES, assertDescriptorDigest, memberHandshakeProof, memberTranscript,
  readRouteSecret, routeSecretPath, verifyMemberHandshakeProof } from "./native-member.mjs";
import { NATIVE_PROTOCOL, NativeFrameDecoder, encodeNativeFrame, nativeCursor, parseNativeCursor,
  validateNativeEnvelope, validateNativeId } from "./native-protocol.mjs";
import { NativeServiceClient } from "./native-service.mjs";
import { publicNodeKeyDigest } from "./protocol/route.mjs";
import { startMemberChannel } from "./tailcat-routes.mjs";
import { localTransferIdentity } from "./tailcat.mjs";
import { ServiceDarkError, nativeMessage } from "./wake/subscriber.mjs";

/** How long a handshake frame may take to arrive before the channel is called dark. */
export const HANDSHAKE_TIMEOUT_MS = 30000;

/** @param {unknown} value @param {string} label */
function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new AgoraError(`native member handshake needs a ${label}`);
  return value;
}

/**
 * Write one frame. Deliberately simpler than the service's `sendFrame`: the only frames written
 * here are the two handshake frames, which are a few hundred bytes and precede any request, so
 * there is no pending-write budget to blow. Everything after the welcome goes through
 * `NativeServiceClient`, which has the service's own backpressure refusal.
 * @param {import("node:stream").Duplex} stream @param {Record<string, unknown>} value
 */
function writeFrame(stream, value) {
  if (stream.destroyed || !stream.writable) return false;
  stream.write(encodeNativeFrame(value));
  return true;
}

/**
 * Reads the handshake frames off one stream, then gets out of the way.
 *
 * The service has a private `readHandshakeFrame` that makes a fresh decoder PER FRAME and drops
 * whatever it had buffered. This one keeps a single decoder across the whole handshake and refuses
 * at handover if anything is left in it, because the `NativeServiceClient` that takes the stream
 * next constructs its OWN decoder: bytes stranded in mine would not be lost loudly, they would
 * desync the client's framing and surface as an invalid frame length much later, against a
 * different cause. A stranded byte is the silent-discard shape this campaign keeps finding.
 */
class HandshakeReader {
  /** @param {import("node:stream").Duplex} stream @param {number} timeoutMs */
  constructor(stream, timeoutMs) {
    this.stream = stream;
    this.timeoutMs = timeoutMs;
    this.decoder = new NativeFrameDecoder();
    /** @type {unknown[]} */
    this.queue = [];
    /** @type {unknown} */
    this.failure = undefined;
    /** @type {(() => void) | undefined} */
    this.waiter = undefined;
    this.detached = false;
    this.onData = (/** @type {Buffer} */ bytes) => {
      try { for (const frame of this.decoder.push(bytes)) this.queue.push(frame); }
      catch (error) { this.failure = error; }
      this.waiter?.();
    };
    this.onError = (/** @type {Error} */ error) => { this.failure = error; this.waiter?.(); };
    this.onClose = () => {
      this.failure ??= new AgoraError("member-channel-dark: the host closed the channel during the handshake");
      this.waiter?.();
    };
    stream.on("data", this.onData);
    stream.on("error", this.onError);
    stream.on("close", this.onClose);
  }

  /** @param {string} label */
  async next(label) {
    while (true) {
      if (this.queue.length) return /** @type {Record<string, any>} */ (validateNativeEnvelope(this.queue.shift()));
      if (this.failure !== undefined) throw this.failure;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.failure ??= new AgoraError(`member-channel-dark: the host's ${label} did not arrive within ${this.timeoutMs} ms`);
          done();
        }, this.timeoutMs);
        timer.unref?.();
        const done = () => { clearTimeout(timer); this.waiter = undefined; resolve(undefined); };
        this.waiter = done;
      });
    }
  }

  /** Refuse rather than strand anything the client's fresh decoder cannot see. Deliberately does
   * NOT detach: between this reader's listener going away and the request client's going on, Node
   * keeps the stream flowing and drops whatever it emits in the gap — the stranded-bytes shape one
   * tick later. The caller attaches the client first and detaches after. */
  assertDrained() {
    if (this.queue.length)
      throw new AgoraError(`member-hello-refused: the host sent ${this.queue.length} unsolicited frame(s) with its welcome`);
    if (this.decoder.buffer.length)
      throw new AgoraError(`member-hello-refused: ${this.decoder.buffer.length} byte(s) followed the welcome inside the handshake reader; the request client frames independently and cannot see them`);
  }

  detach() {
    if (this.detached) return;
    this.detached = true;
    this.stream.off("data", this.onData);
    this.stream.off("error", this.onError);
    this.stream.off("close", this.onClose);
  }
}

/**
 * The descriptor as the operator carried it. Parsed, shape-checked and self-digest-checked; NOT
 * treated as authentication (see the header).
 * @param {string} file
 */
export async function readRemoteDescriptor(file) {
  let raw;
  try { raw = await readFile(file, "utf8"); }
  catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    throw new AgoraError(`descriptor-unreadable: no route descriptor at ${file} (${code ?? String(e)}); the operator carries it by hand from the host's \`service route open\``);
  }
  /** @type {unknown} */
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new AgoraError(`descriptor-unreadable: ${file} is not valid JSON`); }
  return assertDescriptorDigest(parsed);
}

/**
 * This seat's enrolled Agora identity, and never a freshly minted one.
 *
 * `localTransferIdentity` GENERATES a key on ENOENT, which is right for `enroll` and wrong here: a
 * connect that quietly minted one would leave a new identity on disk as the side effect of a failed
 * dial, and then fail a layer later with "local enrolled private key does not match route binding"
 * — a true sentence and the wrong diagnosis, pointing at the descriptor instead of at the fact that
 * this seat never enrolled. So the file is required to exist first.
 * @param {string} stateRoot
 * @param {{ identity?: typeof localTransferIdentity }} [deps]
 */
export async function resolveSeatIdentity(stateRoot, deps = {}) {
  // ONE call, not a check and then a use. The earlier shape stat'ed the key and then called the
  // identity helper, which mints on ENOENT: two observations of a file that can change between
  // them, and the second one quietly creates what the first was checking for. `create: false` makes
  // the refusal the helper's own, at the moment it would otherwise have minted.
  return (deps.identity ?? localTransferIdentity)(stateRoot, { create: false });
}

/**
 * What this seat can check about a descriptor before spending a Tailcat child on it.
 *
 * Each refusal is named, and none of them authenticates the host. The `allowedKeyDigest` check is
 * the one with content: it says this route was granted to THIS seat's key rather than another's.
 * `startMemberChannel` checks the same digest again against the key's own `printpub`
 * (tailcat-routes.mjs), which is the authoritative one; this earlier copy exists so the operator
 * gets a named reason instead of a spawn failure, and the duplication is deliberate.
 * @param {ReturnType<typeof assertDescriptorDigest>} descriptor
 * @param {{ stateRoot: string, nodeKey: string }} seat
 */
export function assertRemoteDescriptor(descriptor, seat) {
  const seatDigest = publicNodeKeyDigest(seat.nodeKey);
  if (descriptor.binding.allowedKeyDigest !== seatDigest)
    throw new AgoraError("descriptor-not-ours: this route was opened for a different public node key; ask the host to `service route open --allow-key` with the key this seat's `enroll` prints");
  // Equality against the binding's own canonical name, never containment: containment prevents
  // escape and permits SELECTION, and selecting which file gets HMAC'd is the whole attack.
  routeSecretPath(seat.stateRoot, descriptor.binding, descriptor.proofRef);
  return descriptor;
}

/**
 * The client half of the member handshake.
 *
 * The transcript is rebuilt from MY binding. Only the three freshness fields come off the wire
 * (`bootEpoch`, `requestId`, `serverChallenge`); every binding-derived field comes from the
 * descriptor, through the host's own `memberTranscript`, so there is one construction of it in the
 * tool and a frame that disagrees cannot steer what I verify — it can only fail the proof. The
 * field-by-field comparison happens first so the refusal is named rather than a bare proof failure.
 *
 * This seat never sends an `accountId`: the route binds the principal, and a frame naming one is
 * refused by the host. Claiming it "for clarity" would be exactly the claim the binding replaces.
 * @param {{ stream: import("node:stream").Duplex, binding: any, secret: string, timeoutMs?: number,
 *  onDrained?: (stream: import("node:stream").Duplex) => any }} input
 */
export async function completeMemberHandshake(input) {
  const timeoutMs = input.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const reader = new HandshakeReader(input.stream, timeoutMs);
  try {
    const hello = await reader.next("member server hello");
    if (hello.type === "server-hello")
      throw new AgoraError("member-phase-refused: this is a member route and the host greeted with the local handshake; the seat nonce is not this channel's authentication");
    if (hello.type !== "member-server-hello")
      throw new AgoraError(`member-hello-refused: the host greeted with ${JSON.stringify(hello.type)}`);
    const bootEpoch = validateNativeId(requiredString(hello.bootEpoch, "boot epoch"), "service boot epoch");
    const requestId = validateNativeId(requiredString(hello.requestId, "handshake request id"), "handshake request id");
    const serverChallenge = validateNativeId(requiredString(hello.serverChallenge, "server challenge"), "server challenge");
    const serverTranscript = memberTranscript(input.binding, { bootEpoch, requestId, serverChallenge });
    for (const [field, mine] of Object.entries(serverTranscript))
      if (hello[field] !== mine)
        throw new AgoraError(`member-binding-mismatch: the host's ${field} is not the one this descriptor binds`);
    if (!verifyMemberHandshakeProof(hello.proof, input.secret, MEMBER_PHASES.server, serverTranscript))
      throw new AgoraError("member-host-proof-refused: the host did not prove this route's secret. The descriptor is reach; this proof is the authentication, and it failed");

    const clientChallenge = randomUUID().replaceAll("-", "");
    const transcript = { ...serverTranscript, clientChallenge };
    if (!writeFrame(input.stream, { protocol: NATIVE_PROTOCOL, type: "member-client-hello", ...transcript,
      proof: memberHandshakeProof(input.secret, MEMBER_PHASES.client, transcript) }))
      throw new AgoraError("member-channel-dark: the channel closed before this seat could authenticate");

    const welcome = await reader.next("member welcome");
    if (welcome.type !== "member-welcome")
      throw new AgoraError(`member-welcome-refused: the host answered the client hello with ${JSON.stringify(welcome.type)}`);
    for (const [field, mine] of Object.entries(transcript))
      if (welcome[field] !== mine)
        throw new AgoraError(`member-welcome-refused: the welcome's ${field} does not echo the transcript this seat proved`);
    if (!verifyMemberHandshakeProof(welcome.proof, input.secret, MEMBER_PHASES.welcome, transcript))
      throw new AgoraError("member-welcome-refused: the welcome did not prove the fresh transcript");
    reader.assertDrained();
    // The handover, in the one order that leaves no gap: the client's listener goes on while this
    // reader's is still attached, and only then does this one come off.
    const handed = input.onDrained ? input.onDrained(input.stream) : undefined;
    reader.detach();
    return { requestId, transcript, memberAccountId: input.binding.accountId, handed };
  } catch (error) {
    reader.detach();
    throw error;
  }
}

/**
 * One remote room: the Tailcat channel and the request client over it.
 *
 * A dropped channel is reported, never papered over: the client is dropped with the stream and the
 * NEXT verb re-dials. Re-dialling is a fresh connection to the host's still-open listener, so it
 * gets a fresh `requestId` and `serverChallenge` and proves the transcript again under the same
 * route secret. A route the host has CLOSED cannot be re-dialled: its secret is gone and the
 * hello is refused by name, which is revocation working rather than a transport fault.
 */
export class RemoteRoom {
  /**
   * @param {{ descriptor: any, secret: string, stateRoot: string, keyPath: string, nodeKey: string,
   *  timeoutMs?: number, serviceId?: string, runtime?: any, channelOptions?: any }} input
   */
  constructor(input) {
    this.descriptor = input.descriptor;
    this.nodeKey = input.nodeKey;
    this.binding = input.descriptor.binding;
    this.secret = input.secret;
    this.stateRoot = input.stateRoot;
    this.keyPath = input.keyPath;
    this.timeoutMs = input.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    // The state root is folded INTO the runtime, not merely held beside it. The channel hands this
    // object to spawnTailcat, which hands it to resolveTailcatBinary, which needs a state root to
    // find the capsule — so a room that keeps the root as its own field and passes {} downward
    // reaches the resolver with nothing and dies inside the guardian, reporting a status with no
    // text. That is the same defect L1 fixed one file over, found here by taking its list to the
    // next unit rather than by anything this suite could see: a faked child never reaches a
    // resolver. A caller's own runtime still wins on any key it sets.
    this.runtime = { stateRoot: input.stateRoot, ...(input.runtime ?? {}) };
    this.channelOptions = input.channelOptions ?? {};
    // The remote has no seat service, so it owns its own channels: a per-process boot id fences
    // every child to this process, and the owner ids are ordinary native ids.
    this.serviceId = input.serviceId ?? this.binding.accountId;
    this.serviceBootId = randomUUID().replaceAll("-", "");
    /** @type {AbortController | undefined} */
    this.owner = undefined;
    /** @type {Promise<{ client: NativeServiceClient, resource: any }> | undefined} */
    this.dialling = undefined;
    this.closed = false;
    /** Channel DROPS observed on this room. Deliberately not called reconnects: it counts closes,
     * and a close is not evidence that anything re-dialled. What proves a re-dial is the host
     * receiving a second subscribe, which is what the reattach cell asserts. */
    this.drops = 0;
    /** Completed dials, incremented only after a handshake produced a live request client. */
    this.dials = 0;
  }

  /** @returns {Promise<NativeServiceClient>} */
  async client() {
    return (await this.#dial()).client;
  }

  #dial() {
    if (this.closed) return Promise.reject(new AgoraError("member-channel-dark: this remote room was closed"));
    if (this.dialling) return this.dialling;
    const drop = () => { if (this.dialling === attempt) this.dialling = undefined; };
    const attempt = (async () => {
      if (!this.owner || this.owner.signal.aborted) this.owner = new AbortController();
      /** @type {NativeServiceClient | undefined} */
      let client;
      const resource = startMemberChannel({ descriptor: this.descriptor }, {
        owner: { serviceId: this.serviceId, serviceBootId: this.serviceBootId, signal: this.owner.signal },
        runtime: this.runtime,
        // The last named gate before a child is spawned, and it does real work: comparing the
        // handed descriptor with the one this room resolved could never fail (the channel
        // validates the object it was given), and a guard that cannot fire is worth less than no
        // guard, because it reads as one. This re-checks the grant against THIS seat's key.
        assertDescriptor: (descriptor) => { assertRemoteDescriptor(/** @type {any} */ (descriptor), { stateRoot: this.stateRoot, nodeKey: this.nodeKey }); },
        resolveClientKey: () => ({ keyPath: this.keyPath }),
        acceptChannel: (accepted, stream, signal) => {
          /** @type {(v?: unknown) => void} */ let resolveReady = () => {};
          /** @type {(e: unknown) => void} */ let rejectReady = () => {};
          const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
          void ready.catch(() => {});
          const closed = new Promise((resolve) => {
            if (stream.destroyed) resolve(undefined); else stream.once("close", () => resolve(undefined));
          });
          void completeMemberHandshake({ stream, binding: accepted, secret: this.secret, timeoutMs: this.timeoutMs,
            // The SAME request machine a local native room runs. It touches only the duplex
            // surface (data/error/close, destroyed, destroy, writable/writableLength/write),
            // which is the duck-typing the host half already relies on, so the remote inherits
            // the timeouts, the unknown-append-acceptance rule and the event fan-out unchanged.
            // Constructed inside the handshake's handover so the stream is never unlistened.
            onDrained: (ready) => { client = new NativeServiceClient(/** @type {any} */ (ready), this.timeoutMs); return client; } })
            .then(() => { resolveReady(undefined); },
              (error) => { rejectReady(error); stream.destroy(); });
          if (signal.aborted) stream.destroy();
          return { ready, closed, stop: async () => { stream.destroy(); await closed; } };
        },
        ...this.channelOptions,
      });
      try { await resource.ready; }
      catch (error) {
        drop(); void resource.stop().catch(() => {});
        // MEASURED, not assumed: a transport child that ends because there is nothing to reach
        // fails the dial in milliseconds, while one that stays connected with no peer answering
        // costs the whole handshake timeout. The fast path was already taken; what it could not do
        // was say what had happened, because the route layer's cancellation message describes its
        // own bookkeeping. A closing room keeps that message, since there the cancellation IS the
        // cause.
        if (!this.closed && /** @type {any} */ (error)?.code === "AGORA_ROUTE_CANCELLED")
          throw new AgoraError(`member-channel-dark: the transport ended before the host greeted this seat, which is what a route that is no longer open looks like from here (${error instanceof Error ? error.message : String(error)})`);
        throw error;
      }
      if (!client) { drop(); void resource.stop().catch(() => {}); throw new AgoraError("member-channel-dark: the channel reported ready without a request client"); }
      this.dials += 1;
      client.socket.once("close", () => { this.drops += 1; drop(); void resource.stop().catch(() => {}); });
      return { client, resource };
    })();
    this.dialling = attempt;
    void attempt.catch(() => {});
    return attempt;
  }

  async close() {
    this.closed = true;
    const attempt = this.dialling;
    this.dialling = undefined;
    this.owner?.abort();
    if (!attempt) return;
    try { const { client, resource } = await attempt; client.close(); await resource.stop().catch(() => {}); }
    catch { /* a dial that never completed has nothing to close */ }
  }
}

/**
 * Resolve everything a remote room needs from this seat's own state, in the order that produces the
 * most useful refusal first: the descriptor, then this seat's identity, then the grant's ownership,
 * then the secret.
 * @param {{ descriptorPath: string, stateRoot: string, timeoutMs?: number, runtime?: any,
 *  channelOptions?: any, identity?: typeof localTransferIdentity }} input
 */
export async function openRemoteRoom(input) {
  const descriptor = await readRemoteDescriptor(input.descriptorPath);
  const seat = await resolveSeatIdentity(input.stateRoot, { identity: input.identity });
  assertRemoteDescriptor(descriptor, { stateRoot: input.stateRoot, nodeKey: seat.nodeKey });
  const secret = await readRouteSecret(input.stateRoot, descriptor.binding, descriptor.proofRef);
  return new RemoteRoom({ descriptor, secret, stateRoot: input.stateRoot, keyPath: seat.keyPath, nodeKey: seat.nodeKey,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.channelOptions ? { channelOptions: input.channelOptions } : {}) });
}

/**
 * Subscribe to a remote room, in the exact shape `openNativeSubscription` returns for a local one,
 * so the watch loop consuming it is the same loop and nothing in `src/wake/subscriber.mjs` moves.
 *
 * The one behaviour a local subscription has no need for is reconnect. The contract is the ruled
 * one: **at-least-once as the consumer sees it**. After a reconnect no message is lost, at most one
 * duplicate is observed per reconnect, a duplicate carries its ORIGINAL message id, and the
 * persisted cursor never moves backwards. The idempotence point is the message id, above the
 * transport — a consumer that must not surface a duplicate dedups on `id`, and this subscription's
 * own floor is not that guarantee, it is only what keeps the common case quiet.
 * @param {{ room: RemoteRoom, since?: string, window?: number, maxReconnects?: number,
 *  backoffMs?: number }} opts
 * @returns {Promise<import("./wake/subscriber.mjs").NativeSubscription>}
 */
export async function openRemoteSubscription(opts) {
  const room = opts.room;
  const roomId = room.binding.roomId;
  const maxReconnects = opts.maxReconnects ?? 5;
  const backoffMs = opts.backoffMs ?? 500;
  /** @type {import("./core.mjs").Message[]} */
  let queue = [];
  /** @type {string | undefined} */
  let darkReason;
  let stopped = false;
  let reconnects = 0;
  /** @type {Set<() => void>} */
  const waiters = new Set();
  const wake = () => { for (const w of waiters) w(); waiters.clear(); };
  const markDark = (/** @type {string} */ why) => { darkReason ??= why; wake(); };
  /** A host-answered refusal, kept as itself so `read` can throw the real cause rather than a
   * darkness that was never observed. @type {unknown} */
  let failure;
  const markFailed = (/** @type {unknown} */ error) => { failure ??= error; wake(); };

  const push = (/** @type {any[]} */ messages) => {
    let added = false;
    for (const raw of messages) {
      /** @type {import("./core.mjs").Message} */
      let m;
      try { m = nativeMessage(raw); parseNativeCursor(m.cursor); }
      catch { continue; }
      // Dedup INSIDE the buffer by id, which is what makes a replayed message after a reconnect a
      // duplicate the consumer never has to see when it has not yet drained the original.
      if (queue.some((q) => q.id === m.id)) continue;
      queue.push(m);
      added = true;
    }
    if (added) { queue.sort((a, b) => parseNativeCursor(a.cursor).sequence - parseNativeCursor(b.cursor).sequence); wake(); }
  };

  let since = opts.since;
  /** @type {{ from: string, to: string, count: number } | null} */
  let neverOffered = null;
  /** @type {NativeServiceClient} */
  let first;
  // Every way the first dial can fail is this room being unreachable from this session, which is
  // what `connectSeatService` says about the local one; the watch loop then ends with
  // `service-dark` and exit 1 rather than 0, because 0 reads as a quiet room.
  try { first = await room.client(); }
  catch (e) { throw new ServiceDarkError(`remote room ${roomId} could not be dialled: ${e instanceof Error ? e.message : String(e)}`); }
  if (!since) {
    const status = (await first.request("status", { roomId })).status;
    const epoch = String(status.epoch);
    // Number() on a field from the wire is the silent-number shape: 3.7 and -5 both survive it and
    // then Math.max(0, committed - window) launders either into the valid cursor 0, which is a
    // full-room replay reported with neverOffered null — a well-formed answer to a malformed
    // status. A count is a non-negative safe integer or the status is refused.
    const committed = status.committed;
    if (typeof committed !== "number" || !Number.isSafeInteger(committed) || committed < 0)
      throw new AgoraError(`the host reported a committed count of ${JSON.stringify(committed)} for ${roomId}; a committed count is a non-negative safe integer, and no cursor is derived from a malformed one`);
    const window = opts.window && opts.window > 0 ? opts.window : 1000;
    const start = Math.max(0, committed - window);
    since = nativeCursor(epoch, start);
    if (start > 0) neverOffered = { from: nativeCursor(epoch, 1), to: nativeCursor(epoch, start), count: start };
  }
  const epoch = parseNativeCursor(since).epoch;
  /** Highest sequence handed to the CALLER. Nothing at or below it is handed out again. */
  let drained = parseNativeCursor(since).sequence;

  /** @param {NativeServiceClient} client @param {string} from */
  const attach = async (client, from) => {
    client.socket.once("close", () => { if (!stopped) void reattach(); });
    const result = await client.subscribe(roomId, from, (message) => push([message]));
    push(Array.isArray(result?.messages) ? result.messages : []);
  };

  /** A refusal the far side named is a fact, not a flaky connection: retrying it five times spawns
   * five Tailcat children to be told the same thing, and then reports the last one as darkness. */
  const NAMED_REFUSAL = /(member-hello-refused|member-welcome-refused|member-host-proof-refused|member-phase-refused|member-binding-mismatch|member-actor-mismatch|member-request-refused|member-room-refused|member-author-kind-refused|descriptor-not-ours|descriptor-unreadable|proof-ref-refused|enrollment-absent|route-not-open|request-refused)/;

  const reattach = async () => {
    // Re-subscribing from `drained` is what makes "nothing is lost" true: the host replays every
    // committed message after the last sequence the CALLER received, not after the last one this
    // process happened to buffer.
    for (let attempt = 0; attempt < maxReconnects && !stopped; attempt += 1) {
      reconnects += 1;
      /** @type {NativeServiceClient | undefined} */
      let client;
      try {
        client = await room.client();
        await attach(client, nativeCursor(epoch, drained));
        wake();
        return;
      } catch (error) {
        if (stopped) return;
        // A refusal the host ANSWERED — a revoked route, a foreign epoch, a backlog it will not
        // replay — arrived on a live socket. It is this session's to recover and it reports
        // ITSELF; retrying it four more times and then calling it "could not be re-dialled" would
        // replace a precise cause with a false one, which is worse than either alone.
        if (client && !client.socket.destroyed) return markFailed(error);
        if (NAMED_REFUSAL.test(error instanceof Error ? error.message : String(error))) return markFailed(error);
        if (attempt + 1 >= maxReconnects)
          return markDark(`remote room ${roomId} could not be re-dialled after ${reconnects} attempt(s): ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => { const t = setTimeout(resolve, backoffMs * (attempt + 1)); t.unref?.(); });
      }
    }
  };

  await attach(first, since);

  return {
    roomId,
    seat: { id: room.binding.accountId, seatLabel: `remote route to ${room.binding.host.id}` },
    neverOffered,
    async read(readOpts = {}) {
      const floor = readOpts.since ? Math.max(drained, parseNativeCursor(readOpts.since).sequence) : drained;
      const limit = readOpts.limit && readOpts.limit > 0 ? readOpts.limit : Infinity;
      /** @type {import("./core.mjs").Message[]} */
      const out = [];
      /** @type {import("./core.mjs").Message[]} */
      const keep = [];
      for (const m of queue) {
        const s = parseNativeCursor(m.cursor).sequence;
        if (s <= floor) continue;
        if (out.length < limit) out.push(m); else keep.push(m);
      }
      queue = keep;
      if (out.length) drained = parseNativeCursor(out[out.length - 1].cursor).sequence;
      else if (failure !== undefined) throw failure;
      else if (darkReason !== undefined) throw new ServiceDarkError(darkReason);
      return /** @type {import("./core.mjs").ReadResult} */ (out);
    },
    wait(ms) {
      if (queue.length || darkReason !== undefined || failure !== undefined) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(done); resolve(undefined); }, Math.max(0, ms));
        const done = () => { clearTimeout(timer); resolve(undefined); };
        waiters.add(done);
      });
    },
    dark: () => darkReason,
    close() { stopped = true; void room.close(); },
  };
}
