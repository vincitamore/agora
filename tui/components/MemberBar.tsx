/**
 * MemberBar: the member strip. Controlled by the shell, which owns the active id and the
 * hotkeys (digits, Ctrl+N/P); clicking a member is the mouse equal. One row, never shrinks.
 */

import { neutral, primary } from "../theme";

export interface MemberTab {
  id: string;
  label: string;
  key: string;
  icon: string;
}

export function MemberBar({ tabs, active, onSwitch }: { tabs: MemberTab[]; active: string; onSwitch: (id: string) => void }) {
  return (
    <box flexDirection="row" flexShrink={0} height={1}>
      {tabs.map((tab, i) => {
        const isActive = tab.id === active;
        return (
          <box key={tab.id} onMouseDown={() => onSwitch(tab.id)} flexDirection="row" height={1}>
            <text>
              {i > 0 ? <span fg={neutral.textMuted}>{"  ·  "}</span> : null}
              <span fg={isActive ? primary.bright : neutral.textDim}>
                {tab.icon} [{tab.key}] {tab.label}
              </span>
            </text>
          </box>
        );
      })}
    </box>
  );
}
