// @ts-check
/**
 * Uploads from the browser: camera, library, file, paste and drop.
 *
 * An image is decoded and drawn onto a canvas, and the canvas is what is uploaded: the bytes that
 * leave the device carry no metadata (no location, no camera serial, no edit history), a HEIC
 * photo from an iPhone arrives as a JPEG any browser can show, and a picture larger than
 * `IMAGE_MAX_EDGE` is scaled down. The thumbnail is drawn from the same decode at the same time.
 * A GIF (it may move) and an SVG (it is a document, and the kit serves it only as a download) are
 * sent as they are; every other file is sent byte for byte.
 *
 * `POST <base>/upload` takes the raw bytes with `X-File-Name` (the name, percent-encoded UTF-8,
 * because a header is Latin-1), `Content-Type`, and for a re-encoded picture `X-Image-Width` and
 * `X-Image-Height`, and answers `{ attachment, thumb? }`. The
 * thumbnail follows as a second `POST <base>/upload` carrying `X-Thumb-For: <digest>`; its
 * failure costs only the thumbnail.
 */

/** The longest edge an uploaded image keeps. */
export const IMAGE_MAX_EDGE = 2560;
/** The longest edge of the thumbnail made beside it. */
export const THUMB_EDGE = 320;
/** JPEG quality for the re-encoded image and its thumbnail. */
const QUALITY = 0.86;
const THUMB_QUALITY = 0.72;

/**
 * @typedef {{ id: string, digest: string, name: string, kind?: "image" | "file", size?: number, mimetype?: string, width?: number, height?: number, [key: string]: unknown }} Attachment
 */

/** An upload the kit refused or could not make; `code` is the route's error code or a local one. */
export class UploadError extends Error {
  /** @param {string} code @param {string} message @param {string} [reason] */
  constructor(code, message, reason) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.reason = reason;
  }
}

/**
 * The size a picture is drawn at: within `max` on its longest edge, never enlarged, whole pixels.
 * @param {number} width @param {number} height @param {number} max
 * @returns {{ width: number, height: number }}
 */
export function fitWithin(width, height, max) {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Whether a file is re-encoded, and into what. PNG stays PNG (it may be transparent, and a
 * screenshot's text stays sharp); every other still image becomes a JPEG.
 * @param {{ name: string, type: string }} file
 * @returns {{ reencode: false } | { reencode: true, type: "image/jpeg" | "image/png" }}
 */
export function reencodePlan(file) {
  const type = String(file.type || "").toLowerCase();
  const ext = (String(file.name || "").match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (type === "image/gif" || type === "image/svg+xml" || ext === "gif" || ext === "svg") return { reencode: false };
  const image = type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff"].includes(ext);
  if (!image) return { reencode: false };
  if (type === "image/png" || ext === "png") return { reencode: true, type: "image/png" };
  return { reencode: true, type: "image/jpeg" };
}

/**
 * The name a re-encoded file carries: its extension follows its new type (`IMG_2244.HEIC` becomes
 * `IMG_2244.jpg`).
 * @param {string} name @param {string} type
 */
export function encodedName(name, type) {
  const ext = type === "image/png" ? "png" : "jpg";
  const base = String(name || "image").replace(/\.[A-Za-z0-9]{1,5}$/, "") || "image";
  return `${base}.${ext}`;
}

/** `2.1 MB`. @param {number} n */
export function sizeWords(n) {
  if (!(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Decode an image file into something a canvas can draw. `createImageBitmap` first (it honours
 * the EXIF orientation); an `<img>` when it refuses, which is how Safari reads HEIC.
 * @param {Blob} file
 * @returns {Promise<{ source: CanvasImageSource, width: number, height: number, close(): void }>}
 */
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch { /* fall through to an <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new UploadError("UNREADABLE", "this picture could not be read on this device", e instanceof Error ? e.message : String(e));
  }
}

/**
 * @param {CanvasImageSource} source @param {{ width: number, height: number }} size @param {string} type @param {number} quality
 * @returns {Promise<Blob>}
 */
async function draw(source, size, type, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext("2d");
  if (!g) throw new UploadError("UNREADABLE", "this browser cannot draw the picture");
  if (type === "image/jpeg") { g.fillStyle = "#ffffff"; g.fillRect(0, 0, size.width, size.height); }
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, size.width, size.height);
  const blob = await new Promise((res) => canvas.toBlob(res, type, quality));
  if (!blob) throw new UploadError("UNREADABLE", "this browser could not encode the picture");
  return /** @type {Blob} */ (blob);
}

/**
 * What will be uploaded for a file: the re-encoded image and its thumbnail, or the file as it is.
 * @param {File} file
 * @param {{ maxEdge?: number, thumbEdge?: number }} [o]
 * @returns {Promise<{ blob: Blob, name: string, type: string, width?: number, height?: number, thumb?: Blob, reencoded: boolean }>}
 */
export async function prepareFile(file, o = {}) {
  const plan = reencodePlan(file);
  if (!plan.reencode) return { blob: file, name: file.name || "file", type: file.type || "application/octet-stream", reencoded: false };
  const img = await decode(file);
  try {
    const size = fitWithin(img.width, img.height, o.maxEdge ?? IMAGE_MAX_EDGE);
    const blob = await draw(img.source, size, plan.type, QUALITY);
    /** @type {Blob | undefined} */
    let thumb;
    try { thumb = await draw(img.source, fitWithin(img.width, img.height, o.thumbEdge ?? THUMB_EDGE), "image/jpeg", THUMB_QUALITY); } catch { thumb = undefined; }
    return { blob, name: encodedName(file.name, plan.type), type: plan.type, width: size.width, height: size.height, thumb, reencoded: true };
  } finally {
    img.close();
  }
}

/**
 * @param {{ status: number, body: any }} r
 * @returns {never}
 */
function failed(r) {
  const e = r.body?.error;
  const code = typeof e === "string" ? e : e?.code ?? `HTTP ${r.status}`;
  if (r.status === 413 || code === "TOO_LARGE") throw new UploadError("TOO_LARGE", e?.message ?? "the file is larger than this room takes");
  if (r.status === 422 || code === "UPLOAD_REFUSED") throw new UploadError("UPLOAD_REFUSED", e?.message ?? "the file was refused", e?.reason ?? undefined);
  throw new UploadError(code, e?.message ?? `the upload failed (${code})`);
}

/**
 * Upload one file: prepared (re-encoded when it is a picture), sent, then its thumbnail.
 * @param {File} file
 * @param {{ base: string, fetch?: typeof fetch, prepared?: Awaited<ReturnType<typeof prepareFile>> }} options
 * @returns {Promise<{ attachment: Attachment, thumb?: unknown, prepared: Awaited<ReturnType<typeof prepareFile>> }>}
 */
export async function uploadFile(file, options) {
  const base = String(options?.base ?? "/chat").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const prepared = options.prepared ?? await prepareFile(file);
  /** @type {Response} */
  let res;
  try {
    res = await doFetch(`${base}/upload`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json", "content-type": prepared.type || "application/octet-stream", "x-file-name": encodeURIComponent(prepared.name),
        ...(prepared.width && prepared.height ? { "x-image-width": String(prepared.width), "x-image-height": String(prepared.height) } : {}),
      },
      body: prepared.blob,
    });
  } catch (e) {
    throw new UploadError("OFFLINE", "the file could not be sent: the room is not reachable from here");
  }
  /** @type {any} */
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body?.ok) failed({ status: res.status, body });
  const attachment = /** @type {Attachment} */ (body.data?.attachment);
  if (!attachment || typeof attachment.id !== "string") throw new UploadError("BAD_ANSWER", "the upload answered without a file reference");
  let thumb = body.data?.thumb;
  if (prepared.thumb && !thumb && typeof attachment.digest === "string") {
    try {
      const t = await doFetch(`${base}/upload`, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "image/jpeg", "x-file-name": encodeURIComponent(`thumb-${prepared.name}`), "x-thumb-for": attachment.digest },
        body: prepared.thumb,
      });
      const tb = await t.json().catch(() => null);
      if (t.ok && tb?.ok) thumb = tb.data?.thumb ?? true;
    } catch { /* the thumbnail is a convenience; the file is uploaded */ }
  }
  return { attachment, thumb, prepared };
}

/**
 * The files a paste or a drop carries.
 * @param {ClipboardEvent | DragEvent} ev
 * @returns {File[]}
 */
export function filesOf(ev) {
  const dt = "clipboardData" in ev ? ev.clipboardData : /** @type {DragEvent} */ (ev).dataTransfer;
  if (!dt) return [];
  /** @type {File[]} */
  const out = [];
  if (dt.files && dt.files.length) { for (const f of Array.from(dt.files)) out.push(f); return out; }
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}
