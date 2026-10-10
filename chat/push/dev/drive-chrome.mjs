#!/usr/bin/env node
// @ts-check
/**
 * The real-push check: a real Chrome subscribes on the dev host's page and receives a test push
 * through its real push service, end to end.
 *
 *   node chat/push/dev/drive-chrome.mjs --playwright <path to playwright-core> --out <dir> [--headless] [--chrome <exe>] [--bun <exe>]
 *
 * Run it under Node: Playwright's pipe to Chrome hangs under Bun on Windows. The dev host it starts
 * runs under Bun (`--bun`, default `bun` on PATH), since the store is bun:sqlite.
 *
 * playwright-core is not a dependency of the kit: install it in a scratch directory and name it.
 * Chrome runs in a fresh profile under the out directory (never the user's own), with the
 * notification permission granted to the dev origin through the browser context, and Playwright's
 * default --disable-background-networking removed (Chrome's push channel is background networking).
 * It starts the dev host, subscribes, sends one test push, waits for the push service's answer, the
 * service worker's push event and the acknowledgement, screenshots the page (and, on Windows,
 * the corner of the primary screen where the system notification shows), prints one JSON result, and stops everything.
 */

import { spawn, execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);

/** @type {Record<string, string | boolean>} */
const a = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, "");
  if (k === "headless") a.headless = true;
  else a[k] = argv[++i];
}
if (typeof a.playwright !== "string" || typeof a.out !== "string") {
  process.stderr.write("usage: drive-chrome.mjs --playwright <path to playwright-core> --out <dir> [--headless] [--chrome <exe>]\n");
  process.exit(2);
}
const out = path.resolve(a.out);
const mode = a.headless ? "headless" : "headed";
await mkdir(out, { recursive: true });
const profile = path.join(out, `profile-${mode}`);
const store = path.join(out, `store-${mode}`);
await rm(profile, { recursive: true, force: true });
await rm(store, { recursive: true, force: true });

/** @type {Record<string, any>} */
const result = { mode, steps: [] };
/** @param {string} s @param {unknown} [v] */
const step = (s, v) => { result.steps.push(v === undefined ? s : { [s]: v }); process.stderr.write(`${s}${v === undefined ? "" : ` ${JSON.stringify(v)}`}\n`); };

const host = spawn(typeof a.bun === "string" ? a.bun : "bun", [path.join(HERE, "serve.mjs"), "--store", store, "--vapid", path.join(out, "vapid.json"), "--port", "0"], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
/** @type {any} */
let context = null;
try {
  const ready = await new Promise((resolve, reject) => {
    let buf = "";
    host.stdout.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
    });
    host.on("exit", (code) => reject(new Error(`dev host exited ${code}`)));
  });
  const url = /** @type {any} */ (ready).url;
  step("dev host", url);

  const pw = await import(pathToFileURL(path.join(path.resolve(a.playwright), "index.mjs")).href);
  context = await pw.chromium.launchPersistentContext(profile, {
    ...(typeof a.chrome === "string" ? { executablePath: a.chrome } : { channel: "chrome" }),
    headless: Boolean(a.headless),
    ignoreDefaultArgs: ["--disable-background-networking", "--disable-component-update"],
    viewport: { width: 1000, height: 640 },
  });
  await context.grantPermissions(["notifications"], { origin: new URL(url).origin });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => /** @type {any} */ (window).devPush);
  result.permission = await page.evaluate(() => Notification.permission);
  step("permission", result.permission);

  try {
    result.endpointHost = new URL(await page.evaluate(() => /** @type {any} */ (window).devPush.subscribe())).host;
    step("subscribed", result.endpointHost);
  } catch (e) {
    result.subscribeError = String(/** @type {any} */ (e)?.message ?? e).split("\n")[0];
    step("subscribe failed", result.subscribeError);
    throw new Error("no subscription");
  }

  const sent = await page.evaluate(() => /** @type {any} */ (window).devPush.test());
  result.pushService = sent.results.map((/** @type {any} */ r) => ({ status: r.status, pushId: r.pushId }));
  step("push service answered", result.pushService);
  const pushId = sent.results[0]?.pushId;

  const deadline = Date.now() + 30_000;
  let ack = null;
  let seen = null;
  while (Date.now() < deadline && !(ack && seen)) {
    seen = await page.evaluate((/** @type {string} */ id) => /** @type {any} */ (window).devPush.seen.find((/** @type {any} */ s) => s.pushId === id) ?? null, pushId);
    const recs = await page.evaluate(() => fetch("/dev/records").then((r) => r.json()));
    ack = recs.data.find((/** @type {any} */ r) => r.id === pushId)?.ackedAt ?? null;
    if (!(ack && seen)) await new Promise((r) => setTimeout(r, 500));
  }
  result.serviceWorkerReceived = seen;
  result.ackedAt = ack;
  step("service worker push event", seen);
  step("ack recorded", ack);
  if (process.platform === "win32" && !a.headless) {
    // only the corner of the primary screen where a system notification appears, never the whole desktop
    const shot = path.join(out, "desktop-notification.png");
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
      `$w=[Math]::Min(560,$s.Width); $h=[Math]::Min(420,$s.Height); ` +
      `$bmp=New-Object System.Drawing.Bitmap $w,$h; $g=[System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen($s.Right-$w,$s.Bottom-$h,0,0,$bmp.Size); $bmp.Save('${shot.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`;
    await exec("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true }).then(() => { result.desktopShot = shot; }, (e) => { result.desktopShotError = String(e.message).split("\n")[0]; });
  }
  await page.waitForTimeout(1200);
  result.pageShot = path.join(out, `page-${mode}.png`);
  await page.screenshot({ path: result.pageShot });
  result.delivered = Boolean(result.pushService?.[0]?.status === 201 && seen && ack);
} catch (e) {
  result.error = String(/** @type {any} */ (e)?.message ?? e).split("\n")[0];
} finally {
  if (context) await context.close().catch(() => undefined);
  host.kill();
  await new Promise((r) => (host.exitCode !== null ? r(undefined) : host.once("exit", () => r(undefined))));
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
