import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { closePane, writeAttachInput, writeDeliveredLine } from "../terminal-backend.ts";

function fakeTerm() {
  const writes: string[] = [];
  return {
    writes,
    term: {
      write(bytes: string | Uint8Array) {
        writes.push(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
      },
      close() {},
    },
  };
}

test("deliver writes only with an admissionId; attach writes only with a live lease", () => {
  const { writes, term } = fakeTerm();
  const pane = { spawnId: "s1", term };
  expect(() => writeDeliveredLine(pane, "x", "")).toThrow(/admissionId/);
  writeDeliveredLine(pane, "[agora] dl-1", "ad-1");
  expect(writes.at(-1)).toBe("[agora] dl-1\n");
  expect(() => writeAttachInput(pane, "hi", false)).toThrow(/lease/);
  writeAttachInput(pane, "hi", true);
  expect(writes.at(-1)).toBe("hi");
  closePane(pane);
});

test("terminal.write is only reached from terminal-backend.ts", () => {
  const root = path.join(import.meta.dir, "..");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "test") continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        const text = readFileSync(p, "utf8");
        if (/\.write\(/.test(text) && path.basename(p) !== "terminal-backend.ts") hits.push(p);
      }
    }
  };
  walk(root);
  expect(hits).toEqual([]);
});
