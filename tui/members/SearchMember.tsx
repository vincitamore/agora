/**
 * SEARCH: a substring search over the messages the room store has loaded, in memory only (no
 * store, no index yet). Rows render like ROOM rows; one horizon line says what the search could
 * see and when. It prints no count of any kind: not of rows, not of authors, not of anything.
 * Enter jumps ROOM to the row under the cursor.
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useRoomStore } from "../lib/room-store";
import { useStableDimensions } from "../lib/use-stable-dimensions";
import { useTypingFlag } from "../lib/typing-context";
import { searchMessages } from "../lib/room-model";
import { clamp, fmtClock, fmtDay, trunc, truncPad } from "../lib/format";
import { redact } from "../../src/core.mjs";
import { authorColor, icons, neutral, primary, semantic } from "../theme";
import { CHROME_ROWS } from "./RoomMember";

const DEBOUNCE_MS = 120;

export const SearchMember = memo(function SearchMember({ active, onJump }: { active: boolean; onJump: () => void }) {
  const store = useRoomStore();
  const { width, height } = useStableDimensions();
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [cursor, setCursor] = useState(0);
  const [top, setTop] = useState(0);

  useTypingFlag(active);

  useEffect(() => {
    const t = setTimeout(() => {
      setApplied(query);
      setCursor(0);
      setTop(0);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const rows = useMemo(() => searchMessages(store.messages, applied), [store.messages, applied]);
  const memberHeight = Math.max(6, height - CHROME_ROWS);
  const listRows = Math.max(3, memberHeight - 4);
  const rowWidth = Math.max(20, width - 2);

  const move = useCallback(
    (delta: number) => {
      const c = clamp(cursor + delta, 0, Math.max(0, rows.length - 1));
      setCursor(c);
      setTop((t) => (c < t ? c : c >= t + listRows ? c - listRows + 1 : t));
    },
    [cursor, rows.length, listRows],
  );

  useKeyboard((key) => {
    if (!active) return;
    const n = key.name;
    if (n === "up") return move(-1);
    if (n === "down") return move(1);
    if (n === "pageup") return move(-listRows);
    if (n === "pagedown") return move(listRows);
    if (n === "return") {
      const hit = rows[cursor];
      if (!hit) return;
      store.requestJump(hit.id);
      onJump();
    }
  });

  const h = store.horizon;
  const horizonText = h
    ? `horizon: ${h.alias} · oldest loaded ${h.oldestTs ? fmtDay(h.oldestTs) : "nothing"}${h.oldestCursor ? ` (cursor ${h.oldestCursor})` : ""} · read ${fmtClock(h.readAt)} · ${h.source} · older messages are not searched here`
    : "horizon: no room loaded yet";

  const tsCol = 8;
  const whoCol = 18;
  const curCol = 7;
  const textCol = Math.max(10, rowWidth - (2 + tsCol + 1 + whoCol + 1 + curCol + 1));

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box height={1} flexShrink={0}>
        <text>
          <span fg={primary.bright}>{icons.search} SEARCH </span>
          <span fg={neutral.textDim}>{trunc("in the loaded room, in memory · enter jumps to the message", Math.max(8, rowWidth - 9))}</span>
        </text>
      </box>
      <box height={1} flexShrink={0} flexDirection="row">
        <text>
          <span fg={primary.main}>{"❯ "}</span>
        </text>
        <box flexGrow={1}>
          <input focused={active} onInput={(v: string) => setQuery(v)} placeholder="type to search text and author" />
        </box>
      </box>

      <box flexDirection="column" flexShrink={0} height={listRows}>
        {Array.from({ length: listRows }).map((_, i) => {
          const idx = top + i;
          const m = rows[idx];
          if (!m) {
            const hint = i === 0 ? (applied.trim() ? (rows.length ? "" : "no row matches in the loaded room") : "rows appear as you type") : "";
            return (
              <box key={i} height={1} flexShrink={0}>
                <text>
                  <span fg={neutral.textMuted}>{hint}</span>
                </text>
              </box>
            );
          }
          const isCursor = idx === cursor;
          const preview = redact(m.text).replace(/\s+/g, " ").trim();
          return (
            <box key={i} height={1} flexShrink={0} backgroundColor={isCursor ? neutral.selection : undefined}>
              <text>
                <span fg={isCursor ? primary.bright : neutral.textMuted}>{isCursor ? icons.cursor : " "} </span>
                <span fg={neutral.textDim}>{truncPad(fmtClock(m.ts), tsCol)} </span>
                <span fg={authorColor[m.author.kind] ?? neutral.textDim}>{truncPad(`${m.author.name} (${m.author.kind})`, whoCol)} </span>
                <span fg={neutral.textMuted}>{truncPad(`c${m.cursor}`, curCol)} </span>
                <span fg={isCursor ? neutral.text : neutral.textDim}>{truncPad(preview, textCol)}</span>
              </text>
            </box>
          );
        })}
      </box>

      <box height={1} flexShrink={0}>
        <text>
          <span fg={semantic.warning}>{truncPad(horizonText, rowWidth)}</span>
        </text>
      </box>
    </box>
  );
});
