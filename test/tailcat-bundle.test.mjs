// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readTailcatLock, resolveTailcatBinary, TAILCAT_TARGETS } from '../src/tailcat-runtime.mjs';
const exec=promisify(execFile);

test('fresh checkout carries all six verified capsules and runs its native binary without Go',async t=>{
  const stateRoot=await mkdtemp(path.join(tmpdir(),'agora-bundle-'));t.after(()=>rm(stateRoot,{recursive:true,force:true}));
  const lock=await readTailcatLock();
  const source=JSON.parse(await readFile(new URL('../vendor/tailcat/source.json',import.meta.url),'utf8'));
  assert.deepEqual(lock.source,source);
  assert.equal(lock.source.revision,'ce6fedcabc220bab3b94d470ab330219111eeae8');
  assert.equal(lock.build.go,'go1.27.0');assert.equal(lock.build.cgo,false);
  for(const target of TAILCAT_TARGETS){
    const [platform,arch]=target.split('-');
    const runtime=await resolveTailcatBinary({stateRoot,platform:platform==='windows'?'win32':platform,arch:arch==='amd64'?'x64':arch});
    assert.equal(runtime.sha256,lock.targets[target].sha256);
  }
  const native=await resolveTailcatBinary({stateRoot});
  assert.equal((await exec(native.path,['version'],{windowsHide:true,timeout:10000})).stdout.trim(),lock.source.tag);
});
