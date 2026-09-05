/**
 * The member set, declared once. The shell maps over this to mount every member eagerly at
 * boot and switch by visibility; adding a member is one line here.
 */

import { icons } from "./theme";

export interface MemberDef {
  id: string;
  label: string;
  /** Single digit hotkey, also the indicator in the member bar. */
  key: string;
  icon: string;
}

export const ROOM_ID = "room";
export const SEARCH_ID = "search";
export const PEERS_ID = "peers";

export const MEMBERS: MemberDef[] = [
  { id: ROOM_ID, label: "ROOM", key: "1", icon: icons.room },
  { id: SEARCH_ID, label: "SEARCH", key: "2", icon: icons.search },
  { id: PEERS_ID, label: "PEERS", key: "3", icon: icons.peers },
];
