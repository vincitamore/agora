import { writeFile } from "node:fs/promises";
import { takeKeyClaim } from "../src/native-member-claim.mjs";
const [stateRoot, digest, out] = process.argv.slice(2);
try {
  const held = await takeKeyClaim({ stateRoot, keyDigest: digest, kind: "resident", label: `pid${process.pid}` });
  await writeFile(out, JSON.stringify({ took: true, generation: held.generation, pid: process.pid }), "utf8");
  // Hold it. Do NOT release: the question is how many holders exist at once.
  await new Promise((r) => setTimeout(r, 1500));
} catch (e) {
  await writeFile(out, JSON.stringify({ took: false, code: e?.code }), "utf8");
}
