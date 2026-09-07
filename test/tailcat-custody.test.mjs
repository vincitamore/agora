// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { createRouteObjectSender } from '../src/tailcat-custody.mjs';

const bytes = Buffer.from('canonical object');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const host = { scheme: /** @type {const} */ ('native'), authority:'seat-A', id:'host000000000001' };
const binding = { host, member:host, accountId:'account000000001', serviceBootId:'boot000000000001', roomId:'a'.repeat(32), roomEpoch:'b'.repeat(32), membershipRevision:1, grantId:'grant00000000001', routeGeneration:'route00000000001', allowedKeyDigest:digest };
const info = { id:'attachment000001', digest, lifetime:/** @type {const} */('durable'), name:'object.bin', kind:/** @type {const} */('file'), size:bytes.length };
const ref = { id:info.id, digest, lifetime:info.lifetime };
function sink() { const chunks = /** @type {Buffer[]} */([]); return { chunks, writable:new Writable({write(chunk,_encoding,done) { chunks.push(Buffer.from(chunk)); done(); }}) }; }

test('custody: exact immutable allowlist, captured binding, no path or unknown identity opens', async () => {
  let opens=0, releases=0;
  const original=structuredClone(binding), allowed=structuredClone(info);
  const sender=createRouteObjectSender(original,[allowed],{signal:new AbortController().signal,maxBytes:100,
    async openObject(captured, attachment) { opens++; assert.equal(captured.membershipRevision,1); assert.equal(attachment.digest,digest); assert.ok(Object.isFrozen(captured.host)); return pinned(Readable.from([bytes]),info,()=>{releases++;}); }});
  original.membershipRevision=2; allowed.digest=`sha256:${'f'.repeat(64)}`;
  // Each arm is paired with the refusal it is FOR. One shared bare assertion let any arm pass on
  // any other arm's failure, and they do not even fail alike: three are send-time custody refusals
  // against a valid allowlist (code not-allowed), while a request carrying a path is refused by the
  // protocol validator before custody sees it. Asserting the code, never the text: every custody
  // refusal shares one outward message on purpose, so the message cannot tell these apart.
  for (const [request, expected] of [
    [{ ...ref, id: 'attachment000002' }, { code: 'AGORA_CUSTODY_NOT_ALLOWED' }],
    [{ ...ref, digest: `sha256:${'f'.repeat(64)}` }, { code: 'AGORA_CUSTODY_NOT_ALLOWED' }],
    [{ ...ref, path: '/private/file' }, { name: 'ProtocolValidationError' }],
    [{ ...ref, lifetime: 'offer' }, { code: 'AGORA_CUSTODY_NOT_ALLOWED' }],
  ]) await assert.rejects(sender.send(/** @type {any} */ (request), sink().writable), expected);
  assert.equal(opens,0);
  const out=sink(); assert.deepEqual(await sender.send(ref,out.writable),{id:info.id,digest,size:bytes.length});
  assert.deepEqual(Buffer.concat(out.chunks),bytes); assert.equal(releases,1);
    // Construction-time: the HOST's own allowlist is malformed, so no send ever happens. That is a
  // different phase from a request refused against a valid allowlist (not-allowed), and the code
  // is what keeps the two apart -- they share one message.
  assert.throws(()=>createRouteObjectSender(binding,[info,info],{signal:new AbortController().signal,maxBytes:100,async openObject(){throw Error('unused');}}), { code: 'AGORA_CUSTODY_ALLOWLIST' });
});

test('custody: changed, short, oversized and wrong-object streams cannot finish successfully', async () => {
  for (const mode of ['changed','short','long','context']) {
    let released=0;
    const supplied=mode==='changed'?Buffer.alloc(bytes.length):mode==='short'?bytes.subarray(1):mode==='long'?Buffer.concat([bytes,Buffer.from('x')]):bytes;
    const sender=createRouteObjectSender(binding,[info],{signal:new AbortController().signal,maxBytes:100,async openObject(){return pinned(Readable.from([supplied]),mode==='context'?{...info,id:'attachment000002'}:info,()=>{released++;});}});
    // Each mode is refused for its OWN reason and the codes say which: a changed or truncated
    // stream fails the digest, an oversized one fails the size bound, and a wrong object fails the
    // context check. One bare assertion here let every mode pass on any other mode's refusal --
    // four scenarios, one undiscriminating check. The message cannot separate them (custody mints
    // one outward message for every reason on purpose), so the code is the only thing that can.
    const expected = { code: mode === 'long' ? 'AGORA_CUSTODY_SIZE'
      : mode === 'context' ? 'AGORA_CUSTODY_OBJECT_CONTEXT' : 'AGORA_CUSTODY_DIGEST' };
    const out=sink(); await assert.rejects(sender.send(ref,out.writable), expected); assert.equal(released,1);
    assert.equal(out.writable.writableFinished,false);
    if(mode==='context'||mode==='long') assert.equal(out.chunks.length,0);
  }
});

test('custody: cancellation during acquisition owns and releases the late object', async () => {
  const controller=new AbortController(); let release=0;
  let acquired=/** @type {(value:import('../src/tailcat-custody.mjs').PinnedObject)=>void} */(()=>{});
  const pending=new Promise(resolve=>{ acquired=resolve; });
  const stream=Readable.from([bytes]);
  const sender=createRouteObjectSender(binding,[info],{signal:controller.signal,maxBytes:100,openObject:()=>/** @type {Promise<import('../src/tailcat-custody.mjs').PinnedObject>} */(pending)});
  const out=sink(), result=sender.send(ref,out.writable);
  controller.abort(); acquired(pinned(stream,info,()=>{release++;}));
  // Measured, not assumed: cancellation during acquisition surfaces the ABORT itself (a DOMException,
  // code 20), not a custody refusal -- the send never reached a custody check. A bare rejects here
  // credited both readings equally, and my own first guess at this site was the wrong one.
  await assert.rejects(result, { name: 'AbortError', code: 20 }); assert.equal(release,1); assert.equal(stream.destroyed,true); assert.equal(out.chunks.length,0);
});

test('custody: mid-stream revocation and destination failure release the pinned object', async () => {
  for(const mode of ['abort','destination']) {
    const controller=new AbortController(); let releases=0;
    const source=new Readable({read(){this.push(bytes.subarray(0,2)); this._read=()=>{};}});
    const destination=new Writable({write(_chunk,_encoding,done){if(mode==='abort'){controller.abort();done();}else done(Error('broken target'));}});
    const sender=createRouteObjectSender(binding,[info],{signal:controller.signal,maxBytes:100,async openObject(){return pinned(source,info,()=>{releases++;});}});
    // The two modes fail for entirely different reasons and the single bare assertion could not tell
    // them apart. 'abort' is a real mid-stream revocation and surfaces the abort (code ABORT_ERR);
    // 'destination' is the FIXTURE'S OWN injected failure travelling back up -- Error('broken
    // target'), with no code, thrown by this test's writable, not by custody. So the arm that looks
    // like it proves "the system refused" actually proves "a destination error propagates", which
    // is worth testing and is not the same claim. Asserting each separately is what keeps a broken
    // stub from passing as a working guard.
    const expected = mode === 'abort' ? { code: 'ABORT_ERR' } : /broken target/;
    await assert.rejects(sender.send(ref,destination), expected); assert.equal(releases,1); assert.equal(source.destroyed,true);
  }
});

test('custody: failed release cannot be presented as successful delivery', async () => {
  const sender=createRouteObjectSender(binding,[info],{signal:new AbortController().signal,maxBytes:100,async openObject(){return pinned(Readable.from([bytes]),info,()=>{throw Error('release failed');});}});
  await assert.rejects(sender.send(ref,sink().writable),/release failed/);
});

test('custody: late or rejected streams finish asynchronous disposal before releasing the pin', async () => {
  let disposed = /** @type {()=>void} */ (()=>{}), released=false, settled=false;
  const source = new Readable({read(){}, destroy(_error, done){disposed=()=>done();}});
  const sender=createRouteObjectSender(binding,[info],{signal:new AbortController().signal,maxBytes:100,async openObject(){return pinned(source,{...info,id:'attachment000002'},()=>{assert.equal(source.closed,true);released=true;});}});
  const result=sender.send(ref,sink().writable); const refused=assert.rejects(result);
  void result.then(()=>{settled=true;},()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(source.destroyed,true); assert.equal(source.closed,false); assert.equal(released,false); assert.equal(settled,false);
  disposed(); await refused; assert.equal(released,true);
});

/** Default-fixture custody owner joins its stream's actual close event.
 * @param {Readable} readable @param {typeof info} metadata @param {()=>void} release */
function pinned(readable,metadata,release) {
  const closed=readable.closed?Promise.resolve():new Promise(resolve=>readable.once('close',()=>resolve(undefined)));
  return {info:metadata,readable,closed,release};
}

test('custody: owner disposal join supports ended non-auto-destroy and emitClose:false streams', async () => {
  for (const ended of [false,true]) for (const emitClose of [false,true]) {
    let finishDestroy=()=>{}, resolveDisposed=()=>{}, released=false;
    const closed=new Promise(resolve=>{resolveDisposed=()=>resolve(undefined);});
    const source=new Readable({autoDestroy:false,emitClose,read(){this.push(null);},destroy(_error,done){finishDestroy=()=>{done();resolveDisposed();};}});
    if(ended){source.resume();await new Promise(resolve=>source.once('end',resolve));}
    const sender=createRouteObjectSender(binding,[info],{signal:new AbortController().signal,maxBytes:100,async openObject(){return {info:{...info,id:'attachment000002'},readable:source,closed,release(){released=true;}};}});
    const refused=assert.rejects(sender.send(ref,sink().writable));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(released,false);finishDestroy();await refused;assert.equal(released,true);
  }
});

/** Custody owner whose disposal join rejects: a disposal can fail after the bytes landed.
 * @param {Readable} readable @param {typeof info} metadata @param {()=>void} release */
function rejectingPinned(readable,metadata,release) {
  const closed=Promise.reject(Object.assign(Error('owner disposal failed'),{code:'P1_DISPOSE'}));
  return {info:metadata,readable,closed,release};
}

test('custody: a rejecting owner disposal join still releases the pin and keeps the verified receipt', async () => {
  let releases=0;
  const sender=createRouteObjectSender(binding,[info],{signal:new AbortController().signal,maxBytes:100,async openObject(){return rejectingPinned(Readable.from([bytes]),info,()=>{releases++;});}});
  const out=sink(); assert.deepEqual(await sender.send(ref,out.writable),{id:info.id,digest,size:bytes.length});
  assert.deepEqual(Buffer.concat(out.chunks),bytes); assert.equal(releases,1);
  releases=0;
  const refused=createRouteObjectSender(binding,[info],{signal:new AbortController().signal,maxBytes:100,async openObject(){return rejectingPinned(Readable.from([bytes]),{...info,id:'attachment000002'},()=>{releases++;});}});
  await assert.rejects(refused.send(ref,sink().writable),{code:'AGORA_CUSTODY_OBJECT_CONTEXT'}); assert.equal(releases,1);
});
