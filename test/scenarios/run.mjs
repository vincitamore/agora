#!/usr/bin/env node
// @ts-check
/**
 * Run one leg of one scenario and print its observation lines on stdout.
 *
 *   node test/scenarios/run.mjs <S00|S01|S03|S04|S07|S13|S14|S19|S20|S23|S29|S34|S60|S61|S62> [--leg normal|red:<check>] [--record]
 *   node test/scenarios/run.mjs S00 --fixture <path> [--from read-json] [--detail]
 *
 * `--leg red:<check>` plants the variation the scenario names for that check. `--record` (normal
 * leg only) rewrites recorded/<scenario>.json from what this build observed: run it in the change
 * that fixes a pinned failure, after reading the FLIPPED line that asked for it. A scenario with a
 * fixture other than its own prints `measured` verdicts and is never recorded.
 *
 * Diagnostics go to stderr; stdout carries observation lines only. The exit code is 0 when every
 * line printed, whatever the verdicts: the gate reads the lines (scenario-suite.mjs), never this code.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { loadRecording, observer, writeRecording } from "./lib/observe.mjs";
import { AGORA_DIR } from "./lib/seat.mjs";
import { loadScenario } from "./lib/scenarios.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    leg: { type: "string", default: "normal" },
    record: { type: "boolean", default: false },
    fixture: { type: "string" },
    from: { type: "string" },
    detail: { type: "boolean", default: false },
  },
});

const id = positionals[0];
if (!id) {
  console.error("usage: node test/scenarios/run.mjs <scenario> [--leg normal|red:<check>] [--record] [--fixture <path>] [--from read-json] [--detail]");
  process.exit(2);
}
const scenario = await loadScenario(id);
const leg = String(values.leg);
if (leg !== "normal") {
  const check = leg.startsWith("red:") ? leg.slice(4) : "";
  if (!scenario.checks[check]) {
    console.error(`${id}: no check named ${JSON.stringify(check)}; the legs are normal and red:<check> for ${Object.keys(scenario.checks).join(", ")}`);
    process.exit(2);
  }
}
if (values.record && leg !== "normal") {
  console.error("--record takes the normal leg only: a red leg is a planted variation, never today's behaviour");
  process.exit(2);
}

/** @type {import("./lib/scenarios.mjs").RunArgs} */
const args = {
  fixture: values.fixture ?? process.env.AGORA_SCENARIO_FIXTURE,
  from: values.from,
  detail: Boolean(values.detail),
};
// a run on a fixture the scenario does not own is a measurement: there is nothing to judge it against
const own = scenario.ownsRun ? scenario.ownsRun(args) : true;
if (values.record && !own) {
  console.error(`${id}: a run on a private fixture is measured, never recorded`);
  process.exit(2);
}
const recording = values.record || !own ? null : await loadRecording(id);
const obs = observer({ scenario: id, leg, recording });
const redCheck = leg.startsWith("red:") ? leg.slice(4) : undefined;

await scenario.run({
  leg,
  red: (check) => check === redCheck,
  only: redCheck,
  baseline: (check, observed) => (values.record ? observed : recording?.checks[check]?.observed ?? null),
  check: obs.check,
  log: (line) => { process.stderr.write(`${id} ${leg}: ${line}\n`); },
  args,
});

if (values.record) {
  let build = "unknown";
  try { build = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: AGORA_DIR, encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
  const rec = await writeRecording(id, obs.lines, { build, ...(scenario.fixtureName ? { fixture: scenario.fixtureName } : {}) });
  process.stderr.write(`${id}: recorded ${Object.keys(rec.checks).length} checks on ${build}\n`);
}
