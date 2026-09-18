#!/usr/bin/env node
// Real-room differential: for every configured room named on the command line, read its history
// (threads folded in), build the export record, evaluate the settlement kernel over it the way
// singulis's ledger.ts does, and compare, for EVERY author, the standing artifacts by that author
// against what `carry`'s fold says stands when that author's posts are the session's own. The two
// readings share one kernel and must agree on every author in every room; a disagreement is an
// exhibit of a mapping defect (the class review caught in PR #188), never of the kernel.
//
//   node scripts/probe-carry-export-differential.mjs house backroom agora [--limit 1000] [--json]
//
// Reads only: the room is read through the CLI (`read --json --threads`), which moves no cursor.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRecord, memberSlug } from "../src/export-record.mjs";
import { foldRoom } from "../src/carry.mjs";
import S from "../src/native-settlement.kernel.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? args[limitAt + 1] : "1000";
const fileAt = args.indexOf("--file");
const file = fileAt >= 0 ? args[fileAt + 1] : null;
const rooms = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit" && args[i - 1] !== "--file");
// with no room named, the probe runs over the committed fixture so the acceptance gate can spawn it
// offline: a synthetic room with cross-author re:, withdraws: of another author's post, a ghost
// withdrawal and a two-target re:, the shapes the mapping has been wrong about
if (!rooms.length && !file) rooms.push(`file:${join(ROOT, "test", "fixtures", "differential-room.ndjson")}`);
if (file) rooms.push(`file:${resolve(file)}`);

/** @param {string} text */
const fm = (text) => JSON.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "null");
/** @param {unknown[]} xs */
const list = (xs) => xs.reduceRight((t, h) => ({ $: "Con", head: h, tail: t }), /** @type {any} */ ({ $: "Nil" }));

/** the singulis ledger.ts mapping over exported artifacts @param {Map<string, string>} files */
function standingByExport(files) {
  const arts = [...files].filter(([p]) => p.startsWith("artifacts/")).map(([p, c]) => ({ id: p.slice("artifacts/".length, -3), fm: fm(c) }))
    .sort((a, b) => String(a.fm.date).localeCompare(String(b.fm.date)));
  /** @type {string[]} */
  const ids = [];
  /** @param {string} id */
  const factOf = (id) => { let i = ids.indexOf(id); if (i < 0) { ids.push(id); i = ids.length - 1; } return { $: "Fact", id: BigInt(i) }; };
  const entries = arts.map((a) => a.fm.retracts
    ? { $: "Retract", fact: factOf(String(a.fm.retracts)), step: { $: "Step", members: list(a.fm["coordination-step"].map((/** @type {string} */ m) => factOf("member:" + m).id)) } }
    : { $: "Assert", fact: factOf(a.id), member: factOf("member:" + a.fm.author).id });
  const ledger = S.apply(list(entries), { $: "Nil" });
  const standing = arts.filter((a) => !a.fm.retracts && S.standing(ledger, factOf(a.id)) === true);
  return { arts, standing };
}

/** @param {string} room */
function readRoom(room) {
  if (room.startsWith("file:")) {
    const text = readFileSync(room.slice(5), "utf8");
    return { msgs: text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)) };
  }
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "agora.mjs"), "read", room, "--json", "--threads", "--limit", limit], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { error: (r.stderr || "").trim().split("\n").at(-1) };
  const msgs = r.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  return { msgs };
}

let disagreements = 0;
const report = [];
for (const room of rooms) {
  const { msgs, error } = readRoom(room);
  if (!msgs) { report.push({ room, error }); continue; }
  const { files, summary } = buildRecord(msgs, { alias: room, transport: "?", room: "?" });
  const { arts, standing } = standingByExport(files);
  const authors = [...new Set(msgs.map((m) => memberSlug(m.signedAs ?? m.author.name)))];
  const rows = [];
  for (const author of authors) {
    const own = new Set(msgs.filter((m) => memberSlug(m.signedAs ?? m.author.name) === author).map((m) => m.id));
    const c = foldRoom(msgs, own, { bearer: author });
    const carry = c.verdicts.map((v) => v.id).sort();
    const exp = standing.filter((a) => a.fm.author === author).map((a) => a.id).sort();
    const agree = carry.length === exp.length && carry.every((id, i) => id === exp[i]);
    if (!agree) disagreements += 1;
    rows.push({ author, posts: own.size, verdicts: carry.length, superseded: c.superseded.length, exportStanding: exp.length, agree,
      ...(agree ? {} : { onlyCarry: carry.filter((id) => !exp.includes(id)), onlyExport: exp.filter((id) => !carry.includes(id)) }) });
  }
  report.push({ room, messages: msgs.length, artifacts: summary.artifacts, retractions: summary.retractions, unresolved: summary.unresolved, authors: rows });
}

if (json) console.log(JSON.stringify({ disagreements, report }, null, 2));
else {
  for (const r of report) {
    if (r.error) { console.log(`${r.room}: read failed: ${r.error}`); continue; }
    console.log(`${r.room}: ${r.messages} messages, ${r.artifacts} settlement artifacts, ${r.retractions} retractions, ${r.unresolved} unresolved`);
    for (const a of r.authors) {
      const line = `  ${a.agree ? "ok   " : "DIFF "}${a.author.padEnd(24)} posts ${String(a.posts).padStart(4)}  verdicts ${String(a.verdicts).padStart(3)}  superseded ${String(a.superseded).padStart(3)}  export-standing ${String(a.exportStanding).padStart(3)}`;
      console.log(line);
      if (!a.agree) console.log(`         only carry: [${a.onlyCarry.join(", ")}]  only export: [${a.onlyExport.join(", ")}]`);
    }
  }
  console.log(`\n${disagreements} disagreement${disagreements === 1 ? "" : "s"} across ${report.length} room${report.length === 1 ? "" : "s"}`);
}
// one observation line for the acceptance gate: a probe that prints nothing has stopped asserting
const authorsChecked = report.reduce((n, r) => n + (r.authors?.length ?? 0), 0);
console.log(JSON.stringify({ probe: "carry-export-differential", rooms: report.map((r) => r.room), authors: authorsChecked, disagreements, pass: disagreements === 0 && authorsChecked > 0 && report.every((r) => !r.error) }));
process.exitCode = disagreements ? 1 : 0;
