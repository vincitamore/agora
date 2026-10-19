// @ts-check
/**
 * Scripted participants for scenarios. Each acts only through what a real participant has: a mock
 * agent is a session (AGORA_SESSION, or a harness's session variable) driving the real CLI; a mock
 * human is a person posting through `agora/client` with `author.kind` human, in process, as a host
 * surface does. Nothing here writes a room record itself.
 *
 * The `behaviours` at the bottom are the failure classes the room has exhibited, each as a scripted
 * act, so a scenario can reproduce them on purpose: a rename mid-thread, a top-level reply carrying
 * `re:`, an address that is half a name, a human posting into the thread the surface had selected,
 * and a model swap that re-registers the bearer (in place, or by a relaunch).
 *
 * The only writes to state that are not a CLI call are named faults (`ageSessionRecord`, the lost
 * ledger in a scenario's red leg): time and loss injected into records the CLI wrote, never a
 * measurement.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGORA_DIR } from "./seat.mjs";

/** @typedef {import("./seat.mjs").Seat} Seat */
/** @typedef {{ id: string, cursor: string, thread?: string, author: { name: string, kind: string }, text: string, signedAs?: string, to?: string[], trailers?: Array<{ key: string, value: string }> }} WireMessage */

let textFiles = 0;

/**
 * A mock agent: one session on the seat, acting through the CLI.
 */
export class Agent {
  /**
   * @param {Seat} seat
   * @param {{ session: string, bearer: string, harness?: 'omp' | 'claude' | null, harnessPid?: number }} spec
   */
  constructor(seat, spec) {
    this.seat = seat;
    this.session = spec.session;
    this.bearer = spec.bearer;
    this.harness = spec.harness ?? null;
    /** @type {number | undefined} */
    this.harnessPid = spec.harnessPid;
  }

  /**
   * Start an agent and register its bearer. With `harness`, a stand-in harness process is started
   * and the session's record names its pid (OMP_PID; under `claude` the session is a Claude Code
   * session id and the pid is CLAUDE_PID), so liveness and departures read as they do on a seat.
   * @param {Seat} seat
   * @param {{ session: string, bearer: string, harness?: 'omp' | 'claude' | null, label?: string }} spec
   */
  static async start(seat, spec) {
    const harnessPid = spec.harness ? await seat.spawnHarness() : undefined;
    const agent = new Agent(seat, { ...spec, harnessPid });
    await agent.register(spec.bearer, spec.label !== undefined ? { label: spec.label } : {});
    return agent;
  }

  /** The session's environment: its session key, and its harness pid when it has one. @returns {Record<string, string>} */
  env() {
    if (this.harness === "claude") return { CLAUDE_CODE_SESSION_ID: this.session, ...(this.harnessPid ? { CLAUDE_PID: String(this.harnessPid) } : {}) };
    return { AGORA_SESSION: this.session, ...(this.harnessPid ? { OMP_PID: String(this.harnessPid) } : {}) };
  }

  /** The session slug the CLI derives (a Claude Code session id is prefixed). */
  get slug() {
    return this.harness === "claude" ? `claude-code-${this.session}` : this.session;
  }

  /** @param {string[]} args */
  async cli(args) {
    return this.seat.cli(args, this.env());
  }

  /** @param {string[]} args */
  async ok(args) {
    const r = await this.cli(args);
    if (r.code !== 0) throw new Error(`agora ${args.join(" ")} (${this.bearer}) exited ${r.code}: ${r.stderr}`);
    return r;
  }

  /** Register (or re-register) this session's bearer. @param {string} bearer @param {{ label?: string }} [opts] */
  async register(bearer, opts = {}) {
    await this.ok(["session", "--as", bearer, ...(opts.label !== undefined ? ["--label", opts.label] : [])]);
    this.bearer = bearer;
  }

  /**
   * Post through the CLI. The text travels in a file, so no body is ever read as a flag.
   * @param {string} text
   * @param {{ to?: string[], re?: string, thread?: string, claim?: string, room?: string }} [opts]
   * @returns {Promise<{ id: string, cursor: string, stderr: string, warnings: string[] }>}
   */
  async post(text, opts = {}) {
    const file = path.join(this.seat.root, `post-${process.pid}-${++textFiles}.txt`);
    await writeFile(file, text, "utf8");
    const args = ["post", opts.room ?? this.seat.alias, "--file", file, "--json"];
    for (const to of opts.to ?? []) args.push("--to", to);
    if (opts.re) args.push("--re", opts.re);
    if (opts.thread) args.push("--thread", opts.thread);
    if (opts.claim) args.push("--claim", opts.claim);
    const r = await this.ok(args);
    await rm(file, { force: true });
    const receipt = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}");
    const warnings = r.stderr.split(/\r?\n/).filter((l) => l.startsWith("agora: WARNING"));
    return { id: receipt.id, cursor: receipt.cursor, stderr: r.stderr, warnings };
  }

  /** Title a thread's root. @param {string} root @param {string} text */
  async title(root, text) {
    await this.ok(["title", this.seat.alias, root, "--text", text]);
  }

  /**
   * One `watch --once --json` poll. `fromStart` resets this session's cursor first (`cursor --reset`:
   * the next watch reads from the start). Returns the delivered messages and the watch-result line.
   * @param {{ wake?: 'all' | 'addressed' | 'mine', fromStart?: boolean, thread?: string }} [opts]
   */
  async watchOnce(opts = {}) {
    if (opts.fromStart) await this.ok(["cursor", this.seat.alias, "--reset"]);
    const r = await this.cli(["watch", this.seat.alias, "--once", "--json", ...(opts.wake ? ["--wake", opts.wake] : []), ...(opts.thread ? ["--thread", opts.thread] : [])]);
    if (r.code !== 0 && r.code !== 42) throw new Error(`watch (${this.bearer}) exited ${r.code}: ${r.stderr}`);
    /** @type {WireMessage[]} */
    const messages = [];
    /** @type {any} */
    let result;
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line.startsWith("{")) continue;
      const o = JSON.parse(line);
      if (o.type === "message") messages.push(o);
      else if (o.type === "watch-result") result = o;
    }
    if (!result) throw new Error(`watch (${this.bearer}) printed no watch-result line: ${r.stdout}${r.stderr}`);
    return { messages, result, stderr: r.stderr };
  }

  /**
   * Arm a background `watch --stream --json` for this session, as a resident arms its watch. The
   * caller stops it with `seat.kill(pid)`.
   * @param {{ forSeconds: number }} opts
   */
  armStream(opts) {
    return this.seat.cliBackground(["watch", this.seat.alias, "--stream", "--json", "--for", String(opts.forSeconds)], this.env());
  }

  /** This session's saved cursor for the room, read from the file the CLI writes (no call, so no record is touched). */
  async savedCursor() {
    try { return (await readFile(path.join(this.seat.state, "sessions", this.slug, `${this.seat.alias}.cursor`), "utf8")).trim(); }
    catch { return null; }
  }

  /** Stop this session's stand-in harness (its exact pid): the session is gone. */
  async stopHarness() {
    if (this.harnessPid) await this.seat.kill(this.harnessPid);
  }
}

/**
 * A mock human posting through `agora/client`, as a host surface does.
 */
export class Human {
  /** @param {any} client @param {string} alias @param {string} name */
  constructor(client, alias, name) {
    this.client = client;
    this.alias = alias;
    this.name = name;
  }

  /** @param {string} text @param {{ to?: string[], re?: string, thread?: string }} [opts] */
  async post(text, opts = {}) {
    /** @type {Array<[string, string]>} */
    const trailers = [];
    for (const to of opts.to ?? []) trailers.push(["to", to]);
    if (opts.re) trailers.push(["re", opts.re]);
    const receipt = await this.client.append(this.alias, { text, author: { kind: "human", name: this.name }, ...(opts.thread ? { thread: opts.thread } : {}), ...(trailers.length ? { trailers } : {}) });
    return { id: String(receipt.id), cursor: String(receipt.cursor) };
  }

  /** @param {string} root @param {string} text */
  async title(root, text) {
    await this.client.annotate(this.alias, { act: "title", target: root, text, author: { kind: "human", name: this.name } });
  }

  /** @param {string} id */
  async pin(id) {
    await this.client.annotate(this.alias, { act: "pin", target: id, author: { kind: "human", name: this.name } });
  }
}

/** Open `agora/client` on a seat (the real client module, in process). @param {Seat} seat */
export async function openClient(seat) {
  const { connect } = await import(pathToFileURL(path.join(AGORA_DIR, "src", "client.mjs")).href);
  return connect({ state: seat.state, config: seat.config, clientName: "scenario-rig" });
}

/**
 * Fault: age a session's record past a bound, as if its last write were `minutes` ago. The record
 * is the CLI's; only `lastSeen` moves, so the tool's own grace is executed at its configured value
 * instead of being waited out.
 * @param {Seat} seat @param {string} slug @param {number} minutes
 */
export async function ageSessionRecord(seat, slug, minutes) {
  const file = path.join(seat.state, "sessions", slug, "session.json");
  const rec = JSON.parse(await readFile(file, "utf8"));
  rec.lastSeen = new Date(Date.now() - minutes * 60_000).toISOString();
  await writeFile(file, JSON.stringify(rec, null, 2) + "\n", "utf8");
}

/** Half of a bearer's first segment, as a reader who half-remembers a name writes it (`coding/Opus` → `cod`). @param {string} bearer */
export function halfName(bearer) {
  const first = bearer.split("/")[0];
  return first.slice(0, Math.max(1, Math.ceil(first.length / 2)));
}

/**
 * The failure classes as scripted acts.
 */
export const behaviours = {
  /** A participant renames itself mid-thread: the same session re-registers under a new bearer. @param {Agent} agent @param {string} bearer */
  renameMidThread: (agent, bearer) => agent.register(bearer),
  /** A reply that cites a message with `--re` and no `--thread`. @param {Agent} agent @param {string} cited @param {string} text @param {{ to?: string[] }} [opts] */
  replyTopLevelWithRe: (agent, cited, text, opts = {}) => agent.post(text, { ...opts, re: cited }),
  /** An address written as half a bearer's name. @param {Agent} agent @param {string} text @param {string} bearer */
  addressHalfName: (agent, text, bearer) => agent.post(text, { to: [halfName(bearer)] }),
  /** A human posting into whatever thread the surface had selected, about something else. @param {Human} human @param {string} selected @param {string} text */
  humanWithSelectedThread: (human, selected, text) => human.post(text, { thread: selected }),
  /** A model swap in place: the same session re-registers with the new model in its bearer. @param {Agent} agent @param {string} bearer @param {{ label?: string }} [opts] */
  modelSwapInPlace: (agent, bearer, opts = {}) => agent.register(bearer, opts),
  /**
   * A model swap by relaunch: the old harness stops, its record ages past the departure grace, and
   * a new session (a new harness) inherits the old one's positions and registers the new bearer.
   * @param {Agent} agent @param {{ session: string, bearer: string, label?: string, graceMinutes: number, inherit?: boolean }} next
   */
  async modelSwapRelaunch(agent, next) {
    await agent.stopHarness();
    await ageSessionRecord(agent.seat, agent.slug, next.graceMinutes + 1);
    const harnessPid = agent.harness ? await agent.seat.spawnHarness() : undefined;
    const successor = new Agent(agent.seat, { session: next.session, bearer: next.bearer, harness: agent.harness, harnessPid });
    if (next.inherit !== false) await successor.ok(["session", "--inherit", agent.slug]);
    await successor.register(next.bearer, next.label !== undefined ? { label: next.label } : {});
    return successor;
  },
};
