import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { issueAdmission } from "../pane-authority.ts";
import { startAuthority } from "../listen.ts";
import { paneHelloProof } from "../protocol.ts";
import { renderDeliveredLine } from "../delivered-line.ts";

const NONCE = "b".repeat(32);

const envelope = {
  deliveryId: "dl-1",
  seat: "seat",
  bearer: "sol",
  room: "house",
  cursorRange: { from: "1:1", to: "1:2" },
  since: "1:0",
};

function sockPath(): string {
  return path.join(os.tmpdir(), `agora-pane-${process.pid}-${Date.now()}.sock`);
}

function readLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const line = text.split("\n")[0];
      socket.off("error", reject);
      resolve(line);
    };
    socket.once("data", onData);
    socket.once("error", reject);
  });
}

test("pane.sock: server writes hello first; deliver before client hello is refused; rendered line is written", async () => {
  const writes: string[] = [];
  const sock = sockPath();
  const started = await startAuthority({
    sock,
    bootEpoch: 7,
    nonce: NONCE,
    open: (spawnId) => ({
      spawnId,
      term: {
        write(bytes: string | Uint8Array) {
          writes.push(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
        },
        close() {},
      },
    }),
  });
  const socket = net.createConnection({ path: sock });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const first = JSON.parse(await readLine(socket));
  expect(first.type).toBe("hello");
  expect(first.bootEpoch).toBe(7);
  expect(typeof first.challenge).toBe("string");
  expect(first.nonce).toBeUndefined();

  socket.write(
    `${JSON.stringify({
      type: "deliver",
      spawnId: "s1",
      admission: { kind: "native-enqueue", id: "ad-1" },
      envelope,
    })}\n`,
  );
  const refused = JSON.parse(await readLine(socket));
  expect(refused.type).toBe("error");
  expect(refused.error).toMatch(/hello/);
  expect(writes).toEqual([]);

  socket.write(
    `${JSON.stringify({
      type: "hello",
      bootEpoch: 7,
      proof: paneHelloProof(NONCE, 7, first.challenge),
    })}\n`,
  );
  socket.write(`${JSON.stringify({ type: "open", spawnId: "s1" })}\n`);
  issueAdmission(started.auth, "ad-1");
  socket.write(
    `${JSON.stringify({
      type: "deliver",
      spawnId: "s1",
      admission: { kind: "native-enqueue", id: "ad-1" },
      envelope,
    })}\n`,
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(writes).toEqual([`${renderDeliveredLine(envelope)}\n`]);
  socket.destroy();
  await started.close();
});

test("bun run start stays alive and prints listening", async () => {
  const sock = sockPath();
  const child = spawn("bun", ["run", path.join(import.meta.dir, "..", "listen.ts")], {
    env: { ...process.env, AGORA_PANE_SOCK: sock, AGORA_BOOT_EPOCH: "3" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("start exited or stayed silent")), 5_000);
    child.stdout?.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(chunk.toString("utf8"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`start exited ${code}`));
    });
  });
  const payload = JSON.parse(line.trim().split("\n")[0]);
  expect(payload.type).toBe("listening");
  expect(payload.bootEpoch).toBe(3);
  expect(child.exitCode).toBeNull();
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
});
