/**
 * ROOM: the loaded room as a fixed-slot windowed list of display lines (never a scrollbox of
 * mounted rows), newest at the bottom, a message cursor the view follows, threads folded under
 * their root, and compose under the list. Every message renders through the CLI's own header
 * and derived-line functions, so what the person sees here is what `agora read` prints.
 *
 * Keys, both dialects: up/down or j/k move the cursor; PageUp/PageDown scroll half a window
 * without moving it; Home/End or g/G
 * to the oldest/newest; Enter or t folds and unfolds; i composes; r re-reads; Esc leaves compose.
 * In compose, Alt+Enter sends (Ctrl+Enter too, where the terminal can tell it from Enter).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { defaultTextareaKeyBindings, type TextareaRenderable } from "@opentui/core";
import { usePollWhileActive, useRoomStore } from "../lib/room-store";
import { useStableDimensions } from "../lib/use-stable-dimensions";
import { useTypingFlag } from "../lib/typing-context";
import { useToast } from "../lib/toast-context";
import { buildLines, foldThreads, type Line } from "../lib/room-model";
import { composeRefusal, preparePost } from "../lib/compose-guard";
import { clamp, trunc, truncPad } from "../lib/format";
import { authorColor, icons, neutral, presence, primary, semantic } from "../theme";
import type { PeerRow } from "../lib/room-client";
import { shown, shownError } from "../lib/safe-text";

/** Rows the shell keeps above and below a member (brand box 3, member bar 1, hint bar 1). */
export const CHROME_ROWS = 5;
/** Rows the compose box takes: border, two text rows, border. */
const COMPOSE_ROWS = 4;
const POLL_MS = 2000;
const PEERS_POLL_MS = 5000;

const SEND_BINDINGS = [
  ...defaultTextareaKeyBindings,
  { name: "return", ctrl: true, action: "submit" as const },
  { name: "return", meta: true, action: "submit" as const },
];

function peersLine(peers: PeerRow[], error: string | undefined, width: number): { text: string; color: string } {
  if (error) return { text: shown(`peers unreadable: ${error}`), color: semantic.warning };
  if (!peers.length) return { text: "no sessions registered on this seat", color: neutral.textMuted };
  const parts = peers.map((p) => `${presence[p.state].glyph} ${p.bearer}`);
  return { text: trunc(parts.join("  "), width), color: neutral.textDim };
}

function toneColor(line: Line, isCursor: boolean): string {
  switch (line.tone) {
    case "header":
      return authorColor[line.kind ?? "unknown"] ?? neutral.textDim;
    case "derived":
      return primary.bright;
    case "fold":
      return semantic.warning;
    case "attachment":
      return neutral.textDim;
    case "note":
      return neutral.textMuted;
    case "blank":
      return neutral.textMuted;
    default:
      return isCursor ? neutral.text : neutral.textDim;
  }
}

export const RoomMember = memo(function RoomMember({ active }: { active: boolean }) {
  const store = useRoomStore();
  const toast = useToast();
  const { width, height } = useStableDimensions();
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(-1);
  const [composing, setComposing] = useState(false);
  // A line offset the person set with PageUp/PageDown; null means the window follows the cursor.
  const [manualTop, setManualTop] = useState<number | null>(null);
  const editor = useRef<TextareaRenderable | null>(null);
  const topRef = useRef(0);

  useTypingFlag(active && composing);
  usePollWhileActive(active, store.refresh, POLL_MS);
  usePollWhileActive(active, store.refreshPeers, PEERS_POLL_MS);

  const memberHeight = Math.max(6, height - CHROME_ROWS);
  const listRows = Math.max(3, memberHeight - 1 - COMPOSE_ROWS);
  const listWidth = Math.max(20, width - 2);

  const entries = useMemo(() => foldThreads(store.messages), [store.messages]);
  const lines = useMemo(() => buildLines(entries, { width: listWidth, unfolded }), [entries, listWidth, unfolded]);

  // The cursor follows the newest entry until the person moves it; -1 means "follow the tail".
  const follow = cursor < 0 || cursor >= entries.length;
  const cursorEntry = entries.length ? (follow ? entries.length - 1 : cursor) : -1;

  // SEARCH hands over an id; land the cursor on its entry (root or the root of its thread).
  useEffect(() => {
    if (!store.jump) return;
    const id = store.jump;
    const at = entries.findIndex((e) => e.root.id === id || e.replies.some((r) => r.id === id));
    if (at >= 0) {
      setCursor(at);
      const e = entries[at]!;
      if (e.replies.some((r) => r.id === id)) setUnfolded((s) => new Set(s).add(e.root.id));
    }
    store.clearJump();
  }, [store.jump, entries, store]);

  // Functional update: a burst of keys before a render must step from the latest cursor, not
  // from the value this closure was rendered with.
  const count = entries.length;
  const move = useCallback(
    (delta: number) => {
      if (!count) return;
      setManualTop(null);
      setCursor((prev) => {
        const from = prev < 0 || prev >= count ? count - 1 : prev;
        const next = clamp(from + delta, 0, count - 1);
        return next === count - 1 ? -1 : next;
      });
    },
    [count],
  );

  const toggleFold = useCallback(() => {
    const e = entries[cursorEntry];
    if (!e || !e.replies.length) return;
    setUnfolded((s) => {
      const n = new Set(s);
      if (n.has(e.root.id)) n.delete(e.root.id);
      else n.add(e.root.id);
      return n;
    });
  }, [entries, cursorEntry]);

  const send = useCallback(async () => {
    const ed = editor.current;
    if (!ed || !store.alias) return;
    const text = ed.plainText;
    const refusal = composeRefusal(text, store.actor);
    if (refusal) {
      toast(refusal, "error");
      return;
    }
    try {
      const r = await store.client.post(store.alias, preparePost(text, store.actor));
      ed.clear();
      setComposing(false);
      setCursor(-1);
      toast(`posted ${r.id} at cursor ${r.cursor}`, "success");
      await store.refresh();
    } catch (e) {
      toast(`not sent: ${shownError(e)}`, "error");
    }
  }, [store, toast]);

  useKeyboard((key) => {
    if (!active) return;
    const n = key.name;
    if (composing) {
      if (n === "escape") setComposing(false);
      return;
    }
    if (n === "up" || n === "k") return move(-1);
    if (n === "down" || n === "j") return move(1);
    if (n === "pageup") return setManualTop(Math.max(0, topRef.current - Math.max(1, Math.floor(listRows / 2))));
    if (n === "pagedown") return setManualTop(topRef.current + Math.max(1, Math.floor(listRows / 2)));
    if (n === "home" || n === "g") {
      setManualTop(null);
      return setCursor(0);
    }
    if (n === "end" || (n === "g" && key.shift) || n === "G") {
      setManualTop(null);
      return setCursor(-1);
    }
    if (n === "return" || n === "t") {
      setManualTop(null);
      return toggleFold();
    }
    if (n === "i") return setComposing(true);
    if (n === "r") return void store.refresh();
  });

  // Window: keep the cursor entry's block in view; the last committed top is a ref, not state,
  // so a scroll never re-renders twice and never changes the slot count.
  const total = lines.length;
  let top = clamp(topRef.current, 0, Math.max(0, total - listRows));
  if (manualTop !== null) top = clamp(manualTop, 0, Math.max(0, total - listRows));
  else if (cursorEntry >= 0) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < total; i++) {
      if (lines[i]!.entry === cursorEntry) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0) {
      const tall = last - first + 1 > listRows;
      if (follow) top = tall ? first : Math.max(0, total - listRows);
      else if (first < top) top = first;
      else if (last >= top + listRows) top = tall ? first : last - listRows + 1;
    }
  }
  topRef.current = top;

  const roomInfo = store.rooms.find((r) => r.alias === store.alias);
  const oldest = store.horizon?.oldestCursor;
  const headLead = `${icons.room} ROOM ${store.alias ?? "(none)"}${roomInfo ? ` · ${roomInfo.transport}` : ""}${oldest ? ` · from cursor ${oldest}` : ""}   PEERS `;
  const headTail = " · this seat only";
  const peers = peersLine(store.peers, store.peersError, Math.max(8, width - 2 - headLead.length - headTail.length));
  const status = store.error
    ? { text: shown(`room unreadable: ${store.error}`), color: semantic.error }
    : !store.alias
      ? { text: "no local room in the config", color: semantic.warning }
      : !entries.length
        ? { text: "nothing in this room yet", color: neutral.textMuted }
        : { text: "", color: neutral.textMuted };

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box height={1} flexShrink={0} flexDirection="row">
        <text>
          <span fg={primary.bright}>{icons.room} ROOM </span>
          <span fg={neutral.text}>{store.alias ?? "(none)"}</span>
          <span fg={neutral.textMuted}>{roomInfo ? ` · ${roomInfo.transport}` : ""}</span>
          <span fg={neutral.textMuted}>{oldest ? ` · from cursor ${oldest}` : ""}</span>
          <span fg={neutral.textMuted}>{"   PEERS "}</span>
          <span fg={peers.color}>{peers.text}</span>
          <span fg={neutral.textMuted}>{headTail}</span>
        </text>
      </box>

      <box
        flexDirection="column"
        flexShrink={0}
        height={listRows}
        onMouseScroll={(e: { scroll?: { direction: string } }) => {
          if (!active || composing) return;
          if (e.scroll?.direction === "up") move(-1);
          else if (e.scroll?.direction === "down") move(1);
        }}
      >
        {Array.from({ length: listRows }).map((_, i) => {
          const idx = top + i;
          const line = lines[idx];
          if (!line) {
            return (
              <box key={i} height={1} flexShrink={0}>
                <text>
                  <span fg={status.color}>{i === 0 ? status.text : ""}</span>
                </text>
              </box>
            );
          }
          const isCursorHeader = line.entry === cursorEntry && line.tone === "header" && !line.reply;
          return (
            <box key={i} height={1} flexShrink={0} backgroundColor={isCursorHeader ? neutral.selection : undefined}>
              <text>
                <span fg={isCursorHeader ? primary.bright : neutral.textMuted}>{isCursorHeader ? `${icons.cursor} ` : "  "}</span>
                <span fg={toneColor(line, line.entry === cursorEntry)}>{truncPad(line.text, listWidth - 2)}</span>
              </text>
            </box>
          );
        })}
      </box>

      <box
        height={COMPOSE_ROWS}
        flexShrink={0}
        borderStyle="rounded"
        borderColor={composing ? primary.main : neutral.border}
        titleColor={composing ? primary.bright : neutral.textDim}
        title={composing ? ` COMPOSE as ${store.actor.name || "(unnamed)"} · alt+enter sends · esc leaves ` : " i to compose "}
        flexDirection="column"
      >
        <textarea
          ref={(r: TextareaRenderable | null) => {
            editor.current = r;
          }}
          focused={active && composing}
          placeholder={composing ? "" : "press i to compose; the post is signed with your name"}
          placeholderColor={neutral.textMuted}
          keyBindings={SEND_BINDINGS}
          onSubmit={() => void send()}
        />
      </box>
    </box>
  );
});
