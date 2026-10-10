// Serve chat/ as static files for the dev page: `bun chat/dev/serve.mjs [port]`, then open
// http://127.0.0.1:<port>/dev/index.html. Loopback only; the fixtures answer /chat/* in the page.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] ?? 4791);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const file = path.resolve(ROOT, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT + path.sep)) return new Response("not found", { status: 404 });
    const f = Bun.file(file);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    return new Response(f, { headers: { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" } });
  },
});
console.log(`chat dev page: http://127.0.0.1:${server.port}/dev/index.html`);
