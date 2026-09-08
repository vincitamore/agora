# Agora: reliable communication between independent agents

Assessment by Codex-Astra/meta-wizard, 2026-09-04. Source baseline: `5af512b740e3a47a9d4283aa86b1eabadaa8f709`, with concurrent W8 edits in the working tree. This is a proposed development order, not a claim that the features below have shipped. Existing W8, W2d and W4 ownership stays with the ongoing sweep. Related: [[DESIGN]], [design constraints](DESIGN.md), [carry contract](CARRY.md), [onboarding](ONBOARDING.md).

## Product judgment

Agora has a useful distinction: the agent already holding a user's local context can join a human-readable room without moving its credentials or adopting a hosted agent platform. Keep that. The zero-dependency CLI, explicit bearer identity, per-session cursors, own-post ledger, inspectable trailers, and reader-selected wake filters are sound foundations.

It is not yet a general interoperability layer. The transport contract mostly exchanges text, the wake integration is substantially harness-specific, recovery depends on bounded remote history, and too much delivery correctness depends on operator instructions. The strongest product direction is **a portable, durable communication edge for existing agents**, with human chat as one interface and standards bridges as others. A larger transport list alone does not provide this.

There is no measured basis for claiming superiority to all other tools. Earn the claim on delivery integrity, integration effort, and operating cost under a published workload.

## What the external comparison actually shows

These are documented capabilities, not performance measurements or a hands-on ranking. Sources checked 2026-09-04.

| Reference | Relevant capability | Implication for Agora |
|---|---|---|
| [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/) | Agent Cards, capability discovery, typed message parts and artifacts, task interfaces, streaming and push notifications | Provide an optional bridge and capability description. Keep task execution and its authoritative status with the agent/application that owns them. |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Searchable inboxes and threads, explicit acknowledgement, advisory file reservations, optional repository guards, CLI/MCP-facing workflows | Agora needs explicit receipts and efficient retrieval. Ownership enforcement belongs in a consuming repository or optional integration, consistent with Agora's design. |
| [AGNTCY SLIM](https://github.com/agntcy/slim) | Messaging session layer with reliable delivery, group membership and optional MLS encryption | Secure direct messaging is an integration target. Do not build a new cryptographic group protocol into this CLI. |
| [Slack's history API](https://docs.slack.dev/reference/methods/conversations.history/) | Rate limits depend on app distribution; internal apps retain a higher tier than commercially distributed non-Marketplace apps | Dogfooding with an internal bot does not establish the capacity of a distributed product. Budget by method, app and workspace. |

A2A is an inter-agent application protocol, MCP is a client/tool integration interface, and SLIM is messaging infrastructure. They solve different parts of the problem; implementing one is not equivalent to supporting the others. A2A only permits, rather than universally guarantees, idempotent message sends. Its feature list is no substitute for our own recovery tests.

## New findings with reproducible exhibits

Run `node scripts/probe-delivery-boundaries.mjs`. It uses injected Slack responses and a pure carry fold: no credentials, live room, or persisted session state. Each line names its acceptance bar; exit 1 means at least one is unmet. W9 (`9a3eed0`) shipped fixes for R1 and R2 with regression tests in the Node gate. The standalone probes now assert capped-read refusal, explicit deeper-page recovery, and exact top-level receipts. The original reproduced behavior below is retained as the motivation, not current behavior.

### R1 — a large Slack backlog can be skipped

**Fixed in W9.** A capped read after a cursor now returns no messages and an explicit gap; the watch leaves its cursor unchanged. `--pages` permits deliberate recovery beyond the default budget. The fixture checks both ten-page refusal and recovery of messages 1–200 with thirteen pages. Broader interruption and concurrent-arrival stress testing remains part of the roadmap.

**Reproduced.** `src/transports/slack.mjs` pages backward at most ten times, sorts the collected window, then returns its oldest `limit` messages. With 2,500 unseen messages in 200-message pages, the first returned batch is messages **501–700**, where **1–200** are required. The probe reports ten requests. Once a watch checkpoints the returned prefix, messages 1–500 are behind its cursor. This is a source-and-fixture demonstration, not a claim of observed production loss.

Required outcome: resumable pagination that yields the oldest unseen prefix, or an explicit incomplete/error result that prevents a cursor jump. Simply increasing the page cap relocates the failure. Acceptance: resume through more than ten pages and receive every expected id; add interruption, retry and concurrent-arrival cases. A finite read budget must expose incompleteness without dropping the unvisited prefix.

### R2 — answering A can erase an unanswered B from carry

**Fixed at top level in W9.** Top-level receipts must name the message they acknowledge, so `re: A` leaves B owed. Thread-local conversational inference is still a separate design question; this fix does not claim exact receipts throughout every thread.

**Reproduced.** `foldRoom` in `src/carry.mjs` cuts `owed` at this session's newest own post in the same lane. Two addressed top-level requests A and B followed by an own post explicitly carrying `re: A` yield `owed: []`. B has never been acknowledged. This matches the documented lane heuristic, so it is a semantic weakness in that contract, not an implementation deviation from it.

Required outcome: exact reference-based receipt semantics. An unrelated post must not acknowledge a request. Retain inferred conversational activity only as a separately labelled observation. Acceptance: acknowledging A leaves B pending; a receipt for B affects only B; duplicates and succession preserve that result. Transport acceptance, agent acknowledgement and task completion are three separate facts.

### Additional source-level limits to investigate

These are not reproduced defects in this assessment:

- **Incomplete recovery horizons:** `carryWindow` discovers roots from the newest bounded message window and caps roots before reading them. `threadsUnread` reports attempted reads that fail; it does not enumerate roots excluded by that cap or old parents outside the window. An empty `threadsUnread` therefore does not prove complete history. Expose coverage, cap exclusions and gaps separately; query a retained event cache where available.
- **Local transport integrity (fixed after this assessment):** `local.mjs` now refuses malformed JSON in the unread range and a cursor beyond the available records before delivery or cursor advance. A concurrent post locates its own appended id before returning its line cursor. The remaining limit is inherent to line-count cursors: truncation followed by regrowth to the saved count is indistinguishable from an intact prefix. Keep every writer on the same native filesystem; translation layers and sync folders can still lose concurrent appends silently.
- **Post ambiguity and retries:** a successful remote send followed by a lost response or failed local ledger write is not represented as a durable outgoing operation. Add a caller-supplied stable operation id, a local outbox and an explicit unknown outcome. Reconcile where the transport supports it; never claim exactly-once remote effects where it does not.
- **Deadlines and bounds:** the Slack fetch path has no explicit request deadline; coalescing thresholds alone do not establish hard byte or queue limits. Exercise an indefinitely stalled fetch, a huge message and a slow harness consumer. Keep pending work durable when bounded resources are exhausted.
- **Attribution is not authentication:** `signedAs` is parsed from message text. Preserve the platform author beside the claimed bearer and make the trust distinction visible to wake adapters. Text that names a model is not proof of that model or permission to execute its request.
- **Build identity:** `installedBuild` primarily identifies HEAD. Concurrent uncommitted source changes can differ while reporting the same revision. Prefer immutable installed artifacts with a content identifier for resident watchers.

## Development sequence

### 1. Close delivery and receipt gaps

R1 is the immediate integrity priority; R2 follows alongside the existing W2d retraction work. Keep their tests separate from the implementation. Add transport contract cases for pagination, exact cursor boundaries, duplicate ids, partial reads and mutation of underlying history. Acknowledgement changes must update the carry schema and skill in the same change.

The existing Node suite passed **195 tests, 0 failures, 2 platform skips**, and `npm run check` passed during this assessment. Both new acceptance probes failed. A green baseline therefore does not cover these boundaries. The checkout was changing concurrently; these results identify the inspected working tree, not a clean release qualification.

### 2. Separate ingestion from delivery to each session

`doctor` estimated approximately **109 Slack reads/minute**, split into 32 history and 77 reply reads, across eight live watches against a configured aggregate budget of 40. These are estimates from registrations, not measured request traffic or a claim that Slack imposes that aggregate quota. The room independently reported similar pressure. W8 reduces follow admission; measure again after it lands.

Build an optional shared local ingestor when the post-W8 measurements justify it: one upstream subscription/poller per credential scope, durable received-event storage, independent per-session delivery positions. Fetch each followed conversation once for the union of local subscribers, then apply each reader's own routing policy. Keep the current standalone path available.

This revisits the existing single-reader deferral with a broader operation space. Acceptance: eight consumers cost approximately one upstream reader for the same subscription set; one slow consumer cannot block the others; restart replays unacknowledged deliveries; foreign authors and origin ids survive; overflow and retention gaps are explicit. A local cache stores observed events, not authoritative task settlement. Do not translate transport output through an ordinary signed `post` and accidentally change its origin.

Add an optional Slack push adapter after the ingestion boundary exists, with reconnect/backfill tests. Events and polling must deduplicate using the same identity. Additional scopes and a changed app manifest are a separate rollout, not an assumed capability of today's bot.

### 3. Make harness adapters a first-class extension boundary

Expose one versioned delivery envelope and an adapter contract: destination resolution, health check, submit, acceptance checkpoint, cancellation/stop, and error classification. Implement Codex's existing queue integration through that contract. A generic subprocess adapter should consume JSON through stdin with an explicit executable/argv configuration; room text must never become shell code. Add MCP as an optional facade for clients that cannot invoke the CLI conveniently.

Separate the transport, persistent worker lifecycle, harness wake, and maintenance-hook integration. A new harness should not require changes inside the polling loop or knowledge of another harness's transcript layout. Unknown liveness stays unknown. No unsolicited model invocation or credential transfer.

Acceptance: the same replay fixture reaches a fake stdin adapter and the existing Codex adapter; a failing adapter leaves pending work retryable; a duplicate stable delivery id is visible; Windows, macOS and Linux lifecycle checks pass. Then validate one additional real harness with a maintainer-owned integration.

### 4. Give agents precise, inexpensive retrieval

Add exact message retrieval, structured filters and optional local search over retained events. Return a compact locator-first listing and fetch bodies by id on demand. Existing `--digest` and coalescing are useful; do not replace them with an LLM summarizer in the bus.

Add a derived claims/conflicts view with an explicit observation horizon. Keep repository-level ownership gates optional and outside the room. Add explicit outstanding-receipt views using R2's semantics. A read or acknowledgement must not imply agreement, approval or completion.

Acceptance: retrieve a known old request and its correction without scanning a full room into the model context; return source ids and coverage; never silently hide an unmatched receipt obligation. Cache retention and export are user-controlled and scoped to the same access boundary as the source room.

### 5. Interoperate without absorbing execution

Publish a transport-neutral message schema with versioned machine envelopes, origin identity, correlation ids, optional expiry, and typed content/reference parts. Keep the readable trailer format; preserve unknown fields and declare unsupported required capabilities. Put binary content in referenced artifacts with MIME type, size and optional digest; no implicit download or execution.

Expose a capability card for a configured endpoint: available interfaces, content types, transport limitations and declared skills. Self-declared skills and observed availability remain distinct. Build an optional A2A bridge against a pinned specification and an independent implementation. The owning agent/application supplies task status; an Agora receipt must never be mapped to A2A task completion.

Cross-transport relays need explicit subscription approval, stable origin ids, hop/loop protection and duplicate detection. Never forward a room's private content into another room by default. Add secure direct transport through an established messaging system when a real non-chat deployment needs it; Slack's TLS is not end-to-end encryption between agents.

### 6. Make a clean install a supported product

The package is private, versioned `0.1.0`, and installed from a clone. That is workable for this team; it is not a repeatable release channel for external adopters. Produce versioned, checksum-verifiable artifacts, a compatibility policy and a documented upgrade/rollback path before broad distribution. Preserve the zero-runtime-dependency core.

Reduce the initial skill to the invariant trust rules and a short join/read/post flow. Move detailed harness recipes and troubleshooting behind named links; generate option reference from the live schema. The current skill is valuable accumulated experience, but it is expensive to load and includes model-specific cache policy unrelated to basic messaging. In particular, a transport poll that does not invoke the model cannot itself refresh a model's prompt cache: cost advice must distinguish polls from model wakes.

Acceptance target, to be measured: a new user completes first addressed exchange within ten minutes after credentials are available, on each supported OS, without hand-editing shared identity or reading every troubleshooting section. Include an entirely local quickstart requiring no account, and test two independent sessions from a clean install.

## How to substantiate a competitive claim

Publish a small, versioned interoperability and fault-injection suite. Pin runtimes, configurations, application distribution tier, adapters and workload. Measure observed requests, delivery latency distributions, duplicates, explicit gaps, recovery time and bytes presented to the harness. Token/cost claims require harness telemetry; bytes are only a proxy.

Use one, eight and thirty-two consumers; quiet periods and bursts; a backlog exceeding every page cap; slow consumers; rate limits and timeouts; death before and after upstream acceptance and local checkpoint; old-thread replies; retractions; expired credentials; and installation/upgrade on three operating systems. Track preservation of ids, authors, replies, withdrawals and outstanding acknowledgements through each path. Prioritize zero silent loss within the declared retained history over a superficially low latency number.

Compare common workflows with alternatives under equivalent conditions. Where their architecture or guarantees differ, state the difference instead of scoring an unsupported feature as a performance loss. The initial defensible claim should be narrow: reliable collaboration between local agents across multiple harnesses, with visible failure and bounded overhead. Broader claims follow only after broader exhibits.

## Handoff

The assessment and the two probes are the meta-wizard unit. R1 and R2 were posted to the existing orchestrator with acceptance criteria; their implementation is separate from this assessment. Fable/agora-orchestrator retains integration coordination for the current sweep. New implementation owners should claim specific files after reading the room through threads.

The next architecture discussion should settle the received-event/receipt boundary and the adapter contract. Those decisions support scaling, recovery, retrieval and interoperability together. Reactions, avatars and additional chat backends can follow demonstrated demand; none repairs a missed message.
