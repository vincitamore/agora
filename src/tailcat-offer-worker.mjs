// @ts-check
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { atomicJson, nodeKeyValid, validateTransferManifest } from './tailcat.mjs';
import { createTransferListener, readTailcatAddress } from './tailcat-http.mjs';
import { spawnTailcat } from './tailcat-process.mjs';

/**
 * An ownership primitive with no process-global handlers. Stop requests cancellation;
 * its returned closed promise joins creations already in flight and removes ready.json.
 * An already pending filesystem rename can briefly publish that legacy file during
 * cancellation. Managed owners consume ready over IPC, never filesystem polling.
 * @param {string} directory
 * @param {{spawn?:typeof spawnTailcat,listen?:typeof createTransferListener,address?:typeof readTailcatAddress,publish?:typeof atomicJson}} [deps]
 */
export function startOfferWorker(directory,deps={}) {
  /** @typedef {{listener:Awaited<ReturnType<typeof createTransferListener>>,child?:Awaited<ReturnType<typeof spawnTailcat>>,listenerClosed?:Promise<unknown>,childClosed?:Promise<void>}} Resource */
  /** @type {Resource[]} */ const resources=[];
  /** @type {any} */ let spec;
  let stopping=false;
  /** @type {unknown} */ let cleanupFailure;
  /** @type {NodeJS.Timeout | undefined} */ let expiry;
  /** @type {()=>void} */ let finishStartup;
  const startupDone=new Promise(resolve=>{finishStartup=()=>resolve(undefined);});
  /** @type {()=>void} */ let cancelStartup;
  const cancelled=new Promise(resolve=>{cancelStartup=()=>resolve(undefined);});
  /** @type {()=>void} */ let resolveClosed;
  /** @type {(error:unknown)=>void} */ let rejectClosed;
  const closed=new Promise((resolve,reject)=>{resolveClosed=()=>resolve(undefined);rejectClosed=reject;});
  void closed.catch(()=>{});
  const ensureRunning=()=>{if(stopping)throw Error('Offer startup was stopped');};
  const control=createServer((req,res)=>{
    const supplied=Buffer.from(String(req.headers.authorization??''));
    const expected=Buffer.from(`Bearer ${spec.controlSecret}`);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(403);res.end();return;}
    // Legacy stopOffer polls health to observe completed cleanup, not stop admission.
    if(req.method==='GET'&&req.url==='/health'){res.writeHead(200);res.end(JSON.stringify({id:spec.id,expires:spec.expires,stopping}));return;}
    if(req.method==='POST'&&req.url==='/stop'){res.writeHead(200);res.end(()=>{void stop();});return;}
    res.writeHead(404);res.end();
  });
  /** A listener may close before its pending child creation finishes. @param {Resource} resource */
  const dispose=resource=>{
    resource.listenerClosed??=Promise.resolve().then(()=>resource.listener.close());
    void resource.listenerClosed.catch(()=>{});
    const child=resource.child;
    if(child&&!resource.childClosed){
      resource.childClosed=new Promise((resolve,reject)=>{
        /** @param {number|null} _code @param {NodeJS.Signals|null} signal */
        const exited=(_code,signal)=>signal?reject(Error('Route guardian termination did not confirm child cleanup')):resolve();
        if(child.exitCode!==null||child.signalCode!==null)exited(child.exitCode,child.signalCode);
        else child.once('exit',exited);
        if(child.connected)child.disconnect();
      });
      void resource.childClosed.catch(()=>{});
    }
  };
  const shutdown=async()=>{
    for(const resource of resources)dispose(resource);
    await startupDone;
    for(const resource of resources)dispose(resource);
    const results=await Promise.allSettled(resources.flatMap(r=>[r.listenerClosed,r.childClosed]));
    await new Promise(resolve=>{control.close(()=>resolve(undefined));control.closeAllConnections();});
    await rm(path.join(directory,'ready.json'),{force:true});
    if(cleanupFailure)throw cleanupFailure;
    const failed=results.find(result=>result.status==='rejected');
    if(failed?.status==='rejected')throw failed.reason;
    await atomicJson(path.join(directory,'stopped.json'),{stoppedAt:new Date().toISOString()});
  };
  const stop=()=>{
    if(!stopping){
      stopping=true;clearTimeout(expiry);cancelStartup();
      void shutdown().then(resolveClosed,rejectClosed);
    }
    return closed;
  };
  const startup=async()=>{
    try {
      spec=JSON.parse(await readFile(path.join(directory,'worker.json'),'utf8'));
      const files=validateTransferManifest(spec.files);
      if(!Array.isArray(spec.peers)||!spec.peers.length||spec.peers.length>4||
          !Number.isSafeInteger(spec.expires)||spec.expires<=Date.now()||spec.expires>Date.now()+86400000||
          !/^[a-f0-9]{64}$/.test(spec.controlSecret))throw Error('Invalid local offer configuration');
      ensureRunning();
      expiry=setTimeout(()=>{void stop();},spec.expires-Date.now());expiry.unref();
      await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(0,'127.0.0.1',()=>resolve(undefined));});
      ensureRunning();
      const addr=control.address();if(!addr||typeof addr==='string')throw Error('Control unavailable');
      await atomicJson(path.join(directory,'control.json'),{port:addr.port,secret:spec.controlSecret,id:spec.id});
      const routes=[];
      for(const [index,peer] of spec.peers.entries()) {
        ensureRunning();
        if(!nodeKeyValid(peer.nodeKey)||!/^sha256:[a-f0-9]{64}$/.test(peer.receiptDigest))throw Error('Invalid route');
        const listener=await (deps.listen??createTransferListener)({payloadDir:path.join(directory,'payload'),files,
          receiptPath:path.join(directory,`receipt-${index}.json`),expires:spec.expires,once:spec.once,receiptDigest:peer.receiptDigest});
        /** @type {Resource} */ const resource={listener};resources.push(resource);
        if(stopping)dispose(resource);
        ensureRunning();
        const child=await (deps.spawn??spawnTailcat)(['serve','--key=new','--full-address','--json',`--allow=${peer.nodeKey}`,String(listener.port)],
          {stateRoot:spec.stateRoot,deadline:spec.expires,...spec.runtime});
        resource.child=child;
        child.once('exit',()=>{void stop();});
        if(stopping||child.exitCode!==null||child.signalCode!==null){dispose(resource);void stop();}
        ensureRunning();
        const address=await Promise.race([(deps.address??readTailcatAddress)(child),cancelled.then(()=>{throw Error('Offer startup was stopped');})]);
        ensureRunning();
        routes.push({account:peer.account,nodeKey:peer.nodeKey,address,port:listener.port,receiptDigest:peer.receiptDigest});
      }
      ensureRunning();
      const offer={id:spec.id,expires:spec.expires,files,routes};
      await (deps.publish??atomicJson)(path.join(directory,'ready.json'),offer);
      ensureRunning();
      return offer;
    } finally {finishStartup();}
  };
  const ready=startup().catch(async error=>{
    if(error?.tailcatCleanupUnconfirmed)cleanupFailure=error;
    const cleanup=stop();
    // A failed diagnostic write must never prevent cleanup.
    await atomicJson(path.join(directory,'failed.json'),{error:'Offer could not become ready. Run agora doctor --offline, check relay connectivity, then retry agora share.'}).catch(()=>{});
    await cleanup;
    throw error;
  });
  void ready.catch(()=>{});
  return {ready,closed,stop};
}

/**
 * Executable wrapper. Only managed mode observes the launcher's ownership channel.
 * @param {string} directory
 * @param {Parameters<typeof startOfferWorker>[1] & {managed?:boolean}} [deps]
 */
export async function runOfferWorker(directory,deps={}) {
  const runtime=startOfferWorker(directory,deps);
  const stop=()=>{void runtime.stop();};
  /** @param {unknown} message */
  const onMessage=message=>{if(/** @type {any} */(message)?.type==='agora-offer-stop')stop();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  if(deps.managed){
    process.once('disconnect',stop);process.on('message',onMessage);
    if(!process.connected)stop();
  }
  const detach=()=>{
    process.off('SIGTERM',stop);process.off('SIGINT',stop);
    if(deps.managed){process.off('disconnect',stop);process.off('message',onMessage);}
  };
  /** @param {unknown} message @param {()=>void} [done] */
  const send=(message,done=()=>{})=>{
    if(!process.connected){done();return;}
    process.send?.(/** @type {any} */(message),()=>done());
  };
  void runtime.closed.then(()=>{
    detach();
    if(deps.managed)send({type:'agora-offer-closed'},()=>{if(process.connected)process.disconnect();});
  },()=>{
    detach();process.exitCode=1;
    if(deps.managed&&process.connected)process.disconnect();
  });
  try {
    const offer=await runtime.ready;
    if(deps.managed)send({type:'agora-offer-ready',offer});
  } catch {process.exitCode=1;}
  return runtime;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)&&
    (process.argv[2]==='--offer-worker'||process.argv[2]==='--managed-offer-worker'))
  await runOfferWorker(path.resolve(process.argv[3]),{managed:process.argv[2]==='--managed-offer-worker'});
