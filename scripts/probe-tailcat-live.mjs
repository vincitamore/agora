// Deliberate live relay acceptance: synthetic bytes and isolated keys, no room posts.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if(process.versions.bun){const result=spawnSync('node',[fileURLToPath(import.meta.url)],{stdio:'inherit',windowsHide:true});process.exit(result.status??1);}
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {setTimeout as delay}from'node:timers/promises';
import {localTransferIdentity,encodeTransfer}from'../src/tailcat.mjs';
import {shareFiles,fetchFiles,stopOffer,offerDirectory}from'../src/tailcat-offers.mjs';
import {controlOffer}from'../src/tailcat-launcher.mjs';import{requestTransfer}from'../src/tailcat-http.mjs';
const start=Date.now();console.log('live probe started',new Date().toISOString());
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agora-live-transfer-')));
const messages=[],peers=[];const senderRoot=path.join(root,'sender');await mkdir(senderRoot);
const input=path.join(root,'hello.txt');await writeFile(input,'verified native transfer\n');
const picture=path.join(root,'screenshot.png'),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=','base64');await writeFile(picture,png);
for(let n=0;n<2;n++){
 const state=path.join(root,'recipient'+n);const identity=await localTransferIdentity(state);peers.push({account:'test'+n,state,...identity});
 messages.push({id:'enroll'+n,cursor:String(n),author:{id:'test'+n,name:'test'+n,kind:'agent'},text:encodeTransfer({version:1,kind:'enrollment',nodeKey:identity.nodeKey})});
}
const transport=account=>({kind:'slack',room:'synthetic-live-test',threads:false,whoami:async()=>({id:account,name:account}),read:async()=>messages,
 post:async text=>{const id='post'+messages.length;messages.push({id,cursor:id,author:{id:account,name:account,kind:'agent'},text});return{id,cursor:id};}});
let offer;
try{
 offer=await shareFiles(transport('sender'),senderRoot,senderRoot,[input,picture],peers.map(x=>x.account),{room:'test',sign:x=>x,once:true,expiresIn:600});
 const dir=offerDirectory(senderRoot,offer.offerId);
 const ready=JSON.parse(await readFile(path.join(dir,'ready.json'),'utf8'));
 assert.notEqual(ready.routes[0].port,ready.routes[1].port);
 const strangerRoot=path.join(root,'stranger');const stranger=await localTransferIdentity(strangerRoot);
 await assert.rejects(requestTransfer({...ready.routes[0],keyPath:stranger.keyPath,stateRoot:strangerRoot,deadline:Date.now()+3000},'/manifest',{maximum:32768}));
 console.log('unauthorized third key: denied');
 for(const [n,peer] of peers.entries()){
  console.log('fetch recipient',n,'elapsed seconds',(Date.now()-start)/1000);
  const output=await fetchFiles(transport(peer.account),peer.state,peer.state,offer.offerId);
  assert.equal(output.status,'received');assert.equal(await readFile(output.attachments[0].path,'utf8'),'verified native transfer\n');
  assert.equal(output.attachments[1].kind,'image');assert.deepEqual(await readFile(output.attachments[1].path),png);
  const retry=await fetchFiles(transport(peer.account),peer.state,peer.state,offer.offerId);
  assert.equal(retry.status,'received');console.log('recipient '+n+': committed bytes, digest, receipt and retry PASS');
 }
 await assert.rejects(shareFiles(transport('sender'),senderRoot,senderRoot,[input,picture],peers.map(x=>x.account),{room:'test',sign:x=>x}),/operation record/);
 console.log('duplicate publication guard: PASS');
}finally{
 if(offer){const dir=offerDirectory(senderRoot,offer.offerId);await stopOffer(senderRoot,offer.offerId);assert.equal(await controlOffer(dir,'health'),false);console.log('resident worker cleanup: PASS');}
 await rm(root,{recursive:true,force:true});
}
