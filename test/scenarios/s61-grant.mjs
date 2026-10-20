// @ts-check
/**
 * S61 · grant. The orchestrator holds a grant open within caps (`roles: open`, models [haiku],
 * maxLive 1). It wants a second coding position; the seat's supervisor (`ensure`) starts it under
 * the host and posts one N8 line in the Room subject. A second pass posts nothing. The started slot
 * signs as itself (`coding-2/Haiku`), never as the base row. A want for a model outside the grant,
 * a want from a session that only names the holder's position in AGORA_LABEL, and a want past
 * maxLive, are each refused by name and start nothing.
 *
 * Bars: the want within caps is started and holds its position, with exactly one N8 line, in the
 * Room subject; the slot's bearer is its own; each refusal names its cap (or the requester); the
 * record keeps the want, the start and the refusals.
 */

import { openSeat } from "./lib/seat.mjs";
import { Agent, openClient } from "./lib/participants.mjs";
import { HOLDER, grantRig } from "./lib/grant-rig.mjs";

const GRANT = { roles: "open", models: ["haiku"], maxLive: 1, maxHours: 8 };

/** The cap a refusal names: the reason's lead words, or `admitted`. @param {any} r */
const capOf = (r) => (r.ok ? "admitted" : /^past maxLive/.test(r.reason) ? "maxLive" : /^model \S+ is outside/.test(r.reason) ? "models"
  : /^a want is asked by the session that holds a grant/.test(r.reason) ? "requester" : r.reason);

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S61",
  name: "grant",
  checks: {
    "started-within-caps": {
      bar: "a want for main.coding within the caps starts main.coding-2 under the host, and the position is held",
      redLeg: "the grant allows only sonnet, so the want (the row's haiku) is refused and nothing starts",
    },
    "one-n8-in-room-subject": {
      bar: "exactly one N8 line for the start (wanted, path grant, outcome started), in the Room subject, after two ensure passes",
      redLeg: "the started position's harness dies between the passes, so the second pass restarts it and posts a second line",
    },
    "refused-outside-models": {
      bar: "a want for a model the grant does not name is refused by the models cap",
      redLeg: "the grant names sonnet as well, so the models cap does not refuse it",
    },
    "slot-bearer": {
      bar: "the started slot main.coding-2 signs as coding-2/Haiku, a bearer of its own, never the base row's coding/Haiku",
      redLeg: "the manifest's coding row is on-demand, so the want takes main.coding itself, which signs as its role",
    },
    "refused-not-holder": {
      bar: "a want from a session that sets AGORA_LABEL to the holder's position but holds no position of its own is refused by the requester rule, before any cap",
      redLeg: "the want comes from the holder's own registered session, so the requester rule admits it and the maxLive cap refuses it",
    },
    "refused-past-maxlive": {
      bar: "a want past maxLive is refused by the maxLive cap and starts nothing",
      redLeg: "the grant's maxLive is 3, so the want is admitted",
    },
    "record-kept": {
      bar: "the ledger holds want, start, and the three refusals, in order",
      redLeg: "the last want names no reason (--because empty), so its refusal is for that and not for a cap",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const grant = ctx.red("started-within-caps") ? { ...GRANT, models: ["sonnet"] }
        : ctx.red("refused-outside-models") ? { ...GRANT, models: ["haiku", "sonnet"], maxLive: 2 }
        : ctx.red("refused-past-maxlive") ? { ...GRANT, maxLive: 3 }
        : GRANT;
      const rig = await grantRig(seat, client, grant, ctx.red("slot-bearer") ? { "main.coding": { tenure: "on-demand" } } : {});

      const first = await rig.want("main.coding");
      const passOne = first.ok ? await rig.ensure() : [];
      const position = first.ok ? first.want.position : null;
      const held = position ? await rig.running(position) : false;
      ctx.check("started-within-caps", { position: "main.coding-2", started: true, held: true },
        { position, started: passOne.some((r) => r.action === "started"), held }, { note: first.ok ? "" : String(/** @type {any} */ (first).reason) });

      if (ctx.red("one-n8-in-room-subject") && position) await rig.die(position);
      await rig.ensure();
      const lines = (await rig.n8()).filter((n) => n.position === "main.coding-2");
      ctx.check("one-n8-in-room-subject", [{ verdict: "wanted", path: "grant", outcome: "started", inRoomSubject: true }],
        lines.map((n) => ({ verdict: n.verdict, path: n.path, outcome: n.outcome, inRoomSubject: n.inRoomSubject })));

      const sonnet = await rig.want("main.coding", { model: "sonnet" });
      ctx.check("refused-outside-models", "models", capOf(sonnet), { note: sonnet.ok ? "" : String(/** @type {any} */ (sonnet).reason) });

      const slot = position ? rig.hosted(position)[0] : undefined;
      ctx.check("slot-bearer", { position: "main.coding-2", bearer: "coding-2/Haiku" }, { position, bearer: slot?.bearer ?? null });

      // the holder's own session, registered at its position as its extension does; and a probe
      // session that registered no position and only sets the variable a launcher would set
      const holder = await Agent.start(seat, { session: "s61-holder", bearer: "orchestrator/Haiku", harness: "omp", label: HOLDER });
      const probe = await Agent.start(seat, { session: "s61-probe", bearer: "probe/Rig", harness: "omp" });
      const asker = ctx.red("refused-not-holder") ? holder : probe;
      const foreign = await rig.wantFrom(asker.slug, { AGORA_LABEL: HOLDER }, "main.coding");
      ctx.check("refused-not-holder", "requester", capOf(foreign), { note: foreign.ok ? "" : String(/** @type {any} */ (foreign).reason) });

      const third = await rig.want("main.coding", { because: ctx.red("record-kept") ? "" : "a third unit waits" });
      const thirdHeld = third.ok ? await rig.running(third.want.position) : false;
      ctx.check("refused-past-maxlive", { cap: "maxLive", started: false }, { cap: capOf(third), started: thirdHeld }, { bounds: { maxLive: /** @type {any} */ (grant).maxLive } });

      const evs = (await rig.ledger()).map((e) => (e.ev === "refuse" ? `refuse:${capOf({ ok: false, reason: e.reason })}` : e.ev));
      ctx.check("record-kept", ["want", "start", "refuse:models", "refuse:requester", "refuse:maxLive"], evs.slice(0, 5));
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
