// @ts-check
/**
 * Observation lines, recorded expectations, and the gate that reads them.
 *
 * A scenario emits one JSON line per check on stdout:
 *
 *   {"type":"observation","scenario":"S14","leg":"normal","check":"re-replies-in-thread",
 *    "expected":{...},"observed":{...},"verdict":"red-as-expected","bounds":{...}}
 *
 * `expected` is the check's bar: the behaviour the framework wants. `observed` is what today's
 * build did, measured from records the real CLI and service wrote. The verdict compares the two
 * against the scenario's recording (recorded/<scenario>.json), which pins, per check, whether it
 * met its bar on the build it was recorded on (`today`) and what it observed (`observed`):
 *
 *   recorded green, bar met               pass
 *   recorded green, bar not met           fail
 *   recorded red,   observed = recorded   red-as-expected  (the pinned failure, still failing the same way)
 *   recorded red,   bar met               flipped          (fixed: update the recording in the fixing change)
 *   recorded red,   anything else         drifted          (different, not fixed: look before re-recording)
 *   no recording for the check            unrecorded
 *   no recording at all (a private fixture run)  measured
 *
 * The gate keeps CI green on `pass` and `red-as-expected` only. A red leg (a planted variation
 * named for one check) must turn that check's verdict into `fail`, `flipped` or `drifted`; a check
 * whose red leg does not is not admitted.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const SCENARIOS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RECORDED_DIR = path.join(SCENARIOS_DIR, "recorded");

/** @typedef {'pass' | 'fail' | 'red-as-expected' | 'flipped' | 'drifted' | 'unrecorded' | 'measured'} Verdict */
/** The verdicts that keep the gate green on a normal leg. */
export const GREEN_VERDICTS = Object.freeze(["pass", "red-as-expected"]);
/** The verdicts a red leg must produce at its named check. */
export const RED_LEG_VERDICTS = Object.freeze(["fail", "flipped", "drifted"]);

/**
 * @typedef {{ today: 'green' | 'red', observed: unknown }} RecordedCheck
 * @typedef {{ scenario: string, recordedOn: string, build: string, fixture?: string, checks: Record<string, RecordedCheck> }} Recording
 * @typedef {{ type: 'observation', scenario: string, leg: string, check: string, expected: unknown, observed: unknown, verdict: Verdict, bounds?: Record<string, number>, note?: string }} Observation
 */

/**
 * The verdict for one check.
 * @param {unknown} expected @param {unknown} observed @param {Recording | null} recording @param {string} check
 * @returns {Verdict}
 */
export function judge(expected, observed, recording, check) {
  if (!recording) return "measured";
  const rec = recording.checks[check];
  if (!rec) return "unrecorded";
  const met = isDeepStrictEqual(expected, observed);
  if (rec.today === "green") return met ? "pass" : "fail";
  if (met) return "flipped";
  return isDeepStrictEqual(observed, rec.observed) ? "red-as-expected" : "drifted";
}

/** @param {string} scenario */
export const recordingPath = (scenario) => path.join(RECORDED_DIR, `${scenario}.json`);

/** @param {string} scenario @returns {Promise<Recording | null>} */
export async function loadRecording(scenario) {
  try {
    return JSON.parse(await readFile(recordingPath(scenario), "utf8"));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Write a scenario's recording from a normal leg's observations. Only the normal leg records: a red
 * leg is a planted variation, never today's behaviour.
 * @param {string} scenario @param {Observation[]} observations @param {{ build: string, fixture?: string }} meta
 */
export async function writeRecording(scenario, observations, meta) {
  /** @type {Record<string, RecordedCheck>} */
  const checks = {};
  for (const o of observations) checks[o.check] = { today: isDeepStrictEqual(o.expected, o.observed) ? "green" : "red", observed: o.observed };
  /** @type {Recording} */
  const recording = { scenario, recordedOn: new Date().toISOString().slice(0, 10), build: meta.build, ...(meta.fixture ? { fixture: meta.fixture } : {}), checks };
  await writeFile(recordingPath(scenario), JSON.stringify(recording, null, 2) + "\n", "utf8");
  return recording;
}

/**
 * An observer for one leg of one scenario. `check` judges and writes one line; nothing else in a
 * scenario writes to stdout.
 * @param {{ scenario: string, leg: string, recording: Recording | null, write?: (line: string) => void }} opts
 */
export function observer(opts) {
  /** @type {Observation[]} */
  const lines = [];
  const write = opts.write ?? ((/** @type {string} */ line) => { process.stdout.write(line + "\n"); });
  return {
    lines,
    /**
     * @param {string} check @param {unknown} expected @param {unknown} observed
     * @param {{ bounds?: Record<string, number>, note?: string }} [extra]
     */
    check(check, expected, observed, extra = {}) {
      /** @type {Observation} */
      const line = { type: "observation", scenario: opts.scenario, leg: opts.leg, check, expected, observed,
        verdict: judge(expected, observed, opts.recording, check), ...(extra.bounds ? { bounds: extra.bounds } : {}), ...(extra.note ? { note: extra.note } : {}) };
      lines.push(line);
      write(JSON.stringify(line));
      return line;
    },
  };
}

/** The observation lines in a process's stdout; anything else on stdout is ignored. @param {string} stdout @returns {Observation[]} */
export function parseObservations(stdout) {
  /** @type {Observation[]} */
  const out = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.type === "observation") out.push(o);
    } catch { /* not a line of ours */ }
  }
  return out;
}

/**
 * The normal leg's gate. Returns the problems, empty when it holds. Each line's verdict is judged
 * again here against the recording on disk, so a scenario cannot pass by printing a verdict.
 * @param {Observation[]} observations @param {Recording | null} recording @param {string[]} declared the checks the scenario declares
 */
export function gateNormal(observations, recording, declared) {
  /** @type {string[]} */
  const problems = [];
  // a scenario that prints nothing has stopped asserting
  if (!observations.length) return ["no observation lines: a scenario that prints nothing has stopped asserting"];
  if (!recording) return ["no recording: run the scenario with --record on the build it pins, and commit recorded/<scenario>.json"];
  const seen = new Set();
  for (const o of observations) {
    seen.add(o.check);
    if (!declared.includes(o.check)) problems.push(`${o.check}: observed but not declared by the scenario`);
    const verdict = judge(o.expected, o.observed, recording, o.check);
    if (verdict !== o.verdict) problems.push(`${o.check}: the line says ${o.verdict}, the recording says ${verdict}`);
    if (verdict === "flipped") problems.push(`${o.check}: FLIPPED, it now meets its bar (observed ${JSON.stringify(o.observed)}); the recording pins it red. Update recorded/${o.scenario}.json (node test/scenarios/run.mjs ${o.scenario} --record) in the change that fixed it`);
    else if (verdict === "drifted") problems.push(`${o.check}: DRIFTED, still short of its bar but different from the pinned failure (recorded ${JSON.stringify(recording.checks[o.check]?.observed)}, observed ${JSON.stringify(o.observed)}). Read what changed before re-recording`);
    else if (verdict === "fail") problems.push(`${o.check}: FAIL, recorded green, now short of its bar (expected ${JSON.stringify(o.expected)}, observed ${JSON.stringify(o.observed)})`);
    else if (verdict === "unrecorded") problems.push(`${o.check}: no recorded expectation`);
  }
  for (const check of declared) if (!seen.has(check)) problems.push(`${check}: declared but printed no observation line`);
  for (const check of Object.keys(recording.checks)) if (!seen.has(check)) problems.push(`${check}: recorded but printed no observation line`);
  return problems;
}

/**
 * A red leg's gate: the named check must be observed, and its verdict must be one that fails the
 * normal gate. A crash or a missing line is a signal, not a discriminating failure.
 * @param {Observation[]} observations @param {string} check @param {Recording | null} recording
 */
export function gateRedLeg(observations, check, recording) {
  const line = observations.find((o) => o.check === check);
  if (!line) return [`red leg ${check}: no observation line for the named check (a crash is not a discriminating failure)`];
  const verdict = judge(line.expected, line.observed, recording, check);
  if (!RED_LEG_VERDICTS.includes(verdict))
    return [`red leg ${check}: the planted variation left the check ${verdict} (observed ${JSON.stringify(line.observed)}); a check whose red leg does not fail is not admitted`];
  return [];
}
