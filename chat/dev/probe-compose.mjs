// The composer in a real browser, on the dev page: the outbox, the scan's guard, a lost answer, a
// mention, an upload stripped of its metadata, edit and withdraw. Prints one line per check and
// exits 1 on any failure.
//
//   bun chat/dev/serve.mjs 4797        (in another shell)
//   PLAYWRIGHT_CORE=<dir of playwright-core> CHROME=<chrome executable> node chat/dev/probe-compose.mjs [http://127.0.0.1:4797]
//
// Drive it with node, not bun: playwright under bun on Windows hangs. playwright-core is not a
// dependency of this repository; install it in a scratch directory and name it.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pwDir = process.env.PLAYWRIGHT_CORE;
if (!pwDir) { console.error("PLAYWRIGHT_CORE names the playwright-core directory"); process.exit(2); }
const { chromium } = require(path.resolve(pwDir));
const origin = process.argv[2] ?? "http://127.0.0.1:4797";

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
let failed = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`); };

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/dev/compose.html?theme=dim`, { waitUntil: "load" });
  await page.waitForSelector("html[data-scene-ready]");
  const input = page.locator(".chat-cmp-input");
  const send = page.locator(".chat-cmp-send");
  const rowsWith = (/** @type {string} */ t) => page.locator(".chat-msg .chat-msg-text", { hasText: t }).count();

  // 1. an offline post is queued, and delivered once on reconnect
  const words = "Bay 2 reads 27 °C now, after the vent opened.";
  await page.evaluate(() => window.__chatDev.setOffline(true));
  await input.fill(words);
  await send.click();
  await page.waitForSelector('.chat-cmp-ob[data-state="queued"]');
  const before = await page.evaluate((w) => window.__chatDev.ROOM.posts.filter((p) => p.text === w).length, words);
  check("offline: the post is held in the outbox, nothing reached the room", before === 0 && (await input.inputValue()) === "");
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("agora-chat:outbox:")).map((k) => JSON.parse(localStorage.getItem(k)).length));
  check("offline: the outbox is kept in localStorage", stored[0] === 1, JSON.stringify(stored));
  await page.evaluate(() => window.__chatDev.setOffline(false));
  await page.waitForFunction(() => !document.querySelector(".chat-cmp-ob"), null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const room = await page.evaluate((w) => ({ held: [...window.__chatDev.ROOM.byOperation.values()].filter((m) => m.text.startsWith(w)).length, ids: [...new Set(window.__chatDev.ROOM.posts.filter((p) => p.text === w).map((p) => p.operationId))].length }), words);
  check("reconnect: the room holds the post once, under one operation id", room.held === 1 && room.ids === 1, JSON.stringify(room));
  check("reconnect: the ledger shows it once", (await rowsWith(words)) === 1);

  // 2. the scan's warning comes before send, with "send anyway"
  const pw = "The row 8 login is password: tomato-42";
  await input.fill(pw);
  await send.click();
  await page.waitForSelector('.chat-cmp-notice[data-kind="warn"]');
  const postedWarn = await page.evaluate((w) => window.__chatDev.ROOM.posts.filter((p) => p.text === w).length, pw);
  check("warn: the warning is shown and nothing is posted", postedWarn === 0 && (await send.textContent()) === "send anyway");
  await input.fill(pw + " ");
  check("warn: changing the words takes the warning away", (await send.textContent()) === "send" && !(await page.isVisible('.chat-cmp-notice[data-kind="warn"]')));
  await input.fill(pw);
  await send.click();
  await page.waitForSelector('.chat-cmp-notice[data-kind="warn"]');
  await send.click();
  await page.waitForFunction((w) => window.__chatDev.ROOM.posts.some((p) => p.text === w), pw);
  check("warn: send anyway posts it", true);

  // 3. a refusal is never sendable
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
  await input.fill(key);
  await send.click();
  await page.waitForSelector('.chat-cmp-notice[data-kind="refuse"]');
  check("refuse: the refusal is shown and the button never says send anyway", (await send.textContent()) === "send");
  await send.click();
  await page.waitForTimeout(300);
  const postedKey = await page.evaluate(() => window.__chatDev.ROOM.posts.filter((p) => p.text.includes("PRIVATE KEY")).length);
  check("refuse: a second press posts nothing", postedKey === 0);
  await input.fill("");

  // 4. a lost answer (202) is resent under the same operation id
  const lost = "The answer to this one is lost once.";
  await page.evaluate(() => { window.__chatDev.ROOM.nextAccept = "lose"; });
  await input.fill(lost);
  await send.click();
  await page.waitForFunction((w) => window.__chatDev.ROOM.posts.filter((p) => p.text === w).length >= 2, lost, { timeout: 15000 });
  await page.waitForTimeout(300);
  const lostRoom = await page.evaluate((w) => ({ held: [...window.__chatDev.ROOM.byOperation.values()].filter((m) => m.text.startsWith(w)).length, ids: [...new Set(window.__chatDev.ROOM.posts.filter((p) => p.text === w).map((p) => p.operationId))].length }), lost);
  check("202: resent under the same id, held once", lostRoom.held === 1 && lostRoom.ids === 1, JSON.stringify(lostRoom));

  // 5. a mention completes from the people list
  await input.fill("");
  await input.type("ask @ra");
  await page.waitForSelector(".chat-cmp-mentions:not([hidden])");
  await input.press("Enter");
  check("mention: Enter completes @ra to @ravi", (await input.inputValue()) === "ask @ravi ");
  await input.fill("");

  // 6. an upload leaves the device without its metadata
  const upload = await page.evaluate(async () => {
    const photo = await window.__chatDev.samplePhoto("IMG_0001.JPG");
    const b = new Uint8Array(await photo.arrayBuffer());
    const note = new TextEncoder().encode("Exif\0\0GPS-LOCATION-MARKER");
    const seg = new Uint8Array(4 + note.length);
    seg.set([0xff, 0xe1, (note.length + 2) >> 8, (note.length + 2) & 255]); seg.set(note, 4);
    const withExif = new Uint8Array(b.length + seg.length);
    withExif.set(b.subarray(0, 2)); withExif.set(seg, 2); withExif.set(b.subarray(2), 2 + seg.length);
    window.__chatDev.composer.addFiles([new File([withExif], "IMG_0001.JPG", { type: "image/jpeg" })]);
    const t0 = Date.now();
    while (!document.querySelector('.chat-cmp-file[data-state="ready"]') && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    const sent = new Uint8Array(await window.__chatDev.ROOM.lastUpload.arrayBuffer());
    const text = new TextDecoder("latin1").decode(sent);
    return { hadMarker: new TextDecoder("latin1").decode(withExif).includes("GPS-LOCATION-MARKER"), marker: text.includes("GPS-LOCATION-MARKER"), exif: text.includes("Exif"), name: window.__chatDev.ROOM.uploads.at(-1)?.name };
  });
  check("upload: the picture is re-encoded, its metadata gone", upload.hadMarker && !upload.marker && !upload.exif, JSON.stringify(upload));
  await send.click();
  await page.waitForFunction(() => window.__chatDev.ROOM.posts.some((p) => p.attachments?.length), null, { timeout: 8000 });
  check("upload: the post carries the attachment", true);

  // 7. edit and withdraw the reader's own message
  const own = await page.evaluate(() => window.__chatDev.mine()?.id);
  await page.evaluate((id) => window.__chatDev.composer.edit(id), own);
  await input.fill("Please put bay 2 on the afternoon schedule.");
  await send.click();
  await page.waitForFunction(() => window.__chatDev.ROOM.annotations.some((a) => a.act === "edit"));
  const edit = await page.evaluate(() => window.__chatDev.ROOM.annotations.find((a) => a.act === "edit"));
  check("edit: an edit annotation with the new words", edit.text.startsWith("Please put bay 2"), JSON.stringify(edit));
  await page.waitForSelector(".chat-msg .chat-mark >> text=/edited/");
  check("edit: the ledger marks the message edited", true);
  await page.evaluate((id) => window.__chatDev.composer.actions(id), own);
  const wd = page.locator(".chat-cmp-actions .chat-cmp-option", { hasText: "withdraw" });
  await wd.click();
  check("withdraw: asks once before it acts", (await wd.textContent()).includes("stays in the record") && !(await page.evaluate(() => window.__chatDev.ROOM.annotations.some((a) => a.act === "withdraw"))));
  await wd.click();
  await page.waitForSelector(".chat-msg.is-withdrawn");
  check("withdraw: the ledger shows it withdrawn", true);

  // 8. reactions a served message carries are shown as names; someone else's message offers no edit
  const root = await page.evaluate(() => Object.values(window.__chatDev.THREADS).find((l) => l[0]?.reactions)?.[0]?.id);
  const servedLine = await page.locator(`.chat-msg[data-id="${root}"] .chat-reacts`).textContent();
  check("reactions: a served message's reactions are names", servedLine === "seen · ravi, dana", servedLine ?? "");
  await page.evaluate((id) => window.__chatDev.composer.actions(id), root);
  await page.waitForSelector(".chat-cmp-actions:not([hidden])");
  const opts = await page.locator(".chat-cmp-actions .chat-cmp-option").allTextContents();
  check("actions: another person's message offers reactions only", opts.length === 0, JSON.stringify(opts));
  await page.locator(".chat-cmp-actions .chat-cmp-close").click();

  // 9. a purge made elsewhere takes the words off the page while the thread is open
  const target = await page.evaluate(() => { const l = Object.values(window.__chatDev.THREADS).find((x) => x[0]?.reactions); return l[1].id; });
  const words9 = await page.locator(`.chat-msg[data-id="${target}"] .chat-msg-text`).textContent();
  await page.evaluate((id) => window.__chatDev.purge(id, "asked to remove the reading"), target);
  await page.waitForSelector(`.chat-msg[data-id="${target}"].is-purged`);
  const after9 = await page.locator(`.chat-msg[data-id="${target}"]`).textContent();
  check("purge: the purged words leave the page and the row says why", !!words9 && !after9.includes(words9.slice(0, 20)) && after9.includes("purged") && after9.includes("asked to remove the reading"), after9);

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  failed++;
  console.log(`FAIL probe stopped: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
