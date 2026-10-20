// @ts-check
/**
 * S60 · notice-set. The messenger's notices are a closed set of one-line forms that carry ids, ages
 * and names and never the words of what they point at. Two checks, both on the build's own
 * modules with no seat: the form set equals the set this scenario pins, and a tick over a room whose
 * every message carries a planted phrase raises notices of each clock and none of them carries it.
 */

import { DEFAULT_BOUNDS, NOTICE_TEMPLATES, tick } from "../../src/messenger.mjs";
import { resolveAddress } from "../../src/board-read.mjs";
import { withTrailers } from "../../src/trailers.mjs";

/** The set as this scenario pins it, independently of the unit test's copy. */
const PINNED = {
  N1: "Routed: unaddressed request {id}.",
  N2: "Not taken {age} since {since}: {id}.",
  N3: "{position} has not {verb} {id} after {age}; observe: {verdict}.",
  N4: "Lease on {subject} expired {age} ago without renew or release.",
  N5: "to: {addr} names no holder here ({kind}); nearest: {nearest}.",
  N6: "Open subject {id} unclaimed after {age}.",
  N7: "Reply posted at top level; its subject is {root}.",
  N8: "{position}: {verdict} by {attestor} {age}; path {path}; outcome {outcome}.",
  N9: "No role fits {id}; for {human}.",
};
const PHRASE = "violet-anchor-pumice";

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S60",
  name: "notice-set",
  checks: {
    "form-set-pinned": {
      bar: "the notice forms are exactly the nine pinned ones",
      redLeg: "one form grows a slot for the message's words (a paraphrase planted in N2)",
    },
    "no-words-carried": {
      bar: "0 notices carry the planted phrase, over a room that raises N1, N2, N3, N4, N5, N6 and N7",
      redLeg: "each notice is posted with the first words of the message it points at appended",
    },
  },
  async run(ctx) {
    const forms = ctx.red("form-set-pinned") ? { ...NOTICE_TEMPLATES, N2: "Not taken {age} since {since}: {id} ({text})." } : { ...NOTICE_TEMPLATES };
    ctx.check("form-set-pinned", PINNED, forms);

    const E = "e".repeat(32), T0 = Date.parse("2026-01-01T10:00:00.000Z"), MIN = 60_000, HOST = "acct";
    let n = 0;
    /** @param {{ at: number, human?: boolean, name: string, to?: string[], re?: string, claim?: string, thread?: string }} p */
    const m = (p) => {
      n++;
      const trailers = [...(p.to ?? []).map((v) => ({ key: "to", value: v })), ...(p.re ? [{ key: "re", value: p.re }] : []), ...(p.claim ? [{ key: "claim", value: p.claim }] : [])];
      const body = withTrailers(`${PHRASE} ${n}`, trailers);
      return { id: `${String(n).padStart(4, "0")}`.padEnd(64, "a"), cursor: `${E}:${n}`, ts: new Date(p.at).toISOString(), ...(p.thread ? { thread: p.thread } : {}),
        author: { id: HOST, name: p.name, kind: p.human ? "human" : "agent" }, text: p.human ? body : `${body}\n\n-- ${p.name}`, ...(p.human ? {} : { signedAs: p.name }) };
    };
    const asked = m({ at: T0, human: true, name: "Ada", to: ["coding"] });
    const unaddressed = m({ at: T0, human: true, name: "Ada" });
    const open = m({ at: T0, human: true, name: "Ada", to: ["*"] });
    const typo = m({ at: T0, name: "orchestrator/Opus", to: ["cod"] });
    const topRe = m({ at: T0 + MIN, name: "review/Argon", re: asked.id });
    const take = m({ at: T0, name: "coding/Opus", claim: "parser" });
    const messages = [asked, unaddressed, open, typo, topRe, take];
    const records = [{ slug: "c", state: /** @type {const} */ ("live"), record: /** @type {any} */ ({ bearer: "coding/Opus", label: "desk.coding" }), posted: new Set() },
      { slug: "o", state: /** @type {const} */ ("live"), record: /** @type {any} */ ({ bearer: "orchestrator/Opus", label: "desk.orchestrator" }), posted: new Set() }];
    const rc = { seatName: "host", accountId: HOST, records, messages };
    const { acts } = tick({ now: T0 + 50 * MIN, messages, titles: new Map([[open.id, "Open"]]), pinned: new Set(), accountId: HOST, human: "Ada", bounds: { ...DEFAULT_BOUNDS },
      boardRecords: [{ cursor: `${E}:${n - 1}`, accountId: HOST, operationId: "op", board: { action: "claim", subject: "work:parser" }, expiresAt: new Date(T0 + 5 * MIN).toISOString(), leaseMs: 300_000 }],
      resolve: (a) => resolveAddress(a, rc) });
    const byId = new Map(messages.map((x) => [x.id, x]));
    const posted = acts.map((a) => {
      const cited = byId.get(a.trailers.find((t) => t.key === "re")?.value ?? "");
      return ctx.red("no-words-carried") && cited ? `${a.text} ${cited.text.split("\n")[0]}` : a.text;
    });
    const kinds = [...new Set(acts.map((a) => a.kind))].sort();
    ctx.check("no-words-carried", { carrying: 0, kinds: ["N1", "N2", "N3", "N4", "N5", "N6", "N7"] },
      { carrying: posted.filter((t) => t.includes(PHRASE)).length, kinds });
  },
};
