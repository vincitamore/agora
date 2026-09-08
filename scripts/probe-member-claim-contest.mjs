// L12: does ONE stale claim ever admit TWO holders? Real processes, real filesystem.
//
// This exists as a committed instrument rather than a command one bearer typed, because it is the
// only shape that reproduces the defect: in-process, the event loop walks every contender through
// the same await points in lockstep and the race never appears. Run it after any change to the
// claim's reclaim path.
//
//   node scripts/probe-member-claim-contest.mjs      # exit 0 = one holder every trial
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const taker = fileURLToPath(new URL("./probe-member-claim-taker.mjs", import.meta.url));
import { keyClaimDir, keyClaimFile, canonicalStateRoot } from "../src/native-member-claim.mjs";
import { bootEpoch } from "../src/session.mjs";
const DIGEST = `sha256:${"a".repeat(64)}`;
let worst = 0;
for (let trial = 0; trial < 8; trial++) {
  const root = await mkdtemp(path.join(tmpdir(), "mp-contest-"));
  const dir = keyClaimDir(await canonicalStateRoot(root), DIGEST);
  await mkdir(dir, { recursive: true });
  // ONE stale generation, exactly the world every taker reads. They must all compute the SAME
  // next name (2), so the O_EXCL create is the compare-and-swap and admits exactly one.
  await writeFile(keyClaimFile(dir, 1), JSON.stringify({ keyDigest: DIGEST, pid: 999999999, bootEpoch: bootEpoch(),
    kind: "resident", generation: 1, startedAt: new Date().toISOString() }) + "\n", "utf8");
  const outs = [];
  await Promise.all(Array.from({ length: 8 }, (_, i) => {
    const out = path.join(root, `r${i}.json`); outs.push(out);
    return new Promise((res) => {
      const c = spawn(process.execPath, [taker, root, DIGEST, out], { stdio: "ignore" });
      c.on("exit", () => res(undefined));
    });
  }));
  let took = 0;
  const generations = new Set();
  for (const o of outs) {
    try {
      const r = JSON.parse(await readFile(o, "utf8"));
      if (r.took) { took += 1; generations.add(r.generation); }
    } catch {}
  }
  console.log(`trial ${trial}: holders=${took} generations=${[...generations].join(",") || "none"}`);
  worst = Math.max(worst, took);
}
console.log(worst === 1 ? "PASS: exactly one holder every trial" : `FAIL: ${worst} concurrent holders admitted`);
process.exit(worst === 1 ? 0 : 1);
