// @ts-check
// Compile-only consumer fixture. npm run check includes this file; no I/O or effects.
/** @param {import('../src/protocol/origin.mjs').OriginSource} origin */
export function nativeOriginHost(origin) {
  if (origin.transport === 'native') return origin.host.id;
  // @ts-expect-error External origins do not carry a native host.
  void origin.host;
  return null;
}

/** @type {import('../src/protocol/identity.mjs').AcceptedHostContext} */
export const validHost = { host: { scheme: 'native', authority: 'house', id: 'host_account_0001' } };
/** @type {import('../src/protocol/identity.mjs').AcceptedHostContext} */
export const wrongHost = {
  // @ts-expect-error Accepted host authority is native, never an external face.
  host: { scheme: 'slack', authority: 'house', id: 'host_account_0001' },
};
/** @type {import('../src/protocol/read.mjs').NativeReadRoom} */
export const wrongRoom = {
  // @ts-expect-error A native scan cannot acquire a Slack host type.
  host: { scheme: 'slack', authority: 'house', id: 'host_account_0001' },
  roomId: '1'.repeat(32), epoch: '2'.repeat(32),
};
/** @type {import('../src/protocol/capabilities.mjs').NegotiatedCapabilities} */
export const validCapabilities = { host: validHost.host, negotiated: ['contracts-v2', 'board-v1'] };
/** @type {import('../src/protocol/capabilities.mjs').NegotiatedCapabilities} */
export const wrongCapabilities = {
  host: validHost.host,
  // @ts-expect-error Negotiation exposes a closed vocabulary, not arbitrary strings.
  negotiated: ['unknown-v9'],
};
