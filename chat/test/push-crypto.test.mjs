// @ts-check
// Web Push encryption against RFC 8291's own example (section 5 and appendix A), and the VAPID token.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  b64url, unb64url, encryptAes128gcm, decryptAes128gcm, deriveContentKeys, importPrivate, importPublic,
  vapidJwt, verifyVapid, generateVapidKeys, importVapidPrivate,
} from "../push/crypto.mjs";
import { loadOrCreateVapid, createPush, isKnownPushService } from "../push/server.mjs";

/** RFC 8291 appendix A, whitespace removed. */
const V = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("RFC 8291: the intermediate values of appendix A", async () => {
  const { ikm, cek, nonce } = await deriveContentKeys({
    ecdhSecret: unb64url(V.ecdhSecret), authSecret: unb64url(V.authSecret),
    uaPublic: unb64url(V.uaPublic), asPublic: unb64url(V.asPublic), salt: unb64url(V.salt),
  });
  assert.equal(b64url(ikm), V.ikm);
  assert.equal(b64url(cek), V.cek);
  assert.equal(b64url(nonce), V.nonce);
});

test("RFC 8291: the example message encrypts to the example body, byte for byte", async () => {
  const asPublicRaw = unb64url(V.asPublic);
  const privateKey = await importPrivate(unb64url(V.asPrivate), asPublicRaw, "ECDH");
  const body = await encryptAes128gcm({
    plaintext: unb64url(V.plaintext), uaPublic: unb64url(V.uaPublic), authSecret: unb64url(V.authSecret),
    asKeys: { privateKey, publicRaw: asPublicRaw }, salt: unb64url(V.salt),
  });
  assert.equal(body.length, 144);
  assert.equal(b64url(body), V.body);
});

test("RFC 8291: the user agent's side decrypts the example body to the example text", async () => {
  const uaPublicRaw = unb64url(V.uaPublic);
  const privateKey = await importPrivate(unb64url(V.uaPrivate), uaPublicRaw, "ECDH");
  const plain = await decryptAes128gcm({ body: unb64url(V.body), uaKeys: { privateKey, publicRaw: uaPublicRaw }, authSecret: unb64url(V.authSecret) });
  assert.equal(new TextDecoder().decode(plain), "When I grow up, I want to be a watermelon");
});

test("a fresh encryption round-trips, with padding, and a tampered byte fails", async () => {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const text = JSON.stringify({ title: "hello", body: "x".repeat(1000) });
  const body = await encryptAes128gcm({ plaintext: new TextEncoder().encode(text), uaPublic: publicRaw, authSecret, padding: 37 });
  const plain = await decryptAes128gcm({ body, uaKeys: { privateKey: pair.privateKey, publicRaw }, authSecret });
  assert.equal(new TextDecoder().decode(plain), text);
  const bad = body.slice();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(decryptAes128gcm({ body: bad, uaKeys: { privateKey: pair.privateKey, publicRaw }, authSecret }));
  await assert.rejects(encryptAes128gcm({ plaintext: new Uint8Array(4080), uaPublic: publicRaw, authSecret }), RangeError);
});

test("the VAPID token is ES256 over the claims and verifies under the public key", async () => {
  const keys = await generateVapidKeys();
  const privateKey = await importVapidPrivate(keys.privateJwk);
  const now = Date.parse("2026-10-10T12:00:00Z");
  const jwt = await vapidJwt({ privateKey, audience: "https://push.example.net", subject: "mailto:ops@example.org", now });
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  assert.equal(unb64url(parts[2]).length, 64, "a JWS ES256 signature is r || s, 64 octets");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(unb64url(parts[0]))), { typ: "JWT", alg: "ES256" });
  const { claims } = await verifyVapid(`vapid t=${jwt}, k=${keys.publicKey}`, { audience: "https://push.example.net", now });
  assert.equal(claims.sub, "mailto:ops@example.org");
  assert.equal(claims.exp, now / 1000 + 12 * 3600);
  await assert.rejects(verifyVapid(`vapid t=${jwt}, k=${keys.publicKey}`, { audience: "https://other.example.net", now }), /vapid-audience/);
  const other = await generateVapidKeys();
  await assert.rejects(verifyVapid(`vapid t=${jwt}, k=${other.publicKey}`, { audience: "https://push.example.net", now }), /vapid-signature/);
  await assert.rejects(vapidJwt({ privateKey, audience: "https://a.example", subject: "mailto:x@example.org", expiresIn: 25 * 3600 }), RangeError);
  // the public key is the uncompressed point a browser's applicationServerKey takes
  const raw = unb64url(keys.publicKey);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
  await importPublic(raw, "ECDSA");
});

test("the VAPID key file is created once, at 0600, and read thereafter", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "chat-push-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "vapid.json");
  const [a, b] = await Promise.all([loadOrCreateVapid(file), loadOrCreateVapid(file)]);
  assert.equal(a.publicKey, b.publicKey, "two starts together end with one key");
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
  const c = await loadOrCreateVapid(file);
  assert.equal(c.created, false);
  assert.equal(c.publicKey, a.publicKey);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, "utf8");
  assert.equal(JSON.parse(text).kind, "agora-chat-vapid");
  const junk = path.join(dir, "junk.json");
  await writeFile(junk, "{}");
  await assert.rejects(loadOrCreateVapid(junk), /vapid-file-invalid/);
  await assert.rejects(createPush({ vapidFile: file, subject: "ops@example.org" }), TypeError);
});

test("only the browsers' push services are endpoints", () => {
  for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x", "https://web.push.apple.com/QOx"]) assert.ok(isKnownPushService(new URL(ok)), ok);
  for (const no of ["http://fcm.googleapis.com/fcm/send/abc", "https://fcm.googleapis.com:8443/x", "https://127.0.0.1/x",
    "https://evilfcm.googleapis.com.example/x", "https://notify.windows.com.example/x", "https://localhost/push"]) assert.ok(!isKnownPushService(new URL(no)), no);
});
