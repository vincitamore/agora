// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startOfferWorker, runOfferWorker } from '../src/tailcat-offer-worker.mjs';
import { atomicJson } from '../src/tailcat.mjs';
import { createTransferListener } from '../src/tailcat-http.mjs';
import { launchManagedOffer, launchOffer, controlOffer, unloadOfferRegistration } from '../src/tailcat-launcher.mjs';

const deferred=()=>{
  /** @type {(value?:any)=>void} */
  let resolve=()=>{};
  const promise=new Promise(r=>{resolve=r;});return {promise,resolve};
};
const digest='sha256:'+'a'.repeat(64);
/** @param {import('node:test').TestContext} t */
async function fixture(t,{peers=1,expires=Date.now()+30000}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'agora-managed-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const id=randomUUID();
  await writeFile(path.join(root,'worker.json'),JSON.stringify({id,files:[{id:'0',name:'a.txt',size:1,digest}],
    expires,controlSecret:randomBytes(32).toString('hex'),peers:Array.from({length:peers},(_,n)=>({account:'test'+n,
      nodeKey:'nodekey:'+String(n+1).repeat(64),receiptDigest:digest}))}));
  return {root,id};
}
function guardian({autoExit=true}={}) {
  /** @type {any} */ const child=new EventEmitter();
  Object.assign(child,{connected:true,exitCode:null,signalCode:null,disconnects:0,stdout:new PassThrough()});
  child.finish=()=>{child.exitCode=0;child.connected=false;child.stdout.end();child.emit('exit',0,null);};
  child.disconnect=()=>{child.disconnects++;child.connected=false;if(autoExit)queueMicrotask(child.finish);};
  return child;
}
/** @param {()=>unknown|Promise<unknown>} fn */
async function waitFor(fn,message='condition did not become true',limit=10000) {
  const end=Date.now()+limit;
  while(Date.now()<end){try{if(await fn())return;}catch{}await delay(20);}
  throw Error(message);
}
/** @param {string} file */
async function absent(file){await assert.rejects(access(file),/** @param {any} e */e=>e.code==='ENOENT');}

test('stop joins a listener that finishes creation after cancellation', {timeout:10000},async t=>{
  const {root}=await fixture(t);const entered=deferred(),release=deferred();
  /** @type {any} */
  let listener;let spawns=0;
  const runtime=startOfferWorker(root,{listen:async spec=>{listener=await createTransferListener(spec);entered.resolve();await release.promise;return listener;},
    spawn:async()=>{spawns++;return guardian();}});
  await entered.promise;
  const stopped=runtime.stop();assert.strictEqual(runtime.stop(),stopped);assert.strictEqual(stopped,runtime.closed);
  let closed=false;void stopped.then(()=>{closed=true;});await delay(30);assert.equal(closed,false);
  release.resolve();await assert.rejects(runtime.ready,/stopped/);await stopped;
  assert.equal(listener.server.listening,false);assert.equal(spawns,0);await absent(path.join(root,'ready.json'));
});

test('stop waits for a late child and concurrent callers join its observed exit', {timeout:10000},async t=>{
  const {root}=await fixture(t);const entered=deferred(),release=deferred();const child=guardian({autoExit:false});
  /** @type {any} */
  let listener;
  const runtime=startOfferWorker(root,{listen:async spec=>(listener=await createTransferListener(spec)),
    spawn:async()=>{entered.resolve();await release.promise;return child;}});
  await entered.promise;const stopped=runtime.stop();assert.strictEqual(stopped,runtime.stop());
  let closed=false;void stopped.then(()=>{closed=true;});await delay(30);
  assert.equal(listener.server.listening,false);assert.equal(closed,false);
  release.resolve();await waitFor(()=>child.disconnects===1);assert.equal(closed,false);
  child.finish();await stopped;await assert.rejects(runtime.ready,/stopped/);
  assert.equal(child.disconnects,1);await absent(path.join(root,'ready.json'));
  assert.ok(JSON.parse(await readFile(path.join(root,'stopped.json'),'utf8')).stoppedAt);
});

test('stop cancels address discovery without waiting for a readiness result', {timeout:10000},async t=>{
  const {root}=await fixture(t);const entered=deferred();const child=guardian();
  const runtime=startOfferWorker(root,{spawn:async()=>child,address:async()=>{entered.resolve();return new Promise(()=>{});}});
  await entered.promise;await runtime.stop();await assert.rejects(runtime.ready,/stopped/);
  assert.equal(child.disconnects,1);await absent(path.join(root,'ready.json'));
});

test('failed second recipient startup closes both listeners and first child', {timeout:10000},async t=>{
  const {root}=await fixture(t,{peers:2});
  /** @type {any[]} */
  const listeners=[];
  /** @type {any[]} */
  const children=[];
  const runtime=startOfferWorker(root,{listen:async spec=>{const listener=await createTransferListener(spec);listeners.push(listener);return listener;},
    spawn:async()=>{if(children.length)throw Error('injected spawn failure');const child=guardian();children.push(child);return child;},
    address:async()=> 'a'.repeat(30)});
  await assert.rejects(runtime.ready,/injected spawn failure/);await runtime.closed;
  assert.equal(listeners.length,2);assert.ok(listeners.every(x=>!x.server.listening));assert.equal(children[0].disconnects,1);
  await absent(path.join(root,'ready.json'));
});

test('ordinary offer expiry still closes an otherwise ready runtime', {timeout:10000},async t=>{
  const {root}=await fixture(t,{expires:Date.now()+500});const child=guardian();
  const runtime=startOfferWorker(root,{spawn:async()=>child,address:async()=> 'a'.repeat(30)});
  await runtime.ready;await runtime.closed;assert.equal(child.disconnects,1);await absent(path.join(root,'ready.json'));
});

test('stop before spec read completes creates no route or stale readiness', {timeout:10000},async t=>{
  const {root}=await fixture(t);let routes=0;
  const runtime=startOfferWorker(root,{spawn:async()=>{routes++;return guardian();}});
  await runtime.stop();await assert.rejects(runtime.ready,/stopped/);
  assert.equal(routes,0);await absent(path.join(root,'ready.json'));
});

test('ready publication already in flight is joined and removed on stop', {timeout:10000},async t=>{
  const {root}=await fixture(t);const entered=deferred(),release=deferred();const child=guardian();
  const runtime=startOfferWorker(root,{spawn:async()=>child,address:async()=> 'a'.repeat(30),
    publish:async(file,data)=>{entered.resolve();await release.promise;await atomicJson(file,data);}});
  await entered.promise;const stopped=runtime.stop();let closed=false;void stopped.then(()=>{closed=true;});
  await delay(20);assert.equal(closed,false);release.resolve();await stopped;
  await assert.rejects(runtime.ready,/stopped/);await absent(path.join(root,'ready.json'));
});

test('signal-terminated guardian rejects cleanup instead of waiting on exitCode forever', {timeout:10000},async t=>{
  const {root}=await fixture(t);const child=guardian();
  const runtime=startOfferWorker(root,{spawn:async()=>child,address:async()=> 'a'.repeat(30)});
  await runtime.ready;child.connected=false;child.signalCode='SIGKILL';child.emit('exit',null,'SIGKILL');
  await assert.rejects(runtime.closed,/did not confirm child cleanup/);
  await absent(path.join(root,'ready.json'));await absent(path.join(root,'stopped.json'));
});

test('imported executable wrapper removes its signal handlers on cleanup', {timeout:10000},async t=>{
  const {root}=await fixture(t);const sigint=process.listeners('SIGINT'),sigterm=process.listeners('SIGTERM');
  const runtime=await runOfferWorker(root,{spawn:async()=>guardian(),address:async()=> 'a'.repeat(30)});
  assert.equal(process.listenerCount('SIGINT'),sigint.length+1);
  await runtime.stop();assert.deepEqual(process.listeners('SIGINT'),sigint);assert.deepEqual(process.listeners('SIGTERM'),sigterm);
});

test('legacy health remains available until teardown actually finishes', {timeout:10000},async t=>{
  const {root}=await fixture(t);const child=guardian({autoExit:false});
  const runtime=startOfferWorker(root,{spawn:async()=>child,address:async()=> 'a'.repeat(30)});
  await runtime.ready;const stopped=runtime.stop();
  assert.equal(await controlOffer(root,'health'),true,'legacy stopOffer must not infer completion before exit');
  child.finish();await stopped;assert.equal(await controlOffer(root,'health'),false);
});

test('managed IPC already disconnected before bootstrap cancels before spec read', {timeout:10000},async t=>{
  const {root}=await fixture(t);const entry=path.join(root,'disconnected.mjs');
  await writeFile(entry,`import{runOfferWorker}from${JSON.stringify(new URL('../src/tailcat-offer-worker.mjs',import.meta.url).href)};
import{writeFile}from'node:fs/promises';process.disconnect();
await runOfferWorker(${JSON.stringify(root)},{managed:true,spawn:async()=>{await writeFile(${JSON.stringify(path.join(root,'unexpected-spawn'))},'bad');throw Error('unexpected spawn');}});`);
  const child=spawn(process.execPath,[entry],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const [code]=await once(child,'close');assert.equal(code,1);
  await absent(path.join(root,'unexpected-spawn'));await absent(path.join(root,'ready.json'));
  assert.ok(JSON.parse(await readFile(path.join(root,'stopped.json'),'utf8')).stoppedAt);
});

// Real Node workers/IPC and TCP listeners, without Tailcat or external relay access.
/** @param {string} root */
async function executableFixture(root,{delayed=false}={}) {
  const childPath=path.join(root,'route.mjs');
  await writeFile(childPath,`import{createServer}from'node:net';import{writeFile}from'node:fs/promises';
const server=createServer(socket=>socket.end());
server.listen(0,'127.0.0.1',async()=>{await writeFile(${JSON.stringify(path.join(root,'route.json'))},JSON.stringify({port:server.address().port}));console.log(JSON.stringify({listenAddr:'a'.repeat(30)}));});
process.on('disconnect',()=>{server.close(async()=>{await writeFile(${JSON.stringify(path.join(root,'route-closed'))},'closed');});});
setTimeout(()=>{server.close();process.exit(2);},20000).unref();
`);
  const workerPath=path.join(root,'worker.mjs');
  await writeFile(workerPath,`import{runOfferWorker}from${JSON.stringify(new URL('../src/tailcat-offer-worker.mjs',import.meta.url).href)};
import{spawn}from'node:child_process';import{writeFile}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';
import{appendFileSync}from'node:fs';
appendFileSync(${JSON.stringify(path.join(root,'worker-debug'))},'started '+process.pid+' parent '+process.ppid+'\\n');
process.on('uncaughtExceptionMonitor',e=>appendFileSync(${JSON.stringify(path.join(root,'worker-debug'))},String(e.stack)+'\\n'));
process.on('disconnect',()=>appendFileSync(${JSON.stringify(path.join(root,'worker-debug'))},'disconnected\\n'));
await runOfferWorker(process.argv[3],{managed:process.argv[2]==='--managed-offer-worker',spawn:async()=>{
${delayed?`await writeFile(${JSON.stringify(path.join(root,'spawning'))},'pending');await delay(400);`:''}
return spawn(process.execPath,[${JSON.stringify(childPath)}],{stdio:['pipe','pipe','ignore','ipc'],windowsHide:true});}});
`);
  return workerPath;
}

test('managed ready is live IPC evidence; stopped joins nested cleanup and worker exit', {timeout:10000},async t=>{
  const {root,id}=await fixture(t);const workerPath=await executableFixture(root);
  // A stale file must not make the live launcher ready.
  await writeFile(path.join(root,'ready.json'),JSON.stringify({id:'stale'}));
  const runtime=launchManagedOffer(root,id,{workerPath});t.after(()=>runtime.stop());
  assert.equal((await runtime.ready).id,id);assert.equal(await controlOffer(root,'health'),true);
  const stopped=runtime.stop();assert.strictEqual(stopped,runtime.stop());
  const result=await stopped;assert.equal(result.signal,null);
  assert.equal(await readFile(path.join(root,'route-closed'),'utf8'),'closed');
  assert.equal(await controlOffer(root,'health'),false);await absent(path.join(root,'ready.json'));
});

for(const delayed of [false,true])test(`actual managed owner loss cleans routes${delayed?' created during cancellation':''}`, {timeout:15000},async t=>{
  const {root,id}=await fixture(t);const workerPath=await executableFixture(root,{delayed});
  const parentPath=path.join(root,'owner.mjs');
  await writeFile(parentPath,`import{launchManagedOffer}from${JSON.stringify(new URL('../src/tailcat-launcher.mjs',import.meta.url).href)};
const runtime=launchManagedOffer(${JSON.stringify(root)},${JSON.stringify(id)},{workerPath:${JSON.stringify(workerPath)}});
await runtime.ready;console.log('ready');setInterval(()=>{},1000);
`);
  const parent=spawn(process.execPath,[parentPath],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>{if(parent.exitCode===null)parent.kill('SIGKILL');});
  if(delayed)await waitFor(async()=>{await access(path.join(root,'spawning'));return true;});
  else await waitFor(()=>controlOffer(root,'health'));
  if(!delayed)await waitFor(async()=>{await access(path.join(root,'ready.json'));return true;});
  const exited=once(parent,'exit');parent.kill('SIGKILL');await exited;
  try{await waitFor(async()=>{await access(path.join(root,'stopped.json'));return true;},'worker did not finish cleanup');}
  catch(error){const diagnostic=await readFile(path.join(root,'worker-debug'),'utf8').catch(()=> 'no worker diagnostic');
    const pid=Number(/started (\d+)/.exec(diagnostic)?.[1]);let alive=false;try{process.kill(pid,0);alive=true;}catch{}
    throw Error(/** @type {Error} */(error).message+'; alive='+alive+'; '+diagnostic);}
  assert.equal(await readFile(path.join(root,'route-closed'),'utf8'),'closed');
  assert.equal(await controlOffer(root,'health'),false);await absent(path.join(root,'ready.json'));
});

test('abrupt managed worker death is unconfirmed cleanup, never a successful closed result', {timeout:10000},async t=>{
  const {root,id}=await fixture(t);const workerPath=path.join(root,'crash.mjs');
  await writeFile(workerPath,"process.send({type:'agora-offer-ready',offer:{id:"+JSON.stringify(id)+"}},()=>process.exit(3));");
  const runtime=launchManagedOffer(root,id,{workerPath});await runtime.ready;
  await assert.rejects(runtime.closed,/without confirming route cleanup/);
});

test('managed startup failure rejects ready after cleanup confirmation', {timeout:10000},async t=>{
  const {root,id}=await fixture(t);await writeFile(path.join(root,'worker.json'),'{}');
  const runtime=launchManagedOffer(root,id);await assert.rejects(runtime.ready,/before readiness/);
  const result=await runtime.closed;assert.equal(result.signal,null);
  assert.ok(JSON.parse(await readFile(path.join(root,'stopped.json'),'utf8')).stoppedAt);
});

test('actual spawnTailcat rejected startup joins the guardian before worker closed', {timeout:10000},async t=>{
  const {root}=await fixture(t);const entry=path.join(root,'guardian-timeout.mjs');
  await writeFile(entry,`import cp from'node:child_process';import{syncBuiltinESMExports}from'node:module';import{EventEmitter}from'node:events';
const originalTimeout=globalThis.setTimeout;let alive=false;
cp.spawn=()=>{alive=true;const child=Object.assign(new EventEmitter(),{connected:true,exitCode:null,signalCode:null});
child.send=()=>{};child.disconnect=()=>{child.connected=false;originalTimeout(()=>{alive=false;child.exitCode=0;child.emit('exit',0,null);child.emit('close',0,null);},180);};return child;};
syncBuiltinESMExports();globalThis.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms===20000?20:ms,...args);
const {startOfferWorker}=await import(${JSON.stringify(new URL('../src/tailcat-offer-worker.mjs',import.meta.url).href)});
const runtime=startOfferWorker(${JSON.stringify(root)},{listen:async()=>({port:12345,close:async()=>{}})});
await runtime.closed;console.log(JSON.stringify({closedWhileGuardianAlive:alive,readyResult:await runtime.ready.then(()=> 'resolved',error=>error.message)}));
`);
  const {stdout,stderr}=await promisify(execFile)(process.execPath,[entry],{timeout:5000,windowsHide:true});
  assert.equal(stderr,'');const result=JSON.parse(stdout);assert.equal(result.closedWhileGuardianAlive,false);
  assert.match(result.readyResult,/startup timed out/);
});

test('standalone real worker remains alive when its posting terminal dies', {
  timeout:40000,skip:process.platform==='darwin'&&process.env.AGORA_TEST_LAUNCHD!=='1'?'needs a login launchd domain':false,
},async t=>{
  const {root,id}=await fixture(t,{expires:Date.now()+30000});const workerPath=await executableFixture(root);
  const parentPath=path.join(root,'standalone-parent.mjs');
  await writeFile(parentPath,`import{launchOffer}from${JSON.stringify(new URL('../src/tailcat-launcher.mjs',import.meta.url).href)};
await launchOffer(${JSON.stringify(root)},${JSON.stringify(id)},{workerPath:${JSON.stringify(workerPath)}});setInterval(()=>{},1000);`);
  const parent=spawn(process.execPath,[parentPath],{stdio:'ignore',windowsHide:true});
  t.after(async()=>{if(parent.exitCode===null)parent.kill('SIGKILL');await controlOffer(root,'stop');await unloadOfferRegistration(id);});
  await waitFor(async()=>{await access(path.join(root,'ready.json'));return true;},'standalone did not become ready',25000);
  const exited=once(parent,'exit');parent.kill('SIGKILL');await exited;await delay(100);
  assert.equal(await controlOffer(root,'health'),true);
  assert.equal(await controlOffer(root,'stop'),true);
  await waitFor(async()=>{await access(path.join(root,'stopped.json'));return true;});
  assert.equal(await readFile(path.join(root,'route-closed'),'utf8'),'closed');
});

for (const acknowledge of [false, true]) test(`managed stop reports cleanup-pending while a ${acknowledge ? 'cleanup-acknowledged' : 'silent'} worker remains alive`, {timeout:10000}, async t => {
  const root=await mkdtemp(path.join(tmpdir(),'agora-stop-bound-'));
  const id=randomUUID();
  const workerPath=path.join(root,'wedged-worker.mjs');
  const releasePath=path.join(root,'release-worker');
  await writeFile(workerPath,`import{access}from'node:fs/promises';
process.on('message',message=>{if(message.type==='agora-offer-stop'&&${acknowledge})process.send({type:'agora-offer-closed'});});
process.send({type:'agora-offer-ready',offer:{id:${JSON.stringify(id)}}});
const poll=setInterval(async()=>{try{await access(${JSON.stringify(releasePath)});clearInterval(poll);process.send({type:'agora-offer-closed'},()=>process.disconnect());}catch{}},20);
`);
  const runtime=launchManagedOffer(root,id,/** @type {any} */({workerPath,stopTimeoutMs:50}));
  t.after(async()=>{try{await writeFile(releasePath,'release');await runtime.closed;}finally{await rm(root,{recursive:true,force:true});}});
  await runtime.ready;
  let actuallyClosed=false;
  void runtime.closed.then(()=>{actuallyClosed=true;});
  const stopped=runtime.stop();
  assert.strictEqual(stopped,runtime.stop(),'concurrent stops share one bounded result');
  const outcome=await Promise.race([stopped.then(()=>({kind:'success'}),error=>({kind:'error',error})),delay(400).then(()=>({kind:'still-waiting'}))]);
  assert.equal(outcome.kind,'error','stop must report failure before the test observation deadline');
  const error=/** @type {{kind:string,error:any}} */(outcome).error;
  assert.equal(error.code,'AGORA_CLEANUP_PENDING');
  assert.equal(error.cleanupPending,true);
  assert.equal(actuallyClosed,false,'timeout must not settle actual closure');
  await writeFile(releasePath,'release');
  const result=await runtime.closed;
  assert.equal(result.signal,null);
  assert.equal(actuallyClosed,true,'actual late closure remains observable');
  await assert.rejects(runtime.stop(),e=>/** @type {any} */(e).code==='AGORA_CLEANUP_PENDING');
});
