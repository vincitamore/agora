// Acceptance probe: a rejecting owner disposal join must not leak the pin or lose the receipt.
// Offline; no config, credentials, or live rooms. Exit 1 names an unmet acceptance bar.
//
// `PinnedObject.closed` is P1's disposal join and a disposal can fail. The sender awaits it in a
// `finally` before releasing, so a rejection there must not skip the release or turn a fully
// verified transfer into a failure. Seen red against a build that awaited the join bare.
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { createRouteObjectSender } from "../src/tailcat-custody.mjs";

const bytes = Buffer.from("canonical object");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const host = { scheme: "native", authority: "seat-A", id: "host000000000001" };
const binding = {
  host, member: host, accountId: "account000000001", serviceBootId: "boot000000000001",
  roomId: "a".repeat(32), roomEpoch: "b".repeat(32), membershipRevision: 1,
  grantId: "grant00000000001", routeGeneration: "route00000000001", allowedKeyDigest: digest,
};
const info = { id: "attachment000001", digest, lifetime: "durable", name: "object.bin", kind: "file", size: bytes.length };
const ref = { id: info.id, digest, lifetime: info.lifetime };
const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });

/** An owner whose disposal join rejects. Nothing in the contract forbids it. */
function rejectingPinned(onRelease) {
  return {
    info,
    readable: Readable.from([bytes]),
    closed: Promise.reject(Object.assign(new Error("owner disposal failed"), { code: "OWNER_DISPOSE" })),
    release: () => { onRelease(); },
  };
}

const sender = (onRelease) => createRouteObjectSender(binding, [info], {
  signal: new AbortController().signal, maxBytes: 100,
  async openObject() { return rejectingPinned(onRelease); },
});

let releases = 0;
await sender(() => { releases++; }).send(ref, sink()).then(() => {}, () => {});
const released = {
  probe: "rejecting-disposal-join-still-releases-the-pin",
  pass: releases === 1,
  expectedReleases: 1, actualReleases: releases,
};

const outcome = await sender(() => {}).send(ref, sink()).then(
  (value) => ({ ok: true, value }), (error) => ({ ok: false, code: error?.code }));
const receipt = {
  probe: "rejecting-disposal-join-keeps-the-verified-receipt",
  pass: outcome.ok === true,
  note: "the bytes are delivered and the size and digest verified before the disposal join is awaited",
  outcome: outcome.ok ? "receipt" : `failure(${outcome.code})`,
};

for (const result of [released, receipt]) console.log(JSON.stringify(result));
process.exitCode = [released, receipt].every((p) => p.pass) ? 0 : 1;
