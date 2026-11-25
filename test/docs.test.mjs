// @ts-check
// Documentation parity and link hygiene: keeps hand-copied facts from drifting out of sync with
// the shipped code, ensures the starter config runs cleanly, and verifies every doc is indexed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SESSION_FROM } from "../src/session.mjs";
import { tmp } from "./helpers.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "agora.mjs");

/** @param {string[]} args @param {Record<string, string>} [env] */
async function agora(args, env = {}) {
  const clean = { ...process.env };
  for (const name of Object.keys(clean)) if (name.startsWith("AGORA_")) delete clean[name];
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

test("docs: agora.example.json loads and passes `agora doctor --offline` with exit 0", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const r = await agora(["--config", path.join(ROOT, "agora.example.json"), "doctor", "--offline"], {
      AGORA_STATE: path.join(dir, "state"),
      AGORA_SESSION: "doc-check",
    });
    assert.equal(r.code, 0, r.stdout + "\n" + r.stderr);
    assert.match(r.stdout, /doctor: ok/);
  } finally {
    await cleanup();
  }
});

test("docs: package.json description matches `agora schema --json` description", async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const r = await agora(["schema", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const schema = JSON.parse(r.stdout);
  assert.equal(pkg.description, schema.description);
});

test("docs: session-variable lists in README, AGENTS, CLAUDE, CLI, and ONBOARDING match DEFAULT_SESSION_FROM", async () => {
  const expected = [...DEFAULT_SESSION_FROM].sort();
  const varRe = /\b(?:CLAUDE_CODE_SESSION_ID|OMP_SESSION_ID|GROK_SESSION_ID|CODEX_SESSION_ID|CODEX_THREAD_ID|HERMES_SESSION_ID)\b/g;
  for (const rel of ["README.md", "AGENTS.md", "CLAUDE.md", "docs/ONBOARDING.md", "docs/CLI.md"]) {
    const text = await readFile(path.join(ROOT, rel), "utf8");
    const found = [...new Set(text.match(varRe) ?? [])].sort();
    assert.deepEqual(found, expected, `${rel} session-variable list drifted from DEFAULT_SESSION_FROM`);
  }
});

test("docs: every docs/*.md file is linked from docs/README.md", async () => {
  const index = await readFile(path.join(ROOT, "docs", "README.md"), "utf8");
  const entries = (await readdir(path.join(ROOT, "docs"))).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  const missing = entries.filter((f) => !index.includes(`(${f})`));
  assert.deepEqual(missing, [], `docs/*.md files missing from docs/README.md: ${missing.join(", ")}`);
});

test("docs: every relative markdown link in landing and core docs resolves on disk", async () => {
  const files = [
    "README.md",
    "CONTRIBUTING.md",
    "CLAUDE.md",
    "AGENTS.md",
    "docs/README.md",
    "docs/ONBOARDING.md",
    "docs/SLACK.md",
    "docs/CLI.md",
    "docs/VERIFICATION.md",
    "docs/MEMBER-SEAT.md",
    "docs/DESIGN.md",
    "docs/CLAUDE-PLUGIN.md",
    ".agents/skills/agora/SKILL.md",
  ];
  const linkRe = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
  /** @type {string[]} */
  const broken = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const text = await readFile(abs, "utf8");
    for (const m of text.matchAll(linkRe)) {
      const target = m[1];
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const [filePart] = target.split("#");
      if (!filePart) continue;
      const resolved = path.resolve(path.dirname(abs), filePart);
      if (!existsSync(resolved)) broken.push(`${rel} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], `broken relative markdown links:\n${broken.join("\n")}`);
});

test("docs: bundled Claude plugin skill stays byte-for-byte identical to skills/agora/SKILL.md", async () => {
  const canonical = await readFile(path.join(ROOT, "skills", "agora", "SKILL.md"), "utf8");
  const bundled = await readFile(path.join(ROOT, "plugins", "claude", "agora-room", "skills", "agora", "SKILL.md"), "utf8");
  assert.equal(bundled, canonical, "run copy from skills/agora/SKILL.md to plugins/claude/agora-room/skills/agora/SKILL.md");
});
