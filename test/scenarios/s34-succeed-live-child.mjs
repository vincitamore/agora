// @ts-check
/**
 * S34 · succession with a live child. The orchestrator position (`main.orchestrator`, a Claude Code
 * session whose transcript is fabricated in the seat's fake home) closes a task and asks to be
 * handed to a fresh session (`resident succeed`), while a tool call is still running: its
 * transcript's last entry is an assistant message that called a tool. The cycle defers the request.
 * The tool returns and the turn ends; the next cycle honours the request: it writes the inherit
 * marker by `succeed`, runs the restart and clears the request.
 *
 * The context is small and the session warm, so no other rule of the cycle would act: the request
 * alone is what the cycle honours.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inheritMarkerPath, succeedRequestPath } from "../../src/resident.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent } from "./lib/participants.mjs";

const SESSION = "5c0a1b2c-3434-4222-8333-444455553401";
const POSITION = "main.orchestrator";

/** @param {Record<string, unknown>} o */
const line = (o) => JSON.stringify(o) + "\n";
/** @param {string} at @param {boolean} toolCall */
const assistant = (at, toolCall) => line({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "." }, ...(toolCall ? [{ type: "tool_use", id: "t1", name: "Bash" }] : [])], usage: { input_tokens: 3, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 200, output_tokens: 9 } } });

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S34",
  name: "succeed-live-child",
  checks: {
    "deferred-mid-turn": {
      bar: "while a tool call runs, the cycle defers the succeed request (no act) and keeps it",
      redLeg: "the transcript's last assistant message called no tool (the turn had ended), so the cycle hands it on at once",
    },
    "honoured-between-turns": {
      bar: "once the turn has ended the cycle cycles the position for the succeed request",
      redLeg: "no succeed request was made, so a small, warm session is left alone",
    },
    "marker-and-request": {
      bar: "the honouring cycle writes the inherit marker by succeed and clears the request",
      redLeg: "the honouring cycle runs with --dry-run, so it writes no marker and the request stays",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    try {
      const dir = path.join(seat.home, ".claude", "projects", "-work-tree");
      await mkdir(dir, { recursive: true });
      const transcript = path.join(dir, `${SESSION}.jsonl`);
      const t0 = Date.now() - 120_000;
      await writeFile(transcript, line({ type: "user", timestamp: new Date(t0).toISOString(), message: { role: "user", content: "close the task" } })
        + assistant(new Date(t0 + 30_000).toISOString(), !ctx.red("deferred-mid-turn")));
      const orc = await Agent.start(seat, { session: SESSION, bearer: "orchestrator/Opus", label: POSITION, harness: "claude" });
      if (!ctx.red("honoured-between-turns")) await orc.ok(["resident", "succeed", "--json"]);

      /** @param {string[]} extra */
      const cycle = async (extra) => {
        const r = await seat.cli(["resident", "cycle", POSITION, "--json", "--restart", "node -e 0", ...extra]);
        const row = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((o) => o.type === "resident");
        if (!row) throw new Error(`cycle printed no row (exit ${r.code}): ${r.stdout}${r.stderr}`);
        return row;
      };
      const first = await cycle(["--dry-run"]);
      ctx.check("deferred-mid-turn", { action: "none", requestKept: true }, { action: first.action, requestKept: existsSync(succeedRequestPath(seat.state, POSITION)) }, { note: String(first.reason ?? "") });

      // the tool returns and the turn ends
      await appendFile(transcript, line({ type: "user", timestamp: new Date(t0 + 40_000).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] } })
        + assistant(new Date(t0 + 50_000).toISOString(), false));
      const second = await cycle(ctx.red("marker-and-request") ? ["--dry-run"] : []);
      ctx.check("honoured-between-turns", { action: "cycle", reason: "succeed:" }, { action: second.action === "would-cycle" ? "cycle" : second.action, reason: String(second.reason ?? "").split(" ")[0] }, { note: String(second.reason ?? "") });
      const marker = existsSync(inheritMarkerPath(seat.state, POSITION)) ? JSON.parse(await readFile(inheritMarkerPath(seat.state, POSITION), "utf8")) : null;
      ctx.check("marker-and-request", { markerBy: "succeed", requestCleared: true }, { markerBy: marker?.by ?? null, requestCleared: !existsSync(succeedRequestPath(seat.state, POSITION)) });
      await orc.stopHarness();
    } finally {
      await seat.close();
    }
  },
};
