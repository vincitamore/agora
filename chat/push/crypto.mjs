// @ts-check
/**
 * The cryptography of Web Push, on WebCrypto alone (Bun, Node 22+ and a browser all carry it):
 *
 * - base64url, the encoding every Web Push key and token travels in;
 * - VAPID (RFC 8292): a P-256 key pair, and the ES256 JWT a push service checks on every request;
 * - RFC 8291 message encryption: an ephemeral ECDH share with the subscription's key, HKDF, and one
 *   `aes128gcm` record (RFC 8188) holding the payload.
 *
 * Decryption is here too. A browser never needs it from us; a test's fake push endpoint does, and so
 * does anyone checking that what we send is what a user agent would read.
 */

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

/** One `aes128gcm` record's size: header field `rs`. One record holds any payload we send. */
export const RECORD_SIZE = 4096;
/** The largest plaintext one 4096-octet record holds: rs, less the 16-octet tag and the delimiter. */
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1;

/** @param {Uint8Array} bytes @returns {string} */
export function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} text @returns {Uint8Array<ArrayBuffer>} */
export function unb64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_\-+/]*=*$/.test(text)) throw new TypeError("not base64url");
  const std = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {...Uint8Array} parts @returns {Uint8Array<ArrayBuffer>} */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** @param {ArrayBuffer} buf */
const u8 = (buf) => new Uint8Array(buf);

/**
 * A P-256 point in its uncompressed 65-octet form, as a JWK's x and y.
 * @param {Uint8Array} raw
 */
function pointXY(raw) {
  if (raw.length !== 65 || raw[0] !== 4) throw new TypeError("a P-256 public key is 65 octets, uncompressed (0x04 first)");
  return { x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) };
}

/** @param {Uint8Array} raw @param {'ECDH' | 'ECDSA'} name */
export function importPublic(raw, name) {
  return subtle.importKey("raw", /** @type {Uint8Array<ArrayBuffer>} */ (raw), { name, namedCurve: "P-256" }, true,
    name === "ECDSA" ? ["verify"] : []);
}

/**
 * A private key from its scalar and public point (the form RFC 8291's example gives).
 * @param {Uint8Array} d 32 octets @param {Uint8Array} publicRaw 65 octets @param {'ECDH' | 'ECDSA'} name
 */
export function importPrivate(d, publicRaw, name) {
  const jwk = { kty: "EC", crv: "P-256", d: b64url(d), ...pointXY(publicRaw), ext: true };
  return subtle.importKey("jwk", jwk, { name, namedCurve: "P-256" }, true, name === "ECDSA" ? ["sign"] : ["deriveBits"]);
}

/** @param {CryptoKey} key @returns {Promise<Uint8Array<ArrayBuffer>>} */
export async function exportPublicRaw(key) {
  return u8(await subtle.exportKey("raw", key));
}

/**
 * HKDF-SHA-256, extract then expand in one call.
 * @param {Uint8Array} salt @param {Uint8Array} ikm @param {Uint8Array} info @param {number} length
 */
async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey("raw", /** @type {Uint8Array<ArrayBuffer>} */ (ikm), "HKDF", false, ["deriveBits"]);
  return u8(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: /** @type {Uint8Array<ArrayBuffer>} */ (salt), info: /** @type {Uint8Array<ArrayBuffer>} */ (info) }, key, length * 8));
}

/**
 * The content key and nonce both sides derive (RFC 8291 section 3.4 and RFC 8188 section 2.2).
 * @param {{ ecdhSecret: Uint8Array, authSecret: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array }} input
 */
export async function deriveContentKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  return { ikm, cek, nonce };
}

/** @param {CryptoKey} privateKey @param {CryptoKey} publicKey */
async function ecdh(privateKey, publicKey) {
  return u8(await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
}

/**
 * Encrypt a push message for one subscription (RFC 8291): one `aes128gcm` record, the header carrying
 * the salt, the record size and our ephemeral public key. `asKeys` and `salt` are for the RFC's test
 * vector only; a real send leaves both out and gets fresh ones.
 * @param {{
 *   plaintext: Uint8Array,
 *   uaPublic: Uint8Array,
 *   authSecret: Uint8Array,
 *   asKeys?: { privateKey: CryptoKey, publicRaw: Uint8Array },
 *   salt?: Uint8Array,
 *   padding?: number,
 * }} input
 * @returns {Promise<Uint8Array<ArrayBuffer>>} the request body
 */
export async function encryptAes128gcm({ plaintext, uaPublic, authSecret, asKeys, salt, padding = 0 }) {
  if (authSecret.length !== 16) throw new TypeError("the subscription's auth secret is 16 octets");
  if (plaintext.length + padding > MAX_PLAINTEXT) throw new RangeError(`a push payload holds at most ${MAX_PLAINTEXT} octets`);
  let keys = asKeys;
  if (!keys) {
    const pair = /** @type {CryptoKeyPair} */ (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
    keys = { privateKey: pair.privateKey, publicRaw: await exportPublicRaw(pair.publicKey) };
  }
  const s = salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  if (s.length !== 16) throw new TypeError("the salt is 16 octets");
  const ecdhSecret = await ecdh(keys.privateKey, await importPublic(uaPublic, "ECDH"));
  const { cek, nonce } = await deriveContentKeys({ ecdhSecret, authSecret, uaPublic, asPublic: keys.publicRaw, salt: s });
  // the last (and only) record: the plaintext, the 0x02 delimiter, then any zero padding
  const record = concat(plaintext, Uint8Array.of(2), new Uint8Array(padding));
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = u8(await subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, record));
  const header = new Uint8Array(21 + keys.publicRaw.length);
  header.set(s, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = keys.publicRaw.length;
  header.set(keys.publicRaw, 21);
  return concat(header, sealed);
}

/**
 * Decrypt an `aes128gcm` push body as the user agent would (one record).
 * @param {{ body: Uint8Array, uaKeys: { privateKey: CryptoKey, publicRaw: Uint8Array }, authSecret: Uint8Array }} input
 * @returns {Promise<Uint8Array<ArrayBuffer>>} the plaintext, delimiter and padding removed
 */
export async function decryptAes128gcm({ body, uaKeys, authSecret }) {
  if (body.length < 21) throw new RangeError("shorter than an aes128gcm header");
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdhSecret = await ecdh(uaKeys.privateKey, await importPublic(asPublic, "ECDH"));
  const { cek, nonce } = await deriveContentKeys({ ecdhSecret, authSecret, uaPublic: uaKeys.publicRaw, asPublic, salt });
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = u8(await subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, /** @type {Uint8Array<ArrayBuffer>} */ (body.slice(21 + idlen))));
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (end < 0 || record[end] !== 2) throw new Error("no last-record delimiter");
  return record.slice(0, end);
}

/**
 * A fresh VAPID key pair, as the JSON the key file holds.
 * @returns {Promise<{ publicKey: string, privateJwk: JsonWebKey }>}
 */
export async function generateVapidKeys() {
  const pair = /** @type {CryptoKeyPair} */ (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]));
  return { publicKey: b64url(await exportPublicRaw(pair.publicKey)), privateJwk: await subtle.exportKey("jwk", pair.privateKey) };
}

/** @param {JsonWebKey} jwk */
export function importVapidPrivate(jwk) {
  return subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/**
 * The VAPID JWT for one push service origin (RFC 8292): ES256, `aud` the origin, `exp` at most a day
 * out, `sub` the contact the push service may use.
 * @param {{ privateKey: CryptoKey, audience: string, subject: string, expiresIn?: number, now?: number }} input
 */
export async function vapidJwt({ privateKey, audience, subject, expiresIn = 12 * 3600, now = Date.now() }) {
  if (expiresIn > 24 * 3600) throw new RangeError("a VAPID token expires within 24 hours");
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + expiresIn, sub: subject })));
  const input = `${header}.${claims}`;
  // WebCrypto's ECDSA signature is r || s, 64 octets: exactly JWS's ES256 form, no DER to undo
  const sig = u8(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(input)));
  return `${input}.${b64url(sig)}`;
}

/**
 * Check a VAPID `Authorization` header as a push service does: the JWT's signature under `k`, and its
 * claims. Returns the claims, or throws naming what failed.
 * @param {string | null} authorization @param {{ audience: string, now?: number }} expect
 */
export async function verifyVapid(authorization, { audience, now = Date.now() }) {
  const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!m) throw new Error("vapid-header-malformed");
  const [header, claims, sig] = m[1].split(".");
  if (!header || !claims || !sig) throw new Error("vapid-jwt-malformed");
  if (JSON.parse(new TextDecoder().decode(unb64url(header))).alg !== "ES256") throw new Error("vapid-alg");
  const key = await importPublic(unb64url(m[2]), "ECDSA");
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64url(sig), enc.encode(`${header}.${claims}`));
  if (!ok) throw new Error("vapid-signature");
  const c = JSON.parse(new TextDecoder().decode(unb64url(claims)));
  if (c.aud !== audience) throw new Error("vapid-audience");
  if (typeof c.exp !== "number" || c.exp * 1000 <= now || c.exp * 1000 > now + 24 * 3600 * 1000 + 60_000) throw new Error("vapid-expiry");
  if (typeof c.sub !== "string" || !/^(mailto:|https:)/.test(c.sub)) throw new Error("vapid-subject");
  return { claims: c, publicKey: m[2] };
}
