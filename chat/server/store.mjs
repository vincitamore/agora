// @ts-check
/**
 * The kit's own store, `kit.sqlite` under the host's `storeDir` (bun:sqlite): read positions,
 * reactions by name, push subscriptions and prefs, the message index (FTS5) with the `context`,
 * `waiting` and `card` trailers indexed, and thumbnails by digest. Schema and migrations live here.
 *
 * Not implemented in this build: every function throws.
 */

/**
 * @param {string} storeDir
 * @returns {Promise<{ close(): void }>}
 */
export async function openKitStore(storeDir) {
  void [storeDir];
  throw new Error("not-implemented: chat server store.openKitStore");
}
