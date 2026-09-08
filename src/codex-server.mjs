// @ts-check
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgoraError, EXIT } from "./core.mjs";
import { codexPrompt } from "./codex.mjs";

const MAX_BYTES = 64 * 1024;
/** @param {string} endpoint */
export function codexServerURL(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new AgoraError("invalid Codex server URL", EXIT.usage); }
  if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new AgoraError("Codex server must be a literal loopback ws:// endpoint without credentials, query or path", EXIT.usage);
  return url.href;
}

/** Bound submissions without truncating a message or erasing its origin.
 * @param {string} room @param {import('./core.mjs').Message[]} messages
 */
export function codexServerBatches(room, messages) {
  /** @type {{ text: string, messages: import('./core.mjs').Message[] }[]} */
  const batches = [];
  for (const message of messages) {
    const text = `[Agora origin message id: ${JSON.stringify(message.id)}]\n${codexPrompt(room, message)}`;
    if (Buffer.byteLength(text) > MAX_BYTES) throw new AgoraError("Codex delivery exceeds 64 KiB; message retained at its cursor", EXIT.error);
    const last = batches.at(-1);
    if (last && last.messages.length < 32 && Buffer.byteLength(last.text + "\n\n" + text) <= MAX_BYTES) {
      last.text += "\n\n" + text; last.messages.push(message);
    } else batches.push({ text, messages: [message] });
  }
  return batches;
}

/** Native Node WebSocket includes Undici's headers extension in WebSocketInit.
 * @typedef {(url: string, options: {headers: Record<string,string>}) => WebSocket} SocketFactory
 */
/** Authenticated, bounded JSON-RPC client. No raw provider errors or tokens in diagnostics.
 * @param {{endpoint:string, tokenFile:string, timeoutMs?:number, socket?:SocketFactory}} options
 */
export async function connectCodexServer(options) {
  const endpoint = codexServerURL(options.endpoint);
  if (!path.isAbsolute(options.tokenFile)) throw new AgoraError("Codex token file must be an absolute path", EXIT.usage);
  let token;
  try { token = (await readFile(options.tokenFile, "utf8")).trim(); }
  catch { throw new AgoraError("cannot read Codex capability-token file", EXIT.error); }
  if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw new AgoraError("invalid Codex capability-token file", EXIT.usage);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const factory = options.socket ?? ((url, init) => new WebSocket(url, /** @type {any} */ (init)));
  const socket = factory(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  /** @type {Map<number, {resolve:(value:any)=>void, reject:(error:Error)=>void, timer:ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  /** @type {Map<string, {resolve:(value:{turnId:string,outcome:string})=>void,timer:ReturnType<typeof setTimeout>}>} */
  const turnWaiters = new Map();
  /** @type {Map<string, string>} */
  const terminalTurns = new Map();
  let sequence = 0;
  let closed = false;
  /** @param {string} reason */
  const fail = (reason) => {
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new AgoraError(reason, EXIT.error)); }
    pending.clear();
    for (const [turnId, waiter] of turnWaiters) {
      clearTimeout(waiter.timer); waiter.resolve({ turnId, outcome: "closed-without-completion" });
    }
    turnWaiters.clear();
  };
  const close = () => { fail("Codex connection closed; delivery acknowledgment may be unknown"); socket.close(); };
  socket.addEventListener("close", () => fail("Codex disconnected; delivery acknowledgment may be unknown"));
  socket.addEventListener("error", () => fail("Codex connection failed; delivery acknowledgment may be unknown"));
  socket.addEventListener("message", (event) => {
    const data = String(event.data);
    if (Buffer.byteLength(data) > 4 * 1024 * 1024) { close(); return; }
    let frame;
    try { frame = JSON.parse(data); } catch { close(); return; }
    if (!frame || typeof frame !== "object") { close(); return; }
    if (frame.method === "turn/completed" && typeof frame.params?.turn?.id === "string") {
      const turnId = frame.params.turn.id;
      const outcome = frame.params.turn.status === "completed" ? "completed"
        : frame.params.turn.status === "interrupted" ? "cancelled"
        : frame.params.turn.status === "failed" ? "failed" : undefined;
      if (outcome) {
        const turnWaiter = turnWaiters.get(turnId);
        if (turnWaiter) { turnWaiters.delete(turnId); clearTimeout(turnWaiter.timer); turnWaiter.resolve({ turnId, outcome }); }
        else terminalTurns.set(turnId, outcome);
      }
      return;
    }
    const waiter = pending.get(frame.id);
    if (!waiter) return; // Notifications remain on the owning TUI; never accumulate them here.
    pending.delete(frame.id); clearTimeout(waiter.timer);
    if (frame.error) waiter.reject(new AgoraError(`Codex refused request (RPC ${Number.isInteger(frame.error.code) ? frame.error.code : "error"}); cursor retained`, EXIT.error));
    else if ("result" in frame) waiter.resolve(frame.result);
    else waiter.reject(new AgoraError("invalid Codex acknowledgment; cursor retained", EXIT.error));
  });
  /** @param {string} method @param {Record<string,unknown>} params */
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject(new AgoraError("Codex connection is closed", EXIT.error)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new AgoraError("Codex acknowledgment timed out; do not blindly replay an uncertain delivery", EXIT.error));
      close();
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch { close(); }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AgoraError("Codex connection timed out", EXIT.error)), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new AgoraError("Codex connection/authentication failed", EXIT.error)); }, { once: true });
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new AgoraError("Codex connection closed before initialization", EXIT.error)); }, { once: true });
    });
    await request("initialize", { clientInfo: { name: "agora-watch", version: "1" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
    /** @param {string} turnId @param {number} timeoutMs */
    const waitForTurn = (turnId, timeoutMs) => new Promise((resolve) => {
      const known = terminalTurns.get(turnId);
      if (known) { terminalTurns.delete(turnId); resolve({ turnId, outcome: known }); return; }
      if (closed) { resolve({ turnId, outcome: "closed-without-completion" }); return; }
      const timer = setTimeout(() => {
        turnWaiters.delete(turnId);
        resolve({ turnId, outcome: "closed-without-completion" });
      }, timeoutMs);
      turnWaiters.set(turnId, { resolve, timer });
    });
    return { request, waitForTurn, close };
  } catch (error) { close(); throw error; }
}

/** Deliver through the server OWNING the retained TUI thread. Codex 0.153.4 turn/start
 * uses start_or_steer_turn atomically; no separate idle/busy check or cold resume is needed.
 * Acceptance is not model processing. The cursor callback is withheld until a correlated
 * turn/completed notification reports successful completion for the returned turn id.
 * @param {string} room @param {import('./core.mjs').Message[]} messages
 * @param {{endpoint:string,tokenFile:string,thread:string,timeoutMs?:number,socket?:SocketFactory,
 * processedTimeoutMs?:number,
 * onAccepted?:(message:import('./core.mjs').Message)=>Promise<void>,
 * onProcessed?:(receipt:{id:string,outcome:'completed'|'cancelled'|'failed'|'closed-without-completion'})=>Promise<void>}} options
 */
export async function deliverCodexServer(room, messages, options) {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(options.thread)) throw new AgoraError("invalid Codex thread id", EXIT.usage);
  const batches = codexServerBatches(room, messages); // Validate the complete batch before any effect.
  if (!batches.length) return;
  const client = await connectCodexServer(options);
  try {
    const state = await client.request("thread/read", { threadId: options.thread, includeTurns: false });
    if (state?.thread?.id !== options.thread || !["idle", "active"].includes(state?.thread?.status?.type))
      throw new AgoraError("Codex target is not active or idle in this server; attach the retained TUI before arming delivery", EXIT.error);
    for (const batch of batches) {
      const result = await client.request("turn/start", {
        threadId: options.thread, clientUserMessageId: randomUUID(),
        input: [{ type: "text", text: batch.text, text_elements: [] }],
      });
      if (typeof result?.turn?.id !== "string" || !result.turn.id)
        throw new AgoraError("invalid Codex turn acknowledgment; delivery outcome unknown", EXIT.error);
      const terminal = await client.waitForTurn(result.turn.id, options.processedTimeoutMs ?? 30 * 60_000);
      for (const message of batch.messages) {
        const receipt = /** @type {{id:string,outcome:'completed'|'cancelled'|'failed'|'closed-without-completion'}} */ ({ id: message.id, outcome: terminal.outcome });
        await options.onProcessed?.(receipt);
        if (receipt.outcome === "completed") await options.onAccepted?.(message);
      }
      if (terminal.outcome !== "completed")
        throw new AgoraError(`Codex turn ended ${terminal.outcome}; cursor retained`, EXIT.error);
    }
  } finally { client.close(); }
}
