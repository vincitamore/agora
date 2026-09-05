// Acceptance probe: a service-owned runtime lifetime needs a live local owner, and every other
// lifetime stays inside the day bound. Offline; no config, credentials, or live rooms.
// Exit 1 names an unmet acceptance bar.
//
// A service lifetime is the one shape that takes no expiry timer, so the thing standing between a
// wire DTO and an unbounded runtime is the demand for a real AbortSignal and a matching
// service/boot context. `instanceof AbortSignal` is the check a deserialized object cannot satisfy,
// which is the point of it.
import { prepareRuntimeLifetime, runtimeExpiryDelay } from "../src/tailcat-lifetime.mjs";

const ID = "c".repeat(32), BOOT = "d".repeat(32), DAY = 86400000;
const serviceLifetime = () => ({ kind: "service", owner: { serviceId: ID, serviceBootId: BOOT } });
const liveOwner = () => ({ serviceId: ID, serviceBootId: BOOT, signal: new AbortController().signal });
const refused = (fn) => { try { fn(); return false; } catch { return true; } };

const results = [];

results.push({
  probe: "service-lifetime-without-an-owner-is-refused",
  pass: refused(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() })),
});

// Exactly what survives a JSON round trip: the ids are right and the signal is not real.
const wire = JSON.parse(JSON.stringify({ serviceId: ID, serviceBootId: BOOT, signal: {} }));
results.push({
  probe: "service-lifetime-refuses-a-wire-shaped-owner",
  pass: refused(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() }, wire)),
  note: "a deserialized owner cannot carry a real AbortSignal",
});

results.push({
  probe: "service-lifetime-refuses-a-mismatched-service-or-boot-context",
  pass: refused(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() },
      { serviceId: "e".repeat(32), serviceBootId: BOOT, signal: new AbortController().signal }))
    && refused(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() },
      { serviceId: ID, serviceBootId: "f".repeat(32), signal: new AbortController().signal })),
});

const aborted = new AbortController();
aborted.abort();
results.push({
  probe: "service-lifetime-refuses-an-already-cancelled-owner",
  pass: refused(() => prepareRuntimeLifetime({ lifetime: serviceLifetime() },
    { serviceId: ID, serviceBootId: BOOT, signal: aborted.signal })),
});

let accepted = null;
try { accepted = prepareRuntimeLifetime({ lifetime: serviceLifetime() }, liveOwner()); } catch { /* stays null */ }
results.push({
  probe: "a-matching-live-owner-is-accepted-and-takes-no-expiry-timer",
  pass: accepted?.kind === "service" && runtimeExpiryDelay({ lifetime: serviceLifetime() }) === null,
  note: "null is no timer, and it is reachable only through the guarded branch above",
});

results.push({
  probe: "an-owner-without-an-explicit-service-lifetime-is-refused",
  pass: refused(() => prepareRuntimeLifetime({ deadline: Date.now() + 1000 }, liveOwner()))
    && refused(() => prepareRuntimeLifetime({}, liveOwner())),
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
];
results.push({
  probe: "every-non-service-lifetime-stays-inside-the-day-bound",
  pass: bounded.every(([, ok]) => ok),
  unmet: bounded.filter(([, ok]) => !ok).map(([name]) => name),
});

for (const result of results) console.log(JSON.stringify(result));
process.exitCode = results.every((p) => p.pass) ? 0 : 1;
