// @ts-check
/**
 * S13 · audiences. Six bearers stand for two seats: the host's `Grace/Haiku/messenger` (the
 * owner-first shape a resident row documents), `orchestrator/Opus` and `coding/Opus`; the
 * member's `messenger/Haiku`, `coding/Argon` and `review/Sonnet`. The host's `coding/Opus` holds the
 * position `main.coding` (its `--label`). Grace is the host's person, Lin the member's; the config
 * names the seat `host`. Grace posts one top-level message per address form, and every bearer's
 * `watch --wake mine` (the real CLI, from the start) reports what it was handed: the reach matrix,
 * one check per address, each against the audience the address means.
 *
 * One principal: the member's bearers are sessions on the host seat, so the seat axis of an address
 * (`@member`) has nothing to resolve against and this run says what the matcher does with the
 * words. On a native room a bare address equal to the seat's name (trailers.mjs `matchesAddress`,
 * the `seat.name` branch) is compared with the READER's own bearer, because the CLI sets the actor's
 * name to the bearer (bin/agora.mjs, after `resolveBearer`) and the native transport's `whoami`
 * returns that name (src/transports/native.mjs `whoami`): `to: host` reaches nobody here, where on a
 * transport whose `whoami` names the seat it reaches every bearer on it. The person column (who is
 * notified) has no resolver in the tool to measure; only agent wakes are counted.
 */

import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";

const HOST_BEARERS = ["Grace/Haiku/messenger", "orchestrator/Opus", "coding/Opus"];
const MEMBER_BEARERS = ["messenger/Haiku", "coding/Argon", "review/Sonnet"];
const ALL = [...HOST_BEARERS, ...MEMBER_BEARERS];

/**
 * Each address form, the audience it means, and the red leg that varies it. `sort` keeps every
 * matrix cell in one order so cells compare exactly.
 * @type {Record<string, { audience: string[], bar: string, redLeg: string }>}
 */
const CELLS = {
  "Lin": { audience: [], bar: "a person's name wakes no agent", redLeg: "the member's messenger is registered owner-first as Lin/Haiku/messenger" },
  "@member": { audience: MEMBER_BEARERS, bar: "@member reaches every bearer of the member seat", redLeg: "the post lists the member's bearers by name, the address today's matcher reaches" },
  "@member/coding": { audience: ["coding/Argon"], bar: "@member/coding reaches the member seat's coding bearer only", redLeg: "the post names coding/Argon, the address today's matcher reaches" },
  "coding": { audience: ["coding/Opus", "coding/Argon"], bar: "a role reaches every bearer holding it", redLeg: "the member's coding bearer is registered model-first as Argon/coding" },
  "*": { audience: ALL, bar: "* reaches every bearer", redLeg: "the post writes `all` where it means `*`" },
  "Grace": { audience: [], bar: "a person's name wakes no agent, even where a bearer starts with it", redLeg: "the host's messenger is registered role-first as desk/Haiku" },
  "host": { audience: [], bar: "a bare seat name wakes no agent (only @host addresses a seat)", redLeg: "the host's orchestrator is registered seat-first as host/orchestrator" },
  "main.coding": { audience: ["coding/Opus"], bar: "a position reaches the session holding it, and no other bearer of the role", redLeg: "the host's coding session registers with no position" },
};

/** @type {Record<string, { bar: string, redLeg: string }>} */
const checks = {};
for (const [address, cell] of Object.entries(CELLS)) checks[`reach:${address}`] = { bar: cell.bar, redLeg: cell.redLeg };

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S13",
  name: "audiences",
  checks,
  async run(ctx) {
    const red = (/** @type {string} */ address) => ctx.red(`reach:${address}`);
    // each red leg varies one registration or one address; everything else is the normal leg
    /** @type {Record<string, string>} */
    const rename = {};
    if (red("Lin")) rename["messenger/Haiku"] = "Lin/Haiku/messenger";
    if (red("coding")) rename["coding/Argon"] = "Argon/coding";
    if (red("Grace")) rename["Grace/Haiku/messenger"] = "desk/Haiku";
    if (red("host")) rename["orchestrator/Opus"] = "host/orchestrator";
    /** @type {Record<string, string[]>} */
    const posted = {};
    for (const address of Object.keys(CELLS)) posted[address] = [address];
    /** the positions the readers hold (their `--label`), by the bearer each stands for */
    /** @type {Record<string, string>} */
    const positions = red("main.coding") ? {} : { "coding/Opus": "main.coding" };
    if (red("@member")) posted["@member"] = [...MEMBER_BEARERS];
    if (red("@member/coding")) posted["@member/coding"] = ["coding/Argon"];
    if (red("*")) posted["*"] = ["all"];

    const seat = await openSeat({ seatName: "host" });
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const grace = new Human(client, seat.alias, "Grace");
      /** @type {Array<{ meant: string, agent: Agent }>} */
      const readers = [];
      let n = 0;
      for (const meant of ALL) readers.push({ meant, agent: await Agent.start(seat, { session: `s13-reader-${++n}`, bearer: rename[meant] ?? meant, ...(positions[meant] ? { label: positions[meant] } : {}) }) });
      /** @type {Record<string, string>} */
      const idOf = {};
      for (const address of Object.keys(CELLS)) idOf[address] = (await grace.post(`A note for ${address}.`, { to: posted[address] })).id;
      /** @type {Map<string, Set<string>>} reader (by the bearer it stands for) -> ids its watch was handed */
      const handed = new Map();
      await Promise.all(readers.map(async ({ meant, agent }) => {
        const w = await agent.watchOnce({ fromStart: true, wake: "mine" });
        handed.set(meant, new Set(w.messages.map((m) => m.id)));
      }));
      for (const [address, cell] of Object.entries(CELLS)) {
        // the audience is named by the bearer each reader stands for in the normal leg, so a renamed
        // reader in a red leg is still the same cell of the matrix
        const reached = ALL.filter((meant) => handed.get(meant)?.has(idOf[address]));
        ctx.check(`reach:${address}`, [...cell.audience].sort(), reached.sort(), { note: `posted to: ${posted[address].join(", ")}` });
      }
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
