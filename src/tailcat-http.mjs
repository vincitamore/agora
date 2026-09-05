// @ts-check
import { createServer, request, Agent } from 'node:http';
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { Duplex } from 'node:stream';
import path from 'node:path';
import { spawnTailcat } from './tailcat-process.mjs';
import { validateTransferManifest, atomicJson } from './tailcat.mjs';
import { AgoraError } from './core.mjs';
import { setTimeout as delay } from 'node:timers/promises';

/** @param {import('node:stream').Readable} stream @param {number} maximum */
export async function boundedBytes(stream,maximum) {
  const chunks=[];let size=0;
  for await(const chunk of stream) {size+=chunk.length;if(size>maximum){stream.destroy();throw new AgoraError('Transfer response exceeded its bound. Ask the sender for a new offer.');}chunks.push(chunk);}
  return Buffer.concat(chunks);
}

/**
 * One listener belongs to one authenticated route. Request parameters never choose the route.
 * @param {{payloadDir:string,files:any[],receiptPath:string,expires:number,once:boolean,receiptDigest:string}} route
 */
export async function createTransferListener(route) {
  const files=validateTransferManifest(route.files);
  let consumed=false;
  try {consumed=JSON.parse(await readFile(route.receiptPath,'utf8')).digest===route.receiptDigest;} catch {}
  const server=createServer(async(req,res)=>{
    try {
      if(Date.now()>=route.expires){res.writeHead(410);res.end();return;}
      if(req.method==='POST' && req.url==='/receipt') {
        const body=await boundedBytes(req,256);
        let digest;
        try {digest=JSON.parse(body.toString('utf8')).digest;} catch {}
        if(digest!==route.receiptDigest){res.writeHead(400);res.end();return;}
        await atomicJson(route.receiptPath,{digest,receivedAt:new Date().toISOString()});
        consumed=true;res.writeHead(200,{'Content-Type':'application/json'});res.end('{"received":true}');return;
      }
      if(req.method!=='GET'){res.writeHead(405);res.end();return;}
      if(consumed&&route.once){res.writeHead(410);res.end();return;}
      if(req.url==='/manifest') {
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({files,digest:route.receiptDigest}));return;
      }
      const match=/^\/files\/([0-7])$/.exec(req.url??'');
      const file=match?files.find(x=>x.id===match[1]):null;
      if(!file){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':String(file.size)});
      const stream=createReadStream(path.join(route.payloadDir,file.id));
      stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
    } catch {if(!res.headersSent)res.writeHead(500);res.end();}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(undefined));});
  const address=server.address();if(!address||typeof address==='string')throw new AgoraError('Could not bind a local transfer route. Retry agora share.');
  return {server,port:address.port,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve(undefined));})};
}

/** @param {import('node:child_process').ChildProcess} child */
export async function readTailcatAddress(child) {
  return new Promise((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>finish(new AgoraError('Tailcat relay readiness timed out. Check network access, then retry agora share.')),45000);
    /** @param {Error} [error] @param {string} [address] */
    const finish=(error,address)=>{clearTimeout(timer);child.stdout?.off('data',onData);error?reject(error):resolve(address);};
    /** @param {Buffer} data */
    const onData=data=>{
      text+=data.toString('utf8');
      if(text.length>8192){finish(new AgoraError('Tailcat readiness response was invalid. Run agora doctor --offline.'));return;}
      for(const line of text.split('\n').slice(0,-1)) {
        try {const value=JSON.parse(line);if(typeof value.listenAddr==='string' && /^[A-Za-z0-9._:~+-]{20,1800}$/.test(value.listenAddr)){finish(undefined,value.listenAddr);return;}} catch {}
      }
    };
    child.once('exit',()=>finish(new AgoraError('Tailcat stopped before its route was ready. Check network access and retry agora share.')));
    child.stdout?.on('data',onData);
  });
}

/** Node HTTP over Tailcat's stdio stream; no SSH, scp or system curl.
 * @param {{address:string,port:number,keyPath:string,stateRoot:string,deadline?:number}} route
 * @param {string} endpoint @param {{body?:string,target?:string,maximum:number}} options
 * @param {{spawn?:typeof spawnTailcat,connection?:any}} [deps]
 */
export async function requestTransfer(route,endpoint,options,deps={}) {
  if(!/^[A-Za-z0-9._:~+-]{20,1800}$/.test(route.address)||!Number.isInteger(route.port)||route.port<1||route.port>65535)throw new AgoraError('Offer route is invalid; ask the sender for a new offer.');
  const child=deps.connection?.child??await (deps.spawn??spawnTailcat)([`--key=${route.keyPath}`,route.address,String(route.port)],{stateRoot:route.stateRoot,deadline:route.deadline});
  if(!child.stdin||!child.stdout)throw new AgoraError('Could not open the transfer stream. Retry agora fetch.');
  const stream=deps.connection?.stream??Duplex.from({readable:child.stdout,writable:child.stdin});
  const agent=deps.connection?.agent??new Agent({keepAlive:false});
  agent.createConnection=()=>/** @type {import('node:net').Socket} */(/** @type {unknown} */(stream));
  let successful=false;
  try {
    return await new Promise((resolve,reject)=>{
      const req=request({host:'localhost',port:route.port,path:endpoint,method:options.body?'POST':'GET',agent,
        headers:{Connection:deps.connection?'keep-alive':'close',...(options.body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(options.body)}:{})}},async res=>{
        try {
          if(res.statusCode!==200){res.resume();throw new AgoraError(`Transfer returned HTTP ${res.statusCode}; ${res.statusCode===410?'the offer expired or was consumed; ask for a new agora share offer.':'retry agora fetch <room> <offer-id>.'}`);}
          if(options.target) {
            const handle=await open(options.target,'wx',0o600);let size=0;
            try {for await(const chunk of res){size+=chunk.length;if(size>options.maximum)throw new AgoraError('Received file exceeded its declared size. Ask the sender for a new offer.');await handle.writeFile(chunk);}await handle.sync();}
            finally {await handle.close();}
            successful=true;resolve({size,bytes:Buffer.alloc(0)});
          } else {const bytes=await boundedBytes(res,options.maximum);successful=true;resolve({size:bytes.length,bytes});}
        } catch(e){reject(e);}
      });
      const timer=setTimeout(()=>{req.destroy();reject(new AgoraError('Transfer timed out; no receipt was sent. Retry agora fetch <room> <offer-id>.'));},120000);
      req.on('close',()=>clearTimeout(timer));req.on('error',()=>{clearTimeout(timer);reject(new AgoraError('Transfer connection failed; no receipt was sent. Check that the sender is online, then retry agora fetch <room> <offer-id>.'));});
      req.end(options.body);
    });
  } finally {
    if(!deps.connection){
    if(successful&&child.connected&&child.exitCode===null){
      // Tailcat drains TCP FIN acknowledgements for up to five seconds after stdout EOF.
      // Killing it at HTTP-body completion races the next connection using this same key.
      await Promise.race([new Promise(resolve=>child.once('exit',()=>resolve(undefined))),delay(6500)]);
    }
    agent.destroy();stream.destroy();
    if(child.connected){
      // Do not race another connection using the same enrolled client key against a live predecessor.
      const exited=new Promise(resolve=>{if(child.exitCode!==null)resolve(undefined);else child.once('exit',()=>resolve(undefined));});
      child.disconnect();await exited;
    }else if(!child.disconnect)child.kill();
    }
  }
}

/** One authenticated tunnel carries manifest, files and ACK; a fetch does not churn client identities.
 * @param {Parameters<typeof requestTransfer>[0]} route @param {{spawn?:typeof spawnTailcat}} [deps]
 */
export async function openTransferClient(route,deps={}){
  if(!/^[A-Za-z0-9._:~+-]{20,1800}$/.test(route.address)||!Number.isInteger(route.port)||route.port<1||route.port>65535)throw new AgoraError('Invalid transfer route. Ask for a new agora share offer.');
  const child=await (deps.spawn??spawnTailcat)([`--key=${route.keyPath}`,route.address,String(route.port)],{stateRoot:route.stateRoot,deadline:route.deadline});
  if(!child.stdin||!child.stdout)throw new AgoraError('Transfer pipes are unavailable. Retry agora fetch.');
  const stream=Duplex.from({readable:child.stdout,writable:child.stdin});
  // Agent socket hooks control TCP keepalive/loop residency on net.Socket. Tailcat owns those;
  // this stream remains explicitly owned until close(), so these hooks are intentional no-ops.
  Object.assign(stream,{setKeepAlive:()=>stream,setNoDelay:()=>stream,setTimeout:()=>stream,ref:()=>stream,unref:()=>stream});
  const agent=new Agent({keepAlive:true,maxSockets:1,maxFreeSockets:1});
  agent.createConnection=()=>/** @type {import('node:net').Socket} */(/** @type {unknown} */(stream));
  let closed=false;
  return {
    request:/** @param {string} endpoint @param {Parameters<typeof requestTransfer>[2]} options */(endpoint,options)=>requestTransfer(route,endpoint,options,{connection:{child,stream,agent}}),
    close:async()=>{
      if(closed)return;closed=true;agent.destroy();stream.destroy();
      if(child.connected&&child.exitCode===null)await Promise.race([new Promise(resolve=>child.once('exit',()=>resolve(undefined))),delay(6500)]);
      if(child.connected){const exited=new Promise(resolve=>child.once('exit',()=>resolve(undefined)));child.disconnect();await exited;}
    },
  };
}
