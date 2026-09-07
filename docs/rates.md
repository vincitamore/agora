# Rates and pool attribution

`src/usage/rates.mjs` and `src/usage/pool-attribution.mjs` are the E2a unit: a dated
rate table and an explicit pool map. They do not call a provider, do not actuate, and
do not treat a missing rate as zero.

## Rate table

`data/rates.json` is `{ version: 1, rows: [...] }`. The shipped file has no rows, so
nothing is priced until a qualified row is added. Each row carries:

- the price key: `provider`, `endpoint`, `modelRevision`, `serviceTier`, `region`,
  `billingMode`
- a context bracket `[contextBracketMin, contextBracketMax)` — half-open, so a
  token count equal to a shared boundary belongs to the row whose min is that
  boundary
- `effective`, `retrieved`, `source`, and `qualification` (`qualified` or
  `unqualified`). An unqualified row never prices. An `illustrative: true` row
  prices nothing unless `allowIllustrative: true` is passed (tests only)

Three columns stay separate: `publishedApi`, `providerReportedBill`,
`subscriptionConsumption`. Each maps a usage component to `{ usdPerMillion }`.
Omitted columns are unknown, not zero. Source-reported amounts on a usage record
keep their stated unit and are not converted here.

## `priceUsage`

```
priceUsage(record, table, { eventTime, asOf }, billingContext, residentContext, opts?)
```

- `billingContext` is versioned provenance: each of provider, endpoint, serviceTier,
  region, billingMode is `{ state: 'known', value }` or `{ state: 'unknown' }`. A
  model label is not the key. Any unknown field yields no match.
- `residentContext` is `{ state: 'known', tokens }` or `{ state: 'unknown' }`. The
  bracket is selected per request from that measured value; lifetime totals are
  refused as a substitute. Unmeasured context leaves every component unpriced.
- `eventTime` and `asOf` are separate. A row whose `effective` is after `asOf`
  does not apply. Two matching rows pick the latest effective not after `asOf`.
- Returns `{ apiEquivalent, reportedBill, subscriptionConsumption, unpriced, coverage, row }`.
  `apiEquivalent` is from the dated `publishedApi` column. `reportedBill` is the
  record's `sourceReportedCost` in its stated unit, or unknown. `subscriptionConsumption`
  is unknown unless observed; it is never derived from list-price dollars. A missing
  rate puts tokens in `unpriced` with a reason; it never returns a cost of 0.

## Pool attribution

`attributePool(member, { members: { [member]: poolId } })` maps only by explicit
member id. An unknown mapping returns `{ attributed: false, reason: 'unknown-mapping' }`.
A model or display name is not consulted. The map is not a capacity observation.
