// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localTransferIdentity, encodeTransfer, decodeTransfer, resolveTransferRecipients,
  snapshotTransferFiles, commitReceivedFiles, validateTransferManifest } from '../src/tailcat.mjs';
import { createTransferListener, requestTransfer, openTransferClient } from '../src/tailcat-http.mjs';
import { connect } from 'node:net';
const key=/** @param {number} n */n=>'nodekey:'+String(n).repeat(64);

test('a screenshot remains an image attachment after verified materialization, without trusting its extension',async t=>{
  const root=await fixture(t),input=path.join(root,'screenshot.data');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=','base64');
  await writeFile(input,png);
  const staging=path.join(root,'snapshot'),destination=path.join(root,'received');
  const files=await snapshotTransferFiles(staging,[input]);
  assert.equal(files[0].mimetype,'image/png');
  files[0].mimetype='application/octet-stream'; // receiving presentation cannot trust a peer label
  const received=await commitReceivedFiles(staging,destination,files);
  assert.equal(received[0].kind,'image');assert.deepEqual(await readFile(received[0].path),png);
  const fake=path.join(root,'not-an-image.png');await writeFile(fake,'plain bytes');
  const fakeStaging=path.join(root,'fake-snapshot'),fakeFiles=await snapshotTransferFiles(fakeStaging,[fake]);
  assert.equal(fakeFiles[0].mimetype,'application/octet-stream');
  fakeFiles[0].mimetype='image/png';
  const plain=await commitReceivedFiles(fakeStaging,path.join(root,'fake-received'),fakeFiles);
  assert.equal(plain[0].mimetype,'application/octet-stream');assert.equal(plain[0].kind,'file');
});
/** @param {import("node:test").TestContext} t */
async function fixture(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'agora-transfer-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
/** @param {string} account @param {string} nodeKey @param {string} [signedAs] @returns {any} */
const message=(account,nodeKey,signedAs='Peer/general')=>({author:{id:account,name:account,kind:'agent'},text:encodeTransfer({version:1,kind:'enrollment',nodeKey}),signedAs});
/** @type {any} */const transport={kind:'slack',room:'channel'};

test('concurrent identity creation publishes one key and never uses ambient defaults',async t=>{
  const root=await fixture(t);let counter=0;
  /** @type {string[][]} */const calls=[];
  /** @type {any} */const deps={resolveBinary:async()=>({path:'verified-binary'}),exec:async(/** @type {string} */binary,/** @type {string[]} */args)=>{
    calls.push(args);
    if(args[0]==='genkey'){
      const value=key(++counter);await writeFile(args[2].slice(6),value);return {stdout:value};
    }
    return {stdout:await readFile(args[0].slice(6),'utf8')};
  }};
  const identities=await Promise.all(Array.from({length:8},()=>localTransferIdentity(root,deps)));
  assert.equal(new Set(identities.map(x=>x.nodeKey)).size,1);
  assert.deepEqual(await readdir(path.join(root,'tailcat')),['identity.private.json']);
  assert.ok(calls.every(args=>args.some(x=>x.startsWith('--key=')&&path.isAbsolute(x.slice(6)))));
});

test('first enrollment selects authenticated account, not forged bearer signature',async t=>{
  const root=await fixture(t);const messages=[message('attacker',key(1),'Victim/general')];
  await assert.rejects(resolveTransferRecipients(transport,root,['Victim/general'],{messages}),/authenticated account/);
  const peers=await resolveTransferRecipients(transport,root,['attacker'],{messages});
  assert.equal(peers[0].account,'attacker');
  assert.equal((await resolveTransferRecipients(transport,root,['Victim/general'],{messages}))[0].account,'attacker');
  await assert.rejects(resolveTransferRecipients(transport,root,['Victim/general'],{messages:[...messages,message('other',key(2),'Victim/general')]}),/ambiguous/);
  await assert.rejects(resolveTransferRecipients(transport,root,['attacker'],{messages:[message('attacker',key(2))]}),/key changed/);
  await assert.rejects(resolveTransferRecipients({...transport,kind:'local'},root,['attacker'],{messages}),/not authentication/);
});

test('enrollment history with an explicit gap cannot authorize a transfer',async t=>{
  const root=await fixture(t);
  /** @type {any} */const messages=[message('peer',key(1))];messages.gap={reason:'depth'};
  await assert.rejects(resolveTransferRecipients(transport,root,['peer'],{messages}),/incomplete/);
  assert.equal(decodeTransfer('AGORA_TRANSFER_V1 not-json'),null);
});

test('a pinned peer cannot hide a key rotation outside the newest room window',async t=>{
  const root=await fixture(t);
  const first={...message('peer',key(1)),cursor:'10'};
  /** @type {any} */
  const bus={...transport,read:async()=>[first]};
  await resolveTransferRecipients(bus,root,['peer']);
  let checked=false;
  bus.read=async(/** @type {any} */options)=>{
    if(options.since==='10'){checked=true;const rows=/** @type {any} */([]);rows.gap={reason:'history truncated'};return rows;}
    return [{author:{id:'someone',name:'someone'},text:'newer unrelated chatter',cursor:'10000'}];
  };
  await assert.rejects(resolveTransferRecipients(bus,root,['peer']),/trust history is incomplete/);
  assert.equal(checked,true);
  bus.read=async(/** @type {any} */options)=>options.since?[{...message('peer',key(2)),cursor:'11'}]:[];
  await assert.rejects(resolveTransferRecipients(bus,root,['peer']),/key changed/);
});

test('snapshot is immutable and refuses to erase an existing payload',async t=>{
  const root=await fixture(t);const input=path.join(root,'song.wav');await writeFile(input,'original');
  const payload=path.join(root,'payload');const files=await snapshotTransferFiles(payload,[input]);
  await writeFile(input,'changed');assert.equal(await readFile(path.join(payload,'0'),'utf8'),'original');
  await assert.rejects(snapshotTransferFiles(payload,[input]),{code:'EEXIST'});
  assert.equal(await readFile(path.join(payload,'0'),'utf8'),'original');
  const out=path.join(root,'out');const attachments=await commitReceivedFiles(payload,out,files);
  assert.equal(attachments[0].digest,files[0].digest);
  await commitReceivedFiles(payload,out,files); // identical retry is safe
  assert.equal(await readFile(attachments[0].path,'utf8'),'original');
});

test('case aliases, traversal, reserved device names and symlinks are rejected',async t=>{
  const root=await fixture(t);const base={id:'0',name:'x',size:0,digest:'sha256:'+'a'.repeat(64)};
  for(const name of ['../x','C:\\x','\\\\host\\x','x:ads','NUL.txt','a.','a/../b'])
    assert.throws(()=>validateTransferManifest([{...base,name}]),/unsafe/);
  assert.throws(()=>validateTransferManifest([{...base,name:'A'},{...base,id:'1',name:'a'}]),/names/);
  const real=path.join(root,'real');await mkdir(real);await writeFile(path.join(real,'x'),'x');
  const alias=path.join(root,'alias');await symlink(real,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(snapshotTransferFiles(path.join(root,'payload'),[path.join(alias,'x')]),/symbolic link/);
  assert.equal(await readFile(path.join(real,'x'),'utf8'),'x');
});

test('partial commit rollback preserves all pre-existing destination bytes',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'a'),'one');await writeFile(path.join(root,'b'),'two');
  const payload=path.join(root,'payload');const files=await snapshotTransferFiles(payload,[path.join(root,'a'),path.join(root,'b')]);
  const out=path.join(root,'out');await mkdir(out);await writeFile(path.join(out,'b'),'keep');
  await assert.rejects(commitReceivedFiles(payload,out,files),/collision/);
  assert.deepEqual(await readdir(out),['b']);assert.equal(await readFile(path.join(out,'b'),'utf8'),'keep');
  await writeFile(path.join(payload,'0'),'bad');
  await assert.rejects(commitReceivedFiles(payload,out,files),/digest mismatch/);
});

test('recipient listeners isolate consumption; reads never consume; receipt is idempotent',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'x'),'hello');
  const payload=path.join(root,'payload');const files=await snapshotTransferFiles(payload,[path.join(root,'x')]);
  const make=/** @param {string} id */id=>createTransferListener({payloadDir:payload,files,receiptPath:path.join(root,id+'.json'),expires:Date.now()+60000,once:true,receiptDigest:id});
  const a=await make('a'),b=await make('b');t.after(()=>Promise.all([a.close(),b.close()]));
  const url=/** @param {{port:number}} route @param {string} p */(route,p)=>`http://127.0.0.1:${route.port}${p}`;
  for(let i=0;i<2;i++)assert.equal(await (await fetch(url(a,'/files/0'))).text(),'hello');
  assert.equal((await fetch(url(a,'/files/9'))).status,404);
  assert.equal((await fetch(url(a,'/receipt'),{method:'POST',body:JSON.stringify({digest:'b'})})).status,400);
  for(let i=0;i<2;i++)assert.equal((await fetch(url(a,'/receipt'),{method:'POST',body:JSON.stringify({digest:'a'})})).status,200);
  assert.equal((await fetch(url(a,'/manifest'))).status,410);
  assert.equal((await fetch(url(b,'/manifest'))).status,200);
  assert.equal(JSON.parse(await readFile(path.join(root,'a.json'),'utf8')).digest,'a');
});

test('HTTP requests actually use the supplied Tailcat stream, not direct localhost',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'x'),'tunnel');
  const payload=path.join(root,'payload');const files=await snapshotTransferFiles(payload,[path.join(root,'x')]);
  const server=await createTransferListener({payloadDir:payload,files,receiptPath:path.join(root,'receipt.json'),expires:Date.now()+10000,once:true,receiptDigest:'r'});
  t.after(()=>server.close());
  /** @type {import("node:net").Socket} */let socket;
  /** @type {any} */const deps={spawn:async()=>{socket=connect(server.port,'127.0.0.1');return {stdin:socket,stdout:socket,kill:()=>socket.destroy()};}};
  const result=await requestTransfer({address:'tc'+'a'.repeat(30),port:1,keyPath:'explicit',stateRoot:root},'/files/0',{maximum:6},deps);
  assert.equal(result.bytes.toString(),'tunnel');
});

test('one fetch carries manifest, payload and receipt through one persistent client',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'x'),'tunnel');
  const payload=path.join(root,'payload');const files=await snapshotTransferFiles(payload,[path.join(root,'x')]);
  const server=await createTransferListener({payloadDir:payload,files,receiptPath:path.join(root,'receipt.json'),expires:Date.now()+10000,once:true,receiptDigest:'r'});
  t.after(()=>server.close());let starts=0;
  /** @type {any} */
  const deps={spawn:async()=>{starts++;const socket=connect(server.port,'127.0.0.1');return {stdin:socket,stdout:socket,connected:false,kill:()=>socket.destroy()};}};
  const client=await openTransferClient({address:'tc'+'a'.repeat(30),port:1,keyPath:'explicit',stateRoot:root},deps);
  try{
    assert.equal(JSON.parse((await client.request('/manifest',{maximum:32768})).bytes.toString()).digest,'r');
    assert.equal((await client.request('/files/0',{maximum:6})).bytes.toString(),'tunnel');
    assert.equal(JSON.parse((await client.request('/receipt',{body:'{"digest":"r"}',maximum:256})).bytes.toString()).received,true);
    assert.equal(starts,1);
  }finally{await client.close();}
});
