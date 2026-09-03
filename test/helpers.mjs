// @ts-check
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function tmp() {
  const dir = await mkdtemp(path.join(tmpdir(), "agora-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * A fetch stub routed by URL substring, recording every call.
 * @param {Array<[string, (url: URL, init: RequestInit | undefined) => { status?: number, body?: unknown, headers?: Record<string, string> }]>} routes
 */
export function fakeFetch(routes) {
  /** @type {{ url: URL, init: RequestInit | undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const f = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const [needle, handler] of routes) {
      if (url.href.includes(needle)) {
        const r = handler(url, init);
        const status = r.status ?? 200;
        // 204, 205 and 304 carry no body at all; Response refuses to be built with one
        const empty = status === 204 || status === 205 || status === 304;
        return new Response(empty ? null : r.body === undefined ? "" : JSON.stringify(r.body), {
          status,
          headers: { "content-type": "application/json", ...(r.headers ?? {}) },
        });
      }
    }
    return new Response(JSON.stringify({ ok: false, error: "no route", message: "no route" }), { status: 404 });
  };
  return { fetch: f, calls };
}

export const actor = /** @type {import('../src/core.mjs').Actor} */ ({ name: "Claude (house)", kind: "agent" });
