import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { journalWrite } from "../journal.ts";

const FIXTURE_DIR =
  process.env.AGORA_P4_FIXTURES ??
  "C:/Users/AlexMoyer/Documents/opus/forge/output/agora-native-adapters/fixtures/spawn";

test("three-arrivals: service lines journalled whole; human keystrokes as count and digest only", () => {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "three-arrivals.json"), "utf8"));
  const delivered = fixture.arrivals.find((a: { kind: string }) => a.kind === "delivered");
  const human = fixture.arrivals.find((a: { kind: string }) => a.kind === "attached-human");
  expect(delivered.journalled.whole).toBe(true);
  expect(human.journalled.whole).toBe(false);
  expect(human.journalled.recorded).toEqual(["at", "byteCount", "digest"]);

  const svc = journalWrite("service", "s1", delivered.surface);
  expect(svc.bytes).toBe(delivered.surface);
  expect(svc.byteCount).toBe(delivered.surface.length);

  const hum = journalWrite("human", "s1", "secret-typed");
  expect(hum.bytes).toBeUndefined();
  expect(hum.byteCount).toBe("secret-typed".length);
  expect(hum.digest).toHaveLength(64);
});
