// @ts-check
// The bare npm name `agora` belongs to an unrelated publisher, so an install line that names it
// installs someone else's code. Every doc, README and skill installs this tool from its git ref.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Directories that are not this repository's own text: dependencies, git, and local working copies. */
const SKIP = new Set([".git", "node_modules", ".worktrees", ".muse", ".agora-state"]);

/** A command that installs or runs a package by name, and the rest of its line. */
const INSTALL = /\b(?:npm\s+(?:i|install|add)|pnpm\s+(?:i|install|add|dlx)|yarn\s+(?:global\s+)?add|bun\s+(?:i|install|add)|bunx|npx|omp\s+(?:plugin\s+)?install)\b(?<rest>[^\n`]*)/g;
/** The registry name alone, with or without a version or tag. */
const BARE = /^(?:npm:)?agora(?:@[^\s/:#]*)?$/;

/**
 * The install lines in a text that name the bare package, as `line: text`.
 * @param {string} text
 * @returns {string[]}
 */
export function bareInstallLines(text) {
  /** @type {string[]} */
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(INSTALL)) {
      for (const raw of (m.groups?.rest ?? "").trim().split(/\s+/)) {
        if (/^(?:&&|\|\||[;|#>])/.test(raw)) break; // the next command, a comment, a redirect
        const token = raw.replace(/^["']|["',;)]+$/g, "");
        if (!token || token.startsWith("-")) continue;
        if (BARE.test(token)) { out.push(`${i + 1}: ${line.trim()}`); return; }
      }
    }
  });
  return out;
}

/** Every Markdown file under the repository root. @param {string} dir @returns {Promise<string[]>} */
async function markdown(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) out.push(...await markdown(path.join(dir, e.name))); }
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(path.join(dir, e.name));
  }
  return out;
}

test("the matcher: the bare name under any installer is caught, with a version or a tag; the git ref, another package and a path are not", () => {
  for (const line of [
    "npm i -g agora", "npm install agora", "npm install --global agora@latest", "bun add agora", "bun add -g agora@0.2.4",
    "pnpm add agora", "yarn global add agora", "npx agora schema --json", "bunx agora doctor", "omp plugin install agora",
    "omp install agora", '`omp plugin install "agora"`', "npm install npm:agora",
  ]) assert.deepEqual(bareInstallLines(line), [`1: ${line}`], line);
  for (const line of [
    'omp plugin install "github:vincitamore/agora#v0.2.5"', "npm install github:vincitamore/agora", "npm link",
    "claude plugin install agora-room@agora --config rooms=try", "npm install", "bun install --cwd tui", "npm install @someone/agora",
    "npm install ./agora", "npm install agora-cli", "npm run check && agora doctor", "npm install # then run agora",
  ]) assert.deepEqual(bareInstallLines(line), [], line);
});

test("no doc, README or skill installs the bare npm name `agora` (it is another publisher's package; install from the git ref)", async () => {
  /** @type {string[]} */
  const found = [];
  for (const file of await markdown(ROOT)) {
    for (const hit of bareInstallLines(await readFile(file, "utf8"))) found.push(`${path.relative(ROOT, file)}:${hit}`);
  }
  assert.deepEqual(found, [], `install lines naming the bare npm package; use the git ref (omp plugin install "github:vincitamore/agora#<tag>", or a clone):\n${found.join("\n")}`);
});
