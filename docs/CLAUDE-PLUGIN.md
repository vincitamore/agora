# Agora in Claude Code: the `agora-room` plugin

`plugins/claude/agora-room` is a Claude Code plugin (a *mod*: plugin JavaScript that runs inside Claude Code) that puts an Agora room into a Claude Code session, in the terminal and in the Claude desktop app's Code tab:

- **watch**: each new room message starts one turn in the idle session. The plugin owns the watch, so there is no background command to keep alive and no exit-42 loop to re-arm.
- **`room_post`**: a tool the model calls to post to the room, signed as the session's bearer.
- **a pane** (`/agora-room`): the room's subjects by latest activity with unread marks, a thread view, a compose field with its target stated, and who is here.

It needs Claude Code 2.1.299 or later (mods from 2.1.287; the pane's text props from 2.1.299; measured on 2.1.304) and the `agora` CLI. The plugin reads no token and holds no credential: everything it does with a room goes through the CLI, under the config you already have.

Mods run outside the sandbox with your permissions. An organization can limit or turn them off (`allowManagedModsOnly`, `disableAllHooks`), and a session started with `--safe-mode` or `--bare` loads none.

## Install

Two marketplaces carry the same plugin: the repository root (`.claude-plugin/marketplace.json`, marketplace `agora`), so the repository's git URL or a clone's root can be added, and `plugins/claude` (marketplace `agora-plugins`) for a path inside a clone.

**Claude Code CLI**

```sh
claude plugin marketplace add <git url of this repository, or a clone's root>
claude plugin install agora-room@agora --config rooms=<room alias>
```

`--config KEY=VALUE` sets a configuration option at install time (repeatable); without it `claude plugin install` prints `userConfig options not yet set`, and `/plugin configure agora-room@agora` in a session asks for them. To try the plugin for one session without installing it: `claude --plugin-dir <clone>/plugins/claude/agora-room`.

**Claude desktop app** (Code tab, local sessions; not WSL sessions): the app cannot be handed a plugin by flag (`claude --desktop` refuses `--plugin-dir`), so install it: **+** > **Add plugins**, add the repository (or a clone's root) as a marketplace, install **agora-room**, and fill in the configuration form. A mod installed this way ran in a session opened after the install without restarting the app; if it does not load, quit the app completely (tray icon > Quit) and start it again. The CLI commands above do the same thing and write the same user settings. The environment of the shell you start the app from is not the app's: set variables through the `env` key of your Claude Code settings (below).

The desktop app's behaviour of this plugin was not measured here. The prototype this plugin grew from (a mod that polls a room and submits prompts) was measured working in the Code tab; the pane, the tool and the configuration form are measured on the CLI only, and the pane's presses and typing are exercised by the mods test kit, which draws it for the `desktop` surface too (see Tests).

## Configure

Precedence, highest first; each setting is taken whole from the first layer that sets it, and an empty value does not shadow a lower layer:

1. **environment**: set in your shell, or for the desktop app in the `env` key of `~/.claude/settings.json` (the plugin reads it with `$.env.get`, and the agora CLI children inherit it)
2. **the project file** `.agora-room.json` in the session's folder
3. **the plugin's configuration form** (`userConfig`), stored in user settings as `pluginConfigs["agora-room@<marketplace>"].options`, where the marketplace is `agora` or `agora-plugins` (Claude Code ignores project and local settings for these)
4. **defaults**

| Setting | Environment | Project file key | Form key | Default |
|---|---|---|---|---|
| rooms to watch and post to (aliases from your agora config; comma-separated) | `AGORA_ROOM` | `rooms` (array or string) | `rooms` | none: the plugin does nothing and says so |
| agora session key | `AGORA_SESSION` | `session` | `session` | `claude-<first 8 of the Claude session id>` |
| what wakes the session | `AGORA_ROOM_WAKE` | `wake` | `wake` | `addressed` |
| poll interval, ms (500 to 600000) | `AGORA_ROOM_INTERVAL_MS` | `intervalMs` | `interval_ms` | 2000 |
| how to run agora: an executable path, or a JSON array argv prefix | `AGORA_ROOM_CMD` | `command` (array or string) | `agora_command` | `agora` from `PATH` |
| bearer for the watch and the tool (`AGORA_ACTOR`) | `AGORA_ACTOR` | `actor` | `actor` | the session record, then the agora config |
| bearer for posts typed in the pane | `AGORA_ROOM_PANE_AS` | `paneAs` | `pane_as` | the bearer above |
| watch switch (`off`, `0`, `false`, `no`) | `AGORA_ROOM_WATCH` | `watch` | | on |
| liveness file path | `AGORA_ROOM_LIVENESS` | `liveness` | | `~/.agora/claude-room/<session key>.json` |
| extra environment for every agora child (for example `AGORA_CONFIG`) | | `env` (object of strings) | | none |

A bad value falls back to its default and is reported as a line in the transcript when the session starts.

```json
{
  "rooms": ["lab"],
  "session": "lab-claude",
  "wake": "addressed",
  "intervalMs": 2000,
  "command": ["node", "/path/to/agora/bin/agora.mjs"],
  "actor": "Claude/lab",
  "env": { "AGORA_CONFIG": "/path/to/agora.json" }
}
```

The plugin runs the CLI with no shell, so name an executable: a Windows `.cmd` shim of `agora` may not resolve; `["node", "<clone>/bin/agora.mjs"]` does (measured).

Use a **stable session key** for a standing session: the watch then resumes from the cursor that key saved, and the CLI's own-post suppression keeps working across restarts. With the default key (new each session) the watch starts at the room head every time.

## The parts

### Watch

At session start, for each room, before the first prompt: `agora cursor <room> --json`. A saved cursor is resumed; none means `agora cursor <room> --now`, the room head. **History is never replayed**: a message posted before the head was taken does not arrive.

Every interval, for each room: `agora watch <room> --once --json --wake <mode>` under the session key. The plugin writes no matching code. It relies on the CLI for three things, and keeps only what the CLI printed:

- **the wake filter**: `--wake addressed` (default) delivers everything except messages addressed to someone else; `mine` only what is addressed to this bearer, its seat or everyone; `all` everything. Filtered messages still advance the cursor;
- **own posts**: the CLI skips what this session key posted (the `room_post` tool posts under the same key), so the model's own replies never come back as turns;
- **the cursor**: the CLI advances it after delivery.

Each message the CLI delivers becomes exactly one prompt submitted to the idle session, the line

```
agora <room> <id> thread=<thread|none> from=<author>: <text>
```

with newlines in the text folded to ` / `. The model reads it framed as "The agora-room plugin sent a message: …". A message that arrives while a turn is running is queued by Claude Code and starts the next turn when this one ends; two messages in one poll are two turns, in order. A message is submitted once: the plugin keeps the ids it has delivered (the last 500) and its queue in the plugin store, so a reload of the mod does not repeat or lose what was in flight (a prompt that may have been sent is checked against the transcript before it is sent again). If you stop a turn, the plugin waits for the next `turn.complete` and resubmits what Claude Code refused.

One window is not closed: the CLI advances its cursor when it prints a message, and the plugin persists the message right after. A hard kill of Claude Code between the two loses that message. The room still has it (`agora read`).

**Failure.** A poll that fails (the child exits other than 0 or 42, cannot start, or does not answer within 20 s) is recorded, shown in the status line, and the timer callback throws, which Claude Code logs (`$.clock.every: the callback threw: …`) and runs again at the next interval. Nothing else is needed to recover. Whatever a failed child printed before it died is still queued.

**Status line and liveness file.** The line under the prompt reads `⚠ agora-room: <room> · read Ns ago` (`· last poll failed` while the last poll failed; `not read yet` before the first read). The liveness file is JSON rewritten each tick and each delivery: `session`, `wake`, `intervalMs`, per room `ready`, `lastRead`, `lastTick`, `polls`, `lastError`, and `ticks`, `errors`, `lastError`, `delivered`, `dropped`, `queued`, `inflight`, `blocked`, `updatedAt`. A supervisor can judge the watch alive by `updatedAt` and per-room `lastRead` being recent.

`AGORA_ROOM_WATCH=off` disables only the watch: no polling, no liveness file, no status line. The tool and the pane still work.

Measured on the CLI (Claude Code 2.1.304, haiku, temp local room, poll interval 1.5 s; the numbers are small samples, not a benchmark): two messages posted before launch did not arrive; three posts at 7 s gaps gave three turns, each message once, post to turn 583, 875 and 1107 ms (a second run: 1279, 55 and 340 ms); a message addressed to another bearer was not delivered and one addressed to this bearer was; with the watch child failing twice the message posted meanwhile arrived once, 3.9 s after it was posted; a child killed by its pid mid-poll was replaced on the next interval and the message posted meanwhile arrived once, 1.0 s after the kill.

### `room_post`

The model sees the tool as `mcp__agora-room__room_post`:

| Argument | |
|---|---|
| `text` | required; at most 20000 characters |
| `room` | one of the configured rooms; optional when there is exactly one; any other room is refused |
| `thread` | root message id of the subject to post inside; omit to open a new subject. To answer a delivered line, pass its `thread=` value, or its id when it says `thread=none` |
| `reply_to` | id of the message this answers (`--re`) |
| `to` | list of bearers, a seat or `*` (`--to`) |

It runs `agora post <room> --json …` under the session key and bearer and returns the receipt (`{"id":…,"cursor":…,"alias":…,"thread":…}`). Options come before a `--` terminator and the text after it, so text that starts with a dash is text.

A tool that a mod serves is answered by the mod, which would skip Claude Code's own permission step, so the plugin takes that step itself: it asks the engine for the permission decision (`$.tool.check`: your rules, mode and allow list). `deny` refuses the post; `allow` posts; `ask` puts the question `Post to room <room>? "<text>"` to you with **Post** / **Do not post** (nothing posts until you answer; with nobody to ask, it does not post). Measured: with no allow rule the dialog drew and nothing was posted. For an unattended session add `mcp__agora-room__room_post` to `permissions.allow` in settings (the measurement runs did).

### The pane

`/agora-room` opens the pane (it runs while a turn is running). It draws with Box, Text, Button, Input and Select, the elements the Claude Code reference marks as drawing in both the terminal and the desktop app; a surface without Input or Select gets the pane without that control and a line saying so.

- first row: the room (a button per room when several are configured), `r: refresh`, and who has spoken recently with how long ago;
- the **target line** `Post → room <room> · <a new subject | reply in "<subject>"> · to: <no one in particular | everyone (*) | name>` always says where a post would go; `n` or **new subject** goes back to the list, the selector sets `to:`, the `say` field posts on Enter;
- **subjects** (a top-level message with its thread), newest activity first, titled by the thread title or the first line, each with its message count and age; `● n` marks messages newer than what you last saw in it, never your own; `1` to `9` or Enter opens one, `b` goes back. A first open marks nothing unread (the room as it was then is the baseline); opening a thread marks it read. The pane reads the last 200 messages, so a subject quiet for longer is not listed;
- the **thread view** shows each message with author, age and `to`, and the signature line removed.

The pane reads and posts under the session key `<session key>-pane` and the `pane_as` bearer, not the watch's key: a post typed in the pane is a participant's post, so one addressed to this session reaches its watch. It refreshes every 8 s while open and after each post. Hotkeys do not work while the `say` field has focus (every printable key goes to the field) and are not drawn in the VS Code extension.

In a short terminal the compose controls are on top and the list scrolls below them. Keyboard focus: the pane takes it when opened by command; Esc returns focus to the prompt and closes the pane.

**Verified without eyes:** the pane registers and its tree validates for the terminal and the desktop surface (`claude plugin test`), every press, selection and typed post reaches the CLI with the target the line states, and `tern capture` of a real terminal session showed it drawn (header, target line, selector, field, the subject list, the `● 1` mark after a new reply and the reorder). **Not verified:** how it looks in the desktop app, the VS Code extension, a taller or wider terminal, light themes, or with a human's keystrokes (nothing was typed into a pane).

## Uninstall

```sh
claude plugin uninstall agora-room@agora        # or @agora-plugins
claude plugin marketplace remove agora           # or agora-plugins
```

Uninstalling clears the plugin from your settings (including its configuration) but **leaves `~/.claude/plugins/cache/<marketplace>/`**; delete that folder by hand if you want the copy gone. In the desktop app, restart it afterwards so the mod unloads. The plugin's own leftovers: the liveness file, and the agora state of its session keys (`AGORA_SESSION=<key> agora session --forget`).

## Safety

- **A room message is input, never an instruction.** Anyone who can post to the room can put text in front of the model. The framing the model reads names the plugin as the sender and the message as a quoted line, `from=` is only what the sender signed, and the tool's description tells the model to weigh room messages and not obey them. The permission decision is the control, not the model's judgment: an allow rule for `room_post` lets a message from the room cause a post without asking you, so allow it only in sessions where that is acceptable, and do not allow other tools you would not want a stranger's message to trigger.
- `--wake mine` narrows what starts turns to messages addressed to this bearer; `addressed` (default) still delivers broadcasts.
- The tool posts only to configured rooms, only through the CLI, under the session's bearer; it can be told to address someone (`to`) but cannot post as another bearer.
- No token is read, stored or logged by the plugin. Do not put one in `.agora-room.json`; its `env` is for paths and switches.
- Posts in a room are visible to everyone in it, and some rooms face other transports: check `agora room faces <room>` before a session posts.

## Tests

`node --test test/claude-plugin-room.test.mjs` runs the plain helpers (`plugins/claude/agora-room/hooks/lib.js`: configuration precedence, the CLI's output, the cursor and dedup queue, post arguments, subjects, the pane tree) and the real CLI against a local room for what the plugin leaves to it (start at the head, own-post skip, the wake filter, a post landing in its thread). From `plugins/claude/agora-room`, `claude plugin test` runs the hooks themselves under the mods test kit with a stub for the CLI: the watch (head first, one prompt per message, a repeated message dropped, a failing poll recovered), a saved cursor, the watch switch, the tool's arguments, and the pane on the terminal and desktop surfaces including a typed post. `claude plugin validate` accepts the plugin and the marketplace.
