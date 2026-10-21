// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { LINEAGE_RE, counterparts, differentFrom, lineageClash, modelFamily, roomOfPosition } from "../src/lineage.mjs";

test("family: the model segment of the id, never the provider (red leg: a provider that serves claude is not a family)", () => {
  assert.equal(modelFamily("google-antigravity/claude-opus-5-5:high"), "claude");
  assert.equal(modelFamily("anthropic/claude-sonnet-5-5:high"), "claude");
  assert.equal(modelFamily("claude-haiku-4-5"), "claude");
  assert.equal(modelFamily("gemini-4-argon"), "gemini");
  assert.equal(modelFamily("google-antigravity/gemini-4-argon:high"), "gemini");
  assert.equal(modelFamily("openai/gpt-6-sol"), "openai");
  assert.equal(modelFamily("o5-mini"), "openai");
  assert.equal(modelFamily("xai/grok-5"), "xai");
  assert.equal(modelFamily("moonshotai/Kimi-K3"), "kimi");
  assert.notEqual(modelFamily("google-antigravity/claude-opus-5-5"), "google-antigravity", "the provider is not the family");
});

test("rule: any or different-from-<role>; anything else is refused by name", () => {
  assert.equal(differentFrom("any"), null);
  assert.equal(differentFrom("different-from-coding"), "coding");
  for (const bad of ["", "none", "different-from-", "different-from-Coding", "same-as-coding", "different from coding"]) {
    assert.equal(LINEAGE_RE.test(bad), false, bad);
    assert.throws(() => differentFrom(bad), /lineage must be "any" or "different-from-<role>"/);
  }
  assert.equal(roomOfPosition("lab.review"), "lab");
  assert.equal(roomOfPosition("review"), "");
});

const rows = {
  "lab.coding": { slug: "lab.coding", role: "coding", model: "anthropic/claude-sonnet-5-5", lineage: "any" },
  "lab.coding-2": { slug: "lab.coding-2", role: "coding", model: "anthropic/claude-haiku-5-5", lineage: "any" },
  "lab.review": { slug: "lab.review", role: "review", model: "google/gemini-4-argon", lineage: "different-from-coding" },
  "lab.orchestrator": { slug: "lab.orchestrator", role: "orchestrator", model: "anthropic/claude-sonnet-5-5", lineage: "any" },
  "lab.messenger": { slug: "lab.messenger", role: "messenger", model: "code", lineage: "any", harness: "agora" },
  "other.coding": { slug: "other.coding", role: "coding", model: "google/gemini-4-argon", lineage: "any" },
};

test("counterparts: the role a row differs from in its own room, both ways; other rooms and unbound rows never", () => {
  assert.deepEqual(counterparts(rows, "lab.review").map((c) => [c.position, c.rule]),
    [["lab.coding", "lab.review differs from coding"], ["lab.coding-2", "lab.review differs from coding"]]);
  assert.deepEqual(counterparts(rows, "lab.coding").map((c) => [c.position, c.rule]), [["lab.review", "lab.review differs from coding"]],
    "a coding start is bound by the review row's rule");
  assert.deepEqual(counterparts(rows, "lab.orchestrator"), [], "an orchestrator is bound by nothing");
  assert.deepEqual(counterparts(rows, "lab.messenger"), [], "a messenger runs no model");
  assert.deepEqual(counterparts(rows, "other.coding"), [], "another room's review does not bind");
});

test("clash: a start on the family a counterpart in force runs is refused by name; another family passes (red leg: the bearer's model name differs, the family does not)", () => {
  const inForce = [{ position: "lab.coding", rule: "lab.review differs from coding", rowModel: "x", model: "anthropic/claude-sonnet-5-5", source: "session omp-1" }];
  const why = lineageClash({ slug: "lab.review", model: "google-antigravity/claude-opus-5-5:high" }, inForce);
  assert.match(String(why), /^lineage: lab\.review on google-antigravity\/claude-opus-5-5:high is family claude, the family lab\.coding runs \(anthropic\/claude-sonnet-5-5, from its session omp-1\); the manifest says lab\.review differs from coding$/);
  assert.equal(lineageClash({ slug: "lab.review", model: "gemini-4-argon" }, inForce), null);
  assert.equal(lineageClash({ slug: "lab.review", model: "anthropic/claude-opus-5-5" }, []), null, "nothing in force, nothing to clash with");
});
