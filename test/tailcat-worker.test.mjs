// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('an unexpected route exit closes the worker without disconnecting a dead IPC channel',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-route-exit-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const digest='sha256:'+'a'.repeat(64);
  await writeFile(path.join(root,'worker.json'),JSON.stringify({id:randomUUID(),files:[{id:'0',name:'a.txt',size:1,digest}],
    expires:Date.now()+20000,controlSecret:randomBytes(32).toString('hex'),peers:[{account:'test',nodeKey:'nodekey:'+'b'.repeat(64),receiptDigest:digest}]}));
  const script=path.join(root,'run.mjs');
  await writeFile(script,`import{runOfferWorker}from${JSON.stringify(new URL('../src/tailcat-offer-worker.mjs',import.meta.url).href)};
import{spawn}from'node:child_process';
await runOfferWorker(${JSON.stringify(root)},{spawn:async()=>spawn(process.execPath,['-e',${JSON.stringify("setTimeout(()=>console.log(JSON.stringify({listenAddr:'a'.repeat(30)})),50);setTimeout(()=>process.exit(1),250)")}],{stdio:['pipe','pipe','pipe','ipc']})});
`);
  const result=await promisify(execFile)(process.execPath,[script],{timeout:10000,windowsHide:true});
  assert.equal(result.stderr,'');
  assert.ok(JSON.parse(await readFile(path.join(root,'stopped.json'),'utf8')).stoppedAt);
  await assert.rejects(readFile(path.join(root,'ready.json')),/** @param {any} e */e=>e.code==='ENOENT');
});
