// @ts-check
// Hop counts on agent-to-agent wake chains: a post made while answering a wake is one hop deeper than
// what woke it, and a watch armed with `--max-hops` lets nothing deeper wake its session.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmp } from "./helpers.mjs";
import { WAKE_FILE, hopOf } from "../src/hop.mjs";
import { withTrailers } from "../src/trailers.mjs";

const run = promisify(execFile);
const BIN = new URL("../bin/agora.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** @param {string[]} args @param {Record<string, string>} env @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
async function agora(args, env) {
  const clean = { ...process.env };
  for (const name of Object.keys(clean)) if (/^(AGORA_|CLAUDE_|OMP_|GROK_|CODEX_|HERMES_)/.test(name)) delete clean[name];
  try {
    const child = run(process.execPath, [BIN, ...args], { env: { ...clean, ...env }, windowsHide: true, timeout: 30_000 });
    child.child.stdin?.end();
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** @param {string} stdout */
const typed = (stdout) => stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
/** @param {string} stdout */
const bodies = (stdout) => typed(stdout).filter((o) => o.type === "message").map((o) => String(o.text).split("\n")[0]);

/** One line of a local room's file, posted by another agent. @param {string} id @param {string} text */
const line = (id, text) => `${JSON.stringify({ id, author: { id: "Ada", name: "Ada", kind: "agent" }, text, ts: "2026-09-04T00:00:00.000Z" })}\n`;

/** A seat with one local room `down`, and the env of one session on it. @param {string} dir */
async function seat(dir) {
  const file = path.join(dir, "agora.json");
  const state = path.join(dir, "state");
  await writeFile(file, JSON.stringify({ actor: { name: "Grace", kind: "agent" }, rooms: { down: { transport: "local", path: path.join(dir, "down.ndjson") } } }));
  return { room: path.join(dir, "down.ndjson"), state, env: { AGORA_CONFIG: file, AGORA_STATE: state, AGORA_SESSION: "a", AGORA_ACTOR: "Grace/watch" } };
}

test("hopOf: no trailer is hop 0; the highest whole-number hop: in the block counts; anything else reads as 0; a block of only hop: is a block", () => {
  assert.equal(hopOf("plain words"), 0);
  assert.equal(hopOf("plain words\n\n-- Ada"), 0);
  assert.equal(hopOf(withTrailers("deep", [{ key: "hop", value: "3" }])), 3, "hop alone makes a block");
  assert.equal(hopOf(`${withTrailers("deep", [{ key: "to", value: "Grace" }, { key: "hop", value: "2" }, { key: "hop", value: "7" }])}\n\n-- Ada`), 7);
  assert.equal(hopOf(withTrailers("odd", [{ key: "to", value: "Grace" }, { key: "hop", value: "lots" }])), 0);
  assert.equal(hopOf(withTrailers("odd", [{ key: "to", value: "Grace" }, { key: "hop", value: "-2" }])), 0);
  assert.equal(hopOf("prose that says\nhop: 9 in the middle\nof a paragraph"), 0, "a colon in prose is not a trailer");
});

test("watch --max-hops n: a message past n wakes nothing, still advances the cursor and stays readable; one at n wakes; no trailer is 0 (red leg: without the flag the deepest message wakes)", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    await appendFile(s.room, line("1", withTrailers("at the cap", [{ key: "hop", value: "4" }])));
    await appendFile(s.room, line("2", withTrailers("past the cap", [{ key: "hop", value: "5" }])));
    await appendFile(s.room, line("3", "no hop at all"));
    let r = await agora(["watch", "down", "--once", "--json", "--max-hops", "4"], s.env);
    assert.equal(r.code, 42, r.stderr);
    assert.deepEqual(bodies(r.stdout), ["at the cap", "no hop at all"]);
    assert.equal(typed(r.stdout).at(-1).filtered, 1);
    r = await agora(["watch", "down", "--once", "--json", "--max-hops", "4"], s.env);
    assert.equal(r.code, 0, "the filtered message advanced the cursor with the rest");
    const read = await agora(["read", "down", "--json"], s.env);
    assert.match(read.stdout, /past the cap/, "readable");

    await agora(["cursor", "down", "--reset"], s.env);
    r = await agora(["watch", "down", "--once", "--json"], s.env);
    assert.deepEqual(bodies(r.stdout), ["at the cap", "past the cap", "no hop at all"], "red leg: the cap is the reader's flag, never automatic");

    r = await agora(["watch", "down", "--once", "--max-hops", "four"], s.env);
    assert.equal(r.code, 2);
  } finally { await cleanup(); }
});

test("post: while the session's harness holds a wake record the post carries one hop past it; a hop the caller wrote stands; with no record, or one that does not parse, none (red legs); the ledger keeps the thread a reply went into", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const s = await seat(dir);
    const sdir = path.join(s.state, "sessions", "a");
    const hopOfPost = async (/** @type {string[]} */ args) => {
      const r = await agora(["post", "down", "--json", ...args], s.env);
      assert.equal(r.code, 0, r.stderr);
      const id = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}").id;
      const read = await agora(["read", "down", "--json"], s.env);
      const m = typed(read.stdout).find((o) => o.id === id);
      return m?.trailers?.find((/** @type {any} */ t) => t.key === "hop")?.value ?? null;
    };
    assert.equal(await hopOfPost(["--", "no wake"]), null, "red leg: no record, no hop");
    await mkdir(sdir, { recursive: true });
    await writeFile(path.join(sdir, WAKE_FILE), JSON.stringify({ v: 1, type: "wake", session: "a", hop: 2, ids: ["down 1"], at: "2026-09-04T00:00:00.000Z" }));
    assert.equal(await hopOfPost(["--", "answering"]), "3");
    assert.equal(await hopOfPost(["--trailer", "hop: 0", "--", "written by hand"]), "0", "the caller's own hop stands");
    await writeFile(path.join(sdir, WAKE_FILE), JSON.stringify({ v: 1, type: "wake", session: "a", hop: null }));
    assert.equal(await hopOfPost(["--", "a record naming no hop"]), null);
    await writeFile(path.join(sdir, WAKE_FILE), "{torn");
    assert.equal(await hopOfPost(["--", "a torn record"]), null);

    const root = await agora(["post", "down", "--json", "--", "a root"], s.env);
    const rootId = JSON.parse(root.stdout.trim().split("\n").pop() ?? "{}").id;
    await agora(["post", "down", "--json", "--thread", rootId, "--", "a reply"], s.env);
    const ledger = (await readFile(path.join(sdir, "posted.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(ledger.slice(-2).map((r) => r.thread ?? null), [null, rootId]);
  } finally { await cleanup(); }
});
