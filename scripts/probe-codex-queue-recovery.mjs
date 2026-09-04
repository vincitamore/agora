// Explicit live acceptance probe. Sends ONE informational message to the named Codex thread.
// No Slack traffic, shared cursors, harness restarts, or database repairs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify, parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { queueCodex } from "../src/codex.mjs";
import { readCursor } from "../src/core.mjs";
import { localTransport } from "../src/transports/local.mjs";
import { watch } from "../src/watch.mjs";

const { values } = parseArgs({ options: { "live-target": { type: "string" }, bin: { type: "string" } } });
if (!values["live-target"]) throw new Error("Requires --live-target <Codex thread>; this sends one informational probe to that conversation.");
const dir = await mkdtemp(path.join(tmpdir(), "agora-queue-recovery-probe-"));
const nonce = randomUUID();
let attempts = 0;
const run = promisify(execFile);
try {
  const transport = localTransport({ transport: "local", path: path.join(dir, "room.ndjson") }, {
    actor: { name: "Agora recovery probe", kind: "system" },
  });
  await transport.post(`Informational delivery probe ${nonce}: testing Agora queue recovery after a simulated pre-acceptance failure. No work is assigned and no response is needed.`);
  const result = await watch(transport, {
    stateDir: dir, key: "probe", mode: "once",
    onBatch: (messages, batch) => queueCodex("agora-recovery-probe", messages, {
      thread: values["live-target"], bin: values.bin,
      run: async (file, args, options) => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("simulated failure before starting Codex"), { code: 1 });
        return run(file, args, options);
      },
      onQueued: async ({ message }) => { await batch.checkpoint(message); },
    }),
  });
  const cursor = await readCursor(dir, "probe");
  assert.equal(result.delivered, 1);
  assert.equal(cursor, "1");
  assert.equal((await transport.read({ since: cursor })).length, 0);
  console.log(JSON.stringify({ pass: true, nonce, target: values["live-target"], attempts,
    accepted: 1, cursor, pending: 0, scope: "queue acceptance and checkpoint; not proof the target consumed its next turn" }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
