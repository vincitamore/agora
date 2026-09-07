#!/usr/bin/env node
// T3 live-only probe. It is deliberately not run by CI: it requires the two real
// machines, an operator-carried descriptor, and an enrolled/non-enrolled Tailcat key.
// Grace runs it after T2 freezes. It must exhibit Tailcat's own --allow refusal and
// the two-direction cursors; the loopback suite cannot make either claim.
import process from "node:process";

if (process.argv.includes("--help")) {
  console.log("Usage: probe-native-member-live.mjs --host-descriptor <path> --enrolled-key <path> --non-enrolled-key <path>");
  console.log("Run only on the real machines. Record Tailcat --allow refusal, bidirectional cursors, and no partial frame after each induced disconnect.");
  process.exit(0);
}
throw new Error("live T3 probe is a Grace-operated harness; supply the real-machine adapter and explicit descriptor paths before running it");
