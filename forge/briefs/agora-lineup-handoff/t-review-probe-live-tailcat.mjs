#!/usr/bin/env node
// T3 live-only probe procedure. It stays with the campaign evidence, rather than
// product scripts: it requires two real machines, a carried descriptor, and enrolled
// and non-enrolled Tailcat keys. The orchestration role runs it after T1 and T2 land.
import process from "node:process";

if (process.argv.includes("--help")) {
  console.log("Usage: probe-native-member-live.mjs --host-descriptor <path> --enrolled-key <path> --non-enrolled-key <path>");
  console.log("Run only on the real machines. Record Tailcat --allow refusal, bidirectional cursors, and no partial frame after each induced disconnect.");
  process.exit(0);
}
throw new Error("live T3 probe procedure needs the real-machine adapter and explicit descriptor paths");
