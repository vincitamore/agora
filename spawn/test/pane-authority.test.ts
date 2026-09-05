import { expect, test } from "bun:test";
import { createAuthority, handleJson, issueAdmission, registerPane } from "../pane-authority.ts";
import { paneHelloProof } from "../protocol.ts";
import { renderDeliveredLine } from "../delivered-line.ts";

const NONCE = "a".repeat(32);

const envelope = {
  deliveryId: "dl-1",
  seat: "seat",
  bearer: "sol",
  room: "house",
  cursorRange: { from: "1:1", to: "1:2" },
  since: "1:0",
};

function harness() {
  const writes: string[] = [];
  const auth = createAuthority({
    bootEpoch: 7,
    nonce: NONCE,
    now: () => 1_000,
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
  handleJson(auth, {
    type: "hello",
    bootEpoch: 7,
    proof: paneHelloProof(NONCE, 7, auth.challenge),
  });
  registerPane(auth, "s1");
  issueAdmission(auth, "ad-1");
  return { auth, writes };
}

test("an unproven hello is refused; open.cmd is refused at parse so it never opens", () => {
  const opens: string[] = [];
  const auth = createAuthority({
    bootEpoch: 7,
    nonce: NONCE,
    now: () => 1_000,
    open: (spawnId) => {
      opens.push(spawnId);
      return { spawnId, term: { write() {}, close() {} } };
    },
  });
  expect(() => handleJson(auth, { type: "hello", bootEpoch: 7 })).toThrow(/unproven hello/);
  expect(() => handleJson(auth, { type: "open", spawnId: "s1", cmd: ["whoami"] })).toThrow(/cmd key|proven hello/);
  expect(opens).toEqual([]);
});

test("deliver writes the rendered envelope; attach-input without a lease refuses", () => {
  const { auth, writes } = harness();
  handleJson(auth, {
    type: "deliver",
    spawnId: "s1",
    admission: { kind: "native-enqueue", id: "ad-1" },
    envelope,
  });
  expect(writes).toEqual([`${renderDeliveredLine(envelope)}\n`]);
  expect(writes[0]).toContain("dl-1");
  expect(() =>
    handleJson(auth, { type: "attach-input", spawnId: "s1", session: "h1", bytes: "x" }),
  ).toThrow(/lease/);
});

test("attach then attach-input writes; a different session is refused and writes nothing", () => {
  const { auth, writes } = harness();
  handleJson(auth, { type: "attach", spawnId: "s1", session: "h1" });
  handleJson(auth, { type: "attach-input", spawnId: "s1", session: "h1", bytes: "ok" });
  expect(writes.at(-1)).toBe("ok");
  expect(() =>
    handleJson(auth, { type: "attach", spawnId: "s1", session: "other" }),
  ).toThrow(/exclusive/);
  expect(() =>
    handleJson(auth, { type: "attach-input", spawnId: "s1", session: "other", bytes: "no" }),
  ).toThrow(/lease/);
  expect(writes.filter((w) => w === "no")).toEqual([]);
});

test("unknown spawnId refuses without opening; deliver after close throws", () => {
  const { auth, writes } = harness();
  const before = auth.opens.slice();
  expect(() =>
    handleJson(auth, { type: "attach-input", spawnId: "ghost", session: "h1", bytes: "x" }),
  ).toThrow(/pane-unknown/);
  expect(auth.opens).toEqual(before);
  handleJson(auth, { type: "close", spawnId: "s1" });
  expect(() =>
    handleJson(auth, {
      type: "deliver",
      spawnId: "s1",
      admission: { kind: "native-enqueue", id: "ad-1" },
      envelope,
    }),
  ).toThrow(/pane-unknown/);
  expect(writes).toEqual([]);
});

test("a forged well-typed admission id is refused until issued", () => {
  const { auth, writes } = harness();
  expect(() =>
    handleJson(auth, {
      type: "deliver",
      spawnId: "s1",
      admission: { kind: "native-enqueue", id: "NEVER-ISSUED" },
      envelope,
    }),
  ).toThrow(/unissued/);
  expect(writes).toEqual([]);
  issueAdmission(auth, "NEVER-ISSUED");
  handleJson(auth, {
    type: "deliver",
    spawnId: "s1",
    admission: { kind: "native-enqueue", id: "NEVER-ISSUED" },
    envelope,
  });
  expect(writes.at(-1)).toContain("dl-1");
});
