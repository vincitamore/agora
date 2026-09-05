// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { encodeTransfer, atomicJson } from '../src/tailcat.mjs';
import { shareFiles, listOffers, resumeOffer, forgetOffer } from '../src/tailcat-offers.mjs';

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
