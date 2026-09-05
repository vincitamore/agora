import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { FRAME_TYPES } from "../protocol.ts";

const FIXTURE_DIR =
  process.env.AGORA_P4_FIXTURES ??
  "C:/Users/operator/Documents/alpha/forge/output/agora-native-adapters/fixtures/spawn";

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
