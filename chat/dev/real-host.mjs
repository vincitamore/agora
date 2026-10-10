// The kit against a real room: a temporary seat service with one native room (test/seat-service.mjs),
// the kit's server half mounted in a small Bun host, and chat/ served beside it, so the dev page at
// /dev/real.html runs the client half on the real routes. One signed-in person; the agent's side is
// the agora CLI against the same seat (the host prints the command).
//
//   bun chat/dev/real-host.mjs [port]
//
// Ctrl+C (or SIGTERM) closes the kit, stops the seat service and removes its temporary directory.
// Sample data only.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createChat } from "../server/index.mjs";
import { startSeat } from "../test/seat-service.mjs";

const CHAT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] ?? 4798);
const PEOPLE = [{ id: "p-mei", name: "mei" }, { id: "p-ravi", name: "ravi" }, { id: "p-dana", name: "dana" }];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

/** @type {Array<() => Promise<void> | void>} */
const after = [];
const t = /** @type {any} */ ({ after: (/** @type {() => Promise<void>} */ fn) => { after.push(fn); } });
const seat = await startSeat(t);
const dir = await mkdtemp(path.join(tmpdir(), "agora-chat-real-"));
after.push(() => rm(dir, { recursive: true, force: true }));

const chat = await createChat({
  agoraDir: seat.agoraDir, agoraState: seat.state, agoraConfig: seat.config, room: seat.alias, clientName: "dev-host",
  storeDir: path.join(dir, "kit"),
  hooks: {
    identify: async () => PEOPLE[0],
    authorize: () => true,
    people: async () => PEOPLE,
    // a stand-in for a host's scan: a key block is refused, a password-looking line warned
    scanText: (/** @type {string} */ text) => {
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return { refuse: "a private key cannot be posted in the room" };
      if (/\b(password|passwd|pin|secret)\s*[:=]\s*\S+/i.test(text)) return { warn: "this looks like a password; everyone who reads the room would see it" };
      return {};
    },
    scanUpload: async () => ({ ok: true }),
    notifyText: ({ message }) => ({ title: `${message.author?.name ?? "someone"} wrote`, body: String(message.text ?? "") }),
    presence: async () => ({ state: "ready" }),
    residentName: "the resident",
  },
  push: null,
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const r = await chat.handle(req, PEOPLE[0]);
    if (r) return r;
    const url = new URL(req.url);
    const file = path.resolve(CHAT, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(CHAT + path.sep)) return new Response("not found", { status: 404 });
    const f = Bun.file(file);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f, { headers: { "content-type": TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file))] ?? "application/octet-stream", "cache-control": "no-store" } });
  },
});

await seat.agora(["post", seat.alias, "Is the north vent in bay 2 stuck closed? The house is at 31 °C.", "--no-sign"]);
console.log(`real host: http://127.0.0.1:${server.port}/dev/real.html`);
console.log(`agent side: AGORA_CONFIG=${seat.config} AGORA_STATE=${seat.state} node ${path.join(seat.agoraDir, "bin", "agora.mjs")} <verb> ${seat.alias} ...`);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  server.stop(true);
  await chat.close().catch(() => {});
  for (const fn of after) await Promise.resolve(fn()).catch(() => {});
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
// a parent that drives this host may close stdin instead of sending a signal
process.stdin.on("end", close);
process.stdin.resume();
