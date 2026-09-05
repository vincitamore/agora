// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256, resolveTailcatBinary } from '../src/tailcat-runtime.mjs';
import { spawnTailcat } from '../src/tailcat-process.mjs';

/** Keep the injected test runtime within the production executable bound even when Node is a large macOS binary.
 * @param {string} root */
async function testRuntime(root) {
  const executable=process.platform==='win32'?process.execPath:path.join(root,'fixture-runtime');
  if(process.platform!=='win32')await writeFile(executable,`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,{mode:0o700});
  const options={stateRoot:root,override:executable,overrideSha256:sha256(await readFile(executable))};
  await resolveTailcatBinary(options); // Surface the precise fixture verification failure before the guardian's sanitized message.
  return options;
}

test('runtime exit does not truncate buffered bytes through a slow guardian pipe',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-guardian-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const child=await spawnTailcat(['-e','process.stdout.write(Buffer.alloc(1048576,97))'],await testRuntime(root));
  let bytes=0;
  assert.ok(child.stdout);
  for await(const chunk of child.stdout){bytes+=chunk.length;await delay(2);}
  assert.equal(bytes,1048576);
});

for(const serviceOwned of [false,true])test(`killing the requesting parent reaps its ${serviceOwned?'service':'offer'} runtime without a saved-PID kill`,async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-guardian-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const moduleUrl=new URL('../src/tailcat-process.mjs',import.meta.url).href;
  const options=await testRuntime(root);
  const fixture=path.join(root,'parent.mjs');
  await writeFile(fixture,`import {spawnTailcat} from ${JSON.stringify(moduleUrl)};
const options=${JSON.stringify(options)};
const owner=${serviceOwned?"{serviceId:'service-aaaaaaaa',serviceBootId:'boot-aaaaaaaaaaa',signal:new AbortController().signal}":'undefined'};
if(owner)options.lifetime={kind:'service',owner:{serviceId:owner.serviceId,serviceBootId:owner.serviceBootId}};
const child=await spawnTailcat(['-e','console.log(process.pid);setInterval(()=>{},1000)'],options,owner);
child.stdout.pipe(process.stdout);
`);
  const parent=spawn(process.execPath,[fixture],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>{if(parent.exitCode===null)parent.kill('SIGKILL');});
  const runtimePid=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('guardian did not start')),15000);let text='';
    parent.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timeout);resolve(Number(text.trim()));}});
    parent.once('exit',()=>{clearTimeout(timeout);reject(Error('parent exited before fixture started'));});
  });
  assert.ok(Number.isSafeInteger(runtimePid));
  parent.kill('SIGKILL');
  let live=true;
  for(let i=0;i<100;i++){
    try{process.kill(/** @type {number} */(runtimePid),0);}catch{live=false;break;}await delay(50);
  }
  assert.equal(live,false,'IPC disconnect must terminate the runtime; this test only probes, never kills the stored pid');
});

test('live owner abort cannot be suppressed by another listener and preserves runtime output',{timeout:15000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-owner-abort-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const controller=new AbortController();
  controller.signal.addEventListener('abort',event=>event.stopImmediatePropagation());
  const owner={serviceId:'service-aaaaaaaa',serviceBootId:'boot-aaaaaaaaaaa',signal:controller.signal};
  const options={...await testRuntime(root),lifetime:/** @type {const} */({kind:'service',owner:{serviceId:owner.serviceId,serviceBootId:owner.serviceBootId}})};
  const child=await spawnTailcat(['-e','console.log("ready");setInterval(()=>{},1000)'],options,owner);
  t.after(()=>{controller.abort();if(child.connected)child.disconnect();child.stdout?.resume();});
  const closed=new Promise(resolve=>child.once('exit',resolve));
  let output='';
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('runtime output missing')),10000);
    child.stdout?.on('data',chunk=>{output+=chunk;if(output.includes('ready')){clearTimeout(timeout);resolve(undefined);}});
  });
  assert.equal(child.exitCode,null);
  controller.abort();
  await closed;
  assert.equal(output.trim(),'ready');
  assert.notEqual(child.exitCode,null,'guardian closes after actual runtime termination');
});

for(const explicit of [false,true])test(`${explicit?'explicit expiry':'legacy deadline'} stops a running runtime`,async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-expiry-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=await testRuntime(root);
  const deadline=Date.now()+2500;
  const expiry=explicit?{lifetime:/** @type {const} */({kind:'expiring',expiresAt:new Date(deadline).toISOString()})}:{deadline};
  const child=await spawnTailcat(['-e','console.log("ready");setInterval(()=>{},1000)'],{...runtime,...expiry});
  t.after(()=>{if(child.connected)child.disconnect();child.stdout?.resume();});
  let output='';child.stdout?.on('data',chunk=>{output+=chunk;});
  await new Promise(resolve=>child.once('close',resolve));
  assert.equal(output.trim(),'ready');
  assert.ok(Date.now()>=deadline-100,'expiry must not stop before its deadline');
});

test('owner cancellation during startup rejects only after guardian cleanup',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-start-abort-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=await testRuntime(root);
  for(let i=0;i<3;i++){
    const controller=new AbortController();
    const owner={serviceId:'service-aaaaaaaa',serviceBootId:'boot-aaaaaaaaaaa',signal:controller.signal};
    const pending=spawnTailcat(['-e','process.stdout.write(Buffer.alloc(16777216));setInterval(()=>{},1000)'],{...runtime,lifetime:{kind:'service',owner:{serviceId:owner.serviceId,serviceBootId:owner.serviceBootId}}},owner);
    controller.abort();
    await assert.rejects(pending,{code:'AGORA_RUNTIME_CANCELLED'});
  }
});

test('buffered startup cancellation waits for actual guardian exit before rejection',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-buffered-abort-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const options=await testRuntime(root);
  const fixture=path.join(root,'buffered-startup.mjs');
  // Process-local interception withholds readiness, not process execution. Actual
  // unread runtime output triggers abort, making the drain/exit join observable.
  await writeFile(fixture,`import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
const original=cp.spawn, controller=new AbortController(), events=[]; let guardian;
cp.spawn=(...args)=>{
  guardian=original(...args);
  const emit=guardian.emit;
  guardian.emit=function(name,...args){
    if(name==='message'&&args[0]?.status==='started')return true;
    return emit.call(this,name,...args);
  };
  guardian.once('exit',()=>events.push('exit'));
  guardian.stdout.once('readable',()=>{events.push('buffered');controller.abort();});
  return guardian;
};
syncBuiltinESMExports();
const {spawnTailcat}=await import(${JSON.stringify(new URL('../src/tailcat-process.mjs',import.meta.url).href)});
const owner={serviceId:'service-aaaaaaaa',serviceBootId:'boot-aaaaaaaaaaa',signal:controller.signal};
const options={...${JSON.stringify(options)},lifetime:{kind:'service',owner:{serviceId:owner.serviceId,serviceBootId:owner.serviceBootId}}};
try{
  await assert.rejects(spawnTailcat(['-e','process.stdout.write(Buffer.alloc(16777216));setInterval(()=>{},1000)'],options,owner),{code:'AGORA_RUNTIME_CANCELLED'});
  assert.deepEqual(events,['buffered','exit']);
  assert.notEqual(guardian.exitCode,null);
  assert.equal(guardian.signalCode,null);
  console.log('buffered cancellation joined');
}finally{guardian?.stdout?.resume();if(guardian?.connected)guardian.disconnect();}
`);
  const result=await promisify(execFile)(process.execPath,[fixture],{timeout:15000,windowsHide:true});
  assert.equal(result.stdout.trim(),'buffered cancellation joined');
});
