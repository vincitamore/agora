// The writing half's fixtures, laid over the reading half's (fixtures.js): the routes the composer,
// the uploads, the message sheet and the search sheet call, answered as CONTRACT.md says, plus a
// room that de-duplicates by operation id, an offline switch, and a stream that delivers what was
// posted. The text scan is a stand-in for the host's: it warns on a password-looking line and
// refuses a private key block. Sample data only: the greenhouse.

import { THREADS, PEOPLE } from "./fixtures.js";

const ME = PEOPLE[0];
let seq = 5000;
const hex = (n) => n.toString(16).padStart(64, "0");

/** What the room holds, by operation id: one message per id, however often it is sent. */
export const ROOM = { byOperation: new Map(), posts: [], offline: false, nextAccept: null, scans: [], uploads: [], annotations: [], reactions: new Map(), lastUpload: null };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (data) => json(200, { ok: true, data });
const fail = (status, code, extra = {}) => json(status, { ok: false, error: { code, ...extra } });

/** The stand-in for the host's scan: a refusal for a key block, a warning for a password line. */
export function devScan(text) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return { refuse: "a private key cannot be posted in the room" };
  if (/\b(password|passwd|pin|secret)\s*[:=]\s*\S+/i.test(text)) return { warn: "this looks like a password; everyone who reads the room would see it, and it stays in the record" };
  return {};
}

const streams = new Set();

function deliver(m) {
  for (const s of streams) {
    if (s.readyState === 2) continue;
    if (s.thread === "main" || s.thread === (m.thread ?? m.id) || s.thread === m.target) s.emit(m.act ? "annotation" : "message", m);
  }
}

export function installComposeFixtures(base) {
  // track the reading half's event sources so a post reaches the open thread
  const Base = window.EventSource;
  window.EventSource = class extends Base {
    constructor(url) {
      super(url);
      this.thread = new URL(url, location.href).searchParams.get("thread");
      streams.add(this);
    }
  };

  const inner = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!url.pathname.startsWith(base + "/")) return inner(input, init);
    const path = url.pathname.slice(base.length);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = () => JSON.parse(init?.body ?? "{}");

    if (["/post", "/scan", "/upload", "/annotate", "/react", "/search"].includes(path) && ROOM.offline) {
      await new Promise((r) => setTimeout(r, 30));
      throw new TypeError("Failed to fetch");
    }
    if (path === "/state") return ok({ room: "r0", me: ME, resident: { name: "the resident", state: "ready" }, capabilities: ["threads-v1", "annotations-v1"], version: "1.0.0", link: { state: "live" } });
    if (path === "/scan" && method === "POST") {
      const { text } = body();
      ROOM.scans.push(text);
      const s = devScan(text);
      if (s.refuse) return fail(422, "TEXT_REFUSED", { reason: s.refuse });
      return ok(s.warn ? { warn: s.warn } : {});
    }
    if (path === "/post" && method === "POST") {
      const b = body();
      ROOM.posts.push(b);
      const s = devScan(b.text);
      if (s.refuse) return fail(422, "TEXT_REFUSED", { reason: s.refuse });
      // a 202 the test asked for: the room took it, but the answer was lost
      const lose = ROOM.nextAccept === "lose";
      if (lose) ROOM.nextAccept = null;
      let m = ROOM.byOperation.get(b.operationId);
      const duplicate = !!m;
      if (!m) {
        seq++;
        let text = b.text;
        if (b.trailers?.length) text += "\n\n" + b.trailers.map(([k, v]) => `${k}: ${v}`).join("\n");
        m = { id: hex(seq), cursor: `e1:${seq}`, ts: new Date().toISOString(), text, author: { name: ME.name, kind: "human", ref: ME.id }, via: "dev-host",
          ...(b.thread ? { thread: b.thread } : {}), ...(b.trailers?.length ? { trailers: b.trailers.map(([key, value]) => ({ key, value })) } : {}),
          ...(b.attachments?.length ? { attachments: b.attachments } : {}) };
        ROOM.byOperation.set(b.operationId, m);
        (THREADS[b.thread ?? m.id] ??= []).push(m);
        setTimeout(() => deliver(m), 40);
      }
      if (lose) return fail(202, "ACCEPTANCE_UNKNOWN", { operationId: b.operationId });
      return ok({ receipt: { id: m.id, cursor: m.cursor, duplicate, operationId: b.operationId, thread: b.thread ?? null }, ...(s.warn ? { warn: s.warn } : {}) });
    }
    if (path === "/upload" && method === "POST") {
      const blob = init.body;
      const name = decodeURIComponent(init.headers["x-file-name"] ?? "file");
      const type = init.headers["content-type"] ?? "application/octet-stream";
      if (init.headers["x-thumb-for"]) return ok({ thumb: { digest: init.headers["x-thumb-for"] } });
      if (blob.size > 25 * 1024 * 1024) return fail(413, "TOO_LARGE");
      if (/\.(exe|bat|cmd|ps1)$/i.test(name)) return fail(422, "UPLOAD_REFUSED", { reason: "that kind of file is not kept here" });
      seq++;
      const attachment = { id: `a-${seq}`, digest: `sha256:${hex(seq)}`, name, kind: type.startsWith("image/") ? "image" : "file", size: blob.size, mimetype: type };
      ROOM.uploads.push(attachment);
      ROOM.lastUpload = blob;
      await new Promise((r) => setTimeout(r, 120));
      return ok({ attachment });
    }
    if (path === "/annotate" && method === "POST") {
      const b = body();
      ROOM.annotations.push(b);
      const list = Object.values(THREADS).flat();
      const target = list.find((m) => m.id === b.target);
      if (!target) return fail(409, "ROOM_REFUSED", { refusal: { code: "annotation-target-unknown" } });
      if (target.author.ref !== ME.id) return fail(409, "ROOM_REFUSED", { refusal: { code: "annotation-not-author" } });
      seq++;
      const a = { id: hex(seq), cursor: `e1:${seq}`, ts: new Date().toISOString(), act: b.act, target: b.target, ...(b.text ? { text: b.text } : {}), author: { name: ME.name, kind: "human", ref: ME.id } };
      if (b.act === "edit") { target.text = b.text; target.edited = { at: a.ts, text: b.text }; }
      if (b.act === "withdraw") target.withdrawn = { at: a.ts };
      setTimeout(() => deliver({ ...a, thread: target.thread ?? target.id }), 30);
      return ok({ receipt: { id: a.id, cursor: a.cursor } });
    }
    if (path === "/react" && method === "POST") {
      const b = body();
      const k = `${b.target}\0${b.name}`;
      const target = Object.values(THREADS).flat().find((m) => m.id === b.target);
      if (!target) return fail(404, "NOT_FOUND");
      const served = (target.reactions ?? []).find((r) => r.name === b.name);
      const names = new Set(ROOM.reactions.get(k) ?? served?.people ?? []);
      if (b.on) names.add(ME.id); else names.delete(ME.id);
      ROOM.reactions.set(k, [...names]);
      // the kit's shape (CONTRACT.md): [{ name, people }], names in the order first chosen, no field when none
      const list = (target.reactions ?? []).map((r) => (r.name === b.name ? { name: r.name, people: [...names] } : r));
      if (!served) list.push({ name: b.name, people: [...names] });
      const kept = list.filter((r) => r.people.length);
      if (kept.length) target.reactions = kept; else delete target.reactions;
      // every open stream on the thread hears it, as the kit's streams do
      const where = target.thread ?? target.id;
      setTimeout(() => { for (const s of streams) if (s.readyState !== 2 && (s.thread === "main" || s.thread === where)) s.emit("reaction", { target: target.id, reactions: kept }); }, 30);
      return ok({ names: [...names], reactions: kept });
    }
    if (path === "/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const scope = url.searchParams.get("scope") ?? "messages";
      const all = Object.values(THREADS).flat();
      const hits = [];
      for (const m of all) {
        if (m.withdrawn) continue;
        if (scope === "files") {
          const names = (m.attachments ?? []).map((a) => a.name.toLowerCase());
          if (q.every((t) => names.some((n) => n.includes(t)))) hits.push({ message: m, snippet: m.text.split("\n")[0] });
          continue;
        }
        const lower = m.text.toLowerCase();
        if (!q.every((t) => lower.includes(t))) continue;
        const line = m.text.split("\n").find((l) => q.some((t) => l.toLowerCase().includes(t))) ?? "";
        const at = Math.max(0, line.toLowerCase().indexOf(q[0]) - 50);
        hits.push({ message: m, snippet: (at > 0 ? "…" : "") + line.slice(at, at + 160) + (line.length > at + 160 ? "…" : "") });
      }
      hits.sort((a, b) => (a.message.ts < b.message.ts ? 1 : -1));
      return ok({ hits, coverage: { through: `e1:${seq}`, at: all.reduce((m, x) => (x.ts > m ? x.ts : m), "") || null } });
    }
    return inner(input, init);
  };

  // one served message already carries reactions: the root of the plan thread
  const planRoot = Object.values(THREADS).find((list) => list[0]?.text.startsWith("Is the north vent"))?.[0];
  if (planRoot) planRoot.reactions = [{ name: "seen", people: ["p-ravi", "p-dana"] }];

  window.__chatDev = {
    ROOM,
    /** A purge made elsewhere (the CLI, another app): the text leaves the record, a purge event goes to the streams. */
    purge(id, reason) {
      const list = Object.values(THREADS).flat();
      const m = list.find((x) => x.id === id);
      if (!m) return false;
      seq++;
      const p = { id: hex(seq), cursor: `e1:${seq}`, ts: new Date().toISOString(), purged: [id], thread: m.thread ?? m.id, reason, by: { name: "dana", ref: "p-dana" } };
      m.text = ""; delete m.trailers; delete m.attachments; m.purged = { at: p.ts, purge: p.id };
      for (const s of streams) if (s.readyState !== 2 && (s.thread === "main" || s.thread === p.thread)) s.emit("purge", p);
      return true;
    },
    setOffline(v) {
      ROOM.offline = v;
      window.dispatchEvent(new Event(v ? "offline" : "online"));
    },
  };
}

/** A picture drawn in the page, as a camera would hand it over: for the attach sheet's fixture. */
export async function samplePhoto(name = "IMG_2244.jpg") {
  const c = document.createElement("canvas");
  c.width = 1600; c.height = 1200;
  const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, 1200);
  sky.addColorStop(0, "#9fb7c9"); sky.addColorStop(1, "#d9e2d0");
  g.fillStyle = sky; g.fillRect(0, 0, 1600, 1200);
  g.fillStyle = "#4f6b3a";
  for (let i = 0; i < 9; i++) g.fillRect(80 + i * 170, 520 + (i % 3) * 30, 120, 600);
  g.strokeStyle = "#e9ece6"; g.lineWidth = 14;
  for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(0, 120 + i * 70); g.lineTo(1600, 60 + i * 70); g.stroke(); }
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
  return new File([blob], name, { type: "image/jpeg" });
}
