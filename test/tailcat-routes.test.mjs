// @ts-check
// Local lifecycle seams only: fake guardians and P1 sessions do not prove remote authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { connect } from 'node:net';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMemberRoute, startMemberChannel } from '../src/tailcat-routes.mjs';
import { publicNodeKeyDigest } from '../src/protocol/route.mjs';
import { spawnTailcat } from '../src/tailcat-process.mjs';
import { resolveTailcatBinary } from '../src/tailcat-runtime.mjs';

const publicKey=`nodekey:${'1'.repeat(64)}`;
const ownerRef={serviceId:'service000000001',serviceBootId:'boot000000000001'};
function binding(){return {host:{scheme:'native',authority:'house-host',id:'host000000000001'},member:{scheme:'native',authority:'house-member',id:'member0000000001'},
  accountId:'account000000001',serviceBootId:ownerRef.serviceBootId,roomId:'a'.repeat(32),roomEpoch:'b'.repeat(32),membershipRevision:1,grantId:'grant000000000001',routeGeneration:'route000000000001',allowedKeyDigest:publicNodeKeyDigest(publicKey)};}
function descriptor(){return {binding:binding(),protocol:'agora-native/1',endpoint:{transport:'tailcat',address:'a'.repeat(40),port:4444},issuedAt:'2026-09-05T12:00:00.000Z',descriptorDigest:`sha256:${'c'.repeat(64)}`,proofRef:'p1-local-proof'};}
/** @template T @returns {{promise:Promise<T>,resolve:(value:T)=>void,reject:(error:unknown)=>void}} */
function deferred(){let resolve=/** @type {(value:T)=>void} */(()=>{}),reject=/** @type {(error:unknown)=>void} */(()=>{});const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
/** @param {boolean} [automatic] */
function session(automatic=true){const ended=deferred(),ready=deferred();let stopped=0;return {ready:ready.promise,closed:ended.promise,stop:async()=>{stopped++;if(automatic)ended.resolve(undefined);},admit:()=>ready.resolve(undefined),finish:()=>ended.resolve(undefined),stopped:()=>stopped};}
function fixture(){
  const owner=new AbortController();
  /** @type {Array<{args:string[],options:any,owner:any}>} */ const calls=[];
  /** @type {Array<any>} */ const children=[];
  /** @type {((stream:PassThrough)=>void)|undefined} */ let accept;
  let listenerClosed=0,spawnBarrier=/** @type {Promise<void>|undefined} */(undefined),key=publicKey,parseExit=0;
  /** @type {import('../src/tailcat-routes.mjs').Options} */ const options={
    owner:{...ownerRef,signal:owner.signal},runtime:{stateRoot:path.resolve('test-state')},startupTimeoutMs:1000,stopTimeoutMs:50,
    listen:async callback=>{accept=callback;return {port:4444,close:async()=>{listenerClosed++;}};},
    address:async()=> 'a'.repeat(40),
    acceptChannel:async()=>{const s=session();s.admit();return s;},
    spawn:async(args,configuration,liveOwner)=>{
      calls.push({args,options:configuration,owner:liveOwner});
      if(spawnBarrier)await spawnBarrier;
      const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),exitCode:/** @type {number|null} */(null),signalCode:/** @type {NodeJS.Signals|null} */(null),connected:true,
        disconnect(){if(!child.connected)return;child.connected=false;child.exitCode=0;child.stdout.end();child.stdin.destroy();child.emit('exit',0,null);},
      });children.push(child);
      if(args[0]==='parse'||args.includes('printpub'))setImmediate(()=>{child.stdout.end(args[0]==='parse'?'{}':`${key}\n`);child.exitCode=args[0]==='parse'?parseExit:0;child.connected=false;child.emit('exit',child.exitCode,null);});
      return /** @type {Awaited<ReturnType<NonNullable<typeof options.spawn>>>} */(/** @type {unknown} */(child));
    },
  };
  return {options,owner,calls,children,connect(){const socket=new PassThrough();accept?.(socket);return socket;},listenerClosed:()=>listenerClosed,
    /** @param {Promise<void>} value */ blockSpawn(value){spawnBarrier=value;},
    /** @param {string} value */ key(value){key=value;},
    /** @param {number} value */ parseCode(value){parseExit=value;},
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
