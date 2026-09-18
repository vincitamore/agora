// @ts-check
// `export-record` writes a room as the collective record the singulis conformance suite reads.
// The mapping is pinned here, the refusal of a non-empty target, and the differential that
// matters: what carry's fold says stands for one author must equal what the exported
// artifacts, read back through the same proven settlement kernel, say stands for that author.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRecord, memberSlug, writeRecord } from "../src/export-record.mjs";
import { foldRoom } from "../src/carry.mjs";
import S from "../src/native-settlement.kernel.mjs";

/** @param {string} id @param {string} text @param {{ who?: string, kind?: string, thread?: string }} [o] */
function msg(id, text, o = {}) {
  const n = Number(id.replace(/\D/g, "")) || 0;
  return /** @type {import('../src/core.mjs').Message} */ ({
    id, room: "r", ...(o.thread ? { thread: o.thread } : {}),
    author: { id: o.who ?? "seat", name: o.who ?? "seat", kind: /** @type {any} */ (o.kind ?? "agent") },
    text, signedAs: /^--\s(.+)$/m.exec(text)?.[1],
    ts: `2026-09-04T00:00:${String(n).padStart(2, "0")}.000Z`, cursor: `e:${n}`,
  });
}
/** @param {string | undefined} text */
const fm = (text) => JSON.parse(/^---\n([\s\S]*?)\n---\n/.exec(text ?? "")?.[1] ?? "null");

const WINDOW = [
  msg("m1", "claiming the unit\n\nclaim: unit-a\n\n-- Fable/settle"),
  msg("m2", "passes\n\nverdict: pass\nexhibit: run 1\n\n-- Fable/settle"),
  msg("m3", "no wait\n\nwithdraws: e:2\n\n-- Fable/settle"),
  msg("m4", "second look\n\nverdict: pass\nexhibit: run 2\n\n-- Fable/settle"),
  msg("m5", "actually fails\n\nre: m4\nverdict: fail\nexhibit: run 3\n\n-- Fable/settle"),
  msg("m6", "how is it going?", { who: "U1", kind: "human" }),
  msg("m7", "their own verdict\n\nverdict: pass\nexhibit: their run\n\n-- Codex/ops", { who: "Codex/ops", thread: "m6" }),
];
const SOURCE = { alias: "house", transport: "native", room: "abc" };

test("the mapping: messages verbatim, settlement artifacts for verdicts and withdrawals, members and persons", () => {
  const { files, summary } = buildRecord(WINDOW, SOURCE);
  assert.equal(summary.messages, 7);
  assert.deepEqual(summary.members, ["Codex-ops", "Fable-settle"]);
  assert.deepEqual(summary.persons, ["U1"]);
  assert.equal(summary.artifacts, 6, "m2, m3.r1, m4, m5.r1, m5, m7");
  assert.equal(summary.retractions, 2, "m3 withdraws m2 by cursor; m5 answers verdict m4");
  const m3 = fm(files.get("artifacts/m3.r1.md"));
  assert.equal(m3.kind, "settlement");
  assert.equal(m3.retracts, "m2", "a cursor is resolved to the post's id inside the window");
  assert.deepEqual(m3["coordination-step"], ["Fable-settle"]);
  assert.equal(files.has("artifacts/m3.md"), false, "a withdrawal asserts nothing of its own");
  const m5r = fm(files.get("artifacts/m5.r1.md"));
  assert.equal(m5r.retracts, "m4");
  assert.equal(m5r.verdict, undefined, "the retraction and the assertion are separate artifacts, as the singulis mapping reads them");
  const m5 = fm(files.get("artifacts/m5.md"));
  assert.equal(m5.retracts, undefined);
  assert.equal(m5.verdict, "fail");
  assert.deepEqual(m5.exhibits, ["run 3"]);
  assert.equal(fm(files.get("artifacts/m4.md")).retracts, undefined, "a verdict answering nothing retracts nothing");
  const msg7 = fm(files.get("messages/m7.md"));
  assert.equal(msg7.thread, "m6");
  assert.equal(msg7.from, "Codex-ops");
  assert.equal(files.get("messages/m6.md")?.endsWith("how is it going?\n"), true, "the body is verbatim");
  const cfg = fm(files.get("config.md"));
  assert.equal(cfg["as-of"], WINDOW[6].ts, "the record's clock is the newest message");
  assert.deepEqual(cfg.persons, ["U1"]);
  assert.equal(fm(files.get("members/Fable-settle.md")).posts, 5);
  assert.equal(files.has("members/U1.md"), false, "a human is a person, not a member");
});

test("a retraction is written only for the author's own post in the window, as carry reads it", () => {
  // another author's `re:` + verdict contests m1 and withdraws nothing; a `withdraws:` naming a
  // stranger's post or a post outside the window retracts nothing (the second is counted)
  const cross = [
    msg("m1", "passes\n\nverdict: pass\nexhibit: run 1\n\n-- Fable/settle"),
    msg("m2", "fails\n\nre: m1\nverdict: fail\nexhibit: their run\n\n-- Codex/ops", { who: "Codex/ops" }),
    msg("m3", "taking yours back\n\nwithdraws: m1\n\n-- Codex/ops", { who: "Codex/ops" }),
    msg("m4", "taking a ghost back\n\nwithdraws: m99\n\n-- Fable/settle"),
  ];
  const { files, summary } = buildRecord(cross, SOURCE);
  assert.equal(summary.retractions, 0);
  assert.equal(summary.unresolved, 1);
  assert.deepEqual([...files.keys()].filter((p) => p.startsWith("artifacts/")).sort(), ["artifacts/m1.md", "artifacts/m2.md"]);
  assert.equal(fm(files.get("artifacts/m2.md")).retracts, undefined);
  const { standing } = standingByExport(files);
  assert.deepEqual(standing.sort(), ["m1", "m2"], "both facts stand; a contest is not a withdrawal");
  const own = new Set(["m1", "m4"]);
  assert.deepEqual(foldRoom(cross, own, { bearer: "Fable/settle" }).verdicts.map((v) => v.id), ["m1"], "carry agrees: m1 stands");
});

test("member slugs are filesystem-safe and never empty", () => {
  assert.equal(memberSlug("Fable/settle"), "Fable-settle");
  assert.equal(memberSlug("  ///  "), "unnamed");
});

test("the target must be new or empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agora-export-"));
  const { files } = buildRecord(WINDOW, SOURCE);
  await writeRecord(join(dir, "fresh"), files);
  assert.deepEqual((await readdir(join(dir, "fresh"))).sort(), ["artifacts", "config.md", "members", "messages"]);
  await writeFile(join(dir, "taken"), "x");
  await assert.rejects(writeRecord(join(dir, "fresh"), files), /not empty/);
});

/**
 * The singulis ledger.ts mapping, applied to exported artifacts, through agora's copy of the kernel.
 * @param {Map<string, string>} files
 */
function standingByExport(files) {
  const arts = [...files].filter(([p]) => p.startsWith("artifacts/")).map(([p, c]) => ({ id: p.slice("artifacts/".length, -3), fm: fm(c) }))
    .sort((a, b) => String(a.fm.date).localeCompare(String(b.fm.date)));
  /** @type {string[]} */
  const ids = [];
  /** @param {string} id */
  const factOf = (id) => { let i = ids.indexOf(id); if (i < 0) { ids.push(id); i = ids.length - 1; } return { $: "Fact", id: BigInt(i) }; };
  /** @param {unknown[]} xs */
  const list = (xs) => xs.reduceRight((t, h) => ({ $: "Con", head: h, tail: t }), /** @type {any} */ ({ $: "Nil" }));
  const entries = arts.map((a) => a.fm.retracts
    ? { $: "Retract", fact: factOf(String(a.fm.retracts)), step: { $: "Step", members: list(a.fm["coordination-step"].map((/** @type {string} */ m) => factOf("member:" + m).id)) } }
    : { $: "Assert", fact: factOf(a.id), member: factOf("member:" + a.fm.author).id });
  const ledger = S.apply(list(entries), { $: "Nil" });
  return { standing: arts.filter((a) => !a.fm.retracts && S.standing(ledger, factOf(a.id)) === true).map((a) => a.id), arts };
}

test("differential: carry's standing verdicts for one author equal the export's standing artifacts by that author", () => {
  const own = new Set(WINDOW.filter((m) => m.signedAs === "Fable/settle").map((m) => m.id));
  const c = foldRoom(WINDOW, own, { bearer: "Fable/settle" });
  const { files } = buildRecord(WINDOW, SOURCE);
  const { standing, arts } = standingByExport(files);
  const mine = standing.filter((id) => arts.find((a) => a.id === id)?.fm.author === "Fable-settle").sort();
  assert.deepEqual(mine, c.verdicts.map((v) => v.id).sort());
  assert.deepEqual(c.superseded.map((v) => v.id).sort(), ["m2", "m4"]);
  assert.deepEqual(mine, ["m5"]);
});

test("the singulis ledger instrument reads an export and agrees (skips without bun, a Bend checkout and the singulis tree)", async (t) => {
  const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const clone = process.env.BEND_CLONE ?? resolve(ROOT, "..", "bend-src");
  const ledger = process.env.SINGULIS_SPEC ? join(process.env.SINGULIS_SPEC, "conformance", "ledger.ts") : resolve(ROOT, "..", "singulis", "spec", "conformance", "ledger.ts");
  const shell = process.platform === "win32";
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8", shell });
  if (bun.status !== 0 || !existsSync(join(clone, "bend2", "main.ts")) || !existsSync(ledger)) return t.skip("bun, a Bend checkout or the singulis tree is absent");
  const dir = join(await mkdtemp(join(tmpdir(), "agora-export-")), "rec");
  const { files } = buildRecord(WINDOW, SOURCE);
  await writeRecord(dir, files);
  const r = spawnSync("bun", ["--preload", join(clone, "bend2", "main.ts").replaceAll("\\", "/"), ledger, dir, "--json"], { encoding: "utf8", shell, env: { ...process.env, BEND_HUB: "http://127.0.0.1:1" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1) ?? "null");
  assert.deepEqual(out.standing.sort(), standingByExport(files).standing.sort());
  assert.deepEqual(out.retracted.sort(), ["m2", "m4"]);
  assert.equal(out.coordinationFree, false);
});
