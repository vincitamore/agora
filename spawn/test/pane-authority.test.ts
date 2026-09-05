import { expect, test } from "bun:test";
import { createAuthority, handleJson } from "../pane-authority.ts";

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
  return { auth, writes };
}

test("deliver writes the line; attach-input without a lease refuses", () => {
  const { auth, writes } = harness();
  handleJson(auth, {
    type: "deliver",
    spawnId: "s1",
    deliveryId: "dl-1",
    admissionId: "ad-1",
    line: "[agora] dl-1",
  });
  expect(writes).toEqual(["[agora] dl-1\n"]);
  expect(() =>
    handleJson(auth, { type: "attach-input", spawnId: "s1", session: "h1", bytes: "x" }),
  ).toThrow(/lease/);
});

test("attach then attach-input writes; a different session does not", () => {
  const { auth, writes } = harness();
  handleJson(auth, { type: "attach", spawnId: "s1", session: "h1" });
  handleJson(auth, { type: "attach-input", spawnId: "s1", session: "h1", bytes: "ok" });
  expect(writes.at(-1)).toBe("ok");
  expect(() =>
    handleJson(auth, { type: "attach-input", spawnId: "s1", session: "other", bytes: "no" }),
  ).toThrow(/lease/);
});
