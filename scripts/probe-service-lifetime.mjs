// Acceptance probe: a service-owned runtime lifetime needs a live local owner, and every other
// lifetime stays inside the day bound. Offline; no config, credentials, or live rooms.
// Exit 1 names an unmet acceptance bar.
//
// A service lifetime is the one shape that takes no expiry timer, so the thing standing between a
// wire DTO and an unbounded runtime is the demand for a real AbortSignal and a matching
// service/boot context. `instanceof AbortSignal` is the check a deserialized object cannot satisfy,
// which is the point of it.
//
// Every refusal here is matched on its REASON, never on the fact that something threw: a probe that
// accepts any exception reports a guard when the module failed to import, which is the same defect
// it exists to detect.
import { prepareRuntimeLifetime, runtimeExpiryDelay } from "../src/tailcat-lifetime.mjs";

const ID = "c".repeat(32), BOOT = "d".repeat(32), DAY = 86400000;
const serviceLifetime = () => ({ kind: "service", owner: { serviceId: ID, serviceBootId: BOOT } });
const liveOwner = () => ({ serviceId: ID, serviceBootId: BOOT, signal: new AbortController().signal });

/** Refused FOR THE STATED REASON. `why` is a pattern over the message or a predicate on the error. */
function refusedBecause(fn, why) {
  try { fn(); return { refused: false, saw: "no refusal" }; }
  catch (error) {
    const message = String(error?.message ?? error);
    const matched = typeof why === "function" ? why(error) : why.test(message);
    return { refused: matched, saw: matched ? "the stated reason" : `a different failure: ${message}` };
  }
}
const all = (...checks) => ({
  refused: checks.every((c) => c.refused),
  saw: checks.find((c) => !c.refused)?.saw ?? "the stated reason",
});

const results = [];
const bar = (probe, check, extra = {}) =>
  results.push({ probe, pass: check.refused, saw: check.saw, ...extra });

bar("service-lifetime-without-an-owner-is-refused",
  refusedBecause(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() }), /live local owner/i));

// Exactly what survives a JSON round trip: the ids are right and the signal is not real.
const wire = JSON.parse(JSON.stringify({ serviceId: ID, serviceBootId: BOOT, signal: {} }));
bar("service-lifetime-refuses-a-wire-shaped-owner",
  refusedBecause(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() }, wire), /live local owner/i),
  { note: "a deserialized owner cannot carry a real AbortSignal" });

bar("service-lifetime-refuses-a-mismatched-service-or-boot-context", all(
  refusedBecause(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() },
    { serviceId: "e".repeat(32), serviceBootId: BOOT, signal: new AbortController().signal }), /context at owner/i),
  refusedBecause(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() },
    { serviceId: ID, serviceBootId: "f".repeat(32), signal: new AbortController().signal }), /context at owner/i)));

const aborted = new AbortController();
aborted.abort();
bar("service-lifetime-refuses-an-already-cancelled-owner",
  refusedBecause(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() },
    { serviceId: ID, serviceBootId: BOOT, signal: aborted.signal }),
    (error) => error?.code === "AGORA_RUNTIME_CANCELLED"),
  { note: "matched on the cancellation code, not on any throw" });

bar("an-owner-without-an-explicit-service-lifetime-is-refused", all(
  refusedBecause(() => prepareRuntimeLifetime({ deadline: Date.now() + 1000 }, liveOwner()), /explicit service lifetime/i),
  refusedBecause(() => prepareRuntimeLifetime({}, liveOwner()), /explicit service lifetime/i)));

bar("a-lifetime-and-a-deadline-together-are-refused-before-any-effect",
  refusedBecause(() => prepareRuntimeLifetime({ lifetime: serviceLifetime(), deadline: Date.now() + 1000 }, liveOwner()),
    /cannot both be supplied/i));

let accepted = null, acceptError = "";
try { accepted = prepareRuntimeLifetime({ lifetime: serviceLifetime() }, liveOwner()); }
catch (error) { acceptError = String(error?.message ?? error); }
results.push({
  probe: "a-matching-live-owner-is-accepted-and-takes-no-expiry-timer",
  pass: accepted?.kind === "service" && runtimeExpiryDelay({ lifetime: serviceLifetime() }) === null,
  saw: accepted ? "accepted, no timer" : `refused: ${acceptError}`,
  note: "null is no timer, and it is reachable only through the guarded branch above",
});

const now = Date.now();
const bounded = [
  ["absent deadline falls back to the bound", runtimeExpiryDelay({}, now) === DAY],
  ["a far deadline clamps to the bound", runtimeExpiryDelay({ deadline: now + DAY * 900 }, now) === DAY],
  ["a near deadline is preserved", runtimeExpiryDelay({ deadline: now + 60000 }, now) === 60000],
  ["an unparseable deadline falls back", runtimeExpiryDelay({ deadline: Number.NaN }, now) === DAY],
  ["a past deadline never yields a non-positive delay", runtimeExpiryDelay({ deadline: now - DAY }, now) >= 1],
  ["a far expiring lifetime clamps to the bound",
    runtimeExpiryDelay({ lifetime: { kind: "expiring", expiresAt: new Date(now + DAY * 900).toISOString() } }, now) === DAY],
  ["a near expiring lifetime is preserved",
    runtimeExpiryDelay({ lifetime: { kind: "expiring", expiresAt: new Date(now + 60000).toISOString() } }, now) === 60000],
];
results.push({
  probe: "every-non-service-lifetime-stays-inside-the-day-bound",
  pass: bounded.every(([, ok]) => ok),
  saw: bounded.every(([, ok]) => ok) ? "every bound held" : "a bound did not hold",
  unmet: bounded.filter(([, ok]) => !ok).map(([name]) => name),
});

for (const result of results) console.log(JSON.stringify(result));
process.exitCode = results.every((p) => p.pass) ? 0 : 1;
