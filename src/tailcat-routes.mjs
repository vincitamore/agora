// @ts-check
import { createServer } from 'node:net';
import { Duplex } from 'node:stream';
import { finished } from 'node:stream/promises';
import { addAbortListener } from 'node:events';
import path from 'node:path';
import { spawnTailcat } from './tailcat-process.mjs';
import { readTailcatAddress, boundedBytes } from './tailcat-http.mjs';
import { prepareRuntimeLifetime } from './tailcat-lifetime.mjs';
import { validateRouteBinding, validateRouteDescriptor, publicNodeKeyDigest } from './protocol/route.mjs';

/** @typedef {import('./protocol/route.mjs').RouteBinding} Binding */
/** @typedef {import('./protocol/route.mjs').RouteDescriptor} Descriptor */
/** @typedef {{ready:Promise<unknown>,closed:Promise<unknown>,stop:()=>Promise<unknown>}} Session */
/** @typedef {{port:number,close:()=>Promise<unknown>}} Listener */
/** Trusted local dependency surface. None of these functions may be supplied by a wire envelope.
 * @typedef {{owner:import('./tailcat-lifetime.mjs').RuntimeOwner,runtime:Parameters<typeof spawnTailcat>[1],
 * acceptChannel:(binding:Binding,stream:Duplex,signal:AbortSignal)=>Session|Promise<Session>,
 * startupTimeoutMs?:number,stopTimeoutMs?:number,maxChannels?:number,
 * spawn?:typeof spawnTailcat,address?:typeof readTailcatAddress,
 * listen?:(accept:(socket:Duplex)=>void)=>Promise<Listener>}} Options */

/** @template T @param {T} value @returns {T} */
function freeze(value) {
  if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}
  return value;
}
function cancelled(){return Object.assign(Error('Native route stopped before readiness.'),{code:'AGORA_ROUTE_CANCELLED'});}
/** @param {unknown} value @param {number} fallback */
function duration(value,fallback){const n=value??fallback;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<1||n>2147483647)throw Error('Invalid route bound.');return n;}

/** One TCP listener per admitted member. Request bytes never select its binding.
 * The local machine remains in the cooperative trust profile; loopback is not OS-user isolation.
 * @param {(socket:Duplex)=>void} accept @returns {Promise<Listener>} */
async function listen(accept){
  const server=createServer(accept);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve(undefined);});});
  const addr=server.address();if(!addr||typeof addr==='string')throw Error('Native route listener unavailable.');
  return {port:addr.port,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve(undefined)))};
}

/** A closure owns only its own transient handles, never a registry or membership decision.
 * @template T @param {Options} options @param {(scope:ReturnType<typeof resources>)=>Promise<T>} start */
function owned(options,start){
  const startupTimeout=duration(options.startupTimeoutMs,60000);
  const scope=resources(options);
  const startup=Promise.resolve().then(()=>{scope.check();return start(scope);});
  scope.startup=startup.then(()=>{},error=>{scope.failures.push(error?.tailcatCleanupUnconfirmed?error:undefined);});
  const timer=setTimeout(()=>scope.stop(),startupTimeout);
  const ready=scope.race(startup).catch(error=>{void scope.stop();throw error;}).finally(()=>clearTimeout(timer));
  void ready.catch(()=>{});
  return {ready,closed:scope.closed,stop:scope.stop};
}

/** @param {Options} options */
function resources(options){
  if(!options.owner||!(options.owner.signal instanceof AbortSignal)||typeof options.acceptChannel!=='function')throw Error('Native routes require a live local owner and session factory.');
  const owner=Object.freeze({serviceId:options.owner.serviceId,serviceBootId:options.owner.serviceBootId,signal:options.owner.signal});
  const lifetime=prepareRuntimeLifetime({lifetime:{kind:'service',owner:{serviceId:owner.serviceId,serviceBootId:owner.serviceBootId}}},owner);
  // Copy trusted runtime configuration before deferred startup. Callers cannot override lifetime.
  const runtime={...options.runtime,lifetime};delete runtime.deadline;
  const stopTimeout=duration(options.stopTimeoutMs,10000),maxChannels=duration(options.maxChannels,64);
  const controller=new AbortController();
  /** @type {Set<Duplex>} */ const streams=new Set();
  /** @type {Set<Promise<unknown>>} */ const streamDisposals=new Set();
  /** @type {Set<Promise<unknown>>} */ const pending=new Set();
  /** @type {Set<{session:Session,stop?:Promise<unknown>}>} */ const sessions=new Set();
  /** @type {Set<Promise<unknown>>} */ const sessionDisposals=new Set();
  /** @type {Set<{child:Awaited<ReturnType<typeof spawnTailcat>>,closed:Promise<unknown>}>} */ const children=new Set();
  /** @type {unknown[]} */ const failures=[];
  /** @type {Listener|undefined} */ let listener;
  /** @type {Promise<unknown>|undefined} */ let listenerClosed;
  /** @type {()=>void} */ let resolveClosed=()=>{};
  /** @type {(e:unknown)=>void} */ let rejectClosed=()=>{};
  const closed=new Promise((resolve,reject)=>{resolveClosed=()=>resolve(undefined);rejectClosed=reject;});void closed.catch(()=>{});
  /** @type {Promise<unknown>|undefined} */ let stopResult;
  const signal=controller.signal;
  const cancellation=new Promise((_,reject)=>addAbortListener(signal,()=>reject(cancelled())));void cancellation.catch(()=>{});
  const check=()=>{if(signal.aborted)throw cancelled();};
  /** @template T @param {Promise<T>} p @returns {Promise<T>} */
  const race=p=>Promise.race([p,cancellation]);
  /** @param {{session:Session,stop?:Promise<unknown>}} entry */
  const stopSession=entry=>{if(!entry.stop){entry.stop=Promise.resolve().then(()=>entry.session.stop());void entry.stop.catch(error=>{if(!error?.cleanupPending)failures.push(error);});}};
  const dispose=()=>{
    if(listener&&!listenerClosed){listenerClosed=Promise.resolve().then(()=>listener?.close());void listenerClosed.catch(()=>{});}
    for(const stream of streams)stream.destroy();
    for(const entry of sessions)stopSession(entry);
    for(const {child} of children){child.stdout?.resume();if(child.connected)child.disconnect();}
  };
  const cleanup=async()=>{
    dispose();await scope.startup;dispose();
    // Acceptors can still return owned sessions after cancellation; their creation tasks join them.
    await Promise.allSettled([...pending]);dispose();
    const results=await Promise.allSettled([...children].map(x=>x.closed).concat([...sessionDisposals],[...streamDisposals],listenerClosed?[listenerClosed]:[]));
    for(const result of results)if(result.status==='rejected')failures.push(result.reason);
    abortSubscription[Symbol.dispose]();
    const failure=failures.find(x=>x!==undefined);if(failure)throw failure;
  };
  const stop=()=>{
    if(!stopResult){
      stopResult=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Object.assign(Error('Native route cleanup is pending; retain closed and the resource handle.'),{code:'AGORA_CLEANUP_PENDING',cleanupPending:true})),stopTimeout);
        void closed.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
      });void stopResult.catch(()=>{});
      controller.abort();dispose();void cleanup().then(resolveClosed,rejectClosed);
    }
    return stopResult;
  };
  const abortSubscription=addAbortListener(owner.signal,()=>{void stop();});
  /** @param {Duplex} stream */
  const ownStream=stream=>{
    streams.add(stream);stream.on('error',()=>{});
    const disposed=new Promise(resolve=>{if(stream.closed)resolve(undefined);else stream.once('close',()=>resolve(undefined));});
    streamDisposals.add(disposed);void disposed.then(()=>{streams.delete(stream);streamDisposals.delete(disposed);});
    if(signal.aborted)stream.destroy();
  };
  /** @param {Binding} binding @param {Duplex} stream */
  const accept=(binding,stream)=>{
    if(signal.aborted||pending.size+sessions.size>=maxChannels){stream.destroy();return Promise.reject(cancelled());}
    ownStream(stream);
    const task=(async()=>{
      check();const session=await options.acceptChannel(binding,stream,signal);
      if(!session||typeof session.stop!=='function'||!(session.ready instanceof Promise)||!(session.closed instanceof Promise)){
        const error=Error('Session factory returned no joinable ownership handle.');failures.push(error);throw error;
      }
      /** @type {{session:Session,stop?:Promise<unknown>}} */ const entry={session};sessions.add(entry);void session.ready.catch(()=>{});
      const disposal=(async()=>{
        try{await session.closed;}catch(error){failures.push(error);}
        stream.destroy();stopSession(entry);
        await entry.stop?.catch(error=>{if(!error?.cleanupPending)failures.push(error);});sessions.delete(entry);
      })();
      sessionDisposals.add(disposal);void disposal.finally(()=>sessionDisposals.delete(disposal)).catch(()=>{});
      stream.once('close',()=>stopSession(entry));
      if(signal.aborted||stream.destroyed)stopSession(entry);
      try {await race(session.ready);check();}catch(error){stream.destroy();stopSession(entry);throw error;}
      return session;
    })();
    pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;
  };
  /** @param {string[]} args @param {boolean} [resident] */
  const spawn=async(args,resident=false)=>{
    check();const child=await(options.spawn??spawnTailcat)(args,runtime,{...owner,signal});
    // Register exit observation before any await or cancellation dispatch.
    const exited=new Promise((resolve,reject)=>{
      /** @param {number|null} code @param {NodeJS.Signals|null} sig */
      const done=(code,sig)=>sig?reject(Object.assign(Error('Route guardian cleanup unconfirmed.'),{tailcatCleanupUnconfirmed:true})):resolve(code);
      if(child.exitCode!==null||child.signalCode!==null)done(child.exitCode,child.signalCode);else child.once('exit',done);
    });
    const pipe=child.stdout?finished(child.stdout,{cleanup:true}).catch(()=>{}):Promise.resolve();
    const ended=Promise.all([exited,pipe]);void ended.catch(()=>{});children.add({child,closed:ended});
    if(resident)void exited.then(()=>stop(),()=>stop()).catch(()=>{});
    if(signal.aborted){child.stdout?.resume();if(child.connected)child.disconnect();}
    check();return {child,exited};
  };
  /** Run upstream's actual parser/printpub through the same guardian, with bounded output.
   * @param {string[]} args */
  const command=async(args)=>{
    const {child,exited}=await spawn(args);
    if(!child.stdout)throw Error('Tailcat command output unavailable.');
    const bytes=await race(boundedBytes(child.stdout,8192));const code=await race(exited);
    if(code!==0)throw Error('Tailcat route/key validation failed.');return bytes.toString('utf8');
  };
  const scope={closed,stop,check,race,signal,failures,spawn,command,accept,ownStream,
    startup:Promise.resolve(),
    /** @param {Listener} value */ ownListener(value){listener=value;if(signal.aborted)dispose();},
  };
  return scope;
}

/** Host ingress. ready is a locally published endpoint, NOT remote hello or membership proof.
 * P1 registers the returned resource and fences effects against its captured binding.
 * @param {{binding:unknown,allowedNodeKey:string}} request @param {Options} options */
export function startMemberRoute(request,options){
  const binding=freeze(validateRouteBinding(request.binding)),key=request.allowedNodeKey;
  if(publicNodeKeyDigest(key)!==binding.allowedKeyDigest)throw Error('Route allow key does not match binding.');
  if(binding.serviceBootId!==options.owner?.serviceBootId)throw Error('Host route boot does not match local owner.');
  return owned(options,async scope=>{
    const listener=await(options.listen??listen)(socket=>{void scope.accept(binding,socket).catch(()=>socket.destroy());});
    scope.ownListener(listener);scope.check();
    const {child}=await scope.spawn(['serve','--key=new','--full-address','--json',`--allow=${key}`,String(listener.port)],true);
    const address=await scope.race((options.address??readTailcatAddress)(child));scope.check();
    if(typeof address!=='string'||!/^[A-Za-z0-9._:~+-]{20,1800}$/.test(address)||address.endsWith('\n'))throw Error('Invalid route endpoint.');
    await scope.command(['parse',address]);scope.check();
    return freeze({binding,endpoint:{transport:'tailcat',address,port:listener.port}});
  });
}

/** Outbound context callbacks come from the live local P1 registry, never JSON requests.
 * assertDescriptor must authenticate host/proof/context or throw; resolveClientKey must select
 * an already enrolled local private file. P2 additionally derives its actual public key.
 * ready waits for P1's session hello; callbacks themselves do not become authentication proofs.
 * @param {{descriptor:unknown}} request
 * @param {Options & {assertDescriptor:(descriptor:Descriptor,signal:AbortSignal)=>Promise<void>|void,
 * resolveClientKey:(binding:Binding,signal:AbortSignal)=>Promise<{keyPath:string}>}} options */
export function startMemberChannel(request,options){
  const descriptor=freeze(validateRouteDescriptor(request.descriptor));
  if(typeof options.assertDescriptor!=='function'||typeof options.resolveClientKey!=='function')throw Error('Outbound route requires local descriptor authority and enrolled key resolver.');
  return owned(options,async scope=>{
    await options.assertDescriptor(descriptor,scope.signal);scope.check();
    await scope.command(['parse',descriptor.endpoint.address]);scope.check();
    const key=await options.resolveClientKey(descriptor.binding,scope.signal);scope.check();
    if(!key||typeof key.keyPath!=='string'||!path.isAbsolute(key.keyPath)||/[\x00-\x1f\x7f]/.test(key.keyPath))throw Error('Expected local absolute enrolled key path.');
    const keyPath=key.keyPath;
    const printed=await scope.command([`--key=${keyPath}`,'printpub']);scope.check();
    // Upstream printpub appends exactly one LF. Never trim arbitrary invalid whitespace.
    const publicKey=printed.endsWith('\n')?printed.slice(0,-1):printed;
    if(publicNodeKeyDigest(publicKey)!==descriptor.binding.allowedKeyDigest)throw Error('Local enrolled private key does not match route binding.');
    const {child}=await scope.spawn([`--key=${keyPath}`,descriptor.endpoint.address,String(descriptor.endpoint.port)],true);
    if(!child.stdin||!child.stdout)throw Error('Native route pipes unavailable.');
    const stream=Duplex.from({readable:child.stdout,writable:child.stdin});
    await scope.accept(descriptor.binding,stream);scope.check();return freeze({binding:descriptor.binding});
  });
}
