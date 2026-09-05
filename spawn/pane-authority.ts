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
  type ResizeFrame,
} from "./protocol.ts";
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
  now: () => number;
  open: (spawnId: string) => OpenedPane;
};

export function createAuthority(opts: { open: (spawnId: string) => OpenedPane; now?: () => number }): Authority {
  return {
    panes: new Map(),
    leases: new Map(),
    journal: [],
    now: opts.now ?? Date.now,
    open: opts.open,
  };
}

const LEASE_MS = 30_000;

export function handleFrame(auth: Authority, frame: Frame): void {
  switch (frame.type) {
    case "hello":
      return;
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

export function handleJson(auth: Authority, value: unknown): void {
  handleFrame(auth, parseFrame(value));
}

function paneOf(auth: Authority, spawnId: string): OpenedPane {
  const existing = auth.panes.get(spawnId);
  if (existing) return existing;
  const opened = auth.open(spawnId);
  auth.panes.set(spawnId, opened);
  return opened;
}

function deliver(auth: Authority, frame: DeliverFrame): void {
  writeDeliveredLine(paneOf(auth, frame.spawnId), frame.line, frame.admissionId);
  auth.journal.push(journalWrite("service", frame.spawnId, frame.line, new Date(auth.now()).toISOString()));
}

function attach(auth: Authority, frame: AttachFrame): void {
  paneOf(auth, frame.spawnId);
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
  writeAttachInput(paneOf(auth, frame.spawnId), frame.bytes, leaseLive(auth, frame));
  auth.journal.push(journalWrite("human", frame.spawnId, frame.bytes, new Date(auth.now()).toISOString()));
}

function resize(auth: Authority, frame: ResizeFrame): void {
  resizePane(paneOf(auth, frame.spawnId), frame.cols, frame.rows);
}

function close(auth: Authority, frame: CloseFrame): void {
  const pane = auth.panes.get(frame.spawnId);
  if (!pane) return;
  closePane(pane);
  auth.panes.delete(frame.spawnId);
  auth.leases.delete(frame.spawnId);
}
