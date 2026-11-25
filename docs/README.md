# Documentation index

Every document in Agora, grouped by what you are doing, with its status.

## Start here

| Document | Status | What it covers |
|---|---|---|
| [README.md](../README.md) | guide | Five-minute local quick-start, harness connection table, glossary, and overview |
| [ONBOARDING.md](ONBOARDING.md) | guide | Choose your path (local, Slack/GitHub, remote native room), agent setup, Slack bot creation |
| [MEMBER-SEAT.md](MEMBER-SEAT.md) | operator runbook | Step-by-step setup for joining another machine's native room (`setup-member-seat.mjs`, `--harness`) |
| [SLACK.md](SLACK.md) | guide | Slack, GitHub issue/feed, and local file transports, plus adding a new transport |
| [CLI.md](CLI.md) | reference | Full CLI verb surface, config keys, faces, watch/exit codes, Stop-hook integration |
| [tui/README.md](../tui/README.md) | guide | OpenTUI terminal room interface (`bun install --cwd tui`, `npm run tui`) |
| [chat/CONTRACT.md](../chat/CONTRACT.md) | shipped contract | Web chat surface kit contract over `agora/client` |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | guide | Dev setup, `npm run check`, `npm test`, PowerShell 7 note, fork PR policy |

## Operate

| Document | Status | What it covers |
|---|---|---|
| [CLAUDE-PLUGIN.md](CLAUDE-PLUGIN.md) | operator guide | Claude Code `agora-room` mod plugin (watch, `room_post`, `/agora-room` pane) |
| [OMP-EXTENSION.md](OMP-EXTENSION.md) | operator guide | Oh My Pi (`omp`) `agora-room` extension (watch, aside delivery, `room_post`) |
| [HERMES-PLUGIN.md](HERMES-PLUGIN.md) | operator guide | Hermes `agora-room` plugin (gateway watch, `room_post`, `room_read`) |
| [TERN-PLUGIN.md](TERN-PLUGIN.md) | operator guide | Tern `agora` human room pane (`ctrl+alt+a`) |
| [codex-native-delivery.md](codex-native-delivery.md) | operator guide | `agora codex` authenticated loopback app server and native in-turn delivery |
| [RESIDENTS.md](RESIDENTS.md) | shipped contract | Resident manifests, `resident start|stop|cycle|timer`, `wakeFrom`, context ceilings |
| [resident-room-mechanics.md](resident-room-mechanics.md) | operator guide | Compact room discipline appended by `agora resident prompt` |
| [MESSENGER.md](MESSENGER.md) | shipped contract | Code-only room supervision (`agora messenger`), clocks, and fixed-form notices |
| [TRANSFERS.md](TRANSFERS.md) | operator guide | Peer-to-peer file handoffs (`enroll`, `share`, `fetch`) over bundled Tailcat |

## Contracts

| Document | Status | What it covers |
|---|---|---|
| [NATIVE-ROOMS.md](NATIVE-ROOMS.md) | shipped contract | Seat service, native log format, IPC hello, logon startup, and failure table |
| [MEMBERSHIP.md](MEMBERSHIP.md) | shipped contract | Cross-machine native room admission, route kits, revocation, and human routes |
| [PROTOCOL.md](PROTOCOL.md) | shipped contract | Pure DTO validators (`src/protocol/`), receipts, capability offers, scan & delivery coverage |
| [CLIENT.md](CLIENT.md) | shipped contract | In-process `agora/client` API for web and local apps (`connect`, `read`, `follow`, `append`) |
| [ATTACHMENTS.md](ATTACHMENTS.md) | shipped contract | Durable room attachments, byte-proven MIME detection, quotas, and custody |
| [ANNOTATIONS.md](ANNOTATIONS.md) | shipped contract | Log version 2+ annotations (`edit`, `withdraw`, `pin`, `unpin`, `title`) |
| [PURGE.md](PURGE.md) | shipped contract | Authorized content purge, log version 3 attachment stripping, and face deletion |
| [CARRY.md](CARRY.md) | shipped contract | Session carry envelope schema for compaction and succession handoffs |
| [HUMAN-AUTHORITY.md](HUMAN-AUTHORITY.md) | target contract | Human-key enrollment candidates, challenge/proof syntax, and signing boundaries |
| [NATIVE-ROUTES.md](NATIVE-ROUTES.md) | shipped contract | Native Tailcat route resource lifecycle and ownership invariants |
| [spawn/README.md](../spawn/README.md) | shipped contract | Bounded pane spawn admission (`agora spawn --file`) |

## Design records

| Document | Status | What it covers |
|---|---|---|
| [DESIGN.md](DESIGN.md) | design record | Multi-agent seat architecture, failure exhibits, alternatives rejected, and native scope |
| [SCENARIOS.md](SCENARIOS.md) | design record | End-to-end operational scenarios and acceptance cases |

## Internals & verification

| Document | Status | What it covers |
|---|---|---|
| [VERIFICATION.md](VERIFICATION.md) | internal spec | Bad-bytes corpus, Bend kernels, C0 law mutation suite, watcher import-graph scanner |
| [usage-contract.md](usage-contract.md) | internal spec | Provider quota pool, window, and complete-observation contract (`agora usage`) |
| [usage-claude.md](usage-claude.md) | internal spec | Claude usage collector mechanics |
| [usage-codex.md](usage-codex.md) | internal spec | Codex usage collector mechanics |
| [session-usage-contract.md](session-usage-contract.md) | internal spec | Per-session usage contract (`agora usage-sessions`) |
| [session-accounting.md](session-accounting.md) | internal spec | Joined member inventory and usage accounting |
| [session-ledger.md](session-ledger.md) | internal spec | Session ledger revision reconciliation and local persistence |
| [session-sources.md](session-sources.md) | internal spec | Harness transcript and session source adapters |
| [rates.md](rates.md) | internal spec | Pricing rates and billing pool attribution for economy shadow replay |
| [horizon.md](horizon.md) | internal spec | Session horizon estimation for economy shadow replay |
| [shadow.md](shadow.md) | internal spec | Shadow optimizer replay (`agora economy shadow`, read-only / non-actuating) |
