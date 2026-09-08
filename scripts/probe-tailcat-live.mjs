// Deliberate live relay acceptance: synthetic bytes and isolated keys, no room posts.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if(process.versions.bun){const result=spawnSync('node',[fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});process.exit(result.status??1);}
import { parseArgs } from 'node:util';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { redactTailcatDiagnostics } from '../src/tailcat-diagnostics.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {setTimeout as delay}from'node:timers/promises';
import {localTransferIdentity,encodeTransfer}from'../src/tailcat.mjs';
import {shareFiles,fetchFiles,stopOffer,offerDirectory}from'../src/tailcat-offers.mjs';
import {controlOffer}from'../src/tailcat-launcher.mjs';import{requestTransfer}from'../src/tailcat-http.mjs';
// Cross-machine gate. The server must allow the public half of --key-file.
// Keep its address in a file so shell quoting cannot change the token.
// Example: node scripts/probe-tailcat-live.mjs --direct --binary /path/to/tailcat
//   --address-file /private/server.addr --key-file /private/client.private.json
const { values: options } = parseArgs({ options: {
 direct: { type: 'boolean' }, binary: { type: 'string' },
 'address-file': { type: 'string' }, 'key-file': { type: 'string' },
 'timeout-ms': { type: 'string', default: '30000' },
}, allowPositionals: false });
if (options.direct) {
 for (const field of ['binary', 'address-file', 'key-file']) {
  if (!options[field]) throw new Error(`--direct requires --${field}`);
 }
 const timeout = Number(options['timeout-ms']);
 if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) {
  throw new Error('--timeout-ms must be an integer from 1 to 300000');
 }
 const binary = await realpath(options.binary);
 const keyPath = await realpath(options['key-file']);
 const address = (await readFile(options['address-file'], 'utf8')).trim();
 if (!address || /\s/.test(address)) throw new Error('Address file must contain one token');
 const started = Date.now();
 console.error('direct probe started', new Date(started).toISOString());
 const child = spawnSync(binary, [`--key=${keyPath}`, 'ping', '--until-direct',
  `--timeout=${timeout}ms`, address], {
  encoding: 'utf8', windowsHide: true, timeout: timeout + 5000, maxBuffer: 8 * 1024 * 1024,
 });
 const privateValues = [address, keyPath, options['key-file']];
 const safeStdout = redactTailcatDiagnostics(child.stdout ?? '', privateValues);
 const safeStderr = Buffer.from(redactTailcatDiagnostics(child.stderr ?? '', privateValues));
 // Redact the entire captured buffer first: cutting a token can remove its identifying prefix.
 let tailStart = Math.max(0, safeStderr.length - 2048);
 while (tailStart < safeStderr.length && (safeStderr[tailStart] & 0xc0) === 0x80) tailStart++;
 const stderr = safeStderr.subarray(tailStart).toString('utf8');
 const pongs = safeStdout.split(/\r?\n/).filter(line => /^pong in .+ via .+$/.test(line));
 const directEndpoint = pongs.map(line => line.slice(line.lastIndexOf(' via ') + 5)).find(endpoint => {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(endpoint);
  return match && isIP(match[1] ?? match[2]) && Number(match[3]) > 0 && Number(match[3]) <= 65535;
 }) ?? null;
 // Printed output alone is insufficient: the one-shot verb must also exit cleanly.
 const pass = child.status === 0 && !child.error && !child.signal && directEndpoint !== null;
 console.log(JSON.stringify({ pass, binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
  started: new Date(started).toISOString(), elapsedMs: Date.now() - started,
  exit: child.status, signal: child.signal, error: child.error?.code ?? null,
  directEndpoint, pongs, stderr }));
 process.exit(pass ? 0 : 1);
}
if (options.binary || options['address-file'] || options['key-file']) {
 throw new Error('--binary, --address-file and --key-file require --direct');
}
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
