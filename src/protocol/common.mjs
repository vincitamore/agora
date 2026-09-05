// @ts-check
/** Pure new-wire syntax only. These helpers do not authenticate any supplied context. */
export const PROTOCOL_LIMITS = Object.freeze({
  frameBytes: 1048576, textBytes: 262144, attachments: 32,
  nameBytes: 255, mimeBytes: 200, labelBytes: 120,
  locatorBytes: 512, pathBytes: 32768, diagnosticCodeBytes: 64,
  collectionEntries: 1024, capabilities: 64, proofBytes: 16384,
});

/** @typedef {'type'|'field'|'range'|'encoding'|'variant'|'context'} ValidationCode */
/** @typedef {{roomId:string, accountId:string, operationId:string}} OperationContext */
/** @typedef {{transport:string, room:string, id:string}} SourceRef */

export class ProtocolValidationError extends Error {
  /** @param {ValidationCode} code @param {string} [field] Schema path, never input data. */
  constructor(code, field = '$') {
    const safeField = /^\$?(?:[A-Za-z][A-Za-z0-9]*|\.[A-Za-z][A-Za-z0-9]*|\[\d{1,4}\])*$/.test(field) && field.length <= 160 ? field : '$';
    super(`protocol ${code} at ${safeField}`);
    this.name = 'ProtocolValidationError';
    this.code = code;
    this.field = safeField;
  }
}

/**
 * Internal validation seam shared by protocol modules, not a wire DTO API.
 * Copy own enumerable data descriptors before reading values. No getters are invoked.
 * @param {unknown} value @param {readonly string[]} required @param {readonly string[]} [optional]
 * @param {string} [field] @returns {Record<string, unknown>}
 */
export function readRecord(value, required, optional = [], field = '$') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError('type', field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new ProtocolValidationError('type', field);
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) throw new ProtocolValidationError('field', field);
  const allowed = new Set([...required, ...optional]);
  /** @type {Record<string, unknown>} */
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new ProtocolValidationError('field', field);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || descriptor.value === undefined) throw new ProtocolValidationError('field', field);
    result[key] = descriptor.value;
  }
  for (const key of required) if (!Object.hasOwn(result, key)) throw new ProtocolValidationError('field', field);
  return result;
}

/**
 * Internal syntax helper. Preserves text exactly, including combining form and whitespace.
 * @param {unknown} value @param {string} field
 * @param {{min?:number,max:number,pattern?:RegExp,controls?:boolean,nul?:boolean}} options
 */
export function readString(value, field, options) {
  if (typeof value !== 'string') throw new ProtocolValidationError('type', field);
  // String.prototype.isWellFormed is newer than the CLI's ES2022 type surface.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ProtocolValidationError('encoding', field);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new ProtocolValidationError('encoding', field);
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < (options.min ?? 0) || bytes > options.max) throw new ProtocolValidationError('range', field);
  if ((options.controls && /[\u0000-\u001f\u007f-\u009f]/u.test(value)) || (options.nul && value.includes('\0'))) throw new ProtocolValidationError('encoding', field);
  if (options.pattern) {
    // `$` alone permits a final line terminator in some regular-expression modes.
    // Require the entire value and never inherit mutable lastIndex from a caller.
    const pattern = new RegExp(options.pattern.source, options.pattern.flags.replace(/[gy]/g, ''));
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0] !== value) throw new ProtocolValidationError('field', field);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {number} [min] @param {number} [max] */
export function readInteger(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw new ProtocolValidationError('type', field);
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) throw new ProtocolValidationError('range', field);
  return value;
}

/** @template {string} T @param {unknown} value @param {string} field @param {readonly T[]} choices @returns {T} */
export function readEnum(value, field, choices) {
  if (typeof value !== 'string') throw new ProtocolValidationError('type', field);
  if (!choices.includes(/** @type {T} */ (value))) throw new ProtocolValidationError('variant', field);
  return /** @type {T} */ (value);
}

/** Internal bounded JSON-array seam. Reject sparse arrays, extra keys and accessors.
 * @template T @param {unknown} value @param {string} field @param {number} maximum
 * @param {(item:unknown)=>T} validate @returns {T[]}
 */
export function readArray(value, field, maximum, validate) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new ProtocolValidationError('type', field);
  if (value.length > maximum) throw new ProtocolValidationError('range', field);
  if (Reflect.ownKeys(value).length !== value.length + 1) throw new ProtocolValidationError('field', field);
  /** @type {T[]} */ const result = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable || d.value === undefined) throw new ProtocolValidationError('field', field);
    result.push(validate(d.value));
  }
  return result;
}

/** @param {unknown} value @param {string} [field] */
export function readTimestamp(value, field = '$') {
  const text = readString(value, field, { min: 24, max: 27 });
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) throw new ProtocolValidationError('encoding', field);
  return text;
}

/** @param {unknown} value */
export function validateNativeId(value) { return readString(value, 'id', { min: 16, max: 128, pattern: /^[A-Za-z0-9_-]{16,128}$/ }); }
/** @param {unknown} value */
export function validateEpoch(value) { return readString(value, 'epoch', { min: 32, max: 32, pattern: /^[a-f0-9]{32}$/ }); }
/** Room-directory identity has a narrower grammar than account/operation IDs. @param {unknown} value */
export function validateRoomId(value) { return readString(value, 'roomId', { min: 32, max: 32, pattern: /^[a-f0-9]{32}$/ }); }
/** @param {unknown} value */
export function validateDigest(value) { return readString(value, 'digest', { min: 71, max: 71, pattern: /^sha256:[a-f0-9]{64}$/ }); }
/** @param {unknown} value */
export function parseCursor(value) {
  const text = readString(value, 'cursor', { min: 34, max: 49, pattern: /^[a-f0-9]{32}:(0|[1-9][0-9]*)$/ });
  const epoch = text.slice(0, 32);
  const sequence = readInteger(Number(text.slice(33)), 'cursor');
  return { epoch, sequence };
}
/** @param {unknown} value */
export function validateCursor(value) { const { epoch, sequence } = parseCursor(value); return `${epoch}:${sequence}`; }
/** @param {unknown} epoch @param {unknown} sequence */
export function formatCursor(epoch, sequence) { return `${validateEpoch(epoch)}:${readInteger(sequence, 'sequence')}`; }
/** @param {unknown} value */
export function validateText(value) { return readString(value, 'text', { max: PROTOCOL_LIMITS.textBytes }); }
/** @param {unknown} value @returns {SourceRef} */
export function validateSourceRef(value) {
  const v = readRecord(value, ['transport', 'room', 'id']);
  return {
    transport: readString(v.transport, 'transport', { min: 1, max: 32, pattern: /^[a-z][a-z0-9-]{0,31}$/ }),
    room: readString(v.room, 'room', { min: 1, max: PROTOCOL_LIMITS.locatorBytes, controls: true }),
    id: readString(v.id, 'id', { min: 1, max: PROTOCOL_LIMITS.locatorBytes, controls: true }),
  };
}
/** Exact tuple equality only, not account or host authentication.
 * @param {unknown} actual @param {unknown} expected @returns {void}
 */
export function assertOperationContext(actual, expected) {
  const keys = ['roomId', 'accountId', 'operationId'];
  const a = readRecord(actual, keys), e = readRecord(expected, keys);
  for (const key of keys) {
    const validate = key === 'roomId' ? validateRoomId : validateNativeId;
    if (validate(a[key]) !== validate(e[key])) throw new ProtocolValidationError('context');
  }
}
