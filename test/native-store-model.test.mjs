// The native store against the documented model (scripts/fuzz-native-store.mjs), on a fixed
// set of seeds so the run is reproducible. The divergences the store is KNOWN to have are pinned
// here by kind; a new kind reds this test (a defect or a documentation drift to read), and a
// known kind that stops appearing reds it too, because a stale pin is a gate that guards nothing.
// Trimming a pin is what a fix does in the same commit.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fuzzOnce } from "../scripts/fuzz-native-store.mjs";

/** the store's readings the model does not share, each reproduced by the seeds below */
const KNOWN = {
  // a human break on a subject whose lease has expired is applied (the board kernel's LAW 8
  // judges the stored holder, not the live one); the model reads an expired lease as nothing
  // to break, the reading LAW 2 gives every other verb
  "board:break": "a human break on an expired lease is applied rather than refused as nothing-to-break",
};

test("the store diverges from the documented model only in the pinned ways", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agora-store-model-"));
  const kinds = new Map();
  try {
    for (let seed = 1; seed <= 40; seed++) {
      const { divergences } = await fuzzOnce(seed, 60, path.join(root, String(seed)));
      for (const d of divergences) kinds.set(d.what, (kinds.get(d.what) ?? 0) + 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const seen = [...kinds.keys()].sort();
  assert.deepEqual(seen.filter((k) => !(k in KNOWN)), [], `unpinned divergence kinds: ${JSON.stringify(Object.fromEntries(kinds))}`);
  assert.deepEqual(Object.keys(KNOWN).filter((k) => !kinds.has(k)), [], "a pinned divergence no longer reproduces; trim the pin in the commit that fixed it");
});
