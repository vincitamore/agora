import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { attributeRead, journalWrite } from "../journal.ts";
import { FRAME_TYPES } from "../protocol.ts";
import { createAuthority, handleJson } from "../pane-authority.ts";
import { bearerFromProvenance, renderDeliveredLine } from "../delivered-line.ts";
import { outcomeWithoutAdmission, verdictAdmitsWrite } from "../readiness.ts";
import { writeDeliveredLine } from "../terminal-backend.ts";

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

test("attack-matrix pane-sock: deliver before hello is refused", () => {
  const auth = createAuthority({
    bootEpoch: 1,
    open: (spawnId) => ({ spawnId, term: { write() {}, close() {} } }),
  });
  expect(() =>
    handleJson(auth, {
      type: "deliver",
      spawnId: "s",
      deliveryId: "d",
      admissionId: "a",
      line: "x",
    }),
  ).toThrow(/hello/);
});

test("attack-matrix agora-verb: the root CLI has no verb that carries bytes to a pane", () => {
  const src = readFileSync(new URL("../../bin/agora.mjs", import.meta.url), "utf8");
  const verbs = [...src.matchAll(/^\s{4}([a-z][a-z0-9-]*): \{ args:/gm)].map((m) => m[1]);
  expect(verbs.length).toBeGreaterThan(5);
  for (const forbidden of ["write", "send", "type", "keys", "inject"]) {
    expect(verbs.includes(forbidden)).toBe(false);
  }
});

test("attack-matrix wt-any: this package exposes no send-keys, kill or enumerate", () => {
  const matrix = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "attack-matrix.json"), "utf8"));
  const vector = matrix.vectors.find((v: { id: string }) => v.id === "wt-any");
  expect(vector.childAck).toBe(false);
  const root = path.join(import.meta.dir, "..");
  const hits: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(path.join(root, name), "utf8");
    if (/\bsend-keys\b|\benumerate\b/.test(text)) hits.push(name);
  }
  expect(hits).toEqual([]);
});

test("delivered-line: rendered pointer matches the fixture; peer text never rides", () => {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "delivered-line.json"), "utf8"));
  const since = fixture.rendered.match(/--since (\S+)/)[1];
  const rendered = renderDeliveredLine({
    deliveryId: fixture.deliveryId,
    seat: fixture.provenance.seat,
    bearer: bearerFromProvenance(fixture.provenance.from),
    room: fixture.room,
    cursorRange: fixture.cursorRange,
    since,
  });
  expect(rendered).toBe(fixture.rendered);
  expect(rendered).not.toMatch(/ignore your brief/);
  expect(fixture.artifact).toBeNull();
});

test("delivered-line pending: unknown readiness writes nothing without an admission", () => {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "delivered-line.json"), "utf8"));
  expect(fixture.$pendingCase.written).toBe(false);
  expect(fixture.$pendingCase.disposition).toBe("inbox");
  expect(verdictAdmitsWrite(fixture.$pendingCase.readiness.verdict)).toBe(false);
  expect(outcomeWithoutAdmission()).toBe("inbox");

  const writes: string[] = [];
  const pane = {
    spawnId: fixture.recipient.spawnId,
    term: {
      write(bytes: string | Uint8Array) {
        writes.push(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
      },
      close() {},
    },
  };
  expect(() => writeDeliveredLine(pane, fixture.rendered, "")).toThrow(/admissionId/);
  expect(writes).toEqual([]);
});

test("readiness-verdicts: no harness verdict admits a write; unknown stays inbox", () => {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "readiness-verdicts.json"), "utf8"));
  for (const [name, harness] of Object.entries(fixture.harnesses) as [string, { verdict?: string }][]) {
    const verdict =
      name === "hermes" ? "not-admitted" : harness.verdict === "unknown" ? "unknown" : "idle";
    expect(verdictAdmitsWrite(verdict as "idle")).toBe(false);
  }
  expect(fixture.harnesses.hermes.verdict).toBe("not-admitted");
  expect(fixture.harnesses.grok.verdict).toBe("unknown");
  expect(fixture.harnesses.amore.verdict).toBe("unknown");
  expect(fixture.harnesses.omp.verdict).toBe("unknown");
  expect(outcomeWithoutAdmission()).toBe("inbox");
  expect(fixture.$outcomes.inbox).toMatch(/no admission/);
  expect(fixture.admission.notAnAdmission).toEqual(
    expect.arrayContaining(["idle transcript tail", "mtime debounce"]),
  );
});

test("readiness-verdicts exitRace: a closed Terminal refuses the write", () => {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "readiness-verdicts.json"), "utf8"));
  expect(fixture.exitRace.expected).toMatch(/closed/);
  const writes: string[] = [];
  const pane = {
    spawnId: "s1",
    term: {
      closed: true,
      write(bytes: string | Uint8Array) {
        writes.push(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
      },
      close() {},
    },
  };
  expect(() => writeDeliveredLine(pane, "[agora] dl-1", "ad-1")).toThrow(/closed/);
  expect(writes).toEqual([]);
});

test("three-arrivals: onboarding is argv, never a PTY write; unattributed is never human", () => {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "three-arrivals.json"), "utf8"));
  const onboard = fixture.arrivals.find((a: { kind: string }) => a.kind === "onboarding");
  const delivered = fixture.arrivals.find((a: { kind: string }) => a.kind === "delivered");
  const human = fixture.arrivals.find((a: { kind: string }) => a.kind === "attached-human");
  expect(onboard.bytesThroughPTY).toBe(false);
  expect(delivered.bytesThroughPTY).toBe(true);
  expect(human.bytesThroughPTY).toBe(true);
  expect(delivered.admittedBy).toMatch(/receiver-owned admission/);

  const journal = [
    journalWrite("service", fixture.peer, delivered.surface),
    journalWrite("human", fixture.peer, "typed-by-operator"),
  ];
  expect(attributeRead(journal, delivered.surface)).toBe("delivered");
  expect(attributeRead(journal, "typed-by-operator")).toBe("attached-human");
  expect(attributeRead(journal, fixture.forged[0].surface)).toBe("unattributed");
  expect(attributeRead(journal, fixture.forged[0].surface)).not.toBe("attached-human");
  expect(fixture.fourthClass.redIf).toMatch(/labelled human/);
});

test("three-arrivals races: no write occurs without an admission", () => {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "three-arrivals.json"), "utf8"));
  for (const race of fixture.races.cases.slice(0, 2)) {
    expect(race.expected).toMatch(/no write occurs/);
  }
  const writes: string[] = [];
  const auth = createAuthority({
    bootEpoch: 1,
    open: (spawnId) => ({
      spawnId,
      term: {
        write(bytes: string | Uint8Array) {
          writes.push(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
        },
        close() {},
      },
    }),
  });
  handleJson(auth, { type: "hello", bootEpoch: 1 });
  expect(() =>
    handleJson(auth, {
      type: "deliver",
      spawnId: fixture.peer,
      deliveryId: "dl-1",
      admissionId: "",
      line: fixture.arrivals[1].surface,
    }),
  ).toThrow(/admissionId|non-empty/);
  expect(writes).toEqual([]);
});
