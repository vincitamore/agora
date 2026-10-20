// @ts-check
/**
 * A resident's harness side as a scenario drives it: the real agora-room omp extension
 * (plugins/omp/agora-room) bound to a stub `pi` and `ctx`, in this process, against a seat. The
 * extension runs the seat's CLI as its own children, exactly as it does inside omp: it registers
 * `<AGORA_ROLE>/<Model>` at the launcher's position (AGORA_LABEL), takes its predecessor's place
 * (`resident inherit`), sets its starting point, and delivers what its watch admits as turns
 * (recorded here, never typed anywhere). Its timer is not run; the scenario ticks it.
 *
 * The session record names this process's pid (the extension sets OMP_PID to the process it runs
 * in), so the session reads as live while the scenario runs.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createAgoraRoom } from "../../../plugins/omp/agora-room/index.mjs";
import { BIN, nodeExecutable } from "./seat.mjs";

/**
 * Start one session's extension.
 * @param {import("./seat.mjs").Seat} seat
 * @param {{ sessionId: string, modelId: string, role: string, position?: string, wake?: string }} o
 */
export async function startOmpSession(seat, o) {
  const cwd = path.join(seat.root, `omp-${o.sessionId}`);
  await mkdir(cwd, { recursive: true });
  /** @type {Record<string, Function[]>} */
  const handlers = {};
  /** @type {Array<{ msg: any, opts: any }>} */
  const sent = [];
  /** @param {any} shape */
  const object = (shape) => ({ type: "object", shape });
  /** @param {string} t @returns {any} */
  const chain = (t) => { const s = { t, optional: () => chain(`${t}?`), describe: () => s }; return s; };
  const pi = {
    zod: { object, string: () => chain("string"), array: () => chain("array") },
    /** @param {string} ev @param {Function} h */ on(ev, h) { (handlers[ev] ??= []).push(h); },
    registerTool() {},
    /** @param {any} msg @param {any} opts */ sendMessage(msg, opts) { sent.push({ msg, opts }); },
  };
  const ctx = {
    cwd, mode: "tui", hasUI: false, agent: { kind: "main", id: "Main" }, idle: true,
    model: { id: o.modelId },
    models: { current: () => ctx.model },
    isIdle: () => ctx.idle,
    sessionManager: { getSessionId: () => o.sessionId, getBranch: () => [] },
    ui: { setStatus() {}, notify() {} },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimer: () => {},
  };
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...process.env,
    AGORA_CONFIG: seat.config, AGORA_STATE: seat.state, HOME: seat.home, USERPROFILE: seat.home,
    AGORA_ROOM: seat.alias, AGORA_ROOM_WAKE: o.wake ?? "mine", AGORA_ROOM_PREAMBLE: "off",
    AGORA_ROOM_CMD: JSON.stringify([nodeExecutable(), BIN]), AGORA_ROOM_LIVENESS: path.join(cwd, "liveness.json"),
    AGORA_ROLE: o.role, ...(o.position ? { AGORA_LABEL: o.position } : {}),
  };
  for (const k of ["AGORA_SESSION", "AGORA_ACTOR", "OMP_SESSION_ID", "OMP_PID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID"]) delete env[k];
  if (!o.position) delete env.AGORA_LABEL;
  const ctl = createAgoraRoom(pi, { env, home: seat.home, pollTimeoutMs: 30_000 });
  for (const h of handlers.session_start ?? []) await h({ type: "session_start" }, ctx);
  const rt = /** @type {any} */ (ctl.runtime);
  if (!rt) throw new Error("the agora-room extension configured no room for the scenario's session");
  return {
    rt, sent,
    /** The CLI environment of this session: what the model's own shell carries inside omp. */
    cliEnv: { AGORA_SESSION: o.sessionId, OMP_SESSION_ID: o.sessionId },
    slug: `omp-${o.sessionId}`,
    stop: () => rt.stop(),
  };
}
