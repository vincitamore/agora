import { expect, test } from "bun:test";
import { FRAME_TYPES, parseFrame } from "../protocol.ts";

test("the frame union is closed: only hello, deliver, attach, attach-input, resize, close", () => {
  expect([...FRAME_TYPES]).toEqual(["hello", "deliver", "attach", "attach-input", "resize", "close"]);
  const round = parseFrame({
    type: "deliver",
    spawnId: "spawn-1",
    deliveryId: "dl-1",
    admissionId: "ad-1",
    line: "[agora] dl-1",
  });
  expect(round.type).toBe("deliver");
});

test("write, send, type and keys are not frames; adding a writer requires editing the union", () => {
  for (const type of ["write", "send", "type", "keys"]) {
    expect(() => parseFrame({ type, spawnId: "s" })).toThrow(/not a writer this package has/);
  }
  expect(() => parseFrame({ type: "inject" })).toThrow(/unknown/);
});
