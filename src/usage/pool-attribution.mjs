// @ts-check
// E2a: map a session to a pool by explicit mapping only. A model or display
// name never attributes.
import { readRecord, readString } from '../protocol/common.mjs';

export class PoolAttributionError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PoolAttributionError';
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @returns {{ members: Record<string, string> }}
 */
export function validatePoolMapping(value) {
  const v = readRecord(value, ['members'], []);
  if (typeof v.members !== 'object' || v.members === null || Array.isArray(v.members)) {
    throw new PoolAttributionError('members-type');
  }
  /** @type {Record<string, string>} */
  const members = {};
  for (const [member, poolId] of Object.entries(v.members)) {
    if (member.trim() === '') throw new PoolAttributionError('blank-member');
    const id = readString(poolId, 'poolId', { min: 1, max: 128, controls: true });
    if (id.trim() === '') throw new PoolAttributionError('blank-pool');
    members[member] = id;
  }
  return { members };
}

/**
 * @param {string} member
 * @param {unknown} mappingValue
 * @returns {{ attributed: true, poolId: string } | { attributed: false, reason: 'unknown-mapping' }}
 */
export function attributePool(member, mappingValue) {
  if (typeof member !== 'string' || member.trim() === '') {
    throw new PoolAttributionError('blank-member');
  }
  const mapping = validatePoolMapping(mappingValue);
  const poolId = mapping.members[member];
  if (typeof poolId !== 'string') {
    return { attributed: false, reason: 'unknown-mapping' };
  }
  return { attributed: true, poolId };
}
