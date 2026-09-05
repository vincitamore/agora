// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { resolveTailcatBinary, readTailcatLock, sha256, TAILCAT_TARGETS } from '../src/tailcat-runtime.mjs';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vendorDir = path.join(root,'vendor'), stateRoot = path.join(root,'state');
  const bytes = Buffer.from('test-runtime-bytes'), capsule = gzipSync(bytes), license = Buffer.from('BSD 3-Clause License\nTest fixture');
  await mkdir(vendorDir);
  /** @type {any} */
  const lock = { version:1,source:{repository:'https://github.com/tailscale/tailcat',tag:'v0.4.0',revision:'a'.repeat(40)},build:{tags:'netgo'},license:{path:'LICENSE',sha256:sha256(license)},targets:{} };
  for (const target of TAILCAT_TARGETS) {
    await mkdir(path.join(vendorDir,target));
    await writeFile(path.join(vendorDir,target,'tailcat.gz'),capsule);
    lock.targets[target]={path:`${target}/tailcat.gz`,size:bytes.length,sha256:sha256(bytes),capsuleSize:capsule.length,capsuleSha256:sha256(capsule)};
  }
  await writeFile(path.join(vendorDir,'LICENSE'),license);
  const save = () => writeFile(path.join(vendorDir,'lock.json'),JSON.stringify(lock));
  await save();
  return {root,vendorDir,stateRoot,lock,bytes,save};
}
test('all six targets expand locally, including Node x64/win32 aliases',async t=>{
  const f=await fixture(t);
  for(const platform of ['win32','linux','darwin']) for(const arch of ['x64','arm64']) {
    const result=await resolveTailcatBinary({...f,platform,arch});
    assert.deepEqual(await readFile(result.path),f.bytes);
    assert.equal(result.source,'bundle');
  }
});
test('every resolution detects cache corruption and explicit repair restores verified bytes',async t=>{
  const f=await fixture(t), result=await resolveTailcatBinary(f);
  await writeFile(result.path,'changed');
  await assert.rejects(resolveTailcatBinary(f),/cached executable checksum mismatch/);
  const repaired=await resolveTailcatBinary({...f,repair:true});
  assert.deepEqual(await readFile(repaired.path),f.bytes);
});
test('capsule and expanded hashes are separate gates, even with a valid cache',async t=>{
  const f=await fixture(t), result=await resolveTailcatBinary(f), e=f.lock.targets[result.target];
  await writeFile(path.join(f.vendorDir,e.path),'corrupt');
  await assert.rejects(resolveTailcatBinary(f),/capsule checksum mismatch/);
  const replacement=gzipSync(Buffer.from('a different binary'));
  await writeFile(path.join(f.vendorDir,e.path),replacement);
  e.capsuleSha256=sha256(replacement);e.capsuleSize=replacement.length;await f.save();
  await rm(result.path);
  await assert.rejects(resolveTailcatBinary(f),/expanded executable checksum mismatch/);
});
test('declared expansion bounds prevent a gzip bomb',async t=>{
  const f=await fixture(t);const capsule=gzipSync(Buffer.alloc(1024*1024));
  for(const e of Object.values(f.lock.targets)) {
    e.capsuleSize=capsule.length;e.capsuleSha256=sha256(capsule);
    await writeFile(path.join(f.vendorDir,e.path),capsule);
  }
  await f.save();await assert.rejects(resolveTailcatBinary(f),/within its declared size/);
});
test('malformed target paths, missing platforms and altered license are refused',async t=>{
  const f=await fixture(t);
  await assert.rejects(resolveTailcatBinary({...f,platform:'freebsd'}),/unavailable for/);
  f.lock.targets['linux-amd64'].path='../escape';await f.save();
  await assert.rejects(readTailcatLock(f.vendorDir),/target linux-amd64 is invalid/);
  f.lock.targets['linux-amd64'].path='linux-amd64/tailcat.gz';await f.save();
  await writeFile(path.join(f.vendorDir,'LICENSE'),'changed');
  await assert.rejects(resolveTailcatBinary(f),/license checksum mismatch/);
});
test('override is explicit and hash checked, never an ambient executable',async t=>{
  const f=await fixture(t), override=path.join(f.root,'override.exe');
  await writeFile(override,'different runtime');
  await assert.rejects(resolveTailcatBinary({...f,override}),/override checksum mismatch/);
  const result=await resolveTailcatBinary({...f,override,overrideSha256:sha256(Buffer.from('different runtime'))});
  assert.equal(result.source,'override');assert.equal(result.path,override);
  await assert.rejects(resolveTailcatBinary({...f,override:'tailcat'}),/absolute/);
});
test('concurrent first use commits complete bytes with no temporary paths returned',async t=>{
  const f=await fixture(t);
  const results=await Promise.all(Array.from({length:6},()=>resolveTailcatBinary(f)));
  assert.equal(new Set(results.map(x=>x.path)).size,1);
  assert.deepEqual(await readFile(results[0].path),f.bytes);
});
test('linked cache directories cannot redirect extraction',async t=>{
  const f=await fixture(t);await mkdir(f.stateRoot);const outside=path.join(f.root,'outside');await mkdir(outside);
  await symlink(outside,path.join(f.stateRoot,'bin'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(resolveTailcatBinary(f),/linked or non-directory/);
});
