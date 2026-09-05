// @ts-check
// Append-to-subscriber wake latency against an IN-PROCESS seat service: post start to the
// subscriber's read returning that message. The number is the durable append plus one loopback
// frame; it is not the cross-process socket path and is never quoted against a cross-seat bound.
// Run: node scripts/probe-subscriber-latency.mjs [count]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeRoomService } from "../src/native-service.mjs";
import { openNativeSubscription } from "../src/wake/subscriber.mjs";
import { nativeTransport } from "../src/transports/native.mjs";

const ROOM = "b".repeat(32);
const EPOCH = "c".repeat(32);
const count = Math.max(1, Number(process.argv[2]) || 200);
const root = await mkdtemp(path.join(tmpdir(), "agora-latency-"));
const service = new NativeRoomService({ root, accountId: "seat_account_lat1", seatLabel: "probe" });
try {
  await service.start();
  await service.createRoom({ roomId: ROOM, epoch: EPOCH });
  const peer = nativeTransport({ transport: "native", roomId: ROOM }, { actor: { name: "Sol/codex", kind: "agent" }, stateRoot: root });
  const subscription = await openNativeSubscription({ stateRoot: root, roomId: ROOM, since: `${EPOCH}:0` });
  /** @type {number[]} */
  const latencies = [];
  for (let i = 0; i < count; i++) {
    const started = process.hrtime.bigint();
    const posting = peer.post(`m${i}`);
    /** @type {import("../src/core.mjs").Message[]} */
    let got = [];
    while (!got.length) {
      await subscription.wait(5000);
      got = await subscription.read({ since: `${EPOCH}:${i}` });
    }
    latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
    await posting;
  }
  latencies.sort((a, b) => a - b);
  const quantile = (/** @type {number} */ q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(2);
  console.log(JSON.stringify({ method: "in-process service, post start to subscriber read", n: count,
    p50_ms: quantile(0.5), p95_ms: quantile(0.95), max_ms: latencies[latencies.length - 1].toFixed(2), platform: process.platform }));
  subscription.close();
} finally {
  await service.stop();
  await rm(root, { recursive: true, force: true });
}
