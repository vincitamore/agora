// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256 } from '../src/tailcat-runtime.mjs';
import { spawnTailcat } from '../src/tailcat-process.mjs';

test('runtime exit does not truncate buffered bytes through a slow guardian pipe',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-guardian-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const child=await spawnTailcat(['-e','process.stdout.write(Buffer.alloc(1048576,97))'],{stateRoot:root,override:process.execPath,overrideSha256:sha256(await readFile(process.execPath))});
  let bytes=0;
  assert.ok(child.stdout);
  for await(const chunk of child.stdout){bytes+=chunk.length;await delay(2);}
  assert.equal(bytes,1048576);
});

test('killing the requesting parent reaps its owned runtime without a saved-PID kill',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-guardian-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const moduleUrl=new URL('../src/tailcat-process.mjs',import.meta.url).href;
  const binaryHash=sha256(await readFile(process.execPath));
  const fixture=path.join(root,'parent.mjs');
  await writeFile(fixture,`import {spawnTailcat} from ${JSON.stringify(moduleUrl)};
const child=await spawnTailcat(['-e','console.log(process.pid);setInterval(()=>{},1000)'],{stateRoot:${JSON.stringify(root)},override:process.execPath,overrideSha256:${JSON.stringify(binaryHash)}});
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
