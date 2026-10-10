// @ts-check
// The seat-service helper itself: a real service, a minted room, and agora/client in process,
// appending as an app with a client name and reading the message back with `via` and `author.ref`.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGORA_DIR, startSeat } from "./seat-service.mjs";

test("a seat service in a temp root serves a native room to agora/client", { timeout: 60_000 }, async (t) => {
  const seat = await startSeat(t);
  const { connect } = await import(pathToFileURL(path.join(AGORA_DIR, "src", "client.mjs")).href);
  const client = await connect({ state: seat.state, config: seat.config, clientName: "example-app" });
  t.after(() => client.close());
  assert.deepEqual(client.rooms(), [{ alias: seat.alias, roomId: seat.roomId, transport: "native" }]);
  const receipt = await client.append(seat.alias, { text: "hello from the kit's tests", author: { kind: "human", name: "Ada", ref: "person-1" } });
  assert.match(receipt.id, /^[a-f0-9]{64}$/);
  const { messages } = await client.read(seat.alias);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "hello from the kit's tests");
  assert.equal(messages[0].via, "example-app");
  assert.equal(messages[0].author.ref, "person-1");
});
