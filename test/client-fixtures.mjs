// @ts-check
// Fixtures for the agora/client tests: a real seat service in a temporary state root (stopped, then
// removed, in one hook), and a stub service for the answers the real one cannot be made to give on
// command. Not a test file: test/client.test.mjs and test/client-seams.test.mjs import it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClientError, connect } from "../src/client.mjs";
import { NativeRoomService } from "../src/native-service.mjs";
import { NATIVE_PROTOCOL, NativeFrameDecoder, encodeNativeFrame, nativeHandshakeProof, verifyNativeHandshakeProof } from "../src/native-protocol.mjs";

export const ROOM = "6".repeat(32);
export const EPOCH = "7".repeat(32);
export const ACCOUNT = "seat_account_0002";
export const ADA = { kind: /** @type {const} */ ("human"), name: "Ada" };
export const hex32 = () => randomUUID().replaceAll("-", "");

/**
 * A seat: a real service in a fresh state root with one room, and a config that names it beside
 * rows the client does not serve. `stop` and `start` are an operator's restart on the same root.
 * @param {import('node:test').TestContext} t
 */
export async function seat(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-client-"));
  const options = { root, accountId: ACCOUNT, seatLabel: "seat-a" };
  let service = new NativeRoomService(options);
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  const config = path.join(root, "agora.json");
  const configBody = JSON.stringify({
    actor: { name: "Grace/watch", kind: "agent" },
    rooms: {
      house: { transport: "native", roomId: ROOM },
      broken: { transport: "native", roomId: "not-a-room-id" },
      scratch: { transport: "local", path: path.join(root, "scratch.ndjson"), roomId: ROOM },
      far: { transport: "native-remote", descriptor: path.join(root, "far.json") },
    },
  });
  await writeFile(config, configBody, "utf8");
  /** @type {Array<{ close(): void }>} */
  const clients = [];
  t.after(() => { for (const c of clients) c.close(); });
  return {
    root, config, configBody,
    /** @param {{ clientName?: string }} [o] */
    open: async (o = {}) => { const c = await connect({ state: root, config, ...o }); clients.push(c); return c; },
    stop: () => service.stop(),
    start: async () => { service = new NativeRoomService(options); await service.start(); },
  };
}

/**
 * What a stub does after the hello. `answer` sees every frame and returns the reply's fields (the
 * envelope is filled in), several replies in order (events ahead of a subscribe result), `"drop"` to
 * destroy the socket with the request on it, or nothing to stay silent. `paused` stops reading after
 * the hello, so the client's writes back up.
 * @typedef {{ offer?: unknown, echoName?: boolean, paused?: boolean, answer?: (frame: Record<string, any>) => Record<string, any> | Array<Record<string, any>> | 'drop' | undefined }} StubBehaviour
 */

/**
 * A stub seat service: the real hello with a welcome built to order. Every frame after a hello is
 * recorded, and `hellos` counts the connections that completed one.
 * @param {import('node:test').TestContext} t @param {StubBehaviour} first
 */
export async function stub(t, first) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-client-stub-"));
  const accountId = "stub_account_0001", seatLabel = "stub-seat";
  /** @type {Array<Record<string, any>>} */
  const frames = [];
  const counts = { hellos: 0 };
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  /** @type {net.Server | undefined} */
  let server;
  /** @param {StubBehaviour} behaviour */
  const listen = async (behaviour) => {
    const nonce = hex32(), bootEpoch = hex32();
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\agora-client-stub-${hex32()}` : path.join(root, `${hex32().slice(0, 8)}.sock`);
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      const decoder = new NativeFrameDecoder();
      const requestId = hex32(), serverChallenge = hex32();
      const serverTranscript = { bootEpoch, requestId, serverChallenge, accountId, seatLabel };
      socket.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "server-hello", ...serverTranscript, proof: nativeHandshakeProof(nonce, "server", serverTranscript) }));
      let greeted = false;
      socket.on("data", (bytes) => {
        for (const frame of /** @type {Array<Record<string, any>>} */ (decoder.push(bytes))) {
          if (!greeted) {
            const transcript = { ...serverTranscript, clientChallenge: frame.clientChallenge };
            assert.ok(verifyNativeHandshakeProof(frame.proof, nonce, "client", transcript));
            greeted = true;
            counts.hellos += 1;
            socket.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, type: "welcome", ...transcript, proof: nativeHandshakeProof(nonce, "welcome", transcript),
              ...(behaviour.offer !== undefined ? { capabilities: behaviour.offer } : {}),
              ...(behaviour.echoName && frame.clientName ? { clientName: frame.clientName } : {}) }));
            if (behaviour.paused) socket.pause();
            continue;
          }
          frames.push(frame);
          const reply = behaviour.answer?.(frame);
          if (reply === "drop") socket.destroy();
          else for (const one of Array.isArray(reply) ? reply : reply ? [reply] : []) socket.write(encodeNativeFrame({ protocol: NATIVE_PROTOCOL, requestId: frame.requestId, ...one }));
        }
      });
    });
    await new Promise((resolve) => /** @type {net.Server} */ (server).listen(endpoint, () => resolve(undefined)));
    await mkdir(path.join(root, "native"), { recursive: true });
    await writeFile(path.join(root, "native", "service.json"), JSON.stringify({ protocol: NATIVE_PROTOCOL, path: endpoint, nonce, bootEpoch, accountId, seatLabel }));
  };
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    const s = server;
    server = undefined;
    if (s) await new Promise((resolve) => s.close(() => resolve(undefined)));
  };
  await listen(first);
  const config = path.join(root, "agora.json");
  await writeFile(config, JSON.stringify({ actor: { name: "x", kind: "agent" }, rooms: { house: { transport: "native", roomId: ROOM } } }));
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, config, frames, accountId,
    get hellos() { return counts.hellos; },
    /** Destroy every live connection; the listener stays. */
    drop: () => { for (const socket of sockets) socket.destroy(); },
    /** Another service at the same state root, with a new descriptor. @param {StubBehaviour} next */
    restart: async (next) => { await close(); await listen(next); },
  };
}

/** A checkpoint in the stub's room. @param {number} sequence @param {{ roomId?: string, epoch?: string }} [o] */
export const checkpoint = (sequence, o = {}) => ({ roomId: o.roomId ?? ROOM, epoch: o.epoch ?? EPOCH, sequence, digest: sequence === 0 ? null : `sha256:${"a".repeat(64)}` });

/** A message as the stub's room would hold it. @param {number} sequence @param {Record<string, unknown>} [o] */
export const stubMessage = (sequence, o = {}) => ({ id: String(sequence).padStart(64, "0"), room: ROOM, author: { id: "stub_account_0001", name: "Ada", kind: "human" }, text: `message ${sequence}`, ts: "2026-01-01T00:00:00.000Z", cursor: `${EPOCH}:${sequence}`, ...o });

/** @param {() => boolean} pred @param {number} [ms] */
export async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The ClientError a promise rejects with. @param {Promise<unknown>} p @returns {Promise<ClientError>} */
export async function failure(p) {
  try { await p; } catch (e) { assert.ok(e instanceof ClientError, `a ClientError, not ${e}`); return e; }
  assert.fail("expected a ClientError");
}

/** @param {() => unknown} f @returns {ClientError} */
export function thrown(f) {
  try { f(); } catch (e) { assert.ok(e instanceof ClientError, `a ClientError, not ${e}`); return e; }
  assert.fail("expected a ClientError");
}
