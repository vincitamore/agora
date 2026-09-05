import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { FRAME_TYPES } from "../protocol.ts";

const FIXTURE_DIR =
  process.env.AGORA_P4_FIXTURES ??
  "C:/Users/AlexMoyer/Documents/opus/forge/output/agora-native-adapters/fixtures/spawn";

const files = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json")).sort();

test("the design ships nineteen spawn fixtures", () => {
  expect(files).toHaveLength(19);
});

test("attack-matrix package-api: frame union has no write/send/type/keys", () => {
  const matrix = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "attack-matrix.json"), "utf8"));
  const vector = matrix.vectors.find((v: { id: string }) => v.id === "package-api");
  expect(vector.expected).toMatch(/no write\/send\/type\/keys/);
  for (const forbidden of ["write", "send", "type", "keys"]) {
    expect(FRAME_TYPES.includes(forbidden as never)).toBe(false);
  }
});

test("attack-matrix agora-verb: the root CLI has no verb that carries bytes to a pane", () => {
  const src = readFileSync(new URL("../../bin/agora.mjs", import.meta.url), "utf8");
  const verbs = [...src.matchAll(/^\s{4}([a-z][a-z0-9-]*): \{ args:/gm)].map((m) => m[1]);
  expect(verbs.length).toBeGreaterThan(5);
  for (const forbidden of ["write", "send", "type", "keys", "inject"]) {
    expect(verbs.includes(forbidden)).toBe(false);
  }
});
