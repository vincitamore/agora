// @ts-check
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { atomicJson, nodeKeyValid, validateTransferManifest } from './tailcat.mjs';
import { createTransferListener, readTailcatAddress } from './tailcat-http.mjs';
import { spawnTailcat } from './tailcat-process.mjs';

/** @param {string} directory @param {{spawn?:typeof spawnTailcat}} [deps] */
export async function runOfferWorker(directory,deps={}) {
  const spec=JSON.parse(await readFile(path.join(directory,'worker.json'),'utf8'));
  const files=validateTransferManifest(spec.files);
  if(!Array.isArray(spec.peers)||!spec.peers.length||spec.peers.length>4||
      !Number.isSafeInteger(spec.expires)||spec.expires<=Date.now()||spec.expires>Date.now()+86400000||
      !/^[a-f0-9]{64}$/.test(spec.controlSecret))throw Error('Invalid local offer configuration');
  /** @type {Array<{listener:Awaited<ReturnType<typeof createTransferListener>>,child:Awaited<ReturnType<typeof spawnTailcat>>}>} */
  const resources=[];
  let stopping=false;
  const control=createServer((req,res)=>{
    const supplied=Buffer.from(String(req.headers.authorization??''));
    const expected=Buffer.from(`Bearer ${spec.controlSecret}`);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(403);res.end();return;}
    if(req.method==='GET'&&req.url==='/health'){res.writeHead(200);res.end(JSON.stringify({id:spec.id,expires:spec.expires}));return;}
    if(req.method==='POST'&&req.url==='/stop'){res.writeHead(200);res.end();void stop();return;}
    res.writeHead(404);res.end();
  });
  const stop=async()=>{
    if(stopping)return;stopping=true;
    for(const {child} of resources)if(child.connected)child.disconnect(); // a route that already exited has no IPC channel
    await Promise.all(resources.map(({child,listener})=>Promise.all([
      new Promise(resolve=>{if(child.exitCode!==null)resolve(undefined);else child.once('exit',()=>resolve(undefined));}),listener.close()])));
    control.closeAllConnections();control.close();
    await rm(path.join(directory,'ready.json'),{force:true});
    await atomicJson(path.join(directory,'stopped.json'),{stoppedAt:new Date().toISOString()});
  };
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  const expiry=setTimeout(()=>void stop(),spec.expires-Date.now());expiry.unref();
  try {
    await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(0,'127.0.0.1',()=>resolve(undefined));});
    const addr=control.address();if(!addr||typeof addr==='string')throw Error('Control unavailable');
    // Control readiness is available even during relay startup, so a cancelled launcher can stop us.
    await atomicJson(path.join(directory,'control.json'),{port:addr.port,secret:spec.controlSecret,id:spec.id});
    const routes=[];
    for(const [index,peer] of spec.peers.entries()) {
      if(stopping)throw Error('Stopped');
      if(!nodeKeyValid(peer.nodeKey)||!/^sha256:[a-f0-9]{64}$/.test(peer.receiptDigest))throw Error('Invalid route');
      const listener=await createTransferListener({payloadDir:path.join(directory,'payload'),files,
        receiptPath:path.join(directory,`receipt-${index}.json`),expires:spec.expires,once:spec.once,receiptDigest:peer.receiptDigest});
      let child;
      try {child=await (deps.spawn??spawnTailcat)(['serve','--key=new','--full-address','--json',`--allow=${peer.nodeKey}`,String(listener.port)],
        {stateRoot:spec.stateRoot,deadline:spec.expires,...spec.runtime});}
      catch(e){await listener.close();throw e;}
      if(stopping){if(child.connected)child.disconnect();await listener.close();throw Error('Stopped');}
      resources.push({listener,child});
      const address=await readTailcatAddress(child);
      child.once('exit',()=>{if(!stopping)void stop();});
      routes.push({account:peer.account,nodeKey:peer.nodeKey,address,port:listener.port,receiptDigest:peer.receiptDigest});
    }
    if(stopping)throw Error('Stopped');
    await atomicJson(path.join(directory,'ready.json'),{id:spec.id,expires:spec.expires,files,routes});
  } catch {
    await atomicJson(path.join(directory,'failed.json'),{error:'Offer could not become ready. Run agora doctor --offline, check relay connectivity, then retry agora share.'});
    await stop();process.exitCode=1;
  }
}

if(process.argv[2]==='--offer-worker')await runOfferWorker(path.resolve(process.argv[3]));
