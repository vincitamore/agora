import { expect, test } from "bun:test";
import { createAuthority, handleJson, registerPane } from "../pane-authority.ts";
import { renderDeliveredLine } from "../delivered-line.ts";

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
  handleJson(auth, { type: "hello", bootEpoch: 7 });
  registerPane(auth, "s1");
  return { auth, writes };
}

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
