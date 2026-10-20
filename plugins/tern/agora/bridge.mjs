// @ts-check
// The pane's one door to agora: host.luau and window.luau run `node bridge.mjs <verb> ...` and read
// the one JSON object printed on stdout.
//
//   config | rooms                                       what the pane is set up with, the rooms it offers
//   view --room <alias> [--refresh-remote]               one room; stdin {seen, baselineId, hasBaseline, self}
//   post --room <alias> [--thread <id> [--re <id>]] [--to <who>]...   one post, a reply to a message of the thread when --re; stdin {text}
//   set-name                                             the seat's human; stdin {name}
//   service-start | service-stop | resident-cycle-dry | prune-sessions-dry
//
// Every verb takes `--data <dir>`, the plugin's data folder: the settings file `agora.json` is read
// from it and reused remote reads are kept in it. A failure that is the room's or the CLI's is
// `{"ok":false,"error":"..."}` with exit 0, so the pane can show the line; only a crash of the
// bridge itself exits non-zero.
import path from "node:path";
import { parseArgs } from "node:util";
import { DATA_FILE, handle } from "./pane.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string" },
    room: { type: "string" },
    thread: { type: "string" },
    re: { type: "string" },
    to: { type: "string", multiple: true },
    "refresh-remote": { type: "boolean" },
  },
});

/** @returns {Promise<any>} */
async function readInput() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

const verb = positionals[0] ?? "";
const dataDir = values.data ?? null;
const out = await handle(verb, {
  file: dataDir ? path.join(dataDir, DATA_FILE) : null,
  dataDir,
  room: values.room ?? null,
  thread: values.thread ?? null,
  replyTo: values.re ?? null,
  to: values.to ?? [],
  refreshRemote: values["refresh-remote"] === true,
  input: ["view", "post", "set-name"].includes(verb) ? await readInput() : {},
});
process.stdout.write(`${JSON.stringify(out)}\n`);
