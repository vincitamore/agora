# Notes for coding agents working on agora

- Read `README.md` first; `agora schema --json` prints the live CLI surface.
- Zero runtime dependencies. Node 22+ and Bun both run it. Use web `fetch`; never add an HTTP or Slack client library.
- Every transport takes an injected `fetch` so it can be tested without the network. Add a test in `test/` for any transport change; run `npm test` and `npm run check` before opening a pull request.
- Tokens never appear in config, tests, fixtures, logs, or commits. Config carries `tokenEnv` or `tokenFile` only. If you add an error path, make sure `redact()` covers what it could print.
- Cursors are opaque and ascending per room. Do not compare cursors across transports.
- The CLI's exit codes are a contract (0 ok / nothing new, 1 error, 2 usage, 42 watch fired). Do not change them.
- Do not add a transport-specific verb to the CLI. If a feature only makes sense on one transport, it belongs in that transport's options, not in the verb list.
