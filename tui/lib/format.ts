/**
 * Pure text helpers for the cell discipline every list uses: truncate, then pad, so a row can
 * never exceed its box and wrap into the next row. No renderer imports here; unit-tested.
 */

/** Truncate to `width` (ellipsis when cut) then pad to exactly `width`. */
export function truncPad(s: string, width: number): string {
  if (width <= 0) return "";
  if (s.length === width) return s;
  if (s.length > width) return width <= 1 ? s.slice(0, width) : s.slice(0, width - 1) + "…";
  return s.padEnd(width);
}

/** Truncate to `width` (ellipsis when cut) without padding. */
export function trunc(s: string, width: number): string {
  if (width <= 0) return "";
  if (s.length <= width) return s;
  return width <= 1 ? s.slice(0, width) : s.slice(0, width - 1) + "…";
}

/** Wrap plain text into display lines of at most `width` characters. Returns at least one line. */
export function wrapLines(text: string, width: number, maxChars = 100_000): string[] {
  if (width <= 0) return [""];
  let src = text ?? "";
  let cut = false;
  if (src.length > maxChars) {
    src = src.slice(0, maxChars);
    cut = true;
  }
  const out: string[] = [];
  for (const raw of src.split("\n")) {
    const line = raw.replace(/\t/g, "  ").replace(/\r/g, "");
    if (line.length === 0) {
      out.push("");
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      let at = rest.lastIndexOf(" ", width);
      if (at <= 0) at = width;
      out.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^ +/, "");
    }
    out.push(rest);
  }
  if (cut) out.push("… (text cut for display; the record is whole)");
  return out.length ? out : [""];
}

/** `14:22:05` from an ISO timestamp, local time; the raw string when it does not parse. */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `2026-09-05 14:22` from an ISO timestamp, local time; the raw string when it does not parse. */
export function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
