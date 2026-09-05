/**
 * Long-lived pane.sock listener. Server writes hello first (boot-epoch bound).
 * Zero package dependencies: node:net is a Bun builtin.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createAuthority, handleJson, type Authority, type Conn } from "./pane-authority.ts";
import { mintPaneNonce } from "./protocol.ts";
import { openBunPane, type OpenedPane } from "./terminal-backend.ts";

export function paneSockPath(stateRoot: string): string {
  return path.join(stateRoot, "native", "pane.sock");
}

export type Started = {
  auth: Authority;
  server: net.Server;
  sock: string;
  close: () => Promise<void>;
};

export async function startAuthority(opts: {
  sock: string;
  bootEpoch: number;
  nonce: string;
  open?: (spawnId: string, cmd?: string[]) => OpenedPane;
}): Promise<Started> {
  mkdirSync(path.dirname(opts.sock), { recursive: true });
  try {
    rmSync(opts.sock);
  } catch {
    /* absent */
  }
  const auth = createAuthority({
    bootEpoch: opts.bootEpoch,
    nonce: opts.nonce,
    open: opts.open ?? ((spawnId) => openBunPane(spawnId)),
  });
  const server = net.createServer((socket) => accept(auth, socket));
  await listenPath(server, opts.sock);
  return {
    auth,
    server,
    sock: opts.sock,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function listenPath(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: endpoint, exclusive: true });
  });
}

function accept(auth: Authority, socket: net.Socket): void {
  const conn: Conn = { greeted: false };
  socket.write(`${JSON.stringify({ type: "hello", bootEpoch: auth.bootEpoch, challenge: auth.challenge })}\n`);
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handleJson(auth, JSON.parse(line), conn);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/unproven|cmd key|proven hello/.test(message)) {
          console.error("agora: pane refused an unproven or execute-capable frame");
        }
        socket.write(`${JSON.stringify({ type: "error", error: message })}\n`);
      }
    }
  });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<Started> {
  const state = env.AGORA_STATE ?? path.join(env.USERPROFILE ?? env.HOME ?? ".", ".agora", "state");
  const sock = env.AGORA_PANE_SOCK ?? paneSockPath(state);
  const bootEpoch = Number(env.AGORA_BOOT_EPOCH);
  const nonce = env.AGORA_PANE_NONCE && /^[a-f0-9]{32}$/.test(env.AGORA_PANE_NONCE)
    ? env.AGORA_PANE_NONCE
    : mintPaneNonce();
  mkdirSync(path.join(state, "native"), { recursive: true });
  writeFileSync(path.join(state, "native", "pane.nonce"), nonce, { encoding: "utf8", mode: 0o600 });
  const started = await startAuthority({
    sock,
    nonce,
    bootEpoch: Number.isInteger(bootEpoch) && bootEpoch > 0 ? bootEpoch : Date.now(),
  });
  process.stdout.write(`${JSON.stringify({ type: "listening", sock: started.sock, bootEpoch: started.auth.bootEpoch })}\n`);
  return started;
}

if (import.meta.main) {
  await main();
}
