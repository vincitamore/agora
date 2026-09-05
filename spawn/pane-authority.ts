/**
 * Long-lived pane authority. Owns every terminal. The root CLI never imports this file.
 * Started lazily by the seat service on first spawn or attach.
 */
import {
  parseFrame,
  type AttachFrame,
  type AttachInputFrame,
  type CloseFrame,
  type DeliverFrame,
  type Frame,
  type OpenFrame,
  type ResizeFrame,
} from "./protocol.ts";
import { renderDeliveredLine } from "./delivered-line.ts";
import {
  closePane,
  resizePane,
  writeAttachInput,
  writeDeliveredLine,
  type OpenedPane,
} from "./terminal-backend.ts";
import { journalWrite, type JournalEntry } from "./journal.ts";

export type Lease = { session: string; until: number };

export type Authority = {
  panes: Map<string, OpenedPane>;
  leases: Map<string, Lease>;
  journal: JournalEntry[];
  greeted: boolean;
  bootEpoch: number;
  now: () => number;
  open: (spawnId: string, cmd?: string[]) => OpenedPane;
  opens: string[];
};

export function createAuthority(opts: {
  open: (spawnId: string, cmd?: string[]) => OpenedPane;
  now?: () => number;
  bootEpoch: number;
}): Authority {
  return {
    panes: new Map(),
    leases: new Map(),
    journal: [],
    greeted: false,
    bootEpoch: opts.bootEpoch,
    now: opts.now ?? Date.now,
    open: opts.open,
    opens: [],
  };
}

/** Spawn admission calls this. Sock frames never open a pane as a side effect. */
export function registerPane(auth: Authority, spawnId: string, cmd?: string[]): OpenedPane {
  const existing = auth.panes.get(spawnId);
  if (existing) return existing;
  auth.opens.push(spawnId);
  const opened = auth.open(spawnId, cmd);
  auth.panes.set(spawnId, opened);
  return opened;
}

function existingPane(auth: Authority, spawnId: string): OpenedPane {
  const existing = auth.panes.get(spawnId);
  if (!existing) throw new Error("pane-unknown");
  return existing;
}

const LEASE_MS = 30_000;

export type Conn = { greeted: boolean };

export function handleFrame(auth: Authority, frame: Frame, conn?: Conn): void {
  if (frame.type === "hello") {
    if (frame.bootEpoch !== auth.bootEpoch) throw new Error("hello bootEpoch does not match this authority");
    if (conn) conn.greeted = true;
    else auth.greeted = true;
    return;
  }
  const greeted = conn ? conn.greeted : auth.greeted;
  if (!greeted) throw new Error("pane.sock requires hello from the seat service or the human channel first");
  switch (frame.type) {
    case "open":
      return openSpawn(auth, frame);
    case "deliver":
      return deliver(auth, frame);
    case "attach":
      return attach(auth, frame);
    case "attach-input":
      return attachInput(auth, frame);
    case "resize":
      return resize(auth, frame);
    case "close":
      return close(auth, frame);
  }
}

export function handleJson(auth: Authority, value: unknown, conn?: Conn): void {
  handleFrame(auth, parseFrame(value), conn);
}

function openSpawn(auth: Authority, frame: OpenFrame): void {
  registerPane(auth, frame.spawnId, frame.cmd);
}

function deliver(auth: Authority, frame: DeliverFrame): void {
  const line = renderDeliveredLine(frame.envelope);
  writeDeliveredLine(existingPane(auth, frame.spawnId), line, frame.admission);
  auth.journal.push(journalWrite("service", frame.spawnId, line, new Date(auth.now()).toISOString()));
}

function attach(auth: Authority, frame: AttachFrame): void {
  existingPane(auth, frame.spawnId);
  const held = auth.leases.get(frame.spawnId);
  if (held && held.session !== frame.session && auth.now() < held.until) {
    throw new Error("lease exclusive");
  }
  auth.leases.set(frame.spawnId, { session: frame.session, until: auth.now() + LEASE_MS });
}

function leaseLive(auth: Authority, frame: AttachInputFrame): boolean {
  const lease = auth.leases.get(frame.spawnId);
  if (!lease) return false;
  if (lease.session !== frame.session) return false;
  if (auth.now() >= lease.until) return false;
  return true;
}

function attachInput(auth: Authority, frame: AttachInputFrame): void {
  const pane = existingPane(auth, frame.spawnId);
  writeAttachInput(pane, frame.bytes, leaseLive(auth, frame));
  auth.journal.push(journalWrite("human", frame.spawnId, frame.bytes, new Date(auth.now()).toISOString()));
}

function resize(auth: Authority, frame: ResizeFrame): void {
  resizePane(existingPane(auth, frame.spawnId), frame.cols, frame.rows);
}

function close(auth: Authority, frame: CloseFrame): void {
  const pane = auth.panes.get(frame.spawnId);
  if (!pane) return;
  closePane(pane);
  auth.panes.delete(frame.spawnId);
  auth.leases.delete(frame.spawnId);
}
