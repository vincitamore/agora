// @ts-check
/**
 * The gate, as node:test cases: a scenario's normal leg and one red leg per check, each run as its
 * own process (`run.mjs`), each judged from the observation lines it printed and never from its exit
 * code. The red legs open their own seats, so they run side by side.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { gateNormal, gateRedLeg, loadRecording, parseObservations, SCENARIOS_DIR } from "./observe.mjs";
import { loadScenario } from "./scenarios.mjs";
import { nodeExecutable } from "./seat.mjs";

const RUN = path.join(SCENARIOS_DIR, "run.mjs");
/** A leg that has not printed by then is stopped by its exact pid and fails. */
const LEG_TIMEOUT_MS = 240_000;

/** @param {string} id @param {string} leg */
export function runLeg(id, leg) {
  return new Promise((resolve) => {
    // the scenario must not see a fixture a developer set for a private run
    const env = { ...process.env };
    delete env.AGORA_SCENARIO_FIXTURE;
    const child = spawn(nodeExecutable(), [RUN, id, "--leg", leg], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { stderr += `\n(leg stopped after ${LEG_TIMEOUT_MS} ms)`; child.kill(); }, LEG_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, observations: parseObservations(stdout) });
    });
  }).then((r) => /** @type {{ code: number | null, stdout: string, stderr: string, observations: import("./observe.mjs").Observation[] }} */ (r));
}

/** @param {string} text */
const tail = (text) => text.split(/\r?\n/).slice(-25).join("\n");

/**
 * Register a scenario's gate: the normal leg, then one red leg per declared check.
 * @param {string} id
 */
export async function scenarioSuite(id) {
  const scenario = await loadScenario(id);
  const declared = Object.keys(scenario.checks);
  describe(`${id} ${scenario.name}`, { concurrency: 3 }, () => {
    test(`${id} normal leg: every check observed, each pass or red-as-expected`, { timeout: LEG_TIMEOUT_MS + 10_000 }, async (t) => {
      const recording = await loadRecording(id);
      const r = await runLeg(id, "normal");
      for (const o of r.observations) t.diagnostic(`${o.check}: ${o.verdict}`);
      const problems = gateNormal(r.observations, recording, declared);
      assert.deepEqual(problems, [], `${id} normal leg:\n${problems.join("\n")}\n--- stderr tail ---\n${tail(r.stderr)}`);
    });
    for (const check of declared) {
      const spec = scenario.checks[check];
      test(`${id} red leg ${check}: ${spec.redLeg}`, { timeout: LEG_TIMEOUT_MS + 10_000 }, async (t) => {
        assert.ok(spec.redLeg && spec.redLeg.trim(), `${id} ${check} names no red leg; a check without one is not admitted`);
        const recording = await loadRecording(id);
        const r = await runLeg(id, `red:${check}`);
        const line = r.observations.find((o) => o.check === check);
        if (line) t.diagnostic(`${check} under its red leg: ${line.verdict}`);
        const problems = gateRedLeg(r.observations, check, recording);
        assert.deepEqual(problems, [], `${id} red leg ${check}:\n${problems.join("\n")}\n--- stderr tail ---\n${tail(r.stderr)}`);
      });
    }
  });
}
