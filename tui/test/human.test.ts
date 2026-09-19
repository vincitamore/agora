import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { humanFile, humanNameProblem, readHuman, writeHuman } from "../lib/human";

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "agora-tui-human-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("human file", () => {
  test("absent reads as nothing; written once; read back as kind human", async () => {
    await withRoot(async (root) => {
      expect(await readHuman(root)).toBeUndefined();
      const a = await writeHuman(root, "  operator ");
      expect(a).toEqual({ name: "operator", kind: "human" });
      expect(await readHuman(root)).toEqual({ name: "operator", kind: "human" });
      const st = await stat(humanFile(root));
      if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
      const leftovers = (await import("node:fs/promises")).readdir(path.dirname(humanFile(root)));
      expect(await leftovers).toEqual(["human.json"]);
    });
  });

  test("a second write is refused and the first name stands", async () => {
    await withRoot(async (root) => {
      await writeHuman(root, "operator");
      await expect(writeHuman(root, "Someone")).rejects.toThrow(/already names/);
      expect(await readHuman(root)).toEqual({ name: "operator", kind: "human" });
    });
  });

  test("a malformed record is an error, never an absence", async () => {
    await withRoot(async (root) => {
      await (await import("node:fs/promises")).mkdir(path.dirname(humanFile(root)), { recursive: true });
      await writeFile(humanFile(root), "{\"nope\": 1}\n", "utf8");
      await expect(readHuman(root)).rejects.toThrow(/not a human record/);
    });
  });

  test("names are one line, bounded, and never start with a signature dash", () => {
    expect(humanNameProblem("operator")).toBeUndefined();
    expect(humanNameProblem("")).toBeDefined();
    expect(humanNameProblem("a\nb")).toBeDefined();
    expect(humanNameProblem("-- operator")).toBeDefined();
    expect(humanNameProblem("x".repeat(65))).toBeDefined();
  });
});
