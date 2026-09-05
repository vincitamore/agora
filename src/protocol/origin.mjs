// @ts-check
import { ProtocolValidationError, readEnum, readRecord, readString, readTimestamp, validateRoomId } from './common.mjs';
import { validateNativeAccountRef, validateServiceRef } from './identity.mjs';

/** @typedef {ReturnType<typeof validateOriginSource>} OriginSource */
/** @typedef {ReturnType<typeof validateOriginReference>} OriginReference */

/** Source metadata is distinct from destination identity and cannot manufacture host authority.
 * @param {unknown} value */
export function validateOriginSource(value) {
  const candidate = readRecord(value, ['transport', 'room', 'id'], ['host']);
  const transport = readEnum(candidate.transport, 'transport', ['native', 'slack', 'github']);
  const v = readRecord(value, ['transport', 'room', 'id', ...(transport === 'native' ? ['host'] : [])]);
  return { transport,
    ...(transport === 'native' ? { host: validateNativeAccountRef(v.host) } : {}),
    room: transport === 'native' ? validateRoomId(v.room) : readString(v.room, 'room', { min: 1, max: 512, controls: true }),
    id: readString(v.id, 'id', transport === 'native' ? { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ } : { min: 1, max: 512, controls: true }) };
}
/** @param {unknown} value */
export function validateOriginReference(value) {
  const v = readRecord(value, ['source', 'ts', 'author', 'attestor']);
  const a = readRecord(v.author, ['id', 'name', 'kind']);
  return { source: validateOriginSource(v.source), ts: readTimestamp(v.ts),
    author: { id: readString(a.id, 'id', { min: 1, max: 512, controls: true }), name: readString(a.name, 'name', { min: 1, max: 120, controls: true }), kind: readEnum(a.kind, 'kind', ['human', 'agent', 'unknown', 'system']) },
    attestor: validateServiceRef(v.attestor) };
}
/** P5 supplies expected source+attestor from its authenticated reader, never a body trailer.
 * @param {unknown} value @param {unknown} expected */
export function assertOriginContext(value, expected) {
  const v = validateOriginReference(value), e = readRecord(expected, ['source', 'attestor']);
  if (JSON.stringify(v.source) !== JSON.stringify(validateOriginSource(e.source)) || JSON.stringify(v.attestor) !== JSON.stringify(validateServiceRef(e.attestor))) throw new ProtocolValidationError('context');
  return v;
}
