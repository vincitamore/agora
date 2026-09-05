/**
 * PEERS: this seat's sessions from the records under the state root, each with its liveness as
 * a glyph. Remote seats are unknown until the seat service serves a roster; the header says so.
 */

import { memo } from "react";
import { usePollWhileActive, useRoomStore } from "../lib/room-store";
import { useStableDimensions } from "../lib/use-stable-dimensions";
import { fmtDay, trunc, truncPad } from "../lib/format";
import { icons, neutral, presence, primary, semantic } from "../theme";
import { CHROME_ROWS } from "./RoomMember";

const POLL_MS = 5000;

export const PeersMember = memo(function PeersMember({ active }: { active: boolean }) {
  const store = useRoomStore();
  const { width, height } = useStableDimensions();
  usePollWhileActive(active, store.refreshPeers, POLL_MS);

  const memberHeight = Math.max(6, height - CHROME_ROWS);
  const listRows = Math.max(3, memberHeight - 2);
  const rowWidth = Math.max(20, width - 2);
  const bearerCol = 20;
  const stateCol = 9;
  const pidCol = 10;
  const seenCol = 17;
  const slugCol = Math.max(8, rowWidth - (2 + bearerCol + 1 + stateCol + 1 + pidCol + 1 + seenCol + 1));

  const rows = store.peers;

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box height={1} flexShrink={0}>
        <text>
          <span fg={primary.bright}>{icons.peers} PEERS </span>
          <span fg={neutral.textDim}>{trunc("this seat only · remote seats unknown until the seat service serves a roster", Math.max(8, rowWidth - 8))}</span>
        </text>
      </box>
      <box height={1} flexShrink={0}>
        <text>
          <span fg={neutral.textMuted}>
            {`  ${truncPad("BEARER", bearerCol)} ${truncPad("STATE", stateCol)} ${truncPad("PID", pidCol)} ${truncPad("SEEN", seenCol)} ${truncPad("SESSION", slugCol)}`}
          </span>
        </text>
      </box>
      <box flexDirection="column" flexShrink={0} height={listRows}>
        {Array.from({ length: listRows }).map((_, i) => {
          const p = rows[i];
          if (!p) {
            const hint = i === 0 ? (store.peersError ? `peers unreadable: ${store.peersError}` : rows.length ? "" : "no sessions registered on this seat") : "";
            return (
              <box key={i} height={1} flexShrink={0}>
                <text>
                  <span fg={store.peersError ? semantic.warning : neutral.textMuted}>{hint}</span>
                </text>
              </box>
            );
          }
          const pr = presence[p.state];
          return (
            <box key={i} height={1} flexShrink={0}>
              <text>
                <span fg={pr.color}>{pr.glyph} </span>
                <span fg={neutral.text}>{truncPad(p.bearer, bearerCol)} </span>
                <span fg={pr.color}>{truncPad(pr.label, stateCol)} </span>
                <span fg={neutral.textDim}>{truncPad(p.pid !== undefined ? String(p.pid) : "-", pidCol)} </span>
                <span fg={neutral.textDim}>{truncPad(p.lastSeen ? fmtDay(p.lastSeen) : "-", seenCol)} </span>
                <span fg={neutral.textMuted}>{truncPad(p.slug + (p.label ? `  "${p.label}"` : ""), slugCol)}</span>
              </text>
            </box>
          );
        })}
      </box>
    </box>
  );
});
