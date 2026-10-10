// The dev page's server: fixture data shaped exactly as CONTRACT.md's routes answer and its stream
// sends (`message`, `annotation`, `state`, `presence`), installed over `fetch` and `EventSource` so the
// page runs from any static file server with no kit server behind it. Sample data only: a greenhouse.

const ME = { id: "p-mei", name: "mei" };
export const PEOPLE = [ME, { id: "p-ravi", name: "ravi" }, { id: "p-dana", name: "dana" }];
export const NOW = new Date(2026, 9, 9, 14, 16, 0);

const at = (month, day, hh, mm) => new Date(2026, month - 1, day, hh, mm, 0).toISOString();
let seq = 0;
const hex = (n) => n.toString(16).padStart(64, "0");

const human = (name, ref) => ({ id: "seat-acct", name, kind: "human", ref });
const agent = { id: "seat-acct", name: "resident", kind: "agent" };
// a bearer signs as Name/role: one that fits the author column, and one longer than it
const bearer = (name) => ({ id: "seat-acct", name, kind: "agent" });

/** Build a wire message: the text as posted (body, trailer block, signature), with `trailers` read off it. */
function msg(author, ts, body, { trailers = [], thread, sign } = {}) {
  seq++;
  let text = body;
  if (trailers.length) text += "\n\n" + trailers.map(([k, v]) => `${k}: ${v}`).join("\n");
  if (sign) text += `\n\n-- ${sign}`;
  const m = { id: hex(seq), room: "r0", cursor: `e1:${seq}`, ts, text, author };
  if (author.kind === "human") m.via = "dev-host";
  if (thread) m.thread = thread;
  if (trailers.length) m.trailers = trailers.map(([key, value]) => ({ key, value }));
  if (sign) m.signedAs = sign;
  return m;
}

// ---- thread A: a plan waiting on the reader ----
const a0 = msg(human("ravi", "p-ravi"), at(10, 9, 13, 58), "Is the north vent in bay 2 stuck closed? The house is at 31 °C and climbing.",
  { trailers: [["context", "zone=north; bay=bay 2"]] });
const A = a0.id;
const threadA = [
  a0,
  msg(agent, at(10, 9, 13, 59), "Yes. The bay 2 vent motor is getting no open command: the afternoon schedule skips bay 2, so the default *closed* at the bottom of the list takes it.\n\n```evidence\n$ schedule show vents --zone north @ 16 s\nbay-2   closed   (default, no afternoon entry)\n$ motor read vent-n2 --since 1h @ 16 s\nopen commands 0 · position 0 %\n```",
    { thread: A, sign: "resident" }),
  msg(human("mei", "p-mei"), at(10, 9, 14, 11), "Please put it on the afternoon schedule.", { thread: A }),
  msg(agent, at(10, 9, 14, 12), "Before I plan it, the longer view, since the same gap has bitten twice this season. The afternoon schedule was written for the south bays when the north house still had its old roof, which held heat less; the north entries were copied from the morning list and bay 2 was missed because it was out for repair that week. Opening bay 2 at 13:00 matches bays 1 and 3, which have run that way since June with no frost or wind events logged against them. The motor itself reads healthy: it answered a test command at 13:59 in under a second and its last service was in August. If the forecast wind passes 40 km/h the existing wind guard closes every north vent regardless of the schedule, and nothing in this plan changes that guard. The one thing worth watching after it lands is the bay 2 temperature over the next two afternoons, which should fall back in line with bays 1 and 3 within about twenty minutes of the vent opening.",
    { thread: A, sign: "resident" }),
  msg(agent, at(10, 9, 14, 14), "Planned below as P-0412, checked against the live schedule.",
    { thread: A, sign: "resident", trailers: [["card", "plan P-0412"], ["waiting", "p-mei"]] }),
];

// ---- thread B: the ledger with every kind of card ----
const b0 = msg(human("ravi", "p-ravi"), at(10, 6, 8, 44), "Bed 4 drip line losing pressure on rows 9 and 10",
  { trailers: [["context", "bed=bed-4; rows=rows 8, 9, 10"]] });
const B = b0.id;
const threadB = [
  b0,
  msg(human("ravi", "p-ravi"), at(10, 8, 15, 36), "New emitters are in on rows 9 and 10. Move row 8 onto the night schedule so the seedlings stop drying out.", { thread: B }),
  msg(bearer("Tester/kit"), at(10, 8, 15, 38), "Planned as P-0398. Row 8 leaves the day schedule; its valve closes for about a second while it moves.",
    { thread: B, sign: "Tester/kit", trailers: [["card", "plan P-0398"]] }),
  msg(human("ravi", "p-ravi"), at(10, 8, 15, 46), "New service code on the row 8 controller since the swap.",
    { thread: B, trailers: [["card", "receipt R-17"]] }),
  msg(human("mei", "p-mei"), at(10, 9, 11, 1), "Is it holding?", { thread: B }),
  msg(bearer("resident/settlement"), at(10, 9, 11, 2), "**Holding.** No pressure drops on row 8 since the move, none on 9 or 10 since the emitters went in on Oct 7. Watching row 8 until Friday.\n\n```evidence\n$ sensor history bed-4 rows 8-10 @ 3 h 14 m\n  row 8   0 drops since oct 8 15:40\n  rows 9, 10   0 since oct 7 13:42\n```",
    { thread: B, sign: "resident/settlement", trailers: [["card", "view V-0007"], ["card", "watch W-0031"]] }),
];

// ---- threads C and D: waiting on someone else ----
const c0 = msg(human("dana", "p-dana"), at(9, 24, 9, 10), "Seed tray labels for spring");
const C = c0.id;
const threadC = [c0, msg(agent, at(9, 24, 9, 12), "Where do the label printer and the tray scanner plug in?", { thread: C, sign: "resident", trailers: [["waiting", "p-ravi"]] })];
const d0 = msg(human("ravi", "p-ravi"), at(10, 8, 10, 2), "Where is the spare pump at the east house?");
const D = d0.id;
const threadD = [d0, msg(agent, at(10, 8, 10, 5), "Shelf 3, east wall, by the hose reels. Does it prime on its own?", { thread: D, sign: "resident", trailers: [["waiting", "p-dana"]] })];

export const THREADS = { [A]: threadA, [B]: threadB, [C]: threadC, [D]: threadD };
export const ROOTS = { plan: A, ledger: B, labels: C, pump: D };

const summary = (list, extra) => {
  const last = list[list.length - 1];
  const cards = list.flatMap((m) => (m.trailers ?? []).filter((t) => t.key === "card").map((t) => { const [type, id] = t.value.split(" "); return { type, id }; }));
  const waiting = [...new Set(list.flatMap((m) => (m.trailers ?? []).filter((t) => t.key === "waiting").map((t) => t.value)))];
  return { root: list[0], last, lastAt: last.ts, lastBy: last.author.name, unread: false, waiting, cards, ...extra };
};
const LIST = [
  summary(threadA),
  summary(threadB),
  summary(threadC, { unread: true }),
  summary(threadD),
];
const mineIds = new Set([A, B]);

// ---- the host's records the cards load (never carried in the room) ----
export const RECORDS = {
  "plan P-0412": { id: "P-0412", title: "Open the bay 2 vent on the afternoon schedule", status: "awaiting GO · 15 min", awaiting: true, risk: 1, riskWords: "ordinary · rollback ready",
    lines: [["+", "bay-2 open 13:00-17:30 (afternoon)"], [" ", "default closed (unchanged, now below)"]], note: "1 new · 0 existing touched · wind guard unchanged" },
  "plan P-0398": { id: "P-0398", title: "Move row 8 onto the night schedule", status: "✓ held clean", awaiting: false, risk: 1, riskWords: "ordinary · rollback ready",
    lines: [["-", "row-8 schedule day"], ["+", "row-8 schedule night  22:00-04:00"], [" ", "1 valve · reached through controller 2"]],
    foot: ["GO by ravi 15:40 · applied 15:40 · verified 15:41", "hold watch ended oct 9: held clean, 0 drops in 24 h"] },
  "receipt R-17": { id: "R-17", line: "secret saved · row 8 controller service code · by ravi", note: "vault only: never in the room or a log" },
  "view V-0007": { id: "V-0007", what: "chart · pressure drops per day, row 10", status: "static · read 11:02", counts: [3, 5, 2, 7, 4, 9, 6, 11, 8, 4, 13, 0, 0, 0],
    axis: ["sep 26", "oct 7 emitters in", "oct 9"], controls: ["show data", "keep live", "pin to bed 4", "turn into a watch"] },
  "watch W-0031": { id: "W-0031", what: "watch · row 8 pressure drops", status: "running · ends fri 11:02", now: "0 drops · last check 38 s ago", note: "every 60 s · posts each drop here as it happens, and a summary at the end" },
};

// ---- the transport ----
const params = new URLSearchParams(location.search);
const STATE = params.get("state") ?? "live";
const ok = (data) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });

export function installFixtures(base) {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!url.pathname.startsWith(base + "/")) return realFetch(input, init);
    const path = url.pathname.slice(base.length);
    await new Promise((r) => setTimeout(r, 20));
    if (path === "/state") return ok({ room: "r0", me: ME, resident: { state: "ready", lastSeen: at(10, 9, 11, 3) }, capabilities: ["threads-v1", "annotations-v1"], version: "1.0.0" });
    if (path === "/threads") {
      const scope = url.searchParams.get("scope");
      return ok({ threads: LIST.filter((t) => scope !== "mine" || mineIds.has(t.root.id)) });
    }
    const t = path.match(/^\/thread\/([^/]+)$/);
    if (t) {
      const list = THREADS[decodeURIComponent(t[1])];
      if (!list) return new Response(JSON.stringify({ ok: false, error: { code: "THREAD_UNKNOWN" } }), { status: 404 });
      return ok({ messages: list, through: list[list.length - 1].cursor });
    }
    if (path === "/position") return ok({});
    if (path === "/post") return ok({ receipt: { id: hex(999), cursor: "e1:999" } });
    return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }), { status: 404 });
  };

  class FixtureEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onerror = null;
      const thread = new URL(url, location.href).searchParams.get("thread");
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        if (this.onopen) this.onopen(new Event("open"));
        this.emit("state", STATE === "dark" ? { state: "dark" } : { state: "live" });
        this.emit("presence", { state: "ready", lastSeen: at(10, 9, 11, 3) });
        // history then live: the open thread's messages are sent again, and the kit drops them by id
        for (const m of THREADS[thread] ?? []) this.emit("message", m);
      }, 60);
    }
    emit(type, data) {
      const ev = new MessageEvent(type, { data: JSON.stringify(data) });
      this.dispatchEvent(ev);
    }
    close() { this.readyState = 2; }
  }
  window.EventSource = FixtureEventSource;
}
