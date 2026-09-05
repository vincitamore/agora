// @ts-check
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTailcatBinary } from './tailcat-runtime.mjs';
import { AgoraError } from './core.mjs';

/**
 * A guardian owns the actual child handle and kills it on IPC disconnect, including SIGKILL of
 * the offer worker. No saved PID is ever used to kill a process after a restart.
 * @param {string[]} args @param {Parameters<typeof resolveTailcatBinary>[0] & {deadline?:number}} options
 */
export async function spawnTailcat(args,options) {
  const guardian=spawn(process.execPath,[fileURLToPath(import.meta.url),'--guardian'],{stdio:['pipe','pipe','ignore','ipc'],windowsHide:true});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(guardian.connected)guardian.disconnect();reject(new AgoraError('Tailcat startup timed out. Run agora doctor --offline, then retry the transfer.'));},20000);
    guardian.once('error',()=>{clearTimeout(timer);reject(new AgoraError('Tailcat guardian could not start. Run agora doctor --offline.'));});
    guardian.once('exit',()=>{clearTimeout(timer);reject(new AgoraError('Tailcat could not start. Run agora doctor --offline.'));});
    guardian.once('message',message=>{
      clearTimeout(timer);
      if(/** @type {any} */(message).status==='started') resolve(undefined);
      else reject(new AgoraError('Tailcat runtime verification or startup failed. Run agora doctor --offline.'));
    });
    guardian.send({args,options});
  });
  return guardian;
}

if(process.argv[2]==='--guardian') {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | undefined} */let child;
  let stopping=false;
  const stop=()=>{
    if(stopping)return;stopping=true;
    if(!child){process.exit(0);return;}
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
      child=spawn(binary.path,args,{stdio:'pipe',windowsHide:true});
      child.once('error',()=>{process.send?.({status:'failed'});process.exitCode=1;process.disconnect?.();});
      child.once('spawn',()=>process.send?.({status:'started'}));
      // `exit` precedes stdio drain. Exiting the guardian there truncates a valid HTTP response.
      child.once('close',code=>{process.exitCode=code??1;process.stdin.destroy();if(process.connected)process.disconnect();});
      process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.resume();
      const deadline=Number(options.deadline);
      const duration=Number.isFinite(deadline)?Math.min(86400000,Math.max(1,deadline-Date.now())):86400000;
      setTimeout(stop,duration).unref();
    } catch {process.send?.({status:'failed'});process.exit(1);}
  });
}
