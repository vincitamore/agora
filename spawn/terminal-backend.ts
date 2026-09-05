/**
 * The only write() to a pane terminal in this package.
 * Callers are deliver (admitted) and attach-input (leased). Onboarding is argv, never here.
 */

import { isAdmissionKind, type Admission } from "./protocol.ts";

export type TerminalHandle = {
  write(bytes: string | Uint8Array): number | void;
  resize?(cols: number, rows: number): void;
  close(): void;
  closed?: boolean;
};

export type OpenedPane = {
  spawnId: string;
  term: TerminalHandle;
};

export function writeDeliveredLine(pane: OpenedPane, line: string, admission: Admission): void {
  if (!admission || !isAdmissionKind(admission.kind) || !admission.id) {
    throw new Error("deliver write needs a receiver-owned admission {kind, id}");
  }
  if (pane.term.closed) throw new Error("closed Terminal");
  pane.term.write(line.endsWith("\n") ? line : `${line}\n`);
}

export function writeAttachInput(pane: OpenedPane, bytes: string, leaseLive: boolean): void {
  if (!leaseLive) throw new Error("attach write needs a live exclusive lease");
  if (pane.term.closed) throw new Error("closed Terminal");
  pane.term.write(bytes);
}

export function resizePane(pane: OpenedPane, cols: number, rows: number): void {
  pane.term.resize?.(cols, rows);
}

export function closePane(pane: OpenedPane): void {
  pane.term.close();
}

/** Production opener: the authority owns the Bun.Terminal. */
export function openBunPane(spawnId: string, cmd?: string[]): OpenedPane {
  const argv = cmd && cmd.length > 0 ? cmd : ["node", "-e", "setInterval(()=>{}, 1e9)"];
  const Terminal = (Bun as unknown as { Terminal: new (opts: object) => TerminalHandle & { closed?: boolean } }).Terminal;
  const term = new Terminal({
    cols: 80,
    rows: 24,
    data() {},
  });
  const proc = Bun.spawn({ cmd: argv, terminal: term });
  return {
    spawnId,
    term: {
      write(bytes) {
        return term.write(bytes);
      },
      resize(cols, rows) {
        term.resize?.(cols, rows);
      },
      close() {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
        term.close();
      },
      get closed() {
        return Boolean(term.closed);
      },
    },
  };
}
