// @ts-check
/**
 * The scenario registry and the shape every scenario module exports.
 */

/**
 * @typedef {object} RunArgs
 * @property {string | undefined} fixture a fixture path (S00); `AGORA_SCENARIO_FIXTURE` when the flag is absent
 * @property {string | undefined} from the fixture's format: absent for the scenario format, `read-json` for `agora read --json` lines
 * @property {boolean} detail print per-message rows (never for a private fixture's text; rows carry names and counts only)
 */

/**
 * @typedef {object} ScenarioContext
 * @property {string} leg `normal` or `red:<check>`
 * @property {(check: string) => boolean} red true when this leg plants the named check's variation
 * @property {string | undefined} only on a red leg, the check it is for: a scenario may skip the arms that check is not in
 * @property {(check: string, observed: unknown) => unknown} baseline the bar of a baseline check: the value the recording pinned (under --record, what is observed now; on a private fixture, null)
 * @property {(check: string, expected: unknown, observed: unknown, extra?: { bounds?: Record<string, number>, note?: string }) => unknown} check
 * @property {(line: string) => void} log diagnostics, on stderr
 * @property {RunArgs} args
 */

/**
 * @typedef {object} Scenario
 * @property {string} id
 * @property {string} name
 * @property {Record<string, { bar: string, redLeg: string }>} checks every check with its bar and its red leg; a check without a red leg is not admitted
 * @property {(ctx: ScenarioContext) => Promise<void>} run
 * @property {(args: RunArgs) => boolean} [ownsRun] false when the run is on a fixture the scenario's recording does not cover
 * @property {string} [fixtureName] the in-repo fixture a recording was taken on
 */

/** @type {Record<string, string>} */
export const SCENARIO_FILES = Object.freeze({
  S00: "../s00-baseline-replay.mjs",
  S01: "../s01-retired-name.mjs",
  S03: "../s03-never-taken.mjs",
  S04: "../s04-lease-lapse.mjs",
  S07: "../s07-model-swap.mjs",
  S13: "../s13-audiences.mjs",
  S14: "../s14-subjects.mjs",
  S19: "../s19-messenger-deaf.mjs",
  S20: "../s20-unowned.mjs",
  S23: "../s23-succession.mjs",
  S29: "../s29-absent-ensure.mjs",
  S32: "../s32-owed-after-succession.mjs",
  S34: "../s34-succeed-live-child.mjs",
  S60: "../s60-notice-set.mjs",
  S61: "../s61-grant.mjs",
  S62: "../s62-revoke.mjs",
});

/** @param {string} id @returns {Promise<Scenario>} */
export async function loadScenario(id) {
  const file = SCENARIO_FILES[id];
  if (!file) throw new Error(`no scenario ${id}; the scenarios are ${Object.keys(SCENARIO_FILES).join(", ")}`);
  const mod = await import(new URL(file, import.meta.url).href);
  return mod.scenario;
}
