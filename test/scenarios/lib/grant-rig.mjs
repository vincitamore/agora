// @ts-check
/**
 * Grants as a scenario drives them: a real seat (its native room, its session records), a resident
 * manifest in the seat's root, and the grant module's own acts (`recordWant`, `recordUnwant`,
 * `ensure` over `seatEnsureDeps`: the real plan, start, stop and position state) with two stand-ins:
 *
 *   the host   a Tern that answers by the command's words. `new session` starts a stand-in harness
 *              process and acts as the agora-room extension does when a harness starts: it registers
 *              the position's session under its pid with the bearer the start's run record names
 *              (`<AGORA_ROLE>/<Model>`, else AGORA_ACTOR), then, for a model harness, runs `resident
 *              inherit <position>` before anything reads the room; `ls` reports each session live until it died;
 *              `kill session` stops that pid and forgets the session. Whether a position runs is
 *              read from this host's record, never by probing a pid the OS may reuse under load.
 *   the turn   set by the scenario per position (a turn running, or ended at an instant), since a
 *              stand-in harness writes no transcript.
 *
 * The N8 line is posted as the room's messenger session, in the Room subject (the titled, pinned
 * root a human opens), found by the module's own `roomSubject`; the lines are counted from the room
 * as `read --json` returns it. Every process is stopped by the pid it was started with.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseNotice } from "../../../src/messenger.mjs";
import { ensure, readLedger, recordUnwant, recordWant, roomSubject, seatEnsureDeps, wantRequester } from "../../../src/resident-grant.mjs";
import { loadManifest } from "../../../src/resident-start.mjs";
import { modelLabel } from "../../../plugins/omp/agora-room/index.mjs";
import { AGORA_DIR, BIN, nodeExecutable } from "./seat.mjs";
import { Agent, Human } from "./participants.mjs";
import { readRoom } from "./room.mjs";
import { HOST_HUMAN, MESSENGER_BEARER, MESSENGER_SESSION } from "./messenger-rig.mjs";

export const HOLDER = "main.orchestrator";

/**
 * The manifest the room seed writes, for the seat's room `main`: messenger, orchestrator, coding
 * (standing, max 3), review, and the orchestrator's grant. `rows` changes fields of a row by slug.
 * @param {Record<string, unknown> | null} grant @param {Record<string, Record<string, unknown>>} [rows]
 */
export function grantManifest(grant, rows = {}) {
  /** @type {Record<string, Record<string, unknown>>} */
  const residents = {
    [MESSENGER_SESSION]: { role: "messenger", harness: "agora", wake: "all", rooms: ["main"], tenure: "standing", args: ["--human-name", HOST_HUMAN] },
    [HOLDER]: { role: "orchestrator", tenure: "standing", append: ["orchestrator.md"] },
    "main.coding": { role: "coding", tenure: "standing", max: 3, append: ["coding.md"] },
  };
  for (const [slug, fields] of Object.entries(rows)) residents[slug] = { ...residents[slug], ...fields };
  return {
    version: 1,
    models: { haiku: "vendor/claude-haiku-9:medium", sonnet: "vendor/claude-sonnet-9:high" },
    defaults: { harness: "omp", host: "tern", model: "haiku", rooms: ["main"], wake: "mine", preamble: "off", profile: "PROFILE.md" },
    residents,
    ...(grant ? { grants: { [HOLDER]: grant } } : {}),
  };
}

/**
 * @param {import("./seat.mjs").Seat} seat
 * @param {any} client an open client, for the human who opens the Room subject
 * @param {Record<string, unknown> | null} grant
 * @param {Record<string, Record<string, unknown>>} [rows] row fields changed by slug (a red leg's manifest)
 */
export async function grantRig(seat, client, grant, rows = {}) {
  const manifestFile = path.join(seat.root, "residents.json");
  await writeFile(path.join(seat.root, "PROFILE.md"), "# A resident\n\nThe profile.\n");
  for (const f of ["orchestrator.md", "coding.md"]) await writeFile(path.join(seat.root, f), `# ${f}\n`);
  /** @param {Record<string, unknown> | null} g */
  const writeManifest = async (g) => { await writeFile(manifestFile, JSON.stringify(grantManifest(g, rows), null, 2)); return loadManifest(manifestFile); };
  let manifest = await writeManifest(grant);

  const ada = new Human(client, seat.alias, HOST_HUMAN);
  const roomRoot = await ada.post("Room business: starts, stops and the charter.");
  await ada.title(roomRoot.id, "Room");
  await ada.pin(roomRoot.id);
  const messenger = await Agent.start(seat, { session: MESSENGER_SESSION, bearer: MESSENGER_BEARER, label: MESSENGER_SESSION });

  // The stand-in host's own record of its sessions. A session ends only by agora's stop through the
  // host (`kill session`, removed) or by a planted death (`die`, marked dead); liveness is read from
  // this record, never by probing a pid, which the OS reuses under load.
  /** @type {Map<number, { pid: number, position: string, dead: boolean, session: string, bearer: string, inherit: any }>} */
  const sessions = new Map();
  let nextId = 100;
  /** @type {import("../../../src/resident-start.mjs").Runner} */
  const run = async (argv) => {
    if (argv[1] === "new" && argv[2] === "session") {
      const position = argv[3];
      const pid = await seat.spawnHarness();
      const id = nextId++;
      // the bearer and environment the start recorded for the harness, as the extension reads them
      const runFile = argv[argv.indexOf("--run") + 1];
      const exec = JSON.parse(await readFile(runFile, "utf8")).exec;
      const model = exec.argv[exec.argv.indexOf("--model") + 1];
      const bearer = exec.env.AGORA_ACTOR ?? `${exec.env.AGORA_ROLE}/${modelLabel(model)}`;
      const agent = new Agent(seat, { session: `granted-${id}`, bearer, harness: "omp", harnessPid: pid });
      await agent.register(bearer, { label: position });
      // a model harness's extension takes its predecessor's place before its first read
      const inherit = exec.env.AGORA_ROOM ? JSON.parse((await agent.ok(["resident", "inherit", position, "--json"])).stdout.trim().split(/\r?\n/).pop() ?? "{}") : null;
      sessions.set(id, { pid, position, dead: false, session: agent.slug, bearer, inherit });
      return { code: 0, stdout: JSON.stringify({ session: id }), stderr: "" };
    }
    if (argv[1] === "ls") {
      const list = [...sessions].map(([id, s]) => ({ id, name: s.position, tabs: [{ id: id + 1, blocks: [{ id: id + 2, live: !s.dead, exited: s.dead ? 0 : null }] }] }));
      return { code: 0, stdout: JSON.stringify({ sessions: list, detached: [] }), stderr: "" };
    }
    if (argv[1] === "kill" && argv[2] === "session") {
      const id = Number(argv[3]);
      const s = sessions.get(id);
      if (s && !s.dead) await seat.kill(s.pid);
      sessions.delete(id);
      return { code: 0, stdout: "{}", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `the stand-in tern does not answer ${argv.slice(1).join(" ")}` };
  };
  const cfgDoc = JSON.parse(await readFile(seat.config, "utf8"));
  const fakeBin = path.join(seat.root, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  for (const n of ["omp", "tern"]) for (const ext of ["", ".exe"]) await writeFile(path.join(fakeBin, n + ext), "");
  const ctx = { cfg: { ...cfgDoc, path: seat.config }, stateRoot: seat.state, checkout: AGORA_DIR, entry: BIN, node: nodeExecutable(), env: { PATH: fakeBin, PATHEXT: ".EXE" } };
  /** @type {Record<string, any>} */
  const turns = {};
  /** @param {string} _room @param {string} text */
  const post = async (_room, text) => {
    const room = await readRoom(seat);
    const thread = roomSubject(room.messages, room.annotations);
    const r = await messenger.post(text, thread ? { thread } : {});
    return { id: r.id };
  };
  const deps = () => ({ ...seatEnsureDeps({ manifest, ctx, post, run }), turn: async (/** @type {string} */ p) => turns[p] ?? { status: "none" } });
  const now = () => Date.now();

  return {
    manifestFile, roomRoot: roomRoot.id, turns,
    get manifest() { return manifest; },
    /** Replace the grant (null removes it), as the operator's edit of the manifest. @param {Record<string, unknown> | null} g */
    async setGrant(g) { manifest = await writeManifest(g); },
    /** @param {string} position @param {{ model?: string, because?: string }} [opts] */
    want: (position, opts = {}) => recordWant(manifest, seat.state, { requester: HOLDER, session: "orchestrator", position, model: opts.model, cards: [], because: opts.because ?? "parallel units", now: now() },
      { held: async (slot) => (await deps().state(slot)).running }),
    /**
     * A want as the CLI asks it: from a session on the seat, its requester read off that session's
     * own record (`wantRequester`), with whatever AGORA_LABEL the call carries.
     * @param {string} session @param {Record<string, string>} env @param {string} position
     */
    async wantFrom(session, env, position) {
      const asked = await wantRequester(seat.state, { slug: session }, { env });
      return recordWant(manifest, seat.state, { requester: asked.ok ? asked.requester : undefined, requesterRefusal: asked.ok ? undefined : asked.reason, session, position, cards: [], because: "parallel units", now: now() },
        { held: async (slot) => (await deps().state(slot)).running });
    },
    /** @param {string} target */
    unwant: (target) => recordUnwant(seat.state, { target, by: HOLDER, now: now() }),
    /** @param {{ graceSeconds?: number }} [opts] */
    ensure: (opts = {}) => ensure(manifest, seat.state, deps(), opts),
    /** Does the host hold a running session for the position (started by agora's start, not yet stopped or dead)? @param {string} position */
    running: async (position) => [...sessions.values()].some((s) => s.position === position && !s.dead),
    /** Kill a position's stand-in harness (a death, not a stop): its host session stays, exited. @param {string} position */
    async die(position) {
      for (const s of sessions.values()) if (s.position === position && !s.dead) { await seat.kill(s.pid); s.dead = true; }
    },
    /** Start a manifest row as `resident start` would; `overrides` as its flags (`--model`). @param {string} slug @param {Record<string, unknown>} [overrides] */
    startRow: (slug, overrides = {}) => deps().start(slug, { ...manifest.residents[slug], ...overrides }),
    /** The sessions the host started for a position, oldest first: session key, bearer, and what its inherit printed. @param {string} position */
    hosted: (position) => [...sessions.values()].filter((s) => s.position === position),
    /** Stop a position as `resident stop` does: by its recorded handle. @param {string} slug */
    stopByHand: (slug) => deps().stop(slug),
    /** The N8 lines standing in the room: position, verdict, path, outcome, and whether each sits in the Room subject. */
    async n8() {
      const room = await readRoom(seat);
      return room.messages.map((m) => ({ m, n: parseNotice(m.text) })).filter((x) => x.n?.kind === "N8")
        .map(({ m, n }) => ({ ...(/** @type {any} */ (n).fields), inRoomSubject: m.thread === roomRoot.id }));
    },
    ledger: () => readLedger(seat.state),
  };
}
