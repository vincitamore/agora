/**
 * The scripted round trip: a human named in a temp state root posts into a temp local room
 * through LocalRoomClient, and the record comes back with `author.kind: "human"`, first through
 * the same transport, then across processes through `node bin/agora.mjs read --json` under a
 * temp config whose actor is an agent bot, proving the CLI reads the human's post as the human's
 * and never as the seat's bearer.
 */

import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalRoomClient, roomsFromConfig } from "../lib/local-client";
import { readHuman, writeHuman } from "../lib/human";
import { composeRefusal, preparePost } from "../lib/compose-guard";
import { redact } from "../../src/core.mjs";

const run = promisify(execFile);
const REPO = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO, "bin", "agora.mjs");

describe("human post round trip", () => {
  test("posts land as kind human, signed by the human, and the CLI reads them back that way", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agora-tui-post-"));
    const stateRoot = path.join(root, "state");
    const roomPath = path.join(root, "rooms", "scratch.ndjson");
    const configPath = path.join(root, "agora.json");
    try {
      // the shared config names the seat's bot as an agent; the TUI must not post under it
      await writeFile(
        configPath,
        JSON.stringify({ actor: { name: "SeatBot", kind: "agent" }, state: stateRoot, rooms: { scratch: { transport: "local", path: roomPath, note: "fixture" } } }),
        "utf8",
      );
      expect(await readHuman(stateRoot)).toBeUndefined();
      const human = await writeHuman(stateRoot, "operator");

      const view = await roomsFromConfig(configPath);
      expect(view.stateRoot).toBe(stateRoot);
      expect(view.rooms.map((r) => r.alias)).toEqual(["scratch"]);
      const client = new LocalRoomClient(human, view);
      expect(client.actor()).toEqual({ name: "operator", kind: "human" });

      // a peer's agent post first, so the human's is not the only record
      const { localTransport } = await import("../../src/transports/local.mjs");
      const peer = localTransport({ transport: "local", path: roomPath }, { actor: { name: "Grace", kind: "agent" } });
      await peer.post("hello from the seat\n\nto: operator\n\n-- Grace");

      const draft = "hello back\n";
      expect(composeRefusal(draft, human)).toBeUndefined();
      const r = await client.post("scratch", preparePost(draft, human));
      expect(r.cursor).toBe("2");

      // read back through the transport
      const back = await client.read("scratch");
      const mine = back.messages[1];
      expect(mine.author).toEqual({ id: "operator", name: "operator", kind: "human" });
      expect(mine.signedAs).toBe("operator");
      expect(mine.text).toBe("hello back\n\n-- operator");
      expect(back.horizon.oldestCursor).toBe("1");
      expect(back.horizon.source).toBe("local file");

      // the raw record on disk carries the kind the transport stamped
      const raw = (await readFile(roomPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(raw[1].author.kind).toBe("human");
      expect(raw[1].author.name).toBe("operator");

      // cross-process: the CLI, under a config whose actor is an agent, reads the human's post as the human's
      const { stdout } = await run("node", [CLI, "read", "scratch", "--json"], {
        env: { ...process.env, AGORA_CONFIG: configPath, AGORA_STATE: stateRoot, AGORA_SESSION: "tui-roundtrip-test" },
        windowsHide: true,
      });
      const rows = stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
      expect(rows).toHaveLength(2);
      expect(rows[1].type).toBe("message");
      expect(rows[1].author).toEqual({ id: "operator", name: "operator", kind: "human" });
      expect(rows[1].signedAs).toBe("operator");
      expect(rows[0].author.name).toBe("Grace");
      expect(rows[0].to).toEqual(["operator"]);
      expect(JSON.stringify(rows)).not.toContain("SeatBot");

      // the shared config was never written
      const cfgAfter = JSON.parse(await readFile(configPath, "utf8"));
      expect(cfgAfter.actor).toEqual({ name: "SeatBot", kind: "agent" });
      expect(redact(stdout)).toBe(stdout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
