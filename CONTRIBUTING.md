# Contributing to Agora

Thank you for contributing. The operating rules for changing Agora (zero runtime dependencies,
evidence before claims, keeping docs and schema in sync) live in
[skills/agora/SKILL.md](skills/agora/SKILL.md) §5.

## Prerequisites

- **Node.js 22.13 or later** (required for the CLI and the Node test runner)
- **Dev dependencies** (type checker only): run `npm install` once from the repository root
- **Bun** (optional): required for `tui/` (`bun install --cwd tui`) and Bend kernel regeneration
- **PowerShell 7 (`pwsh.exe`)** (optional on Windows): required to run the four Windows Codex
  launcher tests; on stock Windows with only PowerShell 5.1 those tests skip cleanly with a reason

## Verification gates

Run both gates from the repository root before opening a pull request:

```sh
npm run check          # TypeScript JSDoc check (~8 s)
npm test               # full Node test suite: node --test "test/**/*.test.mjs" (~4 min)
```

Additional targeted checks when touching those areas:

```sh
node scripts/make-bad-bytes-corpus.mjs --check   # native store bad-bytes corpus parity
bun test                                         # inside tui/ after `bun install --cwd tui`
```

For formal kernel proofs, C0 law checks, and import-graph scanner rules, see
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Pull requests from forks

CI (`.github/workflows/test.yml`) runs on self-hosted Linux and Windows runners (macOS is off; the
`spawn` job is Bun-only, the `tui` job declares Node, and every new package lands with its own
job). **Pull requests from forks do not run the project's CI automatically**, so paste your local
`npm run check` and `npm test` output directly in the pull request description.

## Acceptance probes and spawn admission

- Acceptance probes live at `scripts/probe-*.mjs` and run under `test/acceptance/`.
- Spawn admission is `agora spawn --file <path>` over `src/spawn/request.mjs` and
  `test/fixtures/spawn/spawn-request.json` (unknown keys exit 1 `request-field-unknown`).

## Keeping docs and surface in sync

- Never hand-edit generated `src/*.kernel.mjs` files (regenerate via `spec/build-kernel.ts`).
- When a verb, option, exit code, or config key changes, update `SCHEMA` in `bin/agora.mjs`,
  [docs/CLI.md](docs/CLI.md), and [skills/agora/SKILL.md](skills/agora/SKILL.md) (plus
  `plugins/claude/agora-room/skills/agora/SKILL.md` so the bundled Claude plugin skill matches).
- Keep `test/docs.test.mjs` and `test/doc-install-names.test.mjs` green.
