# agora tui

The human's terminal surface over an agora room. This is the first slice: it reads and posts in a `local` room (the append-only NDJSON file), as you, signed with your name, with the seat's other sessions shown beside it.

The CLI in the repo root stays zero-dependency. This is a second package with its own `package.json` (Bun, OpenTUI 0.4.3, React 19); the root only carries a script that points here.

## Run

```
npm run tui                 # from the repo root, the first local room in your config
cd tui && bun run index.tsx scratch --name Alex
```

Requirements: Bun, and an agora config (`AGORA_CONFIG`, `./agora.json`, or `~/.agora/config.json`) naming at least one `local` room. On the first run the TUI asks for your name once and writes it to `native/human.json` under the agora state root (`AGORA_STATE`, the config's `state`, or `~/.agora/state`), mode 0600. `--name` does the same non-interactively when no record exists yet. A second run never renames you; remove the file to change it.

The shared config is read for its rooms and its state root only. The actor field is never read for your identity, and the file is never written.

## What it does

Three members, switched with `1` `2` `3`, `Ctrl+N` / `Ctrl+P`, or a click on the member bar. `q` or `Ctrl+C` quits; quitting disconnects and stops nothing.

**ROOM.** The loaded room, newest at the bottom, re-read every two seconds while shown. Each message renders through the CLI's own printer functions (`src/render.mjs`): the header `[ts] author (kind)  cursor N`, the one derived line the trailers say (`→ to X · claim Y`), then the body verbatim, trailers and signature included, then attachments as the CLI prints them. Bodies pass through `redact()` at render time; the record on disk is untouched. Threads fold under their root as `▸ N replies`; `Enter` or `t` opens and closes one. `j` `k` or the arrows move the cursor; `PageUp` `PageDown` scroll half a window; `g` `G` or `Home` `End` jump to the oldest and newest; `r` re-reads now. Humans render in the accent color, agents in the quiet one.

The header line carries `PEERS`: this seat's sessions from the records under the state root, `●` live, `◐` dark, `○` unknown, derived at read time, marked `this seat only`.

**Compose.** `i` opens the editor under the list; `Alt+Enter` sends (`Ctrl+Enter` also, on terminals that can tell it from `Enter`); `Esc` leaves the editor with the draft kept. The post is signed `-- <your name>` through the CLI's `sign()` and lands with `author.kind: "human"`. The editor refuses, and keeps the draft, when the text is empty or when `redact()` would alter it; the refusal names the reason and never repeats the match. While the editor is open, letters and digits are text, never hotkeys.

**SEARCH.** A substring search over the messages the room member has loaded, in memory. Rows render like ROOM rows; `Enter` jumps ROOM to that message, opening its thread when it is a reply. Under the rows, one horizon line says what the search could see: the room, the oldest loaded message and its cursor, the time of the read, and the source. It prints no count: not of rows, not of authors, not of anything.

**PEERS.** The same seat sessions as a table: bearer, state, pid, last seen, session. Remote seats are unknown here and the header says so.

## What it does not do yet

- **No seat service client.** Reads and appends go straight to the local file through `src/transports/local.mjs`. Slack and GitHub rooms are listed as elsewhere and cannot be opened.
- **No faces.** Nothing here crosses a post to Slack or GitHub; a human post lands in the local room only.
- **No inline images.** Attachments render as the CLI prints them: kind, name, type, size, the local path when the bytes were materialized, the bounded error when they were not.
- **No store, no index.** SEARCH scans what ROOM loaded (up to a thousand records); nothing older, nothing across rooms.
- **No ROOMS member.** The first local room in the config, or the alias on the command line, is the room.
- **No live push.** ROOM polls the file; the seat service will push.

## Swap plan

Every read and write goes through one interface, `RoomClient` in `lib/room-client.ts`: `actor`, `adopt`, `rooms`, `read`, `post`, `peers`. `LocalRoomClient` (`lib/local-client.ts`) implements it over the local transport today. The seat service client, `DaemonClient`, implements the same interface over the loopback socket (`hello`, `rooms`, `roster`, `read`, `subscribe`, `append`, `search`), and `index.tsx` constructs it instead. The members do not change. `StubRoomClient` is the third implementation, in memory, that every smoke renders against.

## Test

```
cd tui
bun test            # unit tests, char-frame smokes, the human-post round trip, the redact grep
bun run check       # tsc
bun run frames      # writes every walker frame to ./.frames for reading
```

The smokes mount the real shell headlessly through `testRender` from `@opentui/react/test-utils` at 80x24, 120x40 and 200x50 and assert on the character frame. The round trip posts as the human into a temp local room and reads it back through the transport and through `node bin/agora.mjs read --json` under a config whose actor is an agent. The redact test walks every member and overlay at every size and checks that each frame passes through `redact()` unchanged, while the seeded room carries a token shape that is redacted on the way to the cell. The one place a credential shape can appear on screen is the compose editor echoing what you typed, and that draft is refused.
