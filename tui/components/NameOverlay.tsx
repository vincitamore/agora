/**
 * NameOverlay: the one-time question. Shown until the seat's human has a name; the answer is
 * written once to the private human file by the shell's `onName`, and never to the shared
 * config. Always mounted, toggles `visible`; its input holds the typing flag while shown so no
 * letter of the name reaches a hotkey.
 */

import { useRef, useState } from "react";
import type { InputRenderable } from "@opentui/core";
import { humanNameProblem } from "../lib/human";
import { useTypingFlag } from "../lib/typing-context";
import { neutral, primary, semantic } from "../theme";

export function NameOverlay({ shown, width, onName }: { shown: boolean; width: number; onName: (name: string) => Promise<string | undefined> }) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const field = useRef<InputRenderable | null>(null);
  useTypingFlag(shown);
  const boxWidth = Math.max(40, Math.min(width - 4, 64));
  return (
    <box
      position="absolute"
      top={4}
      left={Math.max(1, Math.floor((width - boxWidth) / 2))}
      width={boxWidth}
      visible={shown}
      borderStyle="rounded"
      borderColor={primary.main}
      titleColor={primary.bright}
      title=" YOUR NAME "
      backgroundColor={neutral.panel}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <box height={1} flexShrink={0}>
        <text>
          <span fg={neutral.textDim}>the name rooms will see on your posts, asked once</span>
        </text>
      </box>
      <box height={1} flexShrink={0} flexDirection="row">
        <text>
          <span fg={primary.main}>{"❯ "}</span>
        </text>
        <box flexGrow={1}>
          <input
            ref={(r: InputRenderable | null) => {
              field.current = r;
            }}
            focused={shown}
            placeholder="type your name, then Enter"
            onSubmit={() => {
              const v = field.current?.value ?? "";
              const p = humanNameProblem(v);
              if (p) {
                setProblem(p);
                return;
              }
              void onName(v.trim()).then((err) => setProblem(err));
            }}
          />
        </box>
      </box>
      <box height={1} flexShrink={0}>
        <text>
          <span fg={problem ? semantic.error : neutral.textMuted}>{problem ?? "written to native/human.json under the state root, mode 0600"}</span>
        </text>
      </box>
    </box>
  );
}
