// Acceptance probe: writeFileAtomic under the race this unit was queued on.
// Offline; a local file room, no credentials. Exit 1 names an unmet acceptance bar.
//
// Two bars, two defects:
// 1. Same-process concurrent writes used to share `.tmp-<pid>`. A overwrites B's temp, A
//    publishes B's bytes, B's rename ENOENTs. The suffix must be unique per call.
// 2. A live watch and a post both write session.json. On Windows the replace rename can
//    EPERM; the retry is why the post is not lost. Nothing here injects EPERM — the race
//    itself is the exhibit. A helper whose retry is deleted still has to survive this
//    load without a lost post or a torn record.
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic } from "../src/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(root, "bin", "agora.mjs");
const results = [];

/** @param {string} probe @param {boolean} pass @param {Record<string, unknown>} [extra] */
function bar(probe, pass, extra = {}) {
  results.push({ probe, pass, ...extra });
}

const { dir, leftovers } = await (async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agora-atomic-race-"));
  const file = path.join(dir, "session.json");
  const n = 24;
  const payloads = Array.from({ length: n }, (_, i) => JSON.stringify({ i, mark: `payload-${i}` }) + "\n");
  const settled = await Promise.allSettled(payloads.map((data) => writeFileAtomic(file, data)));
  const rejected = settled.filter((s) => s.status === "rejected").map((s) => String(/** @type {PromiseRejectedResult} */ (s).reason?.message ?? s.reason));
  let raw = "";
  let parsed = false;
  try {
    raw = await readFile(file, "utf8");
    JSON.parse(raw);
    parsed = true;
  } catch { /* torn or absent */ }
  const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
  const accepted = payloads.some((p) => p === raw);
  bar("same-process concurrent writes do not share a temp or tear the target",
    rejected.length === 0 && parsed && accepted && leftovers.length === 0,
    { rejected, parsed, accepted, leftoverTemps: leftovers, bytes: raw.length });
  return { dir, leftovers };
})();

const race = await (async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agora-watch-post-race-"));
  const cfgPath = path.join(dir, "agora.json");
  const roomPath = path.join(dir, "down.ndjson");
  const state = path.join(dir, "state");
  await writeFile(cfgPath, JSON.stringify({
    actor: { name: "Probe/race", kind: "agent" },
    rooms: { down: { transport: "local", path: roomPath } },
  }));
  const clean = { ...process.env };
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "GROK_SESSION_ID", "GROK_PID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HERMES_SESSION_ID", "AGORA_SESSION_PID", "AGORA_SESSION", "AGORA_ACTOR", "AGORA_CONFIG", "AGORA_STATE"])
    delete clean[name];
  const env = { ...clean, AGORA_CONFIG: cfgPath, AGORA_STATE: state, AGORA_SESSION: "race", AGORA_ACTOR: "Probe/race" };
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [BIN, ...args], {
    env, cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
  });
  const registered = run(["session", "--as", "Probe/race"]);
  if (registered.status !== 0) {
    bar("watch-and-post race: session registered", false, { status: registered.status, stderr: registered.stderr });
    await rm(dir, { recursive: true, force: true });
    return;
  }
  const watch = spawn(process.execPath, [BIN, "watch", "down", "--stream", "--for", "3", "--interval", "1"], {
    env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let watchErr = "";
  watch.stderr?.setEncoding("utf8").on("data", (s) => { watchErr += s; });
  await delay(250);
  const posts = Array.from({ length: 8 }, (_, i) => run(["post", "down", `race-${i}`]));
  const lost = posts.filter((p) => p.status !== 0).map((p) => ({ status: p.status, stderr: String(p.stderr ?? "").slice(0, 200) }));
  await Promise.race([
    new Promise((resolve) => watch.once("close", resolve)),
    delay(8000).then(() => { try { watch.kill(); } catch {} }),
  ]);
  const sessionFile = path.join(state, "sessions", "race", "session.json");
  let recordOk = false;
  try {
    JSON.parse(await readFile(sessionFile, "utf8"));
    recordOk = true;
  } catch { /* torn */ }
  const temps = (await readdir(path.dirname(sessionFile)).catch(() => [])).filter((name) => name.includes(".tmp-"));
  bar("a live watch and concurrent posts keep session.json intact and lose no post",
    lost.length === 0 && recordOk && temps.length === 0,
    { lost, recordOk, leftoverTemps: temps, watchStatus: watch.exitCode, watchErr: watchErr.slice(0, 240) });
  await rm(dir, { recursive: true, force: true });
})();

await rm(dir, { recursive: true, force: true }).catch(() => {});
void leftovers;
void race;

for (const result of results) console.log(JSON.stringify(result));
process.exitCode = results.length > 0 && results.every((r) => r.pass) ? 0 : 1;
