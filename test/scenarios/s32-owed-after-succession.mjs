// @ts-check
/**
 * S32 · owed after succession (the mechanics under LS-S9's "what do you owe?" probe). The
 * orchestrator at `main.orchestrator`, an omp session signing `orchestrator/Sonnet`, answered and
 * claimed one request (R1), read a second it has not answered (R2), and a third arrived after its
 * last read (R3). It hands its place to a fresh session, in two arms, each on its own seat:
 *
 *   succeed   `resident succeed`, then `resident cycle` once its turn has ended: the cycle writes the
 *             inherit marker and runs the restart;
 *   relaunch  `resident stop`, then a start with another model (a model swap by relaunch): the
 *             start finds the position's last session gone and writes the marker naming it.
 *
 * Either way the successor is the real agora-room omp extension started at the position. It takes
 * the predecessor's place before its first read, and the successor asks what it owes the way its
 * card says to: `agora carry <room> --json`.
 *
 * Bars: the marker is consumed by the successor's extension; the successor resumes at the
 * predecessor's cursor and is handed the request its predecessor never read; it owes R2 and R3 and
 * not R1; it holds R1's claim.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inheritMarkerPath, readInheritMarker } from "../../src/resident.mjs";
import { planResident, startResident, stopResident, validateManifest } from "../../src/resident-start.mjs";
import { AGORA_DIR, BIN, nodeExecutable, openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";
import { startOmpSession } from "./lib/omp-session.mjs";

const ARMS = /** @type {const} */ (["succeed", "relaunch"]);
const POSITION = "main.orchestrator";
const SESSIONS = {
  succeed: { pred: "5c0a1b2c-3232-4222-8333-444455550001", succ: "5c0a1b2c-3232-4222-8333-444455550002" },
  relaunch: { pred: "5c0a1b2c-3232-4222-8333-444455550003", succ: "5c0a1b2c-3232-4222-8333-444455550004" },
};

/** @type {Record<string, { bar: string, redLeg: string }>} */
const checks = {};
for (const arm of ARMS) {
  checks[`${arm}:marker-consumed`] = {
    bar: "a marker naming the predecessor stands when the successor starts, and the successor's extension consumes it before its first read",
    redLeg: "the successor starts with no position (AGORA_LABEL unset), so nothing takes the marker",
  };
  checks[`${arm}:resumes-at-predecessor-cursor`] = {
    bar: "the successor's cursor equals the predecessor's, and its first poll delivers R3, the request the predecessor never read",
    redLeg: "the successor moves its cursor to the head (`cursor --now`) after its start",
  };
  checks[`${arm}:owed`] = {
    bar: "`carry` as the successor owes exactly R2 and R3, not R1, which the predecessor answered",
    redLeg: "the inherited posted ledger is lost (removed after the start)",
  };
  checks[`${arm}:claims`] = {
    bar: "`carry` as the successor holds the predecessor's open claim on fix-median",
    redLeg: "the predecessor released its claim before handing over",
  };
}

/** An omp session as the CLI sees one inside omp: its raw id in AGORA_SESSION beside OMP_SESSION_ID. */
class OmpAgent extends Agent {
  /** @returns {Record<string, string>} */
  env() { return { AGORA_SESSION: this.session, OMP_SESSION_ID: this.session, ...(this.harnessPid ? { OMP_PID: String(this.harnessPid) } : {}) }; }
  get slug() { return `omp-${this.session}`; }
}

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S32",
  name: "owed-after-succession",
  checks,
  async run(ctx) {
    for (const arm of ARMS) {
      if (ctx.only && !ctx.only.startsWith(`${arm}:`)) continue;
      await runArm(ctx, arm);
    }
  },
};

/** @param {import("./lib/scenarios.mjs").ScenarioContext} ctx @param {typeof ARMS[number]} arm */
async function runArm(ctx, arm) {
  const red = (/** @type {string} */ name) => ctx.red(`${arm}:${name}`);
  const ids = SESSIONS[arm];
  const seat = await openSeat();
  /** @type {any} */
  let client;
  /** @type {any} */
  let succ;
  try {
    client = await openClient(seat);
    const ada = new Human(client, seat.alias, "Ada");
    const host = await standInHost(seat);

    // the predecessor: started by its arm's way in, registered at the position as its extension does
    let harnessPid;
    if (arm === "relaunch") {
      const started = await startResident(planResident(host.manifest, POSITION, host.ctx), seat.state, { checkout: AGORA_DIR, run: host.run });
      if (started.row.action !== "started") throw new Error(`the predecessor did not start: ${JSON.stringify(started.row)}`);
      harnessPid = host.pidOf(POSITION);
    } else harnessPid = await seat.spawnHarness();
    const pred = new OmpAgent(seat, { session: ids.pred, bearer: "orchestrator/Sonnet", harness: "omp", harnessPid });
    await pred.register("orchestrator/Sonnet", { label: POSITION });
    await pred.ok(["cursor", seat.alias, "--now"]);

    // R1 answered and claimed; R2 read and not answered; R3 arrives after the last read
    const r1 = await ada.post("Please fix the failing median test.", { to: ["orchestrator"] });
    await pred.watchOnce({ wake: "mine" });
    await pred.post("Queued fix-median, position 1.", { thread: r1.id, re: r1.id, claim: "fix-median" });
    const r2 = await ada.post("Add a slugify helper.", { to: ["orchestrator"] });
    await pred.watchOnce({ wake: "mine" });
    if (red("claims")) await pred.ok(["post", seat.alias, "--json", "--thread", r1.id, "--release", "fix-median", "--", "Released fix-median."]);
    const predCursor = await cursorOf(seat, pred.slug);
    const r3 = await ada.post("Is the median fixed yet?", { to: ["orchestrator"], thread: r1.id });
    const label = (/** @type {string} */ id) => (id === r1.id ? "R1" : id === r2.id ? "R2" : id === r3.id ? "R3" : "other");

    // the handover
    if (arm === "succeed") {
      await writeOmpTranscript(seat.home, ids.pred, new Date(Date.now() - 30_000).toISOString());
      await pred.ok(["resident", "succeed"]);
      const cycled = await seat.cli(["resident", "cycle", POSITION, "--restart", `"${nodeExecutable()}" -e 0`, "--json"]);
      const row = JSON.parse(cycled.stdout.trim().split(/\r?\n/).pop() || "{}");
      if (row.action !== "cycle") throw new Error(`the cycle did not honour the succeed request: ${cycled.stdout}${cycled.stderr}`);
      await pred.stopHarness(); // what the restart stops
    } else {
      const stopped = await stopResident(seat.state, POSITION, { run: host.run, sleep: async () => {} });
      if (stopped.action !== "stopped") throw new Error(`the stop did not stop: ${JSON.stringify(stopped)}`);
      const swapped = await startResident(planResident(host.manifest, POSITION, { ...host.ctx, model: "haiku" }), seat.state, { checkout: AGORA_DIR, run: host.run });
      if (swapped.row.action !== "started") throw new Error(`the relaunch did not start: ${JSON.stringify(swapped.row)}`);
    }
    const marker = await readInheritMarker(seat.state, POSITION);

    succ = await startOmpSession(seat, { sessionId: ids.succ, modelId: arm === "relaunch" ? "claude-haiku-4-5" : "claude-sonnet-5-5", role: "orchestrator", ...(red("marker-consumed") ? {} : { position: POSITION }) });
    ctx.check(`${arm}:marker-consumed`, { written: true, namesPredecessor: true, consumed: true },
      { written: marker !== null, namesPredecessor: marker?.from === pred.slug, consumed: marker !== null && !existsSync(inheritMarkerPath(seat.state, POSITION)) }, { note: `by ${marker?.by ?? "nothing"}` });

    if (red("resumes-at-predecessor-cursor")) await seat.cli(["cursor", seat.alias, "--now"], succ.cliEnv);
    if (red("owed")) for (const f of ["posted.jsonl", "posted.1.jsonl"]) await rm(path.join(seat.state, "sessions", succ.slug, f), { force: true });
    const succCursor = await cursorOf(seat, succ.slug);
    await succ.rt.tick();
    const delivered = succ.sent.map((/** @type {any} */ x) => label(String(x.msg.content).split("\n").pop()?.split(" ")[2] ?? ""));
    ctx.check(`${arm}:resumes-at-predecessor-cursor`, { cursorEqual: true, delivered: ["R3"] }, { cursorEqual: predCursor !== null && succCursor === predCursor, delivered });

    const carried = await seat.cli(["carry", seat.alias, "--json"], succ.cliEnv);
    const carry = JSON.parse(carried.stdout.trim().split(/\r?\n/).pop() || "{}");
    ctx.check(`${arm}:owed`, ["R2", "R3"], (carry.owed ?? []).map((/** @type {any} */ o) => label(o.id)), { note: `carry as ${carry.bearer?.name ?? "?"}` });
    ctx.check(`${arm}:claims`, ["fix-median"], (carry.claims ?? []).map((/** @type {any} */ c) => c.subject));
  } finally {
    succ?.stop();
    client?.close();
    await seat.close();
  }
}

/**
 * The seat's manifest (one omp orchestrator row on tern) and a stand-in Tern that starts a stand-in
 * harness per `new session`, reports it live until killed, and stops it by its pid.
 * @param {import("./lib/seat.mjs").Seat} seat
 */
async function standInHost(seat) {
  await writeFile(path.join(seat.root, "PROFILE.md"), "# The orchestrator\n\nThe profile.\n");
  const fakeBin = path.join(seat.root, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  for (const n of ["omp", "tern"]) for (const ext of ["", ".exe"]) await writeFile(path.join(fakeBin, n + ext), "");
  const manifest = validateManifest({
    version: 1,
    models: { haiku: "vendor/claude-haiku-9:medium", sonnet: "vendor/claude-sonnet-9:high" },
    residents: { [POSITION]: { role: "orchestrator", harness: "omp", host: "tern", model: "sonnet", rooms: [seat.alias], wake: "mine", profile: "PROFILE.md", tenure: "standing" } },
  }, path.join(seat.root, "residents.json"));
  const cfgDoc = JSON.parse(await readFile(seat.config, "utf8"));
  const ctx = { cfg: { ...cfgDoc, path: seat.config }, stateRoot: seat.state, checkout: AGORA_DIR, entry: BIN, node: nodeExecutable(), env: { PATH: fakeBin, PATHEXT: ".EXE" } };
  /** @type {Map<number, { pid: number, position: string, dead: boolean }>} */
  const sessions = new Map();
  let nextId = 300;
  /** @type {import("../../src/resident-start.mjs").Runner} */
  const run = async (argv) => {
    if (argv[1] === "new" && argv[2] === "session") {
      const id = nextId++;
      sessions.set(id, { pid: await seat.spawnHarness(), position: argv[3], dead: false });
      return { code: 0, stdout: JSON.stringify({ session: id }), stderr: "" };
    }
    if (argv[1] === "ls") {
      const list = [...sessions].map(([id, s]) => ({ id, name: s.position, tabs: [{ id: id + 1, blocks: [{ id: id + 2, live: !s.dead, exited: s.dead ? 0 : null }] }] }));
      return { code: 0, stdout: JSON.stringify({ sessions: list, detached: [] }), stderr: "" };
    }
    if (argv[1] === "kill" && argv[2] === "session") {
      const s = sessions.get(Number(argv[3]));
      if (s && !s.dead) { await seat.kill(s.pid); s.dead = true; }
      return { code: 0, stdout: "{}", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `the stand-in tern does not answer ${argv.slice(1).join(" ")}` };
  };
  return {
    manifest, ctx, run,
    /** @param {string} position */
    pidOf: (position) => [...sessions.values()].reverse().find((s) => s.position === position && !s.dead)?.pid,
  };
}

/** An OMP transcript whose last turn ended (an assistant message that called no tool). @param {string} home @param {string} uuid @param {string} at */
async function writeOmpTranscript(home, uuid, at) {
  const dir = path.join(home, ".omp", "agent", "sessions", "-work");
  await mkdir(dir, { recursive: true });
  const turn = { type: "message", timestamp: at, message: { role: "assistant", stopReason: "stop", usage: { input: 3, cacheRead: 60_000, cacheWrite: 200, output: 9 } } };
  await writeFile(path.join(dir, `2026-01-01T00-00-00-000Z_${uuid}.jsonl`), JSON.stringify(turn) + "\n", "utf8");
}

/** A session's saved cursor for the room. @param {import("./lib/seat.mjs").Seat} seat @param {string} slug */
async function cursorOf(seat, slug) {
  try { return JSON.parse(await readFile(path.join(seat.state, "sessions", slug, `${seat.alias}.cursor`), "utf8")).cursor ?? null; }
  catch { return null; }
}
