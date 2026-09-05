/**
 * Idle probes are roster surface. No verdict admits a write.
 * Absent a receiver-owned admission the pointer stays in the inbox.
 */

export type ReadinessVerdict = "idle" | "busy" | "unknown" | "not-admitted";

export type DeliveryOutcome = "inbox" | "ack-pending" | "woken";

export const NOT_AN_ADMISSION = Object.freeze([
  "idle transcript tail",
  "mtime debounce",
  "an after-write receipt acknowledgement",
  "a same-tick idle transcript read",
] as const);

export function verdictAdmitsWrite(_verdict: ReadinessVerdict): false {
  return false;
}

export function outcomeWithoutAdmission(): "inbox" {
  return "inbox";
}
