// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeRoomService } from "../src/native-service.mjs";
import { tmp } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/agora.mjs", import.meta.url));
/** A hang guard for a cell that runs the CLI, never a pass condition. */
const CLI_CELL = { timeout: 120_000 };

/** @param {string[]} args @param {NodeJS.ProcessEnv} env @returns {Promise<{ code: number | string | null, stdout: string, stderr: string }>} */
function cli(args, env) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env, windowsHide: true }, (error, stdout, stderr) => {
      const e = /** @type {(Error & { code?: number | string }) | null} */ (error);
      resolve({ code: e ? (e.code ?? null) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });
}

/** The board's subjects as `agora board --json` prints them. @param {NodeJS.ProcessEnv} env */
async function board(env) {
  const r = await cli(["board", "nat", "--json"], env);
  assert.equal(r.code, 0, r.stderr);
  return new Map(r.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((j) => j.type === "board-subject").map((j) => [j.subject, j]));
}

test("release: a post carrying `release:` from the claim's holder releases the board claim on a native room; another session's release of it is refused by name and the claim stays (red leg: a subject that is not held)", CLI_CELL, async () => {
  const t = await tmp();
  const service = new NativeRoomService({ root: t.dir, accountId: "seat_account_0007", seatLabel: "test" });
  try {
    await service.start();
    const roomId = "7".repeat(32);
    await service.createRoom({ roomId, epoch: "b".repeat(32) });
    const config = path.join(t.dir, "agora.json");
    await writeFile(config, JSON.stringify({ actor: { name: "Grace", kind: "agent" }, rooms: { nat: { transport: "native", roomId } } }));
    /** @type {NodeJS.ProcessEnv} */
    const base = { ...process.env, AGORA_STATE: t.dir, AGORA_CONFIG: config };
    for (const k of ["AGORA_LABEL", "CLAUDE_CODE_SESSION_ID", "OMP_SESSION_ID", "CLAUDE_PID", "OMP_PID"]) delete base[k];
    const grace = { ...base, AGORA_SESSION: "s-grace", AGORA_ACTOR: "orchestrator/Sonnet" };
    const ada = { ...base, AGORA_SESSION: "s-ada", AGORA_ACTOR: "coding/Haiku" };

    let r = await cli(["post", "nat", "Taking it.", "--claim", "task:records", "--json"], grace);
    assert.equal(r.code, 0, r.stderr);
    r = await cli(["post", "nat", "Taking the parser.", "--claim", "parser", "--json"], grace);
    assert.equal(r.code, 0, r.stderr);
    let held = await board(grace);
    assert.ok(held.get("work:task:records")?.holder, "a task: claim is the board subject work:task:<slug>");
    assert.ok(held.get("work:parser")?.holder);

    // another session on the same account did not post the claim: its trailer releases nothing
    r = await cli(["post", "nat", "Done with it.", "--release", "parser", "--json"], ada);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /release parser: work:parser stays held: it was claimed by orchestrator\/Sonnet in \S+, which this session did not post/);
    assert.deepEqual(JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}").released, []);
    assert.ok((await board(grace)).get("work:parser")?.holder, "the claim stays");

    // the holder's release frees the board, a task: subject included
    r = await cli(["post", "nat", "Closed.", "--release", "task:records", "--release", "parser", "--json"], grace);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}").released, ["work:task:records", "work:parser"]);
    held = await board(grace);
    assert.equal(held.get("work:task:records")?.holder, null, "released, not lapsed");
    assert.equal(held.get("work:task:records")?.lapsed, null);
    assert.equal(held.get("work:parser")?.holder, null);

    // a successor that inherited the posted ledger holds the predecessor's claims
    r = await cli(["post", "nat", "Taking the fixture.", "--claim", "fixture", "--json"], grace);
    assert.equal(r.code, 0, r.stderr);
    const succ = { ...base, AGORA_SESSION: "s-succ", AGORA_ACTOR: "orchestrator/Haiku" };
    r = await cli(["session", "--inherit", "s-grace"], succ);
    assert.equal(r.code, 0, r.stderr);
    r = await cli(["post", "nat", "Handing it back.", "--release", "fixture", "--json"], succ);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}").released, ["work:fixture"]);
    assert.equal((await board(grace)).get("work:fixture")?.holder, null);

    // red leg: nothing held under the subject, so nothing to release
    r = await cli(["post", "nat", "Not mine.", "--release", "never-claimed", "--json"], grace);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /release never-claimed: work:never-claimed is not held on the board; nothing to release/);
  } finally { await service.stop(); await t.cleanup(); }
});
