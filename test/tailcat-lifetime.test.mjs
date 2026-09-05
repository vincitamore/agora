// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareRuntimeLifetime, runtimeExpiryDelay } from '../src/tailcat-lifetime.mjs';
import { spawnTailcat } from '../src/tailcat-process.mjs';

const ownerIds={serviceId:'service-aaaaaaaa',serviceBootId:'boot-aaaaaaaaaaa'};
const service=/** @type {const} */({kind:'service',owner:ownerIds});

test('lifetime policy preserves bounded offers and reserves indefinite runtime for explicit service ownership',()=>{
  const now=Date.parse('2026-09-05T12:00:00.000Z');
  assert.equal(runtimeExpiryDelay({},now),86400000);
  assert.equal(runtimeExpiryDelay({deadline:now+250},now),250);
  assert.equal(runtimeExpiryDelay({deadline:now-1},now),1);
  assert.equal(runtimeExpiryDelay({deadline:now+86400001},now),86400000);
  assert.equal(runtimeExpiryDelay({lifetime:{kind:'expiring',expiresAt:new Date(now+300).toISOString()}},now),300);
  assert.equal(runtimeExpiryDelay({lifetime:service},now),null);
  assert.equal(runtimeExpiryDelay({lifetime:service},now+7*86400000),null);
  assert.throws(()=>runtimeExpiryDelay({lifetime:service,deadline:now}),/Conflicting/);
  const controller=new AbortController();
  const copy=prepareRuntimeLifetime({lifetime:service},{...ownerIds,signal:controller.signal});
  assert.deepEqual(copy,service);
  assert.notEqual(copy,service);
  assert.notEqual(copy?.kind==='service'&&copy.owner,ownerIds);
});

test('invalid service owner refuses before process or runtime cache effects',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'agora-lifetime-refuse-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const controller=new AbortController();
  const owner={...ownerIds,signal:controller.signal};
  const options={stateRoot:root,lifetime:service};
  await assert.rejects(spawnTailcat([],options),/live local owner/);
  await assert.rejects(spawnTailcat([],options,{...owner,serviceBootId:'boot-bbbbbbbbbbb'}));
  await assert.rejects(spawnTailcat([],options,{...owner,signal:/** @type {AbortSignal} */(/** @type {unknown} */({aborted:false}))}),/live local owner/);
  await assert.rejects(spawnTailcat([],{...options,deadline:Date.now()},owner),/cannot both/);
  await assert.rejects(spawnTailcat([],{stateRoot:root},owner),/explicit service lifetime/);
  controller.abort();
  await assert.rejects(spawnTailcat([],options,owner),{code:'AGORA_RUNTIME_CANCELLED'});
  assert.deepEqual(await readdir(root),[],'refusal must precede runtime installation or launch');
});
