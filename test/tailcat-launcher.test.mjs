// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { controlOffer } from '../src/tailcat-launcher.mjs';

test('native offer worker survives posting-parent death and stops only through its control nonce',{
  skip:process.platform==='darwin'&&process.env.AGORA_TEST_LAUNCHD!=='1'?'needs a login launchd domain':false,
},async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'agora-resident-')));
  const directory=path.join(root,'space & percent% dollar$');await mkdir(directory);
  const id=randomUUID(),secret=randomBytes(32).toString('hex');
  const worker=path.join(root,'fixture-worker.mjs');
  await writeFile(worker,`import {createServer}from'node:http';import{writeFile}from'node:fs/promises';import path from'node:path';
const server=createServer((req,res)=>{if(req.headers.authorization!==${JSON.stringify('Bearer '+secret)}){res.writeHead(403);res.end();return;}if(req.url==='/stop'){res.end(()=>{server.closeAllConnections();server.close();});return;}res.end(JSON.stringify({id:${JSON.stringify(id)}}));});
server.listen(0,'127.0.0.1',async()=>{await writeFile(path.join(process.argv[3],'control.json'),JSON.stringify({id:${JSON.stringify(id)},port:server.address().port,secret:${JSON.stringify(secret)}}));});
setTimeout(()=>{server.closeAllConnections();server.close();},20000).unref();
`);
  const parentPath=path.join(root,'parent.mjs');
  await writeFile(parentPath,`import{launchOffer}from${JSON.stringify(new URL('../src/tailcat-launcher.mjs',import.meta.url).href)};
await launchOffer(${JSON.stringify(directory)},${JSON.stringify(id)},{workerPath:${JSON.stringify(worker)}});console.log('launched');setInterval(()=>{},1000);
`);
  const parent=spawn(process.execPath,[parentPath],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(async()=>{
    parent.kill('SIGKILL');await controlOffer(directory,'stop');
    if(process.platform==='darwin')await promisify(execFile)('/bin/launchctl',['bootout',`gui/${process.getuid?.()}/org.agora.offer.${id}`]).catch(()=>{});
    await rm(root,{recursive:true,force:true});
  });
  // Windows CIM startup has its own 20-second deadline. Do not spend the worker's
  // 10-second readiness budget while PowerShell is still starting on a cold CI host.
  await new Promise((resolve,reject)=>{
    let stdout='',stderr='';
    const timer=setTimeout(()=>reject(Error('native launcher did not return within 25 seconds: '+stderr)),25000);
    parent.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
    parent.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('launched')){clearTimeout(timer);resolve(undefined);}});
    parent.once('error',error=>{clearTimeout(timer);reject(error);});
    parent.once('exit',code=>{clearTimeout(timer);reject(Error('native launcher exited '+code+': '+stderr));});
  });
  for(let n=0;n<100&&!await controlOffer(directory,'health');n++)await delay(100);
  assert.equal(await controlOffer(directory,'health'),true,'native startup must preserve metacharacter-heavy argv');
  parent.kill('SIGKILL');await delay(200);
  assert.equal(await controlOffer(directory,'health'),true,'terminal death is not offer cancellation');
  const record=JSON.parse(await readFile(path.join(directory,'control.json'),'utf8'));
  const wrong=await fetch(`http://127.0.0.1:${record.port}/stop`,{method:'POST',headers:{Authorization:'Bearer wrong'}});
  assert.equal(wrong.status,403);assert.equal(await controlOffer(directory,'health'),true);
  assert.equal(await controlOffer(directory,'stop'),true);
  for(let n=0;n<50&&await controlOffer(directory,'health');n++)await delay(100);
  assert.equal(await controlOffer(directory,'health'),false);
});
