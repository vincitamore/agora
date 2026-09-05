// @ts-check
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateRouteBinding } from './protocol/route.mjs';
import { validateWireAttachment, validateAttachmentReference } from './protocol/attachment.mjs';
import { PROTOCOL_LIMITS } from './protocol/common.mjs';
import { AgoraError } from './core.mjs';

/** @typedef {import('./protocol/route.mjs').RouteBinding} RouteBinding */
/** @typedef {import('./protocol/attachment.mjs').WireAttachment} WireAttachment */
/** P1 supplies a pinned immutable stream, never a path for P2 to reopen.
 * closed is P1's actual stream-disposal join, distinct from EOF or destroyed.
 * @typedef {{info:WireAttachment,readable:Readable,closed:Promise<unknown>,release:()=>void|Promise<void>}} PinnedObject */

/**
 * Local byte-delivery seam. P1 authenticates callers, checks current authority when
 * opening an object, owns canonical custody and aborts signal on route revocation.
 * This factory supplies neither a protocol parser nor an authorization registry.
 * A successful send proves this stream matched the allowed digest/size; it is not
 * a receiver materialization or native commit receipt.
 * @param {unknown} bindingValue
 * @param {unknown[]} allowlist
 * @param {{signal:AbortSignal,maxBytes:number,openObject:(binding:RouteBinding,attachment:WireAttachment,signal:AbortSignal)=>Promise<PinnedObject>}} options
 */
export function createRouteObjectSender(bindingValue, allowlist, options) {
  const binding = validateRouteBinding(bindingValue);
  Object.freeze(binding.host); Object.freeze(binding.member); Object.freeze(binding);
  const { signal, maxBytes, openObject } = options;
  if (!(signal instanceof AbortSignal) || signal.aborted || typeof openObject !== 'function'
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw custodyError('configuration');
  if (!Array.isArray(allowlist) || allowlist.length > PROTOCOL_LIMITS.attachments) throw custodyError('allowlist');
  const entries = allowlist.map(value => Object.freeze(validateWireAttachment(value)));
  const objects = new Map(entries.map(entry => [entry.id, entry]));
  if (objects.size !== entries.length || entries.some(entry => entry.lifetime !== 'durable' || entry.size > maxBytes)) throw custodyError('allowlist');

  return Object.freeze({
    /** The request selects only an already allowed immutable identity.
     * Caller owns destination before invocation; once acquired, pipeline owns its
     * destruction on failure. No native acknowledgement is generated here.
     * @param {unknown} request
     * @param {import('node:stream').Writable} destination
     */
    async send(request, destination) {
      const ref = validateAttachmentReference(request);
      const attachment = objects.get(ref.id);
      if (!attachment || attachment.digest !== ref.digest || attachment.lifetime !== ref.lifetime) throw custodyError('not-allowed');
      signal.throwIfAborted();
      // Await acquisition even after cancellation: a late handle must be released.
      const object = await openObject(binding, attachment, signal);
      if (!object || typeof object.release !== 'function' || !(object.closed instanceof Promise)) {
        if (object?.readable instanceof Readable) object.readable.destroy();
        throw custodyError('invalid-handle');
      }
      void object.closed.catch(() => {});
      let readable;
      try {
        readable = object.readable;
        if (!(readable instanceof Readable)) throw custodyError('invalid-stream');
        signal.throwIfAborted();
        const info = validateWireAttachment(object.info);
        if (info.id !== attachment.id || info.digest !== attachment.digest || info.size !== attachment.size
          || info.lifetime !== 'durable') throw custodyError('object-context');
        let size = 0;
        const digest = createHash('sha256');
        const verifier = new Transform({
          transform(chunk, _encoding, done) {
            if (!(chunk instanceof Uint8Array)) { done(custodyError('non-bytes')); return; }
            size += chunk.byteLength;
            if (size > attachment.size || size > maxBytes) { done(custodyError('size')); return; }
            digest.update(chunk); done(null, chunk);
          },
          flush(done) {
            if (size !== attachment.size || `sha256:${digest.digest('hex')}` !== attachment.digest) { done(custodyError('digest')); return; }
            done();
          },
        });
        await pipeline(readable, verifier, destination, { signal });
        return { id: attachment.id, digest: attachment.digest, size };
      } finally {
        // destroy without embedding a possibly sensitive upstream error in logs.
        if (readable instanceof Readable) {
          if (!readable.destroyed) readable.destroy();
        }
        await object.closed.catch(() => {});
        await object.release();
      }
    },
  });
}

/** @param {string} reason */
function custodyError(reason) {
  return Object.assign(new AgoraError('Native object transfer refused. Inspect the local custody owner.'), { code: `AGORA_CUSTODY_${reason.toUpperCase().replaceAll('-', '_')}` });
}
