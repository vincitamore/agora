// @ts-check
// The kit is a public, generic package: it carries no host vocabulary (no domain, product or person
// names from any one deployment). Every file under chat/ is searched, tracked or not, except this one,
// which has to spell the words it forbids.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHAT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "test/containment.test.mjs";
const FORBIDDEN = "ncu|routeros|mikrotik|ncu-net|network-cli|gary|james|alex|core-router|sw50|escada|scada";

test("chat/ carries no host vocabulary", async () => {
  let out = "";
  try {
    const r = await run("git", ["grep", "--untracked", "-n", "-i", "-I", "-E", FORBIDDEN, "--", ".", `:(exclude)${SELF}`], { cwd: CHAT, windowsHide: true });
    out = r.stdout;
  } catch (e) {
    // git grep exits 1 when nothing matches; anything else is a failure to search, never a pass
    const code = /** @type {any} */ (e).code;
    if (code !== 1) throw e;
  }
  assert.equal(out, "", `host vocabulary in chat/:\n${out}`);
});
