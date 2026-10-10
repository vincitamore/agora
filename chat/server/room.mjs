// @ts-check
/**
 * The room through `agora/client`: connect with the host's client name, read history, follow
 * the room live (one follow per open target, fanned out), and append. Holds no state on disk.
 *
 * Not implemented in this build: every function throws.
 */

/**
 * @param {{ agoraDir: string, agoraState?: string, agoraConfig?: string, room: string, clientName: string }} options
 * @returns {Promise<{ close(): void }>}
 */
export async function openRoom(options) {
  void [options];
  throw new Error("not-implemented: chat server room.openRoom");
}
