// @ts-check
/**
 * S60 · notice-set. The messenger's notices are a closed set of one-line forms that carry ids, ages
 * and names and never the words of what they point at. Two checks, both on the build's own
 * modules with no seat: the form set equals the set this scenario pins, and a tick over a room whose
 * every message carries a planted phrase raises notices of each clock (the queue's, the waiting
 * record's and the arming handover's included, whose waiting line names its need in the planted
 * words) and none carries it.
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
  N10: "Queued {task} not started after {age}, with no task held: {id}.",
  N11: "Waiting on {person} for {task} after {age}: {id}.",
  N12: "On arming: {task} waits on {person} after {age}: {id}.",
  N13: "On arming: queued {queued}; active and yours {yours}; active, held by others {others}.",
};
const PHRASE = "violet-anchor-pumice";

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S60",
  name: "notice-set",
  checks: {
    "form-set-pinned": {
      bar: "the notice forms are exactly the thirteen pinned ones",
      redLeg: "one form grows a slot for the message's words (a paraphrase planted in N2)",
    },
    "no-words-carried": {
      bar: "0 notices carry the planted phrase, over a room that raises N1, N2, N3, N4, N5, N6, N7, N10, N11, N12 and N13",
      redLeg: "each notice is posted with the first words of the message it points at appended",
    },
  },
  async run(ctx) {
    const forms = ctx.red("form-set-pinned") ? { ...NOTICE_TEMPLATES, N2: "Not taken {age} since {since}: {id} ({text})." } : { ...NOTICE_TEMPLATES };
    ctx.check("form-set-pinned", PINNED, forms);

    const E = "e".repeat(32), T0 = Date.parse("2026-01-01T10:00:00.000Z"), MIN = 60_000, HOST = "acct";
    let n = 0;
    /** @param {{ at: number, human?: boolean, name: string, to?: string[], re?: string, claim?: string, release?: string, thread?: string, task?: string, body?: string }} p */
    const m = (p) => {
      n++;
      const trailers = [...(p.to ?? []).map((v) => ({ key: "to", value: v })), ...(p.re ? [{ key: "re", value: p.re }] : []), ...(p.claim ? [{ key: "claim", value: p.claim }] : []),
        ...(p.release ? [{ key: "release", value: p.release }] : []), ...(p.task ? [{ key: "task", value: p.task }] : [])];
      const body = withTrailers(p.body ?? `${PHRASE} ${n}`, trailers);
      return { id: `${String(n).padStart(4, "0")}`.padEnd(64, "a"), cursor: `${E}:${n}`, ts: new Date(p.at).toISOString(), ...(p.thread ? { thread: p.thread } : {}),
        author: { id: HOST, name: p.name, kind: p.human ? "human" : "agent" }, text: p.human ? body : `${body}\n\n-- ${p.name}`, ...(p.human ? {} : { signedAs: p.name }) };
    };
    const asked = m({ at: T0, human: true, name: "Ada", to: ["coding"] });
    const unaddressed = m({ at: T0, human: true, name: "Ada" });
    const open = m({ at: T0, human: true, name: "Ada", to: ["*"] });
    const typo = m({ at: T0, name: "orchestrator/Opus", to: ["cod"] });
    // a queued task (its root carries the mark) and a parked one, whose waiting line names its need in the planted words
    const queued = m({ at: T0, name: "orchestrator/Opus", task: "slugify", to: ["Ada"] });
    const parkedRoot = m({ at: T0, human: true, name: "Ada", to: ["orchestrator"] });
    const parkTake = m({ at: T0, name: "orchestrator/Opus", thread: parkedRoot.id, claim: "task:faster", to: ["Ada"] });
    const park = m({ at: T0 + MIN, name: "orchestrator/Opus", thread: parkedRoot.id, release: "task:faster", to: ["Ada"], body: `waiting: Ada; needs: ${PHRASE}` });
    // a reply posted at top level citing a line that stands in a subject (a top-level answer to a lone top-level line draws no pointer)
    const topRe = m({ at: T0 + MIN, name: "review/Argon", re: park.id });
    const take = m({ at: T0, name: "coding/Opus", claim: "parser" });
    const messages = [asked, unaddressed, open, typo, queued, parkedRoot, parkTake, park, topRe, take];
    const records = [{ slug: "c", state: /** @type {const} */ ("live"), record: /** @type {any} */ ({ bearer: "coding/Opus", label: "desk.coding" }), posted: new Set() },
      { slug: "o", state: /** @type {const} */ ("live"), record: /** @type {any} */ ({ bearer: "orchestrator/Opus", label: "desk.orchestrator", startedAt: new Date(T0 + 2 * MIN).toISOString() }), posted: new Set() }];
    const rc = { seatName: "host", accountId: HOST, records, messages };
    // past every default bound (the longest is R2 and Bo, hours), so every clock's form is exercised
    const now = T0 + Math.max(DEFAULT_BOUNDS.R2, DEFAULT_BOUNDS.Bo, DEFAULT_BOUNDS.I) + 10 * MIN;
    const { acts } = tick({ now, messages, titles: new Map([[open.id, "Open"]]), pinned: new Set(), accountId: HOST, human: "Ada", bounds: { ...DEFAULT_BOUNDS },
      boardRecords: [{ cursor: `${E}:${n - 1}`, accountId: HOST, operationId: "op", board: { action: "claim", subject: "work:parser" }, expiresAt: new Date(T0 + 5 * MIN).toISOString(), leaseMs: 300_000 }],
      resolve: (a) => resolveAddress(a, rc), records });
    const byId = new Map(messages.map((x) => [x.id, x]));
    const posted = acts.map((a) => {
      const cited = byId.get(a.trailers.find((t) => t.key === "re")?.value ?? "");
      return ctx.red("no-words-carried") && cited ? `${a.text} ${cited.text.split("\n")[0]}` : a.text;
    });
    const kinds = [...new Set(acts.map((a) => a.kind))].sort();
    ctx.check("no-words-carried", { carrying: 0, kinds: ["N1", "N10", "N11", "N12", "N13", "N2", "N3", "N4", "N5", "N6", "N7"] },
      { carrying: posted.filter((t) => t.includes(PHRASE)).length, kinds });
  },
};
