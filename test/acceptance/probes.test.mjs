// @ts-check
// The acceptance probes under scripts/probe-*.mjs are the instruments; these entries make them a
// gate. Each spawns its probe and requires exit 0, so a property that once went red cannot go
// quietly green by the probe rotting: a probe that throws, or that stops asserting, fails here.
//
// The probes are spawned with process.execPath rather than a bare "node" so this suite runs under
// whatever runtime it was started with, including one where no node sits on PATH.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @param {string} probe */
function run(probe) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", probe)], {
    cwd: root, encoding: "utf8",
  });
  const lines = String(result.stdout ?? "").split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  const observations = lines.map((l) => JSON.parse(l));
  return { result, observations };
}

for (const probe of ["probe-service-lifetime.mjs", "probe-custody-disposal.mjs", "probe-upload-origin.mjs", "probe-write-atomic-race.mjs", "probe-carry-export-differential.mjs"]) {
  test(`${probe} holds every bar it names`, () => {
    const { result, observations } = run(probe);
    assert.equal(result.error, undefined, `${probe} did not start: ${result.error?.message}`);
    // A probe that prints nothing has stopped asserting, which passes exit 0 and means nothing.
    assert.ok(observations.length > 0, `${probe} printed no observations`);
    const unmet = observations.filter((o) => o.pass !== true);
    assert.deepEqual(unmet, [], `${probe} reported unmet bars: ${JSON.stringify(unmet)}`);
    assert.equal(result.status, 0, `${probe} exited ${result.status}\n${result.stdout}${result.stderr}`);
  });
}
