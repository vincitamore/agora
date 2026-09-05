// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { encodeTransfer, atomicJson, localTransferIdentity } from '../src/tailcat.mjs';
import { shareFiles, listOffers, resumeOffer, forgetOffer, fetchFiles } from '../src/tailcat-offers.mjs';
import { createHash, randomUUID } from 'node:crypto';

test('fetch and receipt retry classify local bytes despite forged peer media labels',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'agora-receive-media-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const identity=await localTransferIdentity(root),id=randomUUID(),account='receiver';
  const payloads=[Buffer.from('plain bytes, definitely not an image'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=','base64')];
  const hash=/** @param {Buffer} bytes */bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
  const files=payloads.map((bytes,i)=>({id:String(i),name:i?'picture.data':'fake.png',size:bytes.length,digest:hash(bytes),mimetype:i?'application/octet-stream':'image/png'}));
  const digest=hash(Buffer.from(JSON.stringify({id,account,key:identity.nodeKey,files})));
  const offer={id,files,expires:Date.now()+60000,routes:[{account,nodeKey:identity.nodeKey,receiptDigest:digest}]};
  /** @type {any} */const bus={whoami:async()=>({id:account}),read:async()=>[{author:{id:'peer'},text:encodeTransfer({version:1,kind:'offer',offer})}]};
  /** @type {string[]} */const requests=[];let failReceipt=true;
  /** @type {Parameters<typeof fetchFiles>[5]} */const deps={openClient:async()=>({
    request:async(endpoint,options)=>{
      requests.push(endpoint);
      if(endpoint==='/manifest')return {bytes:Buffer.from(JSON.stringify({digest,files}))};
      if(endpoint.startsWith('/files/')){assert.ok(options.target);await writeFile(options.target,payloads[Number(endpoint.slice(7))]);return {bytes:Buffer.alloc(0)};}
      if(failReceipt)throw Error('receipt lost');
      return {bytes:Buffer.from('{}')};
    },close:async()=>{},
  })};
  const first=await fetchFiles(bus,root,root,id,{},deps);
  assert.equal(first.status,'saved-receipt-pending');
  assert.deepEqual(first.attachments.map(a=>[a.kind,a.mimetype]),[['file','application/octet-stream'],['image','image/png']]);
  requests.length=0;failReceipt=false;
  const retry=await fetchFiles(bus,root,root,id,{},deps);
  assert.equal(retry.status,'received');assert.deepEqual(requests,['/receipt']);
  assert.deepEqual(retry.attachments,first.attachments);
});

test('lost publication receipt stops the offer and retry cannot create a duplicate',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'agora-publication-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const input=path.join(root,'note.txt');await writeFile(input,'synthetic');
  /** @type {any[]} */const messages=[{author:{id:'peer',name:'peer'},text:encodeTransfer({version:1,kind:'enrollment',nodeKey:'nodekey:'+'a'.repeat(64)})}];
  let posts=0,stops=0;
  /** @type {any} */
  const transport={kind:'slack',room:'synthetic',whoami:async()=>({id:'sender'}),read:async()=>messages,
    post:async(/** @type {string} */text)=>{posts++;messages.push({id:'accepted'+posts,cursor:String(posts),author:{id:'sender'},text});throw Error('lost receipt after commit');}};
  /** @type {typeof import('../src/tailcat-launcher.mjs').launchOffer} */
  const launch=async(directory,id)=>{
    const spec=JSON.parse(await readFile(path.join(directory,'worker.json'),'utf8'));
    const server=createServer((req,res)=>{
      if(req.headers.authorization!==`Bearer ${spec.controlSecret}`){res.writeHead(403);res.end();return;}
      if(req.url==='/stop'){stops++;res.end(()=>{server.closeAllConnections();server.close();});return;}
      res.end(JSON.stringify({id}));
    });
    t.after(()=>{server.closeAllConnections();server.close();});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(undefined)));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    await atomicJson(path.join(directory,'control.json'),{id,port:address.port,secret:spec.controlSecret});
    await atomicJson(path.join(directory,'ready.json'),{id,expires:spec.expires,files:spec.files,routes:[]});
  };
  const options={room:'test',sign:/** @param {string} text */text=>text,launch};
  await assert.rejects(shareFiles(transport,root,root,[input],['peer'],options),/lost receipt/);
  assert.equal(posts,1);assert.equal(stops,1);
  const [first]=await listOffers(root);assert.equal(first.online,false);assert.equal(first.status,'publication-uncertain');
  await assert.rejects(shareFiles(transport,root,root,[input],['peer'],options),/operation record/);assert.equal(posts,1);
  const reconciled=await resumeOffer(transport,root,first.id);assert.equal(reconciled.messageId,'accepted1');assert.equal(reconciled.status,'published-stopped');
  await forgetOffer(root,first.id);
  await assert.rejects(shareFiles(transport,root,root,[input],['peer'],options),/lost receipt/);assert.equal(posts,2);
  await forgetOffer(root,first.id); // old cleanup cannot release a newer operation's guard
  await assert.rejects(shareFiles(transport,root,root,[input],['peer'],options),/operation record/);assert.equal(posts,2);
});
