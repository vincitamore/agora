// @ts-check
// Local lifecycle seams only: fake guardians and P1 sessions do not prove remote authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { connect } from 'node:net';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMemberRoute, startMemberChannel } from '../src/tailcat-routes.mjs';
import { publicNodeKeyDigest } from '../src/protocol/route.mjs';
import { spawnTailcat } from '../src/tailcat-process.mjs';
import { resolveTailcatBinary,sha256 } from '../src/tailcat-runtime.mjs';
import { AgoraError } from '../src/core.mjs';

const publicKey=`nodekey:${'1'.repeat(64)}`;
const ownerRef={serviceId:'service000000001',serviceBootId:'boot000000000001'};
function binding(){return {host:{scheme:'native',authority:'house-host',id:'host000000000001'},member:{scheme:'native',authority:'house-member',id:'member0000000001'},
  accountId:'account000000001',serviceBootId:ownerRef.serviceBootId,roomId:'a'.repeat(32),roomEpoch:'b'.repeat(32),membershipRevision:1,grantId:'grant000000000001',routeGeneration:'route000000000001',allowedKeyDigest:publicNodeKeyDigest(publicKey)};}
function descriptor(){return {binding:binding(),protocol:'agora-native/1',endpoint:{transport:'tailcat',address:'a'.repeat(40),port:4444},issuedAt:'2026-09-05T12:00:00.000Z',descriptorDigest:`sha256:${'c'.repeat(64)}`,proofRef:'p1-local-proof'};}
/** @template T @returns {{promise:Promise<T>,resolve:(value:T)=>void,reject:(error:unknown)=>void}} */
function deferred(){let resolve=/** @type {(value:T)=>void} */(()=>{}),reject=/** @type {(error:unknown)=>void} */(()=>{});const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
/** @param {boolean} [automatic] */
function session(automatic=true){const ended=deferred(),ready=deferred();let stopped=0;return {ready:ready.promise,closed:ended.promise,stop:async()=>{stopped++;if(automatic)ended.resolve(undefined);},admit:()=>ready.resolve(undefined),finish:()=>ended.resolve(undefined),stopped:()=>stopped};}
/** @param {string} root */
async function testRuntime(root){
  const executable=process.platform==='win32'?process.execPath:path.join(root,'fixture-runtime');
  if(process.platform!=='win32')await writeFile(executable,`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,{mode:0o700});
  const options={stateRoot:root,override:executable,overrideSha256:sha256(await readFile(executable))};
  await resolveTailcatBinary(options);return options;
}
function fixture(){
  const owner=new AbortController();
  /** @type {Array<{args:string[],options:any,owner:any}>} */ const calls=[];
  /** @type {Array<any>} */ const children=[];
  /** @type {((stream:PassThrough)=>void)|undefined} */ let accept;
  let listenerClosed=0,spawnBarrier=/** @type {Promise<void>|undefined} */(undefined),key=publicKey,parseExit=0;
  let hangingVerb='',commandTail='',dialFailures=0,hangingDials=0,dialTail='',dialCount=0,dialSessionStops=0;
  /** @type {import('../src/tailcat-routes.mjs').Options} */ const options={
    owner:{...ownerRef,signal:owner.signal},runtime:{stateRoot:path.resolve('test-state')},startupTimeoutMs:1000,stopTimeoutMs:50,
    listen:async callback=>{accept=callback;return {port:4444,close:async()=>{listenerClosed++;}};},
    address:async()=> 'a'.repeat(40),
    acceptChannel:async()=>{const s=session();s.admit();return s;},
    spawn:async(args,configuration,liveOwner)=>{
      calls.push({args,options:configuration,owner:liveOwner});
      if(spawnBarrier)await spawnBarrier;
      const verb=args.find(value=>value==='parse'||value==='printpub')??'';
      const dial=args.length===3&&args[0].startsWith('--key=')&&args[1]===descriptor().endpoint.address;
      if(dial)dialCount++;
      const tail=dial&&(dialCount<=dialFailures||dialCount<=hangingDials)?dialTail:verb===hangingVerb?commandTail:'';
      const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),exitCode:/** @type {number|null} */(null),signalCode:/** @type {NodeJS.Signals|null} */(null),connected:true,
        tailcatStderrTail(){return tail;},
        disconnect(){if(!child.connected)return;child.connected=false;child.exitCode=0;child.stdout.end();child.stdin.destroy();child.emit('exit',0,null);},
      });children.push(child);
      if(verb&&verb!==hangingVerb)setImmediate(()=>{child.stdout.end(verb==='parse'?'{}':`${key}\n`);child.exitCode=verb==='parse'?parseExit:0;child.connected=false;child.emit('exit',child.exitCode,null);});
      if(dial&&dialCount<=dialFailures)setImmediate(()=>{child.stdout.end();child.stdin.destroy();child.exitCode=1;child.connected=false;child.emit('exit',1,null);});
      return /** @type {Awaited<ReturnType<NonNullable<typeof options.spawn>>>} */(/** @type {unknown} */(child));
    },
  };
  return {options,owner,calls,children,connect(){const socket=new PassThrough();accept?.(socket);return socket;},listenerClosed:()=>listenerClosed,
    /** @param {Promise<void>} value */ blockSpawn(value){spawnBarrier=value;},
    /** @param {string} value */ key(value){key=value;},
    /** @param {number} value */ parseCode(value){parseExit=value;},
    /** @param {string} verb @param {string} tail */ hangCommand(verb,tail){hangingVerb=verb;commandTail=tail;},
    /** @param {number} count @param {string} tail */ failDials(count,tail){
      dialFailures=count;dialTail=tail;
      options.acceptChannel=async()=>{
        if(dialCount<=Math.max(dialFailures,hangingDials)){const ready=deferred(),closed=deferred();return {ready:ready.promise,closed:closed.promise,stop:async()=>{dialSessionStops++;ready.reject(Error('transport ended'));closed.resolve(undefined);}};}
        const s=session();s.admit();return s;
      };
    },
    /** @param {number} count @param {string} tail */ hangDials(count,tail){hangingDials=count;this.failDials(0,tail);},
    /** @param {AgoraError} error */ refuseDial(error){
      options.acceptChannel=async()=>{
        const child=children.at(-1);child.exitCode=1;child.connected=false;child.stdout.end();child.stdin.destroy();setImmediate(()=>child.emit('exit',1,null));
        return {ready:Promise.reject(error),closed:Promise.resolve(),stop:async()=>{dialSessionStops++;}};
      };
    },
    dialCount:()=>dialCount,
    dialSessionStops:()=>dialSessionStops,
    outbound(){return {...options,assertDescriptor:async()=>{},resolveClientKey:async()=>({keyPath:path.resolve('local-enrolled.private.json')})};},
  };
}

test('route refuses bad live owner, boot and allow digest before any listener or spawn',()=>{
  const f=fixture();const input={binding:binding(),allowedNodeKey:publicKey};
  assert.throws(()=>startMemberRoute({...input,allowedNodeKey:`nodekey:${'2'.repeat(64)}`},f.options),/allow key/);
  assert.throws(()=>startMemberRoute(input,{...f.options,owner:{...f.options.owner,serviceBootId:'differentboot00001'}}),/boot/);
  assert.throws(()=>startMemberRoute(input,{...f.options,owner:{...f.options.owner,signal:/** @type {AbortSignal} */(/** @type {unknown} */({}))}}),/live local owner/);
  f.owner.abort();assert.throws(()=>startMemberRoute(input,f.options),/owner stopped/);
  assert.equal(f.calls.length,0);assert.equal(f.listenerClosed(),0);
});

test('ingress uses one exact allow key and immutable binding; another route remains live',async()=>{
  const f=fixture(),g=fixture(),b=binding();
  /** @type {import('../src/tailcat-routes.mjs').Binding[]} */
  const captured=[];
  f.options.acceptChannel=async value=>{captured.push(value);const s=session();s.admit();return s;};
  const route=startMemberRoute({binding:b,allowedNodeKey:publicKey},f.options);
  const other=startMemberRoute({binding:binding(),allowedNodeKey:publicKey},g.options);
  b.accountId='mutatedaccount01';b.host.authority='forged';
  const [ready]=await Promise.all([route.ready,other.ready]);const socket=f.connect();await delay(5);
  assert.equal(captured[0].accountId,'account000000001');assert.equal(captured[0].host.authority,'house-host');
  assert.equal(Object.isFrozen(captured[0].host),true);assert.equal(ready.binding.accountId,'account000000001');
  assert.deepEqual(f.calls[0].args,['serve','--key=new','--full-address','--json',`--allow=${publicKey}`,'4444']);
  assert.equal(f.calls[0].options.lifetime.kind,'service');assert.equal(f.calls[0].owner.signal instanceof AbortSignal,true);
  await route.stop();assert.equal(socket.destroyed,true);assert.equal(f.listenerClosed(),1);assert.equal(g.children[0].connected,true);
  await other.stop();
});

test('late listener and late guardian acquisition are owned through cancellation',async()=>{
  const f=fixture(),late=deferred();let count=0;
  f.options.listen=async()=>{await late.promise;return {port:5555,close:async()=>{count++;}};};
  const route=startMemberRoute({binding:binding(),allowedNodeKey:publicKey},f.options);await delay(1);
  const stopping=route.stop();late.resolve(undefined);await assert.rejects(route.ready);await stopping;
  assert.equal(count,1);assert.equal(f.calls.length,0);
  const g=fixture(),spawn=deferred();g.blockSpawn(spawn.promise);
  const next=startMemberRoute({binding:binding(),allowedNodeKey:publicKey},g.options);await delay(1);
  const stopped=next.stop();spawn.resolve(undefined);await assert.rejects(next.ready);await stopped;
  assert.equal(g.children[0].connected,false);assert.equal(g.listenerClosed(),1);
});

test('late acceptChannel session is stopped and actual closed is joined beyond bounded stop',async()=>{
  const f=fixture(),created=deferred(),s=session(false);f.options.acceptChannel=async()=>{await created.promise;return s;};
  const route=startMemberRoute({binding:binding(),allowedNodeKey:publicKey},f.options);await route.ready;const socket=f.connect();
  const stopped=route.stop();created.resolve(undefined);await assert.rejects(stopped,{code:'AGORA_CLEANUP_PENDING'});
  assert.equal(s.stopped(),1);assert.equal(socket.destroyed,true);
  assert.equal(await Promise.race([route.closed.then(()=>true),delay(5).then(()=>false)]),false);
  s.finish();await route.closed;assert.equal(route.stop(),stopped);
});

test('outbound refuses missing verifier and failed descriptor before key/process work',async()=>{
  const f=fixture();assert.throws(()=>startMemberChannel({descriptor:descriptor()},/** @type {any} */(f.options)),/descriptor authority/);
  const options=f.outbound();options.assertDescriptor=async()=>{throw Error('Wrong enrolled host');};
  const route=startMemberChannel({descriptor:descriptor()},options);await assert.rejects(route.ready,/Wrong enrolled host/);await route.closed;assert.equal(f.calls.length,0);
});

test('outbound actual parser and public-key result refuse before network channel spawn',async()=>{
  for(const wrong of ['parse','key']){
    const f=fixture();if(wrong==='parse')f.parseCode(1);else f.key(`nodekey:${'2'.repeat(64)}`);
    const route=startMemberChannel({descriptor:descriptor()},f.outbound());await assert.rejects(route.ready);await route.closed;
    assert.equal(f.calls.some(x=>x.args.length===3&&x.args[1]==='a'.repeat(40)),false);
  }
});

test('clockless command child is stopped by a named verb timeout carrying its stderr tail',async()=>{
  const f=fixture();f.hangCommand('parse','parser still waiting');f.options.commandTimeoutMs=15;
  const route=startMemberChannel({descriptor:descriptor()},f.outbound());
  await assert.rejects(route.ready,error=>{
    assert.match(String(error),/tailcat-command-timeout: parse did not exit within 15 ms/);
    assert.match(String(error),/parser still waiting/);return true;
  });
  await route.closed;assert.equal(f.children[0].connected,false);
});

test('first member dial retries two transport exits then admits without leaking failed children',async()=>{
  const f=fixture();f.failDials(2,'tailcat Ping: context deadline exceeded');
  const options=f.outbound();options.firstDialTimeoutMs=30;options.firstDialBackoffMs=1;
  const route=startMemberChannel({descriptor:descriptor()},options);await route.ready;
  assert.equal(f.dialCount(),3);
  const dials=f.children.filter(child=>child.tailcatStderrTail().includes('Ping')||child===f.children.at(-1));
  assert.equal(dials.length,3);assert.equal(dials[0].connected,false);assert.equal(dials[1].connected,false);assert.equal(f.dialSessionStops(),2);
  await route.stop();assert.equal(dials[2].connected,false);
});

test('a named member refusal remains terminal when its transport ends in the same admission turn',async()=>{
  const f=fixture();f.refuseDial(Object.assign(new AgoraError('the host rejected a deliberately reworded hello'),{code:'member-hello-refused'}));
  const options=f.outbound();options.firstDialTimeoutMs=30;options.firstDialBackoffMs=1;
  const route=startMemberChannel({descriptor:descriptor()},options);
  await assert.rejects(route.ready,error=>/** @type {any} */(error).code==='member-hello-refused'&&/deliberately reworded/.test(String(error)));
  await route.closed;assert.equal(f.dialCount(),1);assert.equal(f.dialSessionStops(),1);
});

test('member-channel-dark is an observation and retries even when the transport ends with it',async()=>{
  const f=fixture();f.refuseDial(Object.assign(new AgoraError('the host did not answer this seat'),{code:'member-channel-dark'}));
  const options=f.outbound();options.firstDialTimeoutMs=30;options.firstDialBackoffMs=1;
  const route=startMemberChannel({descriptor:descriptor()},options);
  await assert.rejects(route.ready,/member-channel-startup-failed: first dial exhausted 3 attempts/);
  await route.closed;assert.equal(f.dialCount(),3);assert.equal(f.dialSessionStops(),3);
});

test('member dial retry exhaustion names startup failure and carries the final stderr tail',async()=>{
  const f=fixture();f.failDials(3,'tailcat Ping: context deadline exceeded');
  const options=f.outbound();options.firstDialTimeoutMs=30;options.firstDialBackoffMs=1;
  const route=startMemberChannel({descriptor:descriptor()},options);
  await assert.rejects(route.ready,error=>{
    assert.match(String(error),/member-channel-startup-failed: first dial exhausted 3 attempts/);
    assert.match(String(error),/tailcat Ping: context deadline exceeded/);return true;
  });
  await route.closed;assert.equal(f.dialCount(),3);assert.equal(f.dialSessionStops(),3);
});

test('each member dial attempt has its own clock when the child never exits',async()=>{
  const f=fixture();f.hangDials(1,'dial remains open');
  const options=f.outbound();options.firstDialAttempts=1;options.firstDialTimeoutMs=15;options.firstDialBackoffMs=1;
  const started=Date.now(),route=startMemberChannel({descriptor:descriptor()},options);
  await assert.rejects(route.ready,error=>{
    assert.match(String(error),/member-channel-startup-failed/);
    assert.match(String(error),/member-channel-dark: the host's member hello or welcome did not arrive within 15 ms/);return true;
  });
  await route.closed;assert.ok(Date.now()-started<250);assert.equal(f.children.at(-1).connected,false);assert.equal(f.dialSessionStops(),1);
});

test('loopback-only injected runtime guardian retains only the bounded tail of stderr',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'agora-route-stderr-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const child=await spawnTailcat(['-e',`process.stderr.write('${'x'.repeat(600)} xoxb-secretsecret privkey:${'a'.repeat(64)} tailcat Ping: context deadline exceeded');process.exit(1)`],await testRuntime(root));
  child.stdout?.resume();await new Promise(resolve=>child.once('close',resolve));
  const tail=/** @type {any} */(child).tailcatStderrTail();
  assert.ok(Buffer.byteLength(tail)<=512);assert.match(tail,/tailcat Ping: context deadline exceeded$/);
  assert.doesNotMatch(tail,/xoxb-secretsecret|privkey:/);assert.match(tail,/\[redacted\]/);
});

test('outbound uses local owner boot but remote binding; ready requires P1 admission',async()=>{
  const f=fixture(),s=session();const input=descriptor();input.binding.serviceBootId='remoteBoot0000001';
  const options=f.outbound();
  /** @type {import('../src/tailcat-routes.mjs').Binding|undefined} */
  let bindingSeen;
  options.acceptChannel=async b=>{bindingSeen=b;return s;};
  const route=startMemberChannel({descriptor:input},options);await delay(10);
  assert.equal(await Promise.race([route.ready.then(()=>true),delay(5).then(()=>false)]),false);
  assert.equal(bindingSeen?.serviceBootId,'remoteBoot0000001');assert.equal(f.calls.at(-1)?.owner.serviceBootId,ownerRef.serviceBootId);
  s.admit();await route.ready;await route.stop();assert.equal(s.stopped(),1);
});

test('owner abort bypasses stopImmediatePropagation and cancels live socket/session',async()=>{
  const f=fixture(),s=session();s.admit();f.options.acceptChannel=async()=>s;
  f.owner.signal.addEventListener('abort',event=>event.stopImmediatePropagation());
  const route=startMemberRoute({binding:binding(),allowedNodeKey:publicKey},f.options);await route.ready;const socket=f.connect();await delay(1);f.owner.abort();await route.closed;
  assert.equal(socket.destroyed,true);assert.equal(s.stopped(),1);assert.equal(f.children[0].connected,false);
});

test('hello timeout rejects readiness and joins a failing/late local acceptor',async()=>{
  const f=fixture(),s=session();const options=f.outbound();options.startupTimeoutMs=15;options.acceptChannel=async()=>s;
  const route=startMemberChannel({descriptor:descriptor()},options);await assert.rejects(route.ready,{code:'AGORA_ROUTE_CANCELLED'});await route.closed;assert.equal(s.stopped(),1);
});

test('guardian signal death rejects cleanup instead of reporting closed success',async()=>{
  const f=fixture();const route=startMemberRoute({binding:binding(),allowedNodeKey:publicKey},f.options);await route.ready;
  const child=f.children[0];child.connected=false;child.signalCode='SIGKILL';child.stdout.end();child.emit('exit',null,'SIGKILL');
  await assert.rejects(route.closed,/cleanup unconfirmed/);
});

test('invalid startup bound cannot leave a scheduled unowned launch',async()=>{
  const f=fixture();f.options.startupTimeoutMs=0;
  assert.throws(()=>startMemberRoute({binding:binding(),allowedNodeKey:publicKey},f.options),/bound/);
  await delay(5);assert.equal(f.calls.length,0);assert.equal(f.listenerClosed(),0);
});

test('actual stream disposal and a late stop failure precede closed',async()=>{
  const f=fixture(),destroyed=deferred(),s=session();s.admit();
  f.options.acceptChannel=async()=>s;
  let accept=/** @type {((socket:PassThrough)=>void)|undefined} */(undefined);
  f.options.listen=async callback=>{accept=callback;return {port:4444,close:async()=>{}};};
  const route=startMemberRoute({binding:binding(),allowedNodeKey:publicKey},f.options);await route.ready;
  const stream=new PassThrough({destroy(_error,done){void destroyed.promise.then(()=>done(null));}});accept?.(stream);await delay(1);
  const stopping=route.stop();await assert.rejects(stopping,{code:'AGORA_CLEANUP_PENDING'});
  assert.equal(await Promise.race([route.closed.then(()=>true),delay(5).then(()=>false)]),false);
  destroyed.resolve(undefined);await route.closed;
  const g=fixture(),late=deferred(),t=session();t.admit();t.stop=async()=>{t.finish();await late.promise;throw Error('stop cleanup failed');};g.options.acceptChannel=async()=>t;
  const next=startMemberRoute({binding:binding(),allowedNodeKey:publicKey},g.options);await next.ready;g.connect();await delay(1);void next.stop();late.resolve(undefined);
  await assert.rejects(next.closed,/stop cleanup failed/);
});

test('malformed session ownership cannot produce successful closed',async()=>{
  const f=fixture();f.options.acceptChannel=async()=>/** @type {any} */({ready:Promise.resolve(),stop:async()=>{}});
  const route=startMemberChannel({descriptor:descriptor()},f.outbound());await assert.rejects(route.ready,/joinable ownership/);await assert.rejects(route.closed,/joinable ownership/);
});

test('default loopback listener actually delivers bytes to its captured P1 session',async()=>{
  const f=fixture();delete f.options.listen;const received=deferred();
  f.options.acceptChannel=async(_binding,stream)=>{stream.once('data',chunk=>received.resolve(chunk.toString()));const s=session();s.admit();return s;};
  const route=startMemberRoute({binding:binding(),allowedNodeKey:publicKey},f.options);const result=await route.ready;
  const socket=connect(result.endpoint.port,'127.0.0.1');socket.on('error',()=>{});socket.write('local-fixture');
  assert.equal(await received.promise,'local-fixture');await route.stop();socket.destroy();
});

test('offline real guardian parser rejects syntax-envelope garbage before key resolution',async()=>{
  const stateRoot=await mkdtemp(path.join(os.tmpdir(),'agora-route-'));
  try{
    const f=fixture(),options=f.outbound();delete options.spawn;options.runtime={stateRoot};options.startupTimeoutMs=60000;options.stopTimeoutMs=10000;
    let resolved=false;options.resolveClientKey=async()=>{resolved=true;return {keyPath:path.join(stateRoot,'absent')};};
    const route=startMemberChannel({descriptor:descriptor()},options);await assert.rejects(route.ready,/validation failed/);await route.closed;assert.equal(resolved,false);
  }finally{await rm(stateRoot,{recursive:true,force:true});}
});

test('offline real guardian printpub checks the actual enrolled private file',async()=>{
  const stateRoot=await mkdtemp(path.join(os.tmpdir(),'agora-route-'));
  try{
    const binary=await resolveTailcatBinary({stateRoot}),keyPath=path.join(stateRoot,'test.private.json');
    await promisify(execFile)(binary.path,['genkey','--client',`--key=${keyPath}`],{timeout:15000,windowsHide:true});
    const {stdout}=await promisify(execFile)(binary.path,[`--key=${keyPath}`,'printpub'],{timeout:15000,windowsHide:true});
    const input=descriptor();input.binding.allowedKeyDigest=publicNodeKeyDigest(stdout.trim());
    const f=fixture(),options=f.outbound();options.runtime={stateRoot};options.startupTimeoutMs=60000;options.stopTimeoutMs=10000;
    options.resolveClientKey=async()=>({keyPath});
    const fake=options.spawn;options.spawn=async(args,runtime,owner)=>args.includes('printpub')?spawnTailcat(args,runtime,owner):/** @type {NonNullable<typeof fake>} */(fake)(args,runtime,owner);
    const route=startMemberChannel({descriptor:input},options);await route.ready;await route.stop();
    // This is key resolution only: parser and resident tunnel remain local fakes, no DERP.
  }finally{await rm(stateRoot,{recursive:true,force:true});}
});
