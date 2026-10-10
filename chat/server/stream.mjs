// @ts-check
/**
 * Server-sent events: `GET /chat/stream?thread=<root>|main`, history then live with duplicates
 * dropped by cursor, and `state` events (`live`, `dark`, `refused`) and `presence`.
 *
 * Every stream is fanned out from the room's one follow (room.mjs). A stream joins the fan-out
 * before it reads its history, so whatever arrives during the read is held; the read covers
 * everything committed before it; the two overlap, and the overlap is dropped by cursor. The
 * history is read only once the follow has been live, so from then on nothing committed is missed.
 * A stream on `main` hears the whole room; a stream on a thread hears its root, its replies and
 * the annotations on them.
 *
 * Events (each `data:` is one JSON object):
 * - `message`: a message, folded (an edit's text, `edited`, `withdrawn`, `pinned`), `id:` its cursor;
 * - `annotation`: `{ ...annotation, message }`, the annotation and its target as now folded (or
 *   null when the kit has not seen the target), `id:` its cursor;
 * - `purge`: `{ id, cursor, ts, purged, thread?, reason, by }`, the messages a purge took (on a
 *   thread's stream, only that thread's), `id:` its cursor; the browser strikes their text;
 * - `state`: `{ state: 'live' | 'dark' | 'refused', reason?, through? }`; the first after the history
 *   carries `through` and `id:` it, so a reconnecting EventSource resumes from there;
 * - `presence`: the host's presence for the resident, `{ name, state, lastSeen?, running? }`,
 *   on open and whenever it changes.
 *
 * A reconnect sends `Last-Event-ID` (or `?since=<cursor>`): the history is then everything after
 * it, read page by page, instead of the newest window.
 */

import { parseCursor } from "./store.mjs";
import { asFault } from "./room.mjs";

/** A comment line on the stream, so a proxy does not decide it has gone quiet. */
export const KEEP_ALIVE_MS = 25_000;
/** How often the resident's presence is asked while any stream is open. */
export const PRESENCE_MS = 15_000;
/** How many records a stream opens with: the newest ones. */
export const HISTORY_LIMIT = 200;
/** How many pages a resumed stream reads before it gives up and opens on the newest window. */
const RESUME_PAGES = 10;
/** Records held for a stream while its history is read; a stream that falls this far behind reads again. */
const BUFFER_MAX = 2000;
/** What a browser waits before it reconnects a closed stream. */
const RETRY_MS = 5000;

/**
 * @typedef {import("./room.mjs").RoomMessage} RoomMessage
 * @typedef {import("./room.mjs").RoomAnnotation} RoomAnnotation
 * @typedef {import("./room.mjs").RoomPurge} RoomPurge
 * @typedef {{ kind: 'message', seq: number, cursor: string, m: RoomMessage } | { kind: 'annotation', seq: number, cursor: string, a: RoomAnnotation }
 *   | { kind: 'purge', seq: number, cursor: string, p: RoomPurge }} Held
 * @typedef {{
 *   thread: string | null,
 *   since: string | undefined,
 *   send(event: string, data: unknown, id?: string): void,
 *   comment(text: string): void,
 *   close(): void,
 *   phase: 'loading' | 'live' | 'ended',
 *   buffer: Held[],
 *   floor: { epoch: string, seq: number } | null,
 *   seen: Set<string>,
 *   ids: Set<string>,
 *   loading: boolean,
 *   attempt: number,
 *   timer: ReturnType<typeof setTimeout> | null,
 * }} Member
 */

/**
 * A message as a browser gets it: the seat account's id and the room id stay on the server.
 * @template {Record<string, any>} M @param {M} m
 */
export function toBrowser(m) {
  const { room: _room, ...rest } = m;
  if (rest.author && typeof rest.author === "object") {
    const { id: _id, ...author } = rest.author;
    return /** @type {Omit<M, 'room'>} */ ({ ...rest, author });
  }
  return rest;
}

/**
 * @typedef {{
 *   room: import("./room.mjs").Room,
 *   store: import("./store.mjs").KitStore,
 *   hooks: import("./index.mjs").ChatHooks,
 *   log: (line: string) => void,
 *   keepAliveMs?: number,
 *   presenceMs?: number,
 * }} StreamOptions
 */

/** @param {StreamOptions} o */
export function createStreams(o) {
  /** @type {Set<Member>} the streams the room is fanned out to */
  const members = new Set();
  /** @type {Set<Member>} every open stream, including one that hears nothing more (a refused thread) */
  const streams = new Set();
  let closed = false;
  const keepAliveMs = o.keepAliveMs ?? KEEP_ALIVE_MS;
  const presenceMs = o.presenceMs ?? PRESENCE_MS;
  /** @type {string | null} */
  let lastPresence = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let presenceTimer = null;

  /** @param {Member} m @param {string | undefined} thread */
  const inThread = (m, thread) => m.thread === null || thread === m.thread;

  /** The target of an annotation as it now stands, folded, from the index. @param {string} target */
  function foldedTarget(target) {
    const got = o.store.message(target);
    if (!got) return null;
    return toBrowser(o.room.fold([got.message], got.annotations)[0]);
  }

  /** @param {Member} m @param {Held} h */
  function deliver(m, h) {
    if (m.seen.has(h.cursor)) return;
    if (m.floor && parseCursor(h.cursor)?.epoch === m.floor.epoch && h.seq <= m.floor.seq) return;
    m.seen.add(h.cursor);
    if (h.kind === "message") {
      m.ids.add(h.m.id);
      m.send("message", toBrowser(h.m), h.cursor);
    } else if (h.kind === "annotation") {
      m.send("annotation", { ...toBrowser(h.a), message: foldedTarget(h.a.target) }, h.cursor);
    } else {
      const { via: _via, ...p } = h.p;
      m.send("purge", p, h.cursor);
    }
  }

  /** @param {Member} m @param {Held} h */
  function offer(m, h) {
    if (m.phase === "loading") {
      if (m.buffer.length < BUFFER_MAX) m.buffer.push(h);
      else m.buffer.length = BUFFER_MAX + 1; // marks the overflow; the history is read again
    } else if (m.phase === "live") deliver(m, h);
  }

  const unlisten = o.room.listen({
    message(raw) {
      const at = parseCursor(raw.cursor);
      if (!at) return;
      const thread = typeof raw.thread === "string" ? raw.thread : raw.id;
      for (const m of members) if (inThread(m, thread)) offer(m, { kind: "message", seq: at.seq, cursor: raw.cursor, m: raw });
    },
    annotation(raw) {
      const at = parseCursor(raw.cursor);
      if (!at) return;
      const thread = o.store.threadOf(raw.target);
      for (const m of members) {
        if (m.thread !== null && thread !== m.thread && !m.ids.has(raw.target)) continue;
        offer(m, { kind: "annotation", seq: at.seq, cursor: raw.cursor, a: raw });
      }
    },
    purge(raw) {
      // a root's stream hears only its thread's ids, and nothing for a purge that took none of them
      const at = parseCursor(raw.cursor);
      if (!at) return;
      for (const m of members) {
        const purged = m.thread === null ? raw.purged : raw.purged.filter((id) => id === m.thread || m.ids.has(id) || o.store.threadOf(id) === m.thread);
        if (purged.length) offer(m, { kind: "purge", seq: at.seq, cursor: raw.cursor, p: { ...raw, purged } });
      }
    },
    state(s, code) {
      for (const m of [...members]) {
        if (s === "live") {
          if (m.phase === "loading") load(m);
          else if (m.phase === "live") m.send("state", { state: "live" });
        } else {
          m.send("state", { state: s, ...(code ? { reason: code } : {}) });
        }
      }
    },
    reset() {
      // the room is another room now (a new epoch): every stream ends and the browser opens again
      for (const m of [...members]) {
        m.send("state", { state: "refused", reason: "room-reset" });
        leave(m);
        m.close();
      }
    },
  });

  /**
   * The history a stream opens with: the newest window, or everything after its resume cursor.
   * @param {Member} m
   */
  async function history(m) {
    /** @type {{ since?: string, limit: number, thread?: string }} */
    const base = { limit: HISTORY_LIMIT, ...(m.thread ? { thread: m.thread } : {}) };
    const resume = m.since && parseCursor(m.since) ? m.since : undefined;
    if (!resume) return o.room.read(base);
    /** @type {RoomMessage[]} */
    const messages = [];
    /** @type {RoomAnnotation[]} */
    const annotations = [];
    let since = resume;
    for (let page = 0; page < RESUME_PAGES; page++) {
      const got = await o.room.read({ ...base, since });
      messages.push(...got.messages);
      annotations.push(...(got.annotations ?? []));
      const done = got.through === since || (got.committedThrough !== undefined && got.through === got.committedThrough) || (!got.messages.length && !got.annotations?.length);
      since = got.through;
      if (done) return { messages, annotations, through: since };
    }
    // too far behind to replay: open on the newest window
    return o.room.read(base);
  }

  /** @param {Member} m */
  function load(m) {
    if (m.loading || m.phase !== "loading") return;
    m.loading = true;
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    history(m).then(
      (got) => {
        m.loading = false;
        if (m.phase !== "loading") return;
        const folded = o.room.fold(got.messages, got.annotations ?? []);
        const shown = new Set(got.messages.map((x) => x.id));
        /** @type {Held[]} */
        const items = [];
        for (const x of folded) {
          const at = parseCursor(x.cursor);
          if (at) items.push({ kind: "message", seq: at.seq, cursor: x.cursor, m: x });
        }
        // an annotation on a message in this history is already folded into it; one on an older message is sent on its own
        for (const a of got.annotations ?? []) {
          const at = parseCursor(a.cursor);
          if (at && !shown.has(a.target)) items.push({ kind: "annotation", seq: at.seq, cursor: a.cursor, a });
          else if (at) m.seen.add(a.cursor);
        }
        items.sort((x, y) => x.seq - y.seq);
        for (const h of items) deliver(m, h);
        const through = parseCursor(got.through);
        if (through) m.floor = through;
        const held = m.buffer.splice(0);
        if (held.length > BUFFER_MAX) {
          // the buffer overflowed: read the history again from where this one ended, which covers what was dropped
          m.since = got.through;
          load(m);
          return;
        }
        for (const h of held) deliver(m, h);
        m.phase = "live";
        m.attempt = 0;
        const f = o.room.followState();
        m.send("state", f.state === "dark" || f.state === "refused" ? { state: f.state, ...(f.code ? { reason: f.code } : {}), through: got.through } : { state: "live", through: got.through }, got.through);
      },
      (e) => {
        m.loading = false;
        if (m.phase !== "loading") return;
        const f = asFault(e);
        if (f.outcome === "refused") {
          // a definite no (an unknown thread root, say): the stream says why and hears nothing more
          m.send("state", { state: "refused", reason: f.code });
          leave(m);
          return;
        }
        m.send("state", { state: "dark", reason: f.code });
        m.timer = setTimeout(() => { m.timer = null; load(m); }, [500, 1000, 2000, 5000, 15000][Math.min(m.attempt++, 4)]);
      },
    );
  }

  /** @param {Member} m */
  function leave(m) {
    m.phase = "ended";
    m.buffer = [];
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    members.delete(m);
    if (!members.size && presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
      lastPresence = null;
    }
  }

  async function presence() {
    /** @type {Record<string, unknown>} */
    let p;
    try { p = { ...(await o.hooks.presence()) }; }
    catch (e) {
      o.log(`chat: the host's presence threw: ${e instanceof Error ? e.message : String(e)}`);
      p = { state: "dark", reason: "presence-unavailable" };
    }
    return { name: o.hooks.residentName, ...p };
  }

  async function tickPresence() {
    const p = await presence();
    const key = JSON.stringify(p);
    if (key === lastPresence) return;
    lastPresence = key;
    for (const m of members) if (m.phase !== "ended") m.send("presence", p);
  }

  /**
   * The stream for one browser. The caller has checked the person may read the thread.
   * @param {Request} req @param {{ thread: string | null, since?: string }} target
   * @returns {Response}
   */
  function open(req, target) {
    if (closed) return new Response(JSON.stringify({ ok: false, error: { code: "STOPPED", message: "the kit is closing" } }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
    const enc = new TextEncoder();
    /** @type {Member | null} */
    let member = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let keepAlive = null;
    const drop = () => {
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = null;
      if (member) {
        leave(member);
        streams.delete(member);
      }
    };
    const signal = req.signal;
    const body = new ReadableStream({
      start(controller) {
        let open = true;
        /** @param {string} text */
        const write = (text) => {
          if (!open) return;
          try { controller.enqueue(enc.encode(text)); } catch { open = false; }
        };
        /** @type {Member} */
        const m = {
          thread: target.thread,
          since: target.since,
          send(event, data, id) { write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
          comment(text) { write(`: ${text}\n\n`); },
          close() {
            drop();
            if (!open) return;
            open = false;
            try { controller.close(); } catch { /* closed */ }
          },
          phase: "loading",
          buffer: [],
          floor: null,
          seen: new Set(),
          ids: new Set(),
          loading: false,
          attempt: 0,
          timer: null,
        };
        member = m;
        members.add(m);
        streams.add(m);
        // the first bytes flush the response; a quiet stream would otherwise send no headers
        write(`retry: ${RETRY_MS}\n: open\n\n`);
        keepAlive = setInterval(() => m.comment("keep-alive"), keepAliveMs);
        const f = o.room.followState();
        if (f.everLive) load(m);
        else if (f.state === "dark" || f.state === "refused") m.send("state", { state: f.state, ...(f.code ? { reason: f.code } : {}) });
        void presence().then((p) => { if (m.phase !== "ended") m.send("presence", p); });
        if (!presenceTimer) presenceTimer = setInterval(() => { void tickPresence(); }, presenceMs);
        const onAbort = () => m.close();
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      },
      cancel() { drop(); },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      },
    });
  }

  return {
    open,
    /** Whether any stream is open (for the host's diagnostics and the kit's tests). */
    anyOpen: () => streams.size > 0,
    close() {
      if (closed) return;
      closed = true;
      unlisten();
      for (const m of [...streams]) m.close();
      members.clear();
      streams.clear();
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = null;
    },
  };
}
