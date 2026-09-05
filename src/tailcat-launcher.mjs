// @ts-check
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgoraError } from './core.mjs';
const exec=promisify(execFile);
const worker=fileURLToPath(new URL('./tailcat-offer-worker.mjs',import.meta.url));
const xml=/** @param {string} s */s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

/**
 * Live IPC ownership, without an independent OS residency registration. The caller must
 * retain this handle. `closed` requires the worker's cleanup acknowledgement AND exit;
 * abrupt worker death rejects it because nested cleanup is then unconfirmed.
 * @param {string} directory @param {string} id
 * @param {{workerPath?:string,startupTimeoutMs?:number}} [options]
 */
export function launchManagedOffer(directory,id,options={}) {
  if(!/^[a-f0-9-]{36}$/.test(id))throw new AgoraError('Invalid offer id. Retry agora share.');
  const timeout=options.startupTimeoutMs??100000;
  if(!Number.isSafeInteger(timeout)||timeout<1)throw new AgoraError('Invalid managed offer startup timeout.',2);
  const child=spawn(process.execPath,[options.workerPath??worker,'--managed-offer-worker',directory],
    // Windows otherwise kills the worker with its owner before IPC disconnect can reap
    // routes. This process group remains referenced and owned through the live IPC handle.
    {stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,detached:process.platform==='win32'});
  let stopping=false,spawned=false,confirmed=false,readySettled=false;
  /** @type {(offer:any)=>void} */ let resolveReady;
  /** @type {(error:unknown)=>void} */ let rejectReady;
  /** @type {Promise<any>} */ const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  /** @type {(result:{code:number|null,signal:NodeJS.Signals|null})=>void} */ let resolveClosed;
  /** @type {(error:unknown)=>void} */ let rejectClosed;
  const closed=new Promise((resolve,reject)=>{resolveClosed=resolve;rejectClosed=reject;});
  void ready.catch(()=>{});void closed.catch(()=>{});
  /** @param {string} message */
  const failReady=message=>{if(!readySettled){readySettled=true;clearTimeout(timer);rejectReady(new AgoraError(message));}};
  const stop=()=>{
    if(!stopping){
      stopping=true;failReady('Managed offer stopped before readiness. Retry agora share.');
      // Keep IPC open for the cleanup acknowledgement. Owner death instead disconnects it.
      if(child.connected)child.send({type:'agora-offer-stop'},error=>{if(error&&child.connected)child.disconnect();});
    }
    return closed;
  };
  const timer=setTimeout(()=>{
    failReady('Managed offer readiness timed out. Check relay connectivity, then retry agora share.');
    void stop();
  },timeout);
  child.once('spawn',()=>{spawned=true;});
  child.on('message',message=>{
    const event=/** @type {any} */(message);
    if(event?.type==='agora-offer-closed'){confirmed=true;return;}
    if(event?.type==='agora-offer-ready'&&!stopping&&!readySettled){
      if(event.offer?.id!==id){failReady('Managed offer readiness identity did not match. Retry agora share.');void stop();return;}
      readySettled=true;clearTimeout(timer);resolveReady(event.offer);
    }
  });
  child.once('error',()=>{failReady('Managed offer worker could not start. Run agora doctor --offline.');});
  child.once('close',(code,signal)=>{
    clearTimeout(timer);
    failReady('Managed offer ended before readiness. Run agora doctor --offline, then retry agora share.');
    if(confirmed||!spawned)resolveClosed({code,signal});
    else rejectClosed(new AgoraError('Managed offer worker exited without confirming route cleanup. Inspect offer health before retrying.'));
  });
  return {ready,closed,stop};
}

/** Native ownership keeps an offer alive after the posting terminal exits. @param {string} directory @param {string} id @param {{workerPath?:string}} [options] */
export async function launchOffer(directory,id,options={}) {
  const entry=options.workerPath??worker;
  if(!/^[a-f0-9-]{36}$/.test(id))throw new AgoraError('Invalid offer id. Retry agora share.');
  if(process.platform==='win32') {
    await exec('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',
      fileURLToPath(new URL('../scripts/start-tailcat-offer.ps1',import.meta.url)),
      '-NodePath',process.execPath,'-WorkerPath',entry,'-OfferDirectory',directory],{windowsHide:true,timeout:20000,maxBuffer:4096});
  } else if(process.platform==='darwin') {
    const label=`org.agora.offer.${id}`;
    const plist=path.join(directory,'launch.plist');
    await writeFile(plist,`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath,entry,'--offer-worker',directory].map(x=>`<string>${xml(x)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>`,{flag:'wx',mode:0o600});
    await exec('/bin/launchctl',['bootstrap',`gui/${process.getuid?.()}`,plist],{timeout:20000});
  } else if(process.platform==='linux') {
    const child=spawn(process.execPath,[entry,'--offer-worker',directory],{detached:true,stdio:'ignore'});
    await new Promise((resolve,reject)=>{child.once('spawn',()=>resolve(undefined));child.once('error',reject);});child.unref();
  } else throw new AgoraError('Native offers support Windows, Linux and macOS. Run agora doctor --offline on a supported seat.');
}

/** Only a matching local control secret can stop a worker; never kill a stored PID. @param {string} directory @param {'health'|'stop'} action */
export async function controlOffer(directory,action) {
  try {
    const record=JSON.parse(await readFile(path.join(directory,'control.json'),'utf8'));
    if(!Number.isInteger(record.port)||record.port<1||record.port>65535||!/^[a-f0-9]{64}$/.test(record.secret))return false;
    const response=await fetch(`http://127.0.0.1:${record.port}/${action}`,{method:action==='stop'?'POST':'GET',headers:{Authorization:`Bearer ${record.secret}`},signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!response.ok)return false;
    return action==='stop'||(await response.json()).id===record.id;
  } catch {return false;}
}

/** Reap a stopped LaunchAgent registration as well as its process. @param {string} id */
export async function unloadOfferRegistration(id){
  if(process.platform!=='darwin')return;
  if(!/^[a-f0-9-]{36}$/.test(id))throw new AgoraError('Invalid offer id. Run agora share <room> --list.');
  await exec('/bin/launchctl',['bootout',`gui/${process.getuid?.()}/org.agora.offer.${id}`],{timeout:10000}).catch(()=>{});
}
