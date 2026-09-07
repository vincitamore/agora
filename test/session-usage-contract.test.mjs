// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTER_STATES, COUNTER_UNITS, SOURCE_UNITS, USAGE_COMPONENTS, FINALITY, OVERLAP_RELATIONS, validateOverlap,
  validateCounter, validateSourceIdentity, validateComponentSet, validateMemberCoverage,
  validateSessionUsageRecord, validateMembershipCoverage, ledgerKey, validateSourceReportedCost,
  supersedesContribution, isSummableUnit,
} from '../src/protocol/session-usage.mjs';

// Synthetic throughout: no harness, no provider, no transcript.
const ID = Object.freeze({
  harness: 'codex', sessionEpoch: 'sess-synthetic-1', sourceId: 'resp_synthetic-0001',
  sourceUnit: 'request', finality: 'final',
});
const refuses = (/** @type {() => unknown} */ fn) => {
  try { fn(); return false; } catch { return true; }
};

test('the vocabulary is closed and the four counter states are distinct', () => {
  assert.deepEqual([...COUNTER_STATES], ['known', 'unknown', 'invalid', 'not-applicable']);
  assert.deepEqual([...SOURCE_UNITS], ['request', 'aggregate', 'cumulative-snapshot']);
  assert.equal(new Set(USAGE_COMPONENTS).size, USAGE_COMPONENTS.length);
  assert.equal(new Set(FINALITY).size, FINALITY.length);
});

// --- The counter matrix: absent / null / zero / bounds / type / range -----------------------

test('counter matrix: each cell is accepted or refused for its own reason', () => {
  // Accepted.
  assert.deepEqual(validateCounter({ state: 'known', value: 0, unit: 'tokens' }),
    { state: 'known', value: 0, unit: 'tokens' });
  assert.deepEqual(validateCounter({ state: 'unknown' }), { state: 'unknown' });
  assert.deepEqual(validateCounter({ state: 'not-applicable' }), { state: 'not-applicable' });
  assert.deepEqual(validateCounter({ state: 'invalid', reason: 'source sent a negative' }),
    { state: 'invalid', reason: 'source sent a negative' });

  // Refused, each for a distinct reason.
  assert.ok(refuses(() => validateCounter(undefined)), 'absent counter');
  assert.ok(refuses(() => validateCounter(null)), 'null counter');
  assert.ok(refuses(() => validateCounter({})), 'no state');
  assert.ok(refuses(() => validateCounter({ state: 'nope' })), 'unknown state name');
  assert.ok(refuses(() => validateCounter({ state: 'known', value: 5 })), 'known without unit');
  assert.ok(refuses(() => validateCounter({ state: 'known', value: -1, unit: 'tokens' })), 'negative');
  assert.ok(refuses(() => validateCounter({ state: 'known', value: 1.5, unit: 'tokens' })), 'fractional');
  assert.ok(refuses(() => validateCounter({ state: 'known', value: '5', unit: 'tokens' })), 'string value');
  assert.ok(refuses(() => validateCounter({ state: 'known', value: NaN, unit: 'tokens' })), 'NaN');
  assert.ok(refuses(() => validateCounter({ state: 'known', value: 0, unit: 'dollars' })), 'unknown unit');
});

test('a measured ZERO and an UNKNOWN are different claims and cannot converge', () => {
  const zero = validateCounter({ state: 'known', value: 0, unit: 'tokens' });
  const unknown = validateCounter({ state: 'unknown' });
  assert.notDeepEqual(zero, unknown);
  assert.equal(zero.value, 0);
  // The unknown carries NO value at all -- there is nothing a consumer could add up.
  assert.equal(Object.hasOwn(unknown, 'value'), false);
});

test('unknown, invalid and not-applicable are three different states, not one', () => {
  const u = validateCounter({ state: 'unknown' });
  const i = validateCounter({ state: 'invalid', reason: 'unusable' });
  const n = validateCounter({ state: 'not-applicable' });
  assert.equal(new Set([u.state, i.state, n.state]).size, 3);
  // None of them carries a number, so none can be silently summed as zero.
  for (const c of [u, i, n]) assert.equal(Object.hasOwn(c, 'value'), false);
});

test('a non-known counter may not smuggle a value or a unit', () => {
  assert.ok(refuses(() => validateCounter({ state: 'unknown', value: 5, unit: 'tokens' })));
  assert.ok(refuses(() => validateCounter({ state: 'not-applicable', value: 0, unit: 'tokens' })));
  assert.ok(refuses(() => validateCounter({ state: 'invalid', value: -3, unit: 'tokens' })));
});

// --- Identity: opaque, never rewritten ------------------------------------------------------

test('an opaque source id is kept VERBATIM and never coerced into native id grammar', () => {
  // Deliberately unlike a native id: short, punctuated, mixed case, a slash.
  for (const raw of ['resp_ABC-123/xyz', 'a', '01J8Z.4/mixed+Case', 'x'.repeat(512)]) {
    const out = validateSourceIdentity({ ...ID, sourceId: raw });
    assert.equal(out.sourceId, raw, 'source text must survive unchanged');
  }
});

test('an unusable source id is refused rather than rewritten to fit', () => {
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, sourceId: '' })), 'empty');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, sourceId: 'x'.repeat(513) })), 'oversize');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, sourceId: 12345 })), 'non-string');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, sourceId: 'a' + String.fromCharCode(0) + 'b' })), 'control char');
});

test('every key component refuses control characters, not just the source id', () => {
  // Each refusal beside the ordinary value of the same field: the cell must show the
  // CHARACTER is what is refused, not that the field is merely fussy.
  assert.ok(validateSourceIdentity({ ...ID, harness: 'codex-cli' }), 'ordinary harness');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, harness: 'a' + String.fromCharCode(0) + 'b' })), 'harness NUL');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, harness: 'a' + String.fromCharCode(10) + 'b' })), 'harness newline');

  assert.ok(validateSourceIdentity({ ...ID, sessionEpoch: '2026-09-07T00:00:00Z' }), 'ordinary epoch');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, sessionEpoch: 'a' + String.fromCharCode(0) + 'b' })), 'epoch NUL');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, sessionEpoch: 'a' + String.fromCharCode(10) + 'b' })), 'epoch newline');
});

test('a ledger key is its own namespace and cannot be mistaken for a native id', () => {
  const key = ledgerKey(ID);
  assert.ok(key.startsWith('src:'), 'namespaced');
  // Native ids are 16..128 of [A-Za-z0-9_-]; a ledger key contains colons, so it can never match.
  assert.ok(/[:]/.test(key), 'contains a separator native id grammar forbids');
  assert.ok(key.includes(ID.sourceId), 'source text is traceable, not hashed away');
});

test('the ledger key is INJECTIVE: no two distinct identities share a key', () => {
  // The delimiter is not forbidden inside the components, so a plain join collides:
  // harness 'a:b' + epoch 'c' and harness 'a' + epoch 'b:c' are different sources.
  const left = { ...ID, harness: 'a:b', sessionEpoch: 'c', sourceId: 'd' };
  const right = { ...ID, harness: 'a', sessionEpoch: 'b:c', sourceId: 'd' };
  assert.notEqual(ledgerKey(left), ledgerKey(right), 'shifting the boundary changes the key');

  // The twin: the SAME identity must still key the same, or injectivity was bought with noise.
  assert.equal(ledgerKey(left), ledgerKey({ ...left }), 'same identity, same key');

  // The same shift one field over.
  assert.notEqual(
    ledgerKey({ ...ID, harness: 'h', sessionEpoch: 'e:1', sourceId: 'x' }),
    ledgerKey({ ...ID, harness: 'h', sessionEpoch: 'e', sourceId: '1:x' }),
    'epoch/sourceId boundary');
});

test('a record NEVER supersedes a contribution from a different source', () => {
  // This is what the collision cost: supersession compares keys, so two sources sharing a
  // key let one source overwrite the other's measured contribution.
  const a2 = { ...ID, harness: 'a:b', sessionEpoch: 'c', sourceId: 'd', finality: /** @type {const} */ ('revision'), revision: 2 };
  const b1 = { ...ID, harness: 'a', sessionEpoch: 'b:c', sourceId: 'd', finality: /** @type {const} */ ('revision'), revision: 1 };
  assert.equal(supersedesContribution(a2, b1), false, 'across sources, whatever the revisions');

  // Twin: within ONE source the ordering still works, so the fix did not disable supersession.
  const a1 = { ...a2, revision: 1 };
  assert.equal(supersedesContribution(a2, a1), true, 'same source, increasing revision');
});

test('missing revision is UNKNOWN order, not first', () => {
  const out = validateSourceIdentity(ID);
  assert.equal(Object.hasOwn(out, 'revision'), false);
});

// --- The laundering guard -------------------------------------------------------------------

test('a source unit cannot launder cumulative state into a request', () => {
  assert.equal(isSummableUnit({ ...ID, sourceUnit: 'request' }), true);
  assert.equal(isSummableUnit({ ...ID, sourceUnit: 'aggregate' }), false);
  assert.equal(isSummableUnit({ ...ID, sourceUnit: 'cumulative-snapshot' }), false);
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, sourceUnit: 'turn' })), 'invented unit');
});

// --- Supersession only under evidenced ordering ---------------------------------------------

test('supersession requires evidenced ordering and refuses every substitute for it', () => {
  const r1 = { ...ID, revision: 1 };
  const r2 = { ...ID, revision: 2 };
  assert.equal(supersedesContribution(r2, r1), true, 'strictly increasing revision');
  assert.equal(supersedesContribution(r1, r2), false, 'not backwards');
  assert.equal(supersedesContribution(r1, r1), false, 'equal is not superseding');
  assert.equal(supersedesContribution(ID, ID), false, 'no revision on either side');
  assert.equal(supersedesContribution(r2, ID), false, 'one side unevidenced');
  // Finality is not a tiebreak: a `final` with no revision does not beat a partial.
  assert.equal(
    supersedesContribution({ ...ID, finality: 'final' }, { ...ID, finality: 'streaming-partial' }),
    false, 'finality alone is not ordering evidence');
  // Different source identity never supersedes, however the revisions compare.
  assert.equal(supersedesContribution(r2, { ...r1, sourceId: 'other-id' }), false);
});

// --- Component sets and coverage --------------------------------------------------------------

test('a component set states its coverage and refuses component names it does not define', () => {
  const ok = validateComponentSet({
    components: {
      'uncached-input': { state: 'known', value: 100, unit: 'tokens' },
      'cached-input': { state: 'unknown' },
      'cache-write-5m': { state: 'not-applicable' },
    },
    coverage: 'partial',
  });
  assert.equal(ok.coverage, 'partial');
  assert.equal(ok.components['uncached-input'].value, 100);
  assert.equal(ok.components['cached-input'].state, 'unknown');
  assert.ok(refuses(() => validateComponentSet({ components: { invented: { state: 'unknown' } }, coverage: 'none' })));
  assert.ok(refuses(() => validateComponentSet({ components: {}, coverage: 'most' })), 'invented coverage');
  assert.ok(refuses(() => validateComponentSet({ components: {} })), 'coverage is required, not derived');
});

// --- Source-reported cost ------------------------------------------------------------------

test('a source-reported cost is stored in the source unit and never converted', () => {
  const c = validateSourceReportedCost({ state: 'known', amount: 1234, unit: 'usd-ticks' });
  assert.equal(c.amount, 1234, 'the number is carried through untouched');
  assert.equal(c.unit, 'usd-ticks', 'ticks stay ticks; converting here would invent a rate');

  // The unit is OPAQUE, so a unit this module has never heard of is ordinary, not invalid.
  assert.equal(validateSourceReportedCost({ state: 'known', amount: 0, unit: 'jpy-micros' }).unit,
    'jpy-micros', 'an unfamiliar source unit is accepted verbatim');
  // A measured zero cost is a real answer and keeps its unit.
  assert.equal(validateSourceReportedCost({ state: 'known', amount: 0, unit: 'usd-ticks' }).amount, 0);
});

test('a cost unit is not a counter unit, in either direction', () => {
  // The two vocabularies are separate on purpose: a cost must never be reachable by code
  // walking the token counters, and a counter must never acquire a money-ish unit.
  // The literal is refused by tsc as well, which is the point; the cast keeps the RUNTIME
  // refusal exercised for consumers that are not typechecked.
  const costUnit = /** @type {any} */ ('usd-ticks');
  assert.ok(refuses(() => validateCounter({ state: 'known', value: 5, unit: costUnit })),
    'a counter cannot be denominated in a cost unit');
  // The twin: the counter's own units still work, so the separation cost nothing.
  assert.equal(validateCounter({ state: 'known', value: 5, unit: 'tokens' }).unit, 'tokens');
  assert.ok(!(/** @type {readonly string[]} */ (COUNTER_UNITS)).includes('usd-ticks'),
    'cost units are not in the counter vocabulary');
});

test('a non-known cost carries no number, exactly as a counter does not', () => {
  assert.equal(validateSourceReportedCost({ state: 'unknown' }).state, 'unknown');
  const bad = validateSourceReportedCost({ state: 'invalid', reason: 'provider returned a null total' });
  assert.ok(bad.state === 'invalid', 'the state survives');
  assert.equal(bad.reason, 'provider returned a null total', 'and the reason is carried');
  assert.ok(refuses(() => validateSourceReportedCost({ state: 'unknown', amount: 0, unit: 'usd-ticks' })),
    'an unknown cost with a zero amount would read as a measured zero');
  assert.ok(refuses(() => validateSourceReportedCost({ state: 'unknown', unit: 'usd-ticks' })),
    'and carries no unit either');
  // The twin: the SAME amount under state known is ordinary.
  assert.equal(validateSourceReportedCost({ state: 'known', amount: 0, unit: 'usd-ticks' }).state, 'known');
});

test('an unusable cost is refused rather than coerced', () => {
  const ok = { state: 'known', amount: 10, unit: 'usd-ticks' };
  assert.ok(validateSourceReportedCost(ok), 'the ordinary case, beside each refusal');
  assert.ok(refuses(() => validateSourceReportedCost({ ...ok, amount: -1 })), 'negative');
  assert.ok(refuses(() => validateSourceReportedCost({ ...ok, amount: 1.5 })), 'non-integer');
  assert.ok(refuses(() => validateSourceReportedCost({ ...ok, amount: '10' })), 'string amount');
  assert.ok(refuses(() => validateSourceReportedCost({ ...ok, unit: '' })), 'empty unit');
  assert.ok(refuses(() => validateSourceReportedCost({ ...ok, unit: 'u'.repeat(33) })), 'oversize unit');
  assert.ok(refuses(() => validateSourceReportedCost({ ...ok, unit: 'a' + String.fromCharCode(0) + 'b' })),
    'control char in unit');
  assert.ok(refuses(() => validateSourceReportedCost({ state: 'known', amount: 10 })), 'known needs a unit');
});

test('cost on a record is optional and additive: OMITTED is not the same as unusable', () => {
  const base = {
    identity: ID,
    observedAt: '2026-09-07T10:00:00.000Z',
    usage: { components: { output: { state: 'known', value: 42, unit: 'tokens' } }, coverage: 'partial' },
  };
  const without = validateSessionUsageRecord(base);
  assert.ok(!Object.hasOwn(without, 'sourceReportedCost'), 'a source that reported none omits it');

  const with_ = validateSessionUsageRecord({
    ...base, sourceReportedCost: { state: 'known', amount: 42, unit: 'usd-ticks' },
  });
  const kept = with_.sourceReportedCost;
  assert.ok(kept && kept.state === 'known', 'the field survived validation');
  assert.equal(kept.amount, 42, 'and one that did keeps it');

  // The distinction the field exists for: reported-but-unusable is a THIRD state, not absence.
  const bad = validateSessionUsageRecord({
    ...base, sourceReportedCost: { state: 'invalid', reason: 'ticks field was null' },
  });
  const unusable = bad.sourceReportedCost;
  assert.ok(unusable, 'a reported-but-unusable cost is present, not dropped to absent');
  assert.equal(unusable.state, 'invalid');
  assert.ok(!Object.hasOwn(unusable, 'amount'), 'and still carries no number');

  // A malformed cost fails the whole record rather than being silently dropped back to absent.
  assert.ok(refuses(() => validateSessionUsageRecord({ ...base, sourceReportedCost: { state: 'known' } })));
});

// --- The blank-identity class ------------------------------------------------------------------

test('a string that is blank once trimmed is refused wherever it must SAY something', () => {
  // A minimum length counts characters and a space is a character, so min:1 admitted " ":
  // present, well-formed, and naming nothing. Each refusal sits beside the ordinary value of
  // the SAME field, so the cell shows the blank is what is refused.
  const BLANK = ' ';
  const usage = { components: { output: { state: 'known', value: 1, unit: 'tokens' } }, coverage: 'partial' };
  const at = '2026-09-07T10:00:00.000Z';

  // Key components. Worst of the class: a blank here is a real, addressable identity for no source.
  assert.ok(validateSourceIdentity({ ...ID, harness: 'codex-cli' }), 'ordinary harness');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, harness: BLANK })), 'blank harness');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, sessionEpoch: BLANK })), 'blank epoch');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, sourceId: BLANK })), 'blank sourceId');
  assert.ok(validateSourceIdentity({ ...ID, harnessVersion: '1.2.3' }), 'ordinary version');
  assert.ok(refuses(() => validateSourceIdentity({ ...ID, harnessVersion: BLANK })), 'blank version');

  // Opaque unit: a bucket whose name is nothing.
  assert.ok(validateSourceReportedCost({ state: 'known', amount: 1, unit: 'usd-ticks' }), 'ordinary unit');
  assert.ok(refuses(() => validateSourceReportedCost({ state: 'known', amount: 1, unit: BLANK })), 'blank unit');

  // A reason that says nothing satisfies "unsupported WITH a reason" vacuously, which is the
  // exact rule the reason exists to enforce.
  assert.ok(validateMemberCoverage({ member: 'seat-a', state: 'unsupported', reason: 'no counters' }));
  assert.ok(refuses(() => validateMemberCoverage({ member: 'seat-a', state: 'unsupported', reason: BLANK })),
    'blank reason');
  assert.ok(refuses(() => validateMemberCoverage({ member: BLANK, state: 'measured' })), 'blank member');
  assert.ok(refuses(() => validateCounter({ state: 'invalid', reason: BLANK })), 'blank counter reason');

  assert.ok(validateOverlap({ relation: 'contained-in-parent', peerKey: 'src:1:h1:e1:x' }), 'ordinary peer');
  assert.ok(refuses(() => validateOverlap({ relation: 'contained-in-parent', peerKey: BLANK })), 'blank peerKey');

  assert.ok(validateSessionUsageRecord({ identity: ID, observedAt: at, usage, model: 'm-1' }), 'ordinary model');
  assert.ok(refuses(() => validateSessionUsageRecord({ identity: ID, observedAt: at, usage, model: BLANK })),
    'blank model');

  // Tabs and newlines are blank too, and a value that merely CONTAINS a space is not blank.
  assert.ok(refuses(() => validateSourceReportedCost({ state: 'known', amount: 1, unit: '	' })), 'tab-only');
  assert.equal(validateSourceReportedCost({ state: 'known', amount: 1, unit: 'usd ticks' }).unit, 'usd ticks',
    'an inner space is content, not blankness');
});

test('a refused blank is not a licence to trim what is accepted', () => {
  // The value is stored VERBATIM. Trimming an opaque foreign identifier would silently rewrite
  // it, which is the same class of harm as refusing it for the wrong reason.
  assert.equal(validateSourceIdentity({ ...ID, sourceId: ' resp-1 ' }).sourceId, ' resp-1 ',
    'surrounding space is preserved: the id belongs to the source, not to us');
  assert.equal(validateSourceReportedCost({ state: 'known', amount: 1, unit: ' usd-ticks' }).unit,
    ' usd-ticks', 'and the same for an opaque unit');
});

// --- Membership coverage ----------------------------------------------------------------------

test('every member is measured or explicitly unsupported WITH a reason', () => {
  const cov = validateMembershipCoverage({
    members: [
      { member: 'seat-a', state: 'measured' },
      { member: 'seat-b', state: 'unsupported', reason: 'harness exposes no usage counters' },
    ],
  });
  assert.equal(cov.members.length, 2);
  assert.ok(refuses(() => validateMemberCoverage({ member: 'seat-c', state: 'unsupported' })),
    'unsupported without a reason is not actionable');
  assert.ok(refuses(() => validateMemberCoverage({ member: 'seat-c', state: 'skipped' })),
    'there is no third state');
});

test('one member, one state: a duplicated member name is refused', () => {
  // An inventory asserting both 'measured' and 'unsupported' for one member hands the
  // consumer two truths and no way to choose.
  assert.ok(refuses(() => validateMembershipCoverage({
    members: [
      { member: 'seat-a', state: 'measured' },
      { member: 'seat-a', state: 'unsupported', reason: 'harness exposes no usage counters' },
    ],
  })), 'same name twice');

  // Twin: two DIFFERENT members with the same state are ordinary and stay accepted.
  assert.equal(validateMembershipCoverage({
    members: [
      { member: 'seat-a', state: 'measured' },
      { member: 'seat-b', state: 'measured' },
    ],
  }).members.length, 2, 'distinct members are not duplicates');
});

// --- The whole record, and its ordinary adjacent pair ------------------------------------------

test('a complete record validates, and an unknown model binding is absent rather than invented', () => {
  const withModel = validateSessionUsageRecord({
    identity: ID, observedAt: '2026-09-07T09:45:00.000Z', model: 'synthetic-model-1',
    usage: { components: { output: { state: 'known', value: 42, unit: 'tokens' } }, coverage: 'partial' },
  });
  assert.equal(withModel.model, 'synthetic-model-1');
  const withoutModel = validateSessionUsageRecord({
    identity: ID, observedAt: '2026-09-07T09:45:00.000Z',
    usage: { components: { output: { state: 'known', value: 42, unit: 'tokens' } }, coverage: 'partial' },
  });
  assert.equal(Object.hasOwn(withoutModel, 'model'), false, 'absent, not defaulted to a placeholder');
  assert.ok(refuses(() => validateSessionUsageRecord({
    identity: ID, observedAt: 'yesterday',
    usage: { components: {}, coverage: 'none' },
  })), 'an unparseable timestamp is refused');
});

// --- Requirements raised by the E1c consumer before the freeze -------------------------------
// Three fields the ledger said it could not encode. Taken in full rather than worked around,
// because a consumer that has to code around a seam encodes the seam's defect downstream.

test('E1c-1: cache writes are split by TTL and there is no ambiguous bucket to pool them in', () => {
  // The discriminating pair: an unpriced 1h write and a measured 5m zero must not converge.
  const unknown1h = validateComponentSet({
    components: { 'cache-write-1h': { state: 'unknown' } }, coverage: 'partial' });
  const zero5m = validateComponentSet({
    components: { 'cache-write-5m': { state: 'known', value: 0, unit: 'tokens' } }, coverage: 'partial' });
  assert.equal(unknown1h.components['cache-write-1h'].state, 'unknown');
  assert.equal(zero5m.components['cache-write-5m'].value, 0);
  assert.notDeepEqual(unknown1h.components, zero5m.components);
  // An adapter that does not know the TTL says so explicitly.
  assert.ok(validateComponentSet({
    components: { 'cache-write-unknown-ttl': { state: 'known', value: 7, unit: 'tokens' } }, coverage: 'partial' }));
  // And the pooled bucket is GONE, so nothing can quietly write to it.
  assert.ok(refuses(() => validateComponentSet({
    components: { 'cache-write': { state: 'unknown' } }, coverage: 'partial' })));
});

test('E1c-2: an overlap relation names its peer, so a blind parent+child sum can be refused', () => {
  assert.deepEqual([...OVERLAP_RELATIONS], ['none', 'contained-in-parent', 'contains-child', 'unknown']);
  assert.deepEqual(validateOverlap({ relation: 'contains-child', peerKey: 'src:codex:s1:child' }),
    { relation: 'contains-child', peerKey: 'src:codex:s1:child' });
  assert.deepEqual(validateOverlap({ relation: 'unknown' }), { relation: 'unknown' });
  assert.deepEqual(validateOverlap({ relation: 'none' }), { relation: 'none' });
  // A relation that names a peer must supply one; "contained in a parent" without the parent
  // cannot be acted on.
  assert.ok(refuses(() => validateOverlap({ relation: 'contained-in-parent' })));
  assert.ok(refuses(() => validateOverlap({ relation: 'contains-child' })));
  // And a relation that names no peer may not smuggle one.
  assert.ok(refuses(() => validateOverlap({ relation: 'none', peerKey: 'src:x' })));
  // unknown is a real answer and is NOT none.
  assert.notDeepEqual(validateOverlap({ relation: 'unknown' }), validateOverlap({ relation: 'none' }));
});

test('E1c-3: a record claiming to BE a revision must carry the ordinal that orders it', () => {
  const asRevision = { ...ID, finality: 'revision' };
  assert.ok(refuses(() => supersedesContribution(asRevision, { ...ID, revision: 1 })),
    'a revision with no ordinal is unusable, not first');
  assert.ok(refuses(() => validateSessionUsageRecord({
    identity: asRevision, observedAt: '2026-09-07T09:45:00.000Z',
    usage: { components: {}, coverage: 'none' },
  })), 'the whole record is refused too, not just the comparison');
  // With the ordinal it works, and a non-revision still needs no ordinal.
  assert.equal(supersedesContribution({ ...asRevision, revision: 2 }, { ...ID, revision: 1 }), true);
  assert.ok(validateSessionUsageRecord({
    identity: ID, observedAt: '2026-09-07T09:45:00.000Z',
    usage: { components: {}, coverage: 'none' },
  }), 'an ordinary final record is unaffected');
});
