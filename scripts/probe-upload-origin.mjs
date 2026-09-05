// Acceptance probe: the picture upload must reach slack.com itself and nowhere that merely
// resembles it. Offline; no config, credentials, or live rooms. Exit 1 names an unmet bar.
//
// The upload URL comes from getUploadURLExternal, so this guard is defence in depth for the case
// where that answer cannot be trusted -- and the API base it comes from is itself configurable.
// A host check written as a string suffix admits any name ENDING with the domain; a guard on the
// first URL does not survive a 307 or 308, which preserve method and body. Disclosure here is
// image bytes and never the token: the upload carries content-type only, no authorization header.
import { createHash } from "node:crypto";
import { slackTransport } from "../src/transports/slack.mjs";

const bytes = Buffer.from("\x89PNG\r\n\x1a\n fixture image bytes");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A transport whose fetch records every host it is asked to contact, and the redirect policy. */
function transportSpy() {
  const contacted = [];
  let redirect = "unset";
  const transport = slackTransport({ transport: "slack", channel: "CTEST" }, {
    token: "offline-fixture",
    async fetch(url, init) {
      contacted.push(new URL(String(url)).host);
      if (String(url).includes("/upload")) redirect = init?.redirect ?? "unset";
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    },
  });
  return { transport, contacted, policy: () => redirect };
}

const results = [];

for (const host of ["evilslack.com", "notslack.com"]) {
  const spy = transportSpy();
  await spy.transport.putUpload({ uploadUrl: `https://${host}/upload`, bytes, mimetype: "image/png", digest })
    .then(() => {}, () => {});
  results.push({
    probe: `upload-refuses-lookalike-host`, host,
    pass: spy.contacted.length === 0,
    contacted: spy.contacted,
    note: "a host ending with the domain is not the domain",
  });
}

for (const host of ["slack.com", "files.slack.com"]) {
  const spy = transportSpy();
  let refused = false;
  await spy.transport.putUpload({ uploadUrl: `https://${host}/upload`, bytes, mimetype: "image/png", digest })
    .catch(() => { refused = true; });
  results.push({
    probe: "upload-accepts-the-genuine-origin", host,
    pass: refused === false && spy.contacted.length === 1 && spy.contacted[0] === host,
    contacted: spy.contacted,
    note: "pinned so a stricter guard cannot pass by refusing everything",
  });
}

const spy = transportSpy();
await spy.transport.putUpload({ uploadUrl: "https://files.slack.com/upload", bytes, mimetype: "image/png", digest })
  .then(() => {}, () => {});
results.push({
  probe: "upload-refuses-to-follow-a-redirect-off-the-validated-origin",
  pass: spy.policy() !== "unset",
  redirectPolicy: spy.policy(),
  note: "307 and 308 preserve method and body, so a guard on the first URL does not survive the hop",
});

for (const result of results) console.log(JSON.stringify(result));
process.exitCode = results.every((p) => p.pass) ? 0 : 1;
