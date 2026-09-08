// @ts-check
import { redact } from './core.mjs';

/** Redact complete diagnostic text before a caller bounds its public output.
 * @param {string} value
 * @param {string[]} [privateValues] Exact invocation values which must not be published. */
export function redactTailcatDiagnostics(value, privateValues = []) {
  let safe = value;
  const literals = privateValues.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
  for (const literal of [...new Set(literals)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    safe = safe.replaceAll(literal, '[redacted]');
  }
  return redact(safe).replace(/\b(?:privkey|tskey-[a-z]+)[:_-][A-Za-z0-9+/_=-]{16,}/gi, '[redacted]');
}
