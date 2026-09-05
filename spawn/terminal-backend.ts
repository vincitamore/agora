/**
 * The only write() to a pane terminal in this package.
 * Callers are deliver (admitted) and attach-input (leased). Onboarding is argv, never here.
 */

export type TerminalHandle = {
  write(bytes: string | Uint8Array): number | void;
  resize?(cols: number, rows: number): void;
  close(): void;
};

export type OpenedPane = {
  spawnId: string;
  term: TerminalHandle;
};

export function writeDeliveredLine(pane: OpenedPane, line: string, admissionId: string): void {
  if (!admissionId) throw new Error("deliver write needs a receiver-owned admissionId");
  pane.term.write(line.endsWith("\n") ? line : `${line}\n`);
}

export function writeAttachInput(pane: OpenedPane, bytes: string, leaseLive: boolean): void {
  if (!leaseLive) throw new Error("attach write needs a live exclusive lease");
  pane.term.write(bytes);
}

export function resizePane(pane: OpenedPane, cols: number, rows: number): void {
  pane.term.resize?.(cols, rows);
}

export function closePane(pane: OpenedPane): void {
  pane.term.close();
}
