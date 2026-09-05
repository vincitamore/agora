// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

/** @param {import('node:test').TestContext} t @param {'after-ready'|'during-publication'} phase */
async function exerciseExit(t,phase){
  const root=await mkdtemp(path.join(tmpdir(),'agora-route-exit-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const digest='sha256:'+'a'.repeat(64);
  await writeFile(path.join(root,'worker.json'),JSON.stringify({id:randomUUID(),files:[{id:'0',name:'a.txt',size:1,digest}],
    expires:Date.now()+20000,controlSecret:randomBytes(32).toString('hex'),peers:[{account:'test',nodeKey:'nodekey:'+'b'.repeat(64),receiptDigest:digest}]}));
  const script=path.join(root,'run.mjs');
  await writeFile(script,`import{runOfferWorker}from${JSON.stringify(new URL('../src/tailcat-offer-worker.mjs',import.meta.url).href)};
import{atomicJson}from${JSON.stringify(new URL('../src/tailcat.mjs',import.meta.url).href)};
import{spawn}from'node:child_process';
import{once}from'node:events';
import path from'node:path';
const trace=event=>console.log(JSON.stringify(event));
let child;
const runtime=await runOfferWorker(${JSON.stringify(root)},{
  spawn:async()=>{
    child=spawn(process.execPath,['-e',${JSON.stringify("process.on('message',message=>{if(message==='crash')process.exit(1)});console.log(JSON.stringify({listenAddr:'a'.repeat(30)}));")}],{stdio:['pipe','pipe','pipe','ipc']});
    child.once('exit',(code,signal)=>trace({event:'route-exit',code,signal,connected:child.connected}));
    return child;
  },
  publish:async(file,value)=>{
    if(path.basename(file)==='ready.json'&&${JSON.stringify(phase)}==='during-publication'){
      // Hold publication until the route really dies: no sleep or timing guess.
      const exited=once(child,'exit');
      trace({event:'publication-held'});
      child.send('crash');
      await exited;
    }
    await atomicJson(file,value);
  }
});
try{
  await runtime.ready;
  trace({event:'worker-ready'});
  child.send('crash');
}catch(error){
  trace({event:'startup-rejected',message:error.message});
}
await runtime.closed;
trace({event:'worker-closed'});
`);
  let result;
  try{
    result={...await promisify(execFile)(process.execPath,[script],{timeout:10000,windowsHide:true}),code:0};
  }catch(error){
    const failure=/** @type {Error & {code?:number|string,signal?:string,stdout?:string,stderr?:string}} */(error);
    assert.equal(failure.code,1,`unexpected subprocess termination: ${failure.message}; signal=${failure.signal}; stdout=${failure.stdout}; stderr=${failure.stderr}`);
    result={code:1,stdout:failure.stdout??'',stderr:failure.stderr??''};
  }
  const trace=result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const diagnostics=JSON.stringify({phase,...result,trace});
  assert.equal(result.code,phase==='after-ready'?0:1,diagnostics);
  assert.equal(result.stderr,'');
  assert.deepEqual(trace.map(row=>row.event),phase==='after-ready'
    ?['worker-ready','route-exit','worker-closed']
    :['publication-held','route-exit','startup-rejected','worker-closed'],diagnostics);
  assert.deepEqual(trace.find(row=>row.event==='route-exit'),{event:'route-exit',code:1,signal:null,connected:false},diagnostics);
  if(phase==='during-publication')assert.equal(trace.find(row=>row.event==='startup-rejected').message,'Offer startup was stopped',diagnostics);
  assert.ok(JSON.parse(await readFile(path.join(root,'stopped.json'),'utf8')).stoppedAt);
  await assert.rejects(readFile(path.join(root,'ready.json')),/** @param {any} e */e=>e.code==='ENOENT');
}

test('an unexpected route exit closes the worker without disconnecting a dead IPC channel',async t=>{
  await exerciseExit(t,'after-ready');
});

test('a route that dies during readiness publication fails startup and joins cleanup',async t=>{
  await exerciseExit(t,'during-publication');
});
