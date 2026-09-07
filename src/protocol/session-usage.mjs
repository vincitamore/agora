// @ts-check
/**
 * Session usage contract (E1a).
 *
 * The records a source adapter produces and a ledger consumes. This module validates SHAPE and
 * refuses what it cannot represent; it establishes no authority. A well-formed record is a
 * well-formed CLAIM about what a harness reported, never evidence that the claim is true, and
 * nothing here infers trust from the syntax of a value.
 *
 * It also prices nothing. Rates, tiers and money belong to a later cut; mixing them in here would
 * make a shape validator into a pricing authority.
 */
import {
  readRecord, readString, readInteger, readEnum, readArray, readTimestamp,
} from './common.mjs';

/** A counter is a tagged union, never a number with sentinel values. */
export const COUNTER_STATES = Object.freeze(/** @type {const} */ ([
  'known', 'unknown', 'invalid', 'not-applicable',
]));

/**
 * What one source record COUNTS. This exists to stop a cumulative total being added as though it
 * were a single request, which is the one arithmetic error that silently doubles a session.
 */
export const SOURCE_UNITS = Object.freeze(/** @type {const} */ ([
  'request', 'aggregate', 'cumulative-snapshot',
]));

/** Disjoint by construction: a component is counted in exactly one of these. */
export const USAGE_COMPONENTS = Object.freeze(/** @type {const} */ ([
  'uncached-input', 'cached-input',
  // Cache writes are split BY TTL rather than pooled. A single `cache-write` bucket makes an
  // unpriced 1h write indistinguishable from a measured 5m zero, which is the collapse this
  // contract exists to refuse; there is deliberately no ambiguous bucket to write to, so an
  // adapter that does not know the TTL must say so.
  'cache-write-5m', 'cache-write-1h', 'cache-write-unknown-ttl',
  'output', 'reasoning-billed', 'tool',
]));

/**
 * How this record's counts relate to another record's.
 *
 * An aggregate already contains its children; summing both double-counts. The relation is stated
 * by the adapter, which is the only party that saw the source structure, and a consumer refuses a
 * blind parent+child sum on it. `unknown` is a real answer and must not be read as `none`.
 */
export const OVERLAP_RELATIONS = Object.freeze(/** @type {const} */ ([
  'none', 'contained-in-parent', 'contains-child', 'unknown',
]));

/** Finality is EVIDENCE the source supplied, never something inferred from arrival order. */
export const FINALITY = Object.freeze(/** @type {const} */ ([
  'final', 'revision', 'streaming-partial', 'unknown',
]));

/** Units a counter may carry. Kept separate from USAGE_COMPONENTS: what is measured vs how. */
export const COUNTER_UNITS = Object.freeze(/** @type {const} */ (['tokens', 'requests']));

/** Coverage of a component set: which components the source actually spoke to. */
export const COVERAGE_STATES = Object.freeze(/** @type {const} */ ([
  'complete', 'partial', 'none',
]));

export const SESSION_USAGE_LIMITS = Object.freeze({
  sourceIdBytes: 512,
  reasonBytes: 200,
  costUnitBytes: 32,
  harnessBytes: 64,
  versionBytes: 64,
  maxCounterValue: Number.MAX_SAFE_INTEGER,
});

/** @param {unknown} value */
function isRecordLike(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A single counter.
 *
 * `known` carries an integer and a unit. The other three carry NEITHER, deliberately: attaching a
 * value to `unknown` or `invalid` invites a consumer to read it, and attaching zero to
 * `not-applicable` is the exact collapse this contract exists to prevent. An explicitly measured
 * zero is `{state:'known', value:0}` and is a different claim from `{state:'unknown'}`.
 *
 * `invalid` means the source said something and it could not be used — a negative token count, a
 * non-finite number. It is retained rather than dropped so a reading can report that a source
 * misbehaved instead of quietly showing less usage than occurred.
 * @param {unknown} value
 */
export function validateCounter(value) {
  const v = readRecord(value, ['state'], ['value', 'unit', 'reason']);
  const state = readEnum(v.state, 'state', COUNTER_STATES);
  if (state !== 'known') {
    // A non-known counter carries no number: there is nothing for a consumer to add up.
    if (Object.hasOwn(v, 'value')) throw new ProtocolUsageError('context', 'value');
    if (Object.hasOwn(v, 'unit')) throw new ProtocolUsageError('context', 'unit');
    return {
      state,
      ...(Object.hasOwn(v, 'reason')
        ? { reason: readString(v.reason, 'reason', { max: SESSION_USAGE_LIMITS.reasonBytes }) }
        : {}),
    };
  }
  return {
    state: /** @type {const} */ ('known'),
    value: readInteger(v.value, 'value', 0, SESSION_USAGE_LIMITS.maxCounterValue),
    unit: readEnum(v.unit, 'unit', COUNTER_UNITS),
  };
}

/**
 * A cost the SOURCE reported, in the source's own unit, stored and never converted.
 *
 * This does not make the contract a pricing authority: it prices nothing, derives nothing, and
 * applies no rate table. It records a figure a provider stated, exactly as `sourceId` records an
 * identifier a provider stated. Dropping such a figure because we decline to type it would
 * collapse "we chose not to carry this" into "no cost information exists" -- the same
 * absent-vs-unknown collapse the rest of this module exists to prevent, one level up, and
 * unrecoverable once the adapter has discarded it. A provider's own figure is also the only
 * independent check on a cost derived from token counts and a rate table.
 *
 * `unit` is OPAQUE and source-supplied (`usd-ticks`, `usd-micros`), never parsed into money and
 * never normalized. It is deliberately NOT drawn from COUNTER_UNITS and lives in its own field,
 * so a cost can never be reached by code walking the token counters, and `isSummableUnit` has
 * nothing to say about it: a cost is never added to a counter, and two costs in different units
 * are not addable to each other either.
 * @param {unknown} value
 */
export function validateSourceReportedCost(value) {
  const v = readRecord(value, ['state'], ['amount', 'unit', 'reason']);
  const state = readEnum(v.state, 'state', COUNTER_STATES);
  if (state !== 'known') {
    // Same rule as a counter: a non-known cost carries no number, so there is nothing to add up
    // and nothing to mistake for a measured zero.
    if (Object.hasOwn(v, 'amount')) throw new ProtocolUsageError('context', 'amount');
    if (Object.hasOwn(v, 'unit')) throw new ProtocolUsageError('context', 'unit');
    return {
      state,
      ...(Object.hasOwn(v, 'reason')
        ? { reason: readString(v.reason, 'reason', { max: SESSION_USAGE_LIMITS.reasonBytes }) }
        : {}),
    };
  }
  return {
    state: /** @type {const} */ ('known'),
    // An integer in the source's own unit. Ticks stay ticks; converting here would invent a rate.
    amount: readInteger(v.amount, 'amount', 0, SESSION_USAGE_LIMITS.maxCounterValue),
    unit: readString(v.unit, 'unit', { min: 1, max: SESSION_USAGE_LIMITS.costUnitBytes, controls: true }),
  };
}

/** Shape errors carry a field path and never the offending value. */
export class ProtocolUsageError extends Error {
  /** @param {string} kind @param {string} field */
  constructor(kind, field) {
    super(`session-usage ${kind} at ${field}`);
    this.name = 'ProtocolUsageError';
    this.kind = kind;
    this.field = field;
  }
}

/**
 * Where a record came from.
 *
 * `sourceId` is OPAQUE: it is the source's own identifier, kept verbatim, checked only for length
 * and control characters. It is never passed through native-id validation and never rewritten to
 * satisfy one, because a foreign identifier that happens to look native is still foreign — and a
 * foreign identifier that does not is not thereby invalid.
 * @param {unknown} value
 */
export function validateSourceIdentity(value) {
  const v = readRecord(
    value,
    ['harness', 'sessionEpoch', 'sourceId', 'sourceUnit', 'finality'],
    ['harnessVersion', 'revision'],
  );
  const sourceId = readString(v.sourceId, 'sourceId', {
    min: 1, max: SESSION_USAGE_LIMITS.sourceIdBytes, controls: true,
  });
  return {
    // P6: all three key components refuse control characters, not just sourceId. A key
    // component that may contain NUL or a newline is a key component that can be forged.
    harness: readString(v.harness, 'harness', { min: 1, max: SESSION_USAGE_LIMITS.harnessBytes, controls: true }),
    sessionEpoch: readString(v.sessionEpoch, 'sessionEpoch', { min: 1, max: 128, controls: true }),
    sourceId,
    sourceUnit: readEnum(v.sourceUnit, 'sourceUnit', SOURCE_UNITS),
    finality: readEnum(v.finality, 'finality', FINALITY),
    ...(Object.hasOwn(v, 'harnessVersion')
      ? { harnessVersion: readString(v.harnessVersion, 'harnessVersion', { min: 1, max: SESSION_USAGE_LIMITS.versionBytes }) }
      : {}),
    // A revision ORDINAL, supplied by the source. Its absence is not "first"; it is unknown.
    ...(Object.hasOwn(v, 'revision') ? { revision: readInteger(v.revision, 'revision', 0) } : {}),
  };
}

/**
 * Identity, with the ordinal a revision needs to be orderable.
 *
 * A record that declares `finality: 'revision'` is claiming to replace something. Without an
 * ordinal there is nothing to order it BY, and a consumer would have to invent precedence from
 * arrival time or output size — exactly the invention this contract refuses. So the ordinal is
 * required precisely when the record claims to be a revision, and optional otherwise.
 * @param {unknown} value
 */
function validateOrderableIdentity(value) {
  const id = validateSourceIdentity(value);
  if (id.finality === 'revision' && !Object.hasOwn(id, 'revision')) {
    throw new ProtocolUsageError('context', 'revision');
  }
  return id;
}

/**
 * The measured components plus what the source actually covered.
 *
 * Coverage is stated rather than derived from which keys happen to be present, because "the source
 * did not mention cache writes" and "the source reported no cache writes" are different facts and
 * only the adapter knows which it saw.
 * @param {unknown} value
 */
export function validateComponentSet(value) {
  const v = readRecord(value, ['components', 'coverage'], ['overlap']);
  if (!isRecordLike(v.components)) throw new ProtocolUsageError('type', 'components');
  const components = /** @type {Record<string, unknown>} */ (v.components);
  for (const key of Object.keys(components)) {
    if (!USAGE_COMPONENTS.includes(/** @type {any} */ (key))) {
      // An unknown component name is refused rather than ignored: silently dropping it would
      // under-report usage while the record still claimed its coverage.
      throw new ProtocolUsageError('field', `components.${key}`);
    }
  }
  /** @type {Record<string, ReturnType<typeof validateCounter>>} */
  const out = {};
  for (const name of USAGE_COMPONENTS) {
    if (Object.hasOwn(components, name)) out[name] = validateCounter(components[name]);
  }
  return {
    components: out,
    coverage: readEnum(v.coverage, 'coverage', COVERAGE_STATES),
    ...(Object.hasOwn(v, 'overlap') ? { overlap: validateOverlap(v.overlap) } : {}),
  };
}

/**
 * An overlap claim. A peer key is REQUIRED whenever the relation names one, because
 * "contained in a parent" without saying which parent cannot be acted on; `unknown` and `none`
 * take no peer.
 * @param {unknown} value
 */
export function validateOverlap(value) {
  const v = readRecord(value, ['relation'], ['peerKey']);
  const relation = readEnum(v.relation, 'relation', OVERLAP_RELATIONS);
  if (relation === 'contained-in-parent' || relation === 'contains-child') {
    return { relation, peerKey: readString(v.peerKey, 'peerKey', { min: 1, max: 1024, controls: true }) };
  }
  if (Object.hasOwn(v, 'peerKey')) throw new ProtocolUsageError('context', 'peerKey');
  return { relation };
}

/**
 * One member of the inventory: measured, or explicitly unsupported with a bounded reason.
 * There is no third state; a member that is neither is a member nobody looked at.
 * @param {unknown} value
 */
export function validateMemberCoverage(value) {
  const v = readRecord(value, ['member', 'state'], ['reason']);
  const state = readEnum(v.state, 'state', /** @type {const} */ (['measured', 'unsupported']));
  if (state === 'unsupported') {
    return {
      member: readString(v.member, 'member', { min: 1, max: 128 }),
      state,
      // An unsupported member must say why, or the inventory cannot be acted on.
      reason: readString(v.reason, 'reason', { max: SESSION_USAGE_LIMITS.reasonBytes }),
    };
  }
  return { member: readString(v.member, 'member', { min: 1, max: 128 }), state };
}

/**
 * One reconciled contribution from one source record.
 * @param {unknown} value
 */
export function validateSessionUsageRecord(value) {
  const v = readRecord(value, ['identity', 'observedAt', 'usage'], ['model', 'sourceReportedCost']);
  return {
    identity: validateOrderableIdentity(v.identity),
    observedAt: readTimestamp(v.observedAt, 'observedAt'),
    usage: validateComponentSet(v.usage),
    // An unknown model binding is REPRESENTED by omission, never invented. A consumer that needs
    // a model must treat its absence as unknown rather than substituting a default.
    ...(Object.hasOwn(v, 'model') ? { model: readString(v.model, 'model', { min: 1, max: 128 }) } : {}),
    // Optional and additive: a source that reports no cost omits the field, which is distinct
    // from a source that reported one we could not use (state 'invalid' with a reason).
    ...(Object.hasOwn(v, 'sourceReportedCost')
      ? { sourceReportedCost: validateSourceReportedCost(v.sourceReportedCost) }
      : {}),
  };
}

/** @param {unknown} value */
export function validateMembershipCoverage(value) {
  const v = readRecord(value, ['members'], []);
  const members = readArray(v.members, 'members', 512, validateMemberCoverage);
  // P3: one member, one state. An inventory carrying `seat-1 measured` and `seat-1 unsupported`
  // hands a consumer both truths and no way to choose, which is worse than either.
  const seen = new Set();
  for (const m of members) {
    if (seen.has(m.member)) throw new ProtocolUsageError('context', 'members');
    seen.add(m.member);
  }
  return { members };
}

/**
 * A local ledger key, in its own namespace.
 *
 * Deliberately prefixed and deliberately NOT native-id grammar, so a ledger key can never be
 * mistaken for, compared against, or stored as a native identifier. The source text is preserved
 * inside it rather than hashed away, because a key that cannot be traced back to its source is a
 * key nobody can reconcile.
 * @param {ReturnType<typeof validateSourceIdentity>} identity
 */
export function ledgerKey(identity) {
  const id = validateSourceIdentity(identity);
  // LENGTH-PREFIXED, not delimiter-joined. The previous form joined on ':' over fields that may
  // themselves contain ':', so harness 'a:b'/epoch 'c' and harness 'a'/epoch 'b:c' produced one
  // key -- and because supersession compares keys, a record from one source could supersede
  // another source's contribution. Escaping would only move the problem to the escape character;
  // a length prefix is injective by construction, whatever the components contain.
  const part = (/** @type {string} */ s) => `${s.length}:${s}`;
  return `src:${part(id.harness)}${part(id.sessionEpoch)}${part(id.sourceId)}`;
}

/**
 * Does `candidate` supersede `accepted`?
 *
 * Only under EVIDENCED ordering: same source identity, and a revision ordinal on both that strictly
 * increases. Everything else is false — including a later arrival, a larger output, or a candidate
 * marked `final` against an accepted `streaming-partial` with no revision evidence. Unknown ordering
 * yields an unresolved contribution for the ledger to hold, which is the honest state; picking
 * max-output or last-arrival would silently choose one of two conflicting truths.
 * @param {unknown} candidate @param {unknown} accepted
 */
export function supersedesContribution(candidate, accepted) {
  const a = validateOrderableIdentity(candidate);
  const b = validateOrderableIdentity(accepted);
  if (ledgerKey(a) !== ledgerKey(b)) return false;
  if (!Object.hasOwn(a, 'revision') || !Object.hasOwn(b, 'revision')) return false;
  return /** @type {number} */ (a.revision) > /** @type {number} */ (b.revision);
}

/**
 * May these two records be ADDED together?
 *
 * Only requests may. An aggregate already contains its children, and a cumulative snapshot is a
 * running total whose difference — not its value — is a contribution. Summing either is the
 * laundering case this contract exists to refuse, and it is refused here rather than left to each
 * consumer to remember.
 * @param {ReturnType<typeof validateSourceIdentity>} identity
 */
export function isSummableUnit(identity) {
  return validateSourceIdentity(identity).sourceUnit === 'request';
}
