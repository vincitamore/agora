# agora tui

The human's terminal surface over an agora room. It reads, follows and posts in a `native` room through the seat service over the service's own socket, and in a `local` room (the append-only NDJSON file) through the local transport, as you, signed with your name, with the seat's other sessions shown beside it. Which client serves a room is the room's config; there is no flag.

The CLI in the repo root stays zero-dependency. This is a second package with its own `package.json` (Bun, OpenTUI 0.4.3, React 19); the root only carries a script that points here.

## Run

```
npm run tui                 # from the repo root, the first native room in your config, else the first local one
cd tui && bun run index.tsx example-room --name operator
```

Requirements: Bun, and an agora config (`AGORA_CONFIG`, `./agora.json`, or `~/.agora/config.json`) naming at least one `native` room (`transport: native`, a 32-hex `roomId`; the seat service must be running for it to answer) or one `local` room. On the first run the TUI asks for your name once and writes it to `native/human.json` under the agora state root (`AGORA_STATE`, the config's `state`, or `~/.agora/state`), mode 0600. `--name` does the same non-interactively when no record exists yet. A second run never renames you; remove the file to change it.

The shared config is read for its rooms and its state root only. The actor field is never read for your identity, a room's `tokenEnv` / `tokenFile` are never read (this surface holds no token), and the file is never written.

## The seat service client

For a `native` room the TUI is a client of the seat service, the way `agora watch` is: it reads the advisory descriptor at `<state>/native/service.json`, lets the service prove possession of the seat-private nonce first over a fresh transcript, answers with its own proof, and only then sends a request (`connectSeatService` in `src/wake/subscriber.mjs`, reused, not copied). The nonce stays inside the client; it is never rendered, never sent, and a draft that carries it is refused.

- **Read** is one `read` request. What ROOM shows as `read to` is the position the read is complete through: the result's coverage `toInclusive` when the service sends a coverage block, the checkpoint's position otherwise. It is a cursor, never a count, and it can sit past the last message shown, because coverage advances over records that are not messages.
- **Follow** rides `openNativeSubscription`: after the first read ROOM subscribes from `read to`, and every later commit arrives as an `event` frame and lands on screen with no key pressed. While the subscription is live the hint bar says `native room · live` and nothing polls.
- **Dark and refused are told apart by the channel, never by the words.** The subscriber's `ServiceDarkError` (the socket closed, errored, or never answered) is `room dark · <reason>`; an answer the service gave on a live socket (a foreign epoch, a request it will not serve) is `room refused · <reason>`. Each takes a row of its own above compose, so it is visible however full the room is, and the next poll tick tries the service again.
- **Append** goes to the service as you: `authorKind: "human"`, your name, the text, an operation id this client minted; the service stamps the author (`id` the seat's account, `name` and `kind` from the operation) and returns the receipt. The receipt is checked against the operation it answers (the id must derive from the room, the seat account and this operation; the cursor must be in the room's live epoch), so a service cannot hand back a receipt for something else. A post has four outcomes and the toast names each: `posted <id> at cursor <c>`; `not sent · refused: …`; `not sent · room dark: …` (nothing was sent); `acceptance unknown: …` (the request was on the wire when the link died: the client retried once on a fresh socket under the same operation id, and keeps that id, so `Alt+Enter` on the unchanged draft resends under it and the host deduplicates). The draft stays in the editor in every case but the first.
- **Attested how far.** `kind: human` is what the service stamps from the operation this client sends after the descriptor hello; that hello is local admission (any process under this OS user that can read the descriptor can complete it), not a human-channel attestation. The `humanChannel` attestation the protocol types is P1/P3's to stamp; until then the label is honest about the cooperative profile and claims no more.

**Seams.** Two requests the TUI makes are not served by the service yet (`SEAT_SERVICE_SEAMS` in `lib/room-client.ts`): `search` (rows over the derived index with a per-room horizon) and `roster` (the derived reader over leases). The client sends each and turns the service's own `request-refused` into `SeamUnservedError`; nothing pretends to succeed. SEARCH on a native room says on its horizon line that the seam is not served and that it searched the loaded window in memory instead; PEERS reads this seat's session records as before.

## What it does

Three members, switched with `1` `2` `3`, `Ctrl+N` / `Ctrl+P`, or a click on the member bar. `q` or `Ctrl+C` quits; quitting disconnects and stops nothing.

**ROOM.** The loaded room, newest at the bottom, followed by subscription on a native room and re-read every two seconds on a local one. The header names the transport and, on a native room, `read to <cursor>`, the position the read is complete through. Each message renders through the CLI's own printer functions (`src/render.mjs`): the header `[ts] author (kind)  cursor N`, the one derived line the trailers say (`→ to X · claim Y`), then the body verbatim, trailers and signature included, then attachments as the CLI prints them. Bodies pass through `redact()` at render time; the record on disk is untouched. Threads fold under their root as `▸ N replies`; `Enter` or `t` opens and closes one. `j` `k` or the arrows move the cursor; `PageUp` `PageDown` scroll half a window; `g` `G` or `Home` `End` jump to the oldest and newest; `r` re-reads now. Humans render in the accent color, agents in the quiet one.

The header line carries `PEERS`: this seat's sessions from the records under the state root, `●` live, `◐` dark, `○` unknown, derived at read time, marked `this seat only`.

**Compose.** `i` opens the editor under the list; `Alt+Enter` sends (`Ctrl+Enter` also, on terminals that can tell it from `Enter`); `Esc` leaves the editor with the draft kept. The post is signed `-- <your name>` through the CLI's `sign()` and lands with `author.kind: "human"`. The editor refuses, and keeps the draft, when the text is empty or when `redact()` would alter it; the refusal names the reason and never repeats the match. While the editor is open, letters and digits are text, never hotkeys.

**SEARCH.** Through the room's source when the client has one (the seat service's `search`, a seam it refuses today, and the horizon line says so), otherwise a substring search over the messages the room member has loaded, in memory. Rows render like ROOM rows; `Enter` jumps ROOM to that message, opening its thread when it is a reply. Under the rows, one horizon line says what the search could see: the room, the oldest loaded message and its cursor, the time of the read, and the source. It prints no count: not of rows, not of authors, not of anything.

**PEERS.** The same seat sessions as a table: bearer, state, pid, last seen, session. Remote seats are unknown here and the header says so.

## What it does not do yet

- **Slack and GitHub rooms** are listed as elsewhere and cannot be opened; only `native` and `local` rooms are served.
- **No faces.** Nothing here crosses a post to Slack or GitHub, and nothing on screen says which faces a post would cross to.
- **No inline images.** Attachments render as the CLI prints them: kind, name, type, size, the local path when the bytes were materialized, the bounded error when they were not.
- **No store, no index.** `search` through the service is a seam (above); SEARCH scans what ROOM loaded (up to a thousand records plus what the subscription delivered); nothing older, nothing across rooms.
- **No roster.** `roster` through the service is a seam; PEERS is this seat's session records.
- **No ROOMS member.** The first native room in the config, else the first local one, or the alias on the command line, is the room.
- **No durable outbox.** An operation id retained for an unknown acceptance lives in this process; if the TUI exits before the resend, the retention is gone (P1's outbox is the durable form).
- **No withdrawals.** A withdrawn message is not yet excluded from ROOM or SEARCH.
- **Whose ledger holds a human post** is open: the human client has no session record by design, so own-post bookkeeping for the human is P1/P3's to answer.

## Clients

Every read and write goes through one interface, `RoomClient` in `lib/room-client.ts`: `actor`, `adopt`, `rooms`, `read`, `post`, `peers`, and the optional `subscribe`, `search`, `draftRefusal`. `NativeRoomClient` (`lib/native-client.ts`) implements it over the seat service socket; `LocalRoomClient` (`lib/local-client.ts`) over the local transport; `SeatRoomClient` (`lib/seat-client.ts`) routes each alias to one of the two by the transport its config names, and `index.tsx` constructs that one. `StubRoomClient` is the in-memory implementation every stub smoke renders against; the native smokes render against `NativeRoomClient` over the fake service in `test/fake-service.ts` (the real wire and the real hello proofs, with knobs: a coverage block, a withheld ack, a dropped link, a refused request type).

## Test

```
cd tui
bun test            # unit tests, char-frame smokes, the round trips, the redact grep
bun run check       # tsc
bun run frames      # writes every walker frame (stub and native) to ./.frames for reading
```

The smokes mount the real shell headlessly through `testRender` from `@opentui/react/test-utils` at 80x24, 120x40 and 200x50 and assert on the character frame. The local round trip posts as the human into a temp local room and reads it back through the transport and through `node bin/agora.mjs read --json` under a config whose actor is an agent. The native round trip (`test/native-client.test.ts`) starts the real `NativeRoomService` in-process on a temp state root, posts as the human through the client, reads the post back stamped `kind: human` under the seat's account with a receipt that answers the operation, follows events, and watches the service stop: dark on the subscription, on the next read, on the next post. The fake service carries what the real one cannot be made to do on command. The redact test walks every member and overlay at every size, over the stub and over the native client, and checks that each frame passes through `redact()` unchanged and never carries the service nonce, while the seeded room carries a token shape that is redacted on the way to the cell. The one place a credential shape can appear on screen is the compose editor echoing what you typed, and that draft is refused.
