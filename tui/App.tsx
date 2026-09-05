/**
 * App: the shell. A brand box, the member bar, the members (all mounted at boot, switched by
 * `visible`, memoized with stable props), a hint bar, the toast overlay and the one-time name
 * overlay. Plain-character hotkeys are gated on the typing context; control chords stay live;
 * Ctrl+C quits unconditionally. A client exit disconnects only; it never stops any service.
 */

import { memo, useCallback, useEffect, useState } from "react";
import { EventEmitter } from "node:events";
import { useKeyboard, useRenderer } from "@opentui/react";
import { neutral, primary, semantic } from "./theme";
import { MEMBERS, PEERS_ID, ROOM_ID, SEARCH_ID } from "./registry";
import { MemberBar } from "./components/MemberBar";
import { NameOverlay } from "./components/NameOverlay";
import { TypingProvider, useTyping } from "./lib/typing-context";
import { ToastOverlay, ToastProvider } from "./lib/toast-context";
import { RoomStoreProvider, useRoomStore } from "./lib/room-store";
import { useStableDimensions } from "./lib/use-stable-dimensions";
import { RoomMember } from "./members/RoomMember";
import { SearchMember } from "./members/SearchMember";
import { PeersMember } from "./members/PeersMember";
import type { HumanActor, RoomClient } from "./lib/room-client";

EventEmitter.defaultMaxListeners = Math.max(EventEmitter.defaultMaxListeners, 64);
if (typeof process.setMaxListeners === "function") process.setMaxListeners(64);

export interface AppProps {
  client: RoomClient;
  /** True until the seat's human has a name; the name overlay shows and compose is refused. */
  needsName?: boolean;
  /** Writes the name once and returns a problem string, or nothing on success. */
  onName?: (name: string) => Promise<string | undefined>;
  initialAlias?: string;
  toastTtlMs?: number;
  /** Called on quit after the renderer is destroyed; the entry exits the process here. */
  onQuit?: () => void;
}

const MRoom = memo(RoomMember);
const MSearch = memo(SearchMember);
const MPeers = memo(PeersMember);
const TABS = MEMBERS.map((m) => ({ id: m.id, label: m.label, key: m.key, icon: m.icon }));

export function App(props: AppProps) {
  return (
    <RoomStoreProvider client={props.client} initialAlias={props.initialAlias}>
      <ToastProvider ttlMs={props.toastTtlMs}>
        <TypingProvider>
          <Shell {...props} />
        </TypingProvider>
      </ToastProvider>
    </RoomStoreProvider>
  );
}

function Shell({ needsName = false, onName, onQuit }: AppProps) {
  const renderer = useRenderer();
  const store = useRoomStore();
  const typing = useTyping();
  const { width } = useStableDimensions();
  const [active, setActive] = useState<string>(ROOM_ID);
  const [naming, setNaming] = useState(needsName);

  useEffect(() => setNaming(needsName), [needsName]);

  const quit = useCallback(() => {
    renderer.destroy();
    if (onQuit) onQuit();
    else process.exit(0);
  }, [renderer, onQuit]);

  const cycle = useCallback((dir: 1 | -1) => {
    setActive((cur) => {
      const i = MEMBERS.findIndex((m) => m.id === cur);
      return MEMBERS[(i + dir + MEMBERS.length) % MEMBERS.length]!.id;
    });
  }, []);

  const toRoom = useCallback(() => setActive(ROOM_ID), []);

  const handleName = useCallback(
    async (name: string): Promise<string | undefined> => {
      if (!onName) return "no writer for the name";
      const problem = await onName(name);
      if (problem) return problem;
      const actor: HumanActor = { name, kind: "human" };
      store.client.adopt(actor);
      store.setActor(actor);
      setNaming(false);
      return undefined;
    },
    [onName, store],
  );

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return quit();
    if (key.ctrl && key.name === "n") return cycle(1);
    if (key.ctrl && key.name === "p") return cycle(-1);
    if (typing || key.ctrl || naming) return;
    if (key.name === "q") return quit();
    if (key.name === "/") return setActive(SEARCH_ID);
    const digit = MEMBERS.find((m) => m.key === key.name);
    if (digit) return setActive(digit.id);
  });

  const activeDef = MEMBERS.find((m) => m.id === active);
  const who = store.actor.name || "(unnamed)";
  const loadedRoom = store.rooms.find((r) => r.alias === store.alias);
  // the hint names the loaded room's transport (the config's choice), and whether it is followed
  const sourceLabel = `${loadedRoom ? `${loadedRoom.transport} room` : store.client.kind}${store.live ? " · live" : ""}`;

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={neutral.background}>
      <box borderStyle="rounded" borderColor={neutral.border} paddingLeft={1} paddingRight={1} flexDirection="row" flexShrink={0} height={3}>
        <text>
          <span fg={primary.bright}>agora</span>
          <span fg={neutral.textMuted}> · </span>
          <span fg={primary.main}>{who}</span>
          <span fg={neutral.textMuted}> (human) · </span>
          <span fg={neutral.text}>{activeDef?.label ?? ""}</span>
          <span fg={neutral.textMuted}>{"   1-3 or ctrl+n/p switch · q quit"}</span>
        </text>
      </box>

      <box paddingLeft={1} paddingRight={1} flexShrink={0} height={1}>
        <MemberBar tabs={TABS} active={active} onSwitch={setActive} />
      </box>

      <box flexDirection="column" flexGrow={1}>
        <box visible={active === ROOM_ID} flexGrow={1} flexDirection="column">
          <MRoom active={active === ROOM_ID && !naming} />
        </box>
        <box visible={active === SEARCH_ID} flexGrow={1} flexDirection="column">
          <MSearch active={active === SEARCH_ID && !naming} onJump={toRoom} />
        </box>
        <box visible={active === PEERS_ID} flexGrow={1} flexDirection="column">
          <MPeers active={active === PEERS_ID && !naming} />
        </box>
      </box>

      <box paddingLeft={1} paddingRight={1} flexShrink={0} height={1}>
        <text>
          <span fg={semantic.info}>{sourceLabel}</span>
          <span fg={neutral.textMuted}>
            {active === ROOM_ID
              ? " · j/k or arrows move · enter folds · i compose · alt+enter send · esc leave · r re-read"
              : active === SEARCH_ID
                ? " · type to search · arrows move · enter jumps to ROOM"
                : " · this seat's sessions, from the state root"}
          </span>
        </text>
      </box>

      <ToastOverlay width={width} />
      <NameOverlay shown={naming} width={width} onName={handleName} />
    </box>
  );
}
