// Offline acceptance probes for docs/ROADMAP.md. No config, credentials, or live rooms.
// Exit 1 names an unmet acceptance bar; exit 0 means every probe passed.
import { slackTransport } from "../src/transports/slack.mjs";
import { foldRoom } from "../src/carry.mjs";

const stamp = (n) => `1700000000.${String(n).padStart(6, "0")}`;
const backlog = Array.from({ length: 2500 }, (_, i) => ({
  ts: stamp(i + 1), text: `message ${i + 1}`, user: "U_TEST", username: "fixture",
})).reverse();
let requests = 0;
const slack = slackTransport({ transport: "slack", channel: "CTEST" }, {
  token: "offline-fixture",
  fetch: async (input) => {
    requests++;
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/conversations.history")) throw new Error(`unexpected method: ${url.pathname}`);
    const eligible = backlog.filter((m) => m.ts > (url.searchParams.get("oldest") ?? ""))
      .filter((m) => !url.searchParams.has("latest") || m.ts < url.searchParams.get("latest"));
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const end = offset + limit;
    const more = end < eligible.length;
    return new Response(JSON.stringify({
      ok: true, messages: eligible.slice(offset, end), has_more: more,
      response_metadata: { next_cursor: more ? String(end) : "" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
const first = await slack.read({ since: stamp(0), limit: 200 });
const pagination = {
  probe: "slack-backlog-oldest-unseen",
  pass: first.length === 200 && first[0]?.cursor === stamp(1) && first.at(-1)?.cursor === stamp(200),
  expectedFirst: stamp(1), actualFirst: first[0]?.cursor,
  expectedLast: stamp(200), actualLast: first.at(-1)?.cursor, requests,
};

const message = (id, text, name) => ({
  id, cursor: id, room: "offline", text,
  ts: `2026-09-04T00:00:0${id}.000Z`,
  author: { id: name, name, kind: "agent" },
});
const folded = foldRoom([
  message("1", "Request A\n\nto: Receiver\n\n-- Sender", "Sender"),
  message("2", "Request B\n\nto: Receiver\n\n-- Sender", "Sender"),
  message("3", "Receipt for A only\n\nre: 1\n\n-- Receiver", "Receiver"),
], new Set(["3"]), { bearer: "Receiver" });
const acknowledgement = {
  probe: "receipt-for-A-preserves-unanswered-B",
  pass: folded.owed.some((m) => m.id === "2") && !folded.owed.some((m) => m.id === "1"),
  expectedOwed: ["2"], actualOwed: folded.owed.map((m) => m.id),
};

for (const result of [pagination, acknowledgement]) console.log(JSON.stringify(result));
process.exitCode = [pagination, acknowledgement].every((p) => p.pass) ? 0 : 1;
