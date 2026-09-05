/**
 * The delivered-line envelope. Peer text never rides; only a pointer.
 * Existence of a record is a prior event, never a licence to write.
 */

export type CursorRange = { from: string; to: string };

export type DeliveredEnvelope = {
  deliveryId: string;
  seat: string;
  bearer: string;
  room: string;
  cursorRange: CursorRange;
  since: string;
};

/** Render the visible pointer. The prefix is a convenience, not the authority. */
export function renderDeliveredLine(env: DeliveredEnvelope): string {
  const { deliveryId, seat, bearer, room, cursorRange, since } = env;
  return `[agora] ${deliveryId} from ${seat}/${bearer} · ${room} · ${cursorRange.from}-${cursorRange.to} · read with agora read ${room} --since ${since}`;
}

/** `sol@opus-windows-primary` → `sol`. */
export function bearerFromProvenance(from: string): string {
  const at = from.indexOf("@");
  return at === -1 ? from : from.slice(0, at);
}
