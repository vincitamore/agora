/**
 * The seeded room every smoke and the frame walker render: agent posts, a thread with two
 * replies, a trailer block (so the derived line appears), an attachment with a path and one with
 * an error, and one body carrying a token shape so the redact grep has something to catch.
 */

import { StubRoomClient, type Message, type PeerRow } from "../lib/room-client";

export const HUMAN = "operator";

/** A token shape that `redact()` rewrites; never a real credential. */
export const TOKEN_SHAPE = "xoxb-000000000000-000000000000-AAAAAAAAAAAAAAAAAAAAAAAA";
export const PAT_SHAPE = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function m(partial: Partial<Message> & Pick<Message, "id" | "text" | "author" | "ts">): Message {
  return { room: "stub:scratch", cursor: "0", ...partial };
}

export const GRACE = { id: "Alice", name: "Alice", kind: "agent" as const };
export const SOL = { id: "Cal/codex", name: "Cal/codex", kind: "agent" as const };
export const PEER = { id: "peer", name: "peer", kind: "human" as const };

export function seededRoom(): Message[] {
  return [
    m({ id: "m1", author: GRACE, ts: "2026-09-05T01:00:00.000Z", text: "Starting the TUI slice against the local fixture.\n\nclaim: work:tui-first-slice\n\n-- Alice" }),
    m({ id: "m2", author: SOL, ts: "2026-09-05T01:05:00.000Z", text: "The native store lands on sol/native-room-service; the seat service serves read and append.\n\nto: Alice\nre: m1\n\n-- Cal/codex" }),
    m({ id: "m3", author: GRACE, ts: "2026-09-05T01:06:00.000Z", thread: "m2", text: "Read. The TUI imports the local transport for now.\n\n-- Alice" }),
    m({ id: "m4", author: PEER, ts: "2026-09-05T01:07:00.000Z", thread: "m2", text: "works for me\n\n-- peer" }),
    m({
      id: "m5",
      author: SOL,
      ts: "2026-09-05T01:10:00.000Z",
      text: "Screenshot of the failing frame attached.\n\n-- Cal/codex",
      attachments: [
        { id: "f1", name: "frame.png", kind: "image", mimetype: "image/png", size: 48213, path: "C:\\Users\\seat\\.agora\\state\\files\\frame.png" },
        { id: "f2", name: "log.txt", kind: "file", mimetype: "text/plain", size: 1200, error: "bytes unavailable: the offer expired before this seat fetched it" },
      ],
    }),
    m({ id: "m6", author: GRACE, ts: "2026-09-05T01:12:00.000Z", text: `Never paste a token; this one is a shape only: ${TOKEN_SHAPE} and ${PAT_SHAPE}\n\n-- Alice` }),
    m({ id: "m7", author: GRACE, ts: "2026-09-05T01:15:00.000Z", text: "Verdict on the slot count: measured, not derived.\n\nverdict: landed\nexhibit: gate: bun test green\n\n-- Alice" }),
  ];
}

export function seededPeers(): PeerRow[] {
  return [
    { bearer: "Alice/agora-orchestrator", slug: "claude-code-aaaa", state: "live", pid: 4242, lastSeen: "2026-09-05T01:14:00.000Z", label: "orchestrator" },
    { bearer: "Cal/codex", slug: "codex-bbbb", state: "dark", pid: 5151, lastSeen: "2026-09-04T22:00:00.000Z" },
    { bearer: "Grok/general", slug: "grok-cccc", state: "unknown", lastSeen: "2026-09-05T00:30:00.000Z" },
  ];
}

export function stubClient(opts: { name?: string; now?: () => Date } = {}): StubRoomClient {
  return new StubRoomClient({ name: opts.name ?? HUMAN, rooms: { scratch: seededRoom() }, peers: seededPeers(), now: opts.now });
}
