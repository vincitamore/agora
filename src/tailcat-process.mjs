// @ts-check
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { addAbortListener } from 'node:events';
import { resolveTailcatBinary } from './tailcat-runtime.mjs';
import { AgoraError, redact } from './core.mjs';
import { prepareRuntimeLifetime, runtimeExpiryDelay, runtimeCancelled } from './tailcat-lifetime.mjs';

const STDERR_TAIL_BYTES=512;
const STDERR_CAPTURE_BYTES=2048;

/** Tailcat is a verified third-party binary, but its stderr is still foreign input. Agora gives it
 * only a private-key PATH (never the route secret), yet a future upstream diagnostic could echo
 * the key it read. Redact the house credential shapes and Tailcat private/auth key shapes before
 * any retained bytes leave this child boundary. The larger private capture keeps a credential's
 * prefix available when the public 512-byte tail is cut. @param {string} value */
function safeStderr(value){
  return redact(value).replace(/\b(?:privkey|tskey-[a-z]+)[:_-][A-Za-z0-9+/_=-]{16,}/gi,'[redacted]');
}

/** @param {Buffer} previous @param {Buffer|string} chunk */
function appendStderrTail(previous,chunk){
  const next=Buffer.concat([previous,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
  return next.length<=STDERR_CAPTURE_BYTES?next:next.subarray(next.length-STDERR_CAPTURE_BYTES);
}

/** @param {Buffer} captured */
function publicStderrTail(captured){
  const safe=Buffer.from(safeStderr(captured.toString('utf8')));
  return (safe.length<=STDERR_TAIL_BYTES?safe:safe.subarray(safe.length-STDERR_TAIL_BYTES)).toString('utf8');
}

/**
 * A guardian owns the actual child handle and kills it on IPC disconnect, including SIGKILL of
 * the offer worker. No saved PID is ever used to kill a process after a restart.
 * @param {string[]} args @param {Parameters<typeof resolveTailcatBinary>[0] & import('./tailcat-lifetime.mjs').LifetimeOptions} options
 * @param {import('./tailcat-lifetime.mjs').RuntimeOwner} [owner] Local P1 handle, never serialized.
 */
export async function spawnTailcat(args,options,owner) {
  const lifetime=prepareRuntimeLifetime(options,owner);
  const ownerSignal=owner?.signal;
  const launchOptions={...options,...(lifetime===undefined?{}:{lifetime})};
  const guardian=spawn(process.execPath,[fileURLToPath(import.meta.url),'--guardian'],{stdio:['pipe','pipe','pipe','ipc'],windowsHide:true});
  let stderrTail=Buffer.alloc(0);
  guardian.stderr?.on('data',chunk=>{stderrTail=appendStderrTail(stderrTail,chunk);});
  Object.defineProperty(guardian,'tailcatStderrTail',{enumerable:false,value:()=>publicStderrTail(stderrTail)});
  // Keep ownership until rejected startup has actually terminated. The caller has no
  // handle yet and cannot join cleanup if rejection races the guardian's exit.
  // Node on Windows can omit ChildProcess.close after parent IPC disconnect.
  // Join actual process exit and the readable pipe, not IPC's close accounting.
  const terminated=Promise.all([
    new Promise(resolve=>{guardian.once('exit',()=>resolve(undefined));guardian.once('error',()=>resolve(undefined));}),
    guardian.stdout?finished(guardian.stdout,{cleanup:true}).catch(()=>{}):Promise.resolve(),
    guardian.stderr?finished(guardian.stderr,{cleanup:true}).catch(()=>{}):Promise.resolve(),
  ]);
  let ready=false;
  /** @type {((reason:Error)=>void)|undefined} */ let rejectStartup;
  const cancel=()=>{
    // Discard only output which no successful caller owns. Otherwise preserve the
    // caller's stdio drain contract while IPC requests actual child shutdown.
    if(!ready)guardian.stdout?.resume();
    rejectStartup?.(runtimeCancelled());
    if(guardian.connected)guardian.disconnect();
  };
  // Another consumer's stopImmediatePropagation must not defeat resource shutdown.
  const abortSubscription=ownerSignal?addAbortListener(ownerSignal,cancel):undefined;
  const removeOwner=()=>abortSubscription?.[Symbol.dispose]();
  guardian.once('exit',removeOwner);guardian.once('error',removeOwner);
  try {await new Promise((resolve,reject)=>{
    rejectStartup=reject;
    const timer=setTimeout(()=>{reject(new AgoraError('Tailcat startup timed out. Run agora doctor --offline, then retry the transfer.'));},20000);
    guardian.once('error',()=>{clearTimeout(timer);reject(new AgoraError('Tailcat guardian could not start. Run agora doctor --offline.'));});
    guardian.once('exit',()=>{clearTimeout(timer);reject(new AgoraError('Tailcat could not start. Run agora doctor --offline.'));});
    guardian.once('message',message=>{
      clearTimeout(timer);
      if(/** @type {any} */(message).status==='started') resolve(undefined);
      else reject(new AgoraError('Tailcat runtime verification or startup failed. Run agora doctor --offline.'));
    });
    guardian.send({args,options:launchOptions},error=>{if(error){clearTimeout(timer);reject(new AgoraError('Tailcat guardian could not receive its startup request. Run agora doctor --offline.'));}});
    if(ownerSignal?.aborted)cancel();
  });
    if(ownerSignal?.aborted)throw runtimeCancelled();
    ready=true;
    rejectStartup=undefined;
  } catch(error) {
    rejectStartup=undefined;
    guardian.stdout?.resume();
    if(guardian.connected)guardian.disconnect();
    await terminated;
    // Signal death does not establish that the guardian observed its own child's exit.
    if(guardian.signalCode!==null)throw Object.assign(new AgoraError('Tailcat guardian exited without confirming runtime cleanup.'),{tailcatCleanupUnconfirmed:true});
    throw error;
  }
  return guardian;
}

if(process.argv[2]==='--guardian') {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | undefined} */let child;
  let stopping=false;
  /** IPC may close between runtime spawn and its readiness event. That is a stop,
   * not an unhandled send error which could orphan the runtime.
   * @param {'started'|'failed'} status */
  const report=status=>{
    if(!process.connected){stop();return;}
    process.send?.({status},error=>{if(error)stop();});
  };
  const stop=()=>{
    if(stopping)return;stopping=true;
    if(!child){process.exit(process.exitCode??0);return;}
    child.kill('SIGTERM');
    const force=setTimeout(()=>{child?.kill('SIGKILL');},2000);force.unref();
  };
  process.on('disconnect',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
  process.once('message',async message=>{
    try {
      const {args,options}=/** @type {any} */(message);
      if(!Array.isArray(args)||args.some(x=>typeof x!=='string')||stopping)throw Error('Invalid launch');
      const binary=await resolveTailcatBinary(options);
      if(stopping)return;
      const duration=runtimeExpiryDelay(options);
      child=spawn(binary.path,args,{stdio:'pipe',windowsHide:true});
      child.once('error',()=>{report('failed');process.exitCode=1;if(process.connected)process.disconnect();});
      child.once('spawn',()=>report('started'));
      // `exit` precedes stdio drain. Exiting the guardian there truncates a valid HTTP response.
      child.once('close',code=>{process.exitCode=code??1;process.stdin.destroy();if(process.connected)process.disconnect();});
      process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
      if(duration!==null)setTimeout(stop,duration).unref();
    } catch {report('failed');process.exitCode=1;stop();}
  });
}
