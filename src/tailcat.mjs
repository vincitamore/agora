// @ts-check
import { readFile, writeFile, mkdir, open, lstat, realpath, rm, rename, readdir, link } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgoraError } from './core.mjs';
import { resolveTailcatBinary, sha256 } from './tailcat-runtime.mjs';

const exec = promisify(execFile);
export const TRANSFER_PREFIX = 'AGORA_TRANSFER_V1 ';
export const MAX_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_OFFER_BYTES = 512 * 1024 * 1024;
export const MAX_FILES = 8;
/** Presentation metadata only; decoders still validate the format and files remain inert.
 * @param {Buffer} prefix */
export function transferMediaType(prefix) {
  if(prefix.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
  if(prefix.length>=3&&prefix[0]===255&&prefix[1]===216&&prefix[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(prefix.subarray(0,6).toString('ascii')))return 'image/gif';
  if(prefix.subarray(0,4).toString('ascii')==='RIFF'&&prefix.subarray(8,12).toString('ascii')==='WEBP')return 'image/webp';
  return 'application/octet-stream';
}
/** @param {any} file */
export const transferAttachment = file => ({...file,kind:['image/png','image/jpeg','image/gif','image/webp'].includes(file.mimetype)?'image':'file'});
export const nodeKeyValid = /** @param {unknown} key */ key => typeof key === 'string' && /^nodekey:[a-f0-9]{64}$/.test(key);
export const fingerprint = /** @param {string} key */ key => sha256(Buffer.from(key)).slice(0,16);
/** @param {unknown} data */
export function encodeTransfer(data) { return TRANSFER_PREFIX + Buffer.from(JSON.stringify(data)).toString('base64url'); }
/** Parsing is inert. Receiving an envelope never starts a process, fetch or enrollment. @param {string} text */
export function decodeTransfer(text) {
  const rows = text.split(/\r?\n/).filter(x=>x.startsWith(TRANSFER_PREFIX));
  if(rows.length!==1 || rows[0].length>6000) return null;
  try {
    const data=JSON.parse(Buffer.from(rows[0].slice(TRANSFER_PREFIX.length),'base64url').toString('utf8'));
    if(data?.version!==1 || !['enrollment','offer'].includes(data.kind)) return null;
    if(data.kind==='enrollment' && !nodeKeyValid(data.nodeKey)) return null;
    return data;
  } catch { return null; }
}

/** The ancestor walk, hoisted so every caller gets it. A reader that only replicated the check on
 * the directory ITSELF left a state root behind a symlinked ancestor refused on the create path and
 * accepted on the read path: the same root, two answers, and the weaker one on the path whose whole
 * purpose is to touch nothing.
 * @param {string} dir */
export async function assertPrivateAncestry(dir) {
  const absolute=path.resolve(dir);
  for(let current=absolute;;current=path.dirname(current)) {
    try {const st=await lstat(current);if(st.isSymbolicLink() || !st.isDirectory())throw new AgoraError('Transfer state traverses a linked or non-directory path. Select a private AGORA_STATE and retry.');}
    catch(e){if(/** @type {NodeJS.ErrnoException} */(e).code!=='ENOENT')throw e;}
    if(path.dirname(current)===current)break;
  }
  return absolute;
}

/** @param {string} dir */
export async function privateDirectory(dir) {
  await assertPrivateAncestry(dir);
  await mkdir(dir,{recursive:true,mode:0o700});
  const st=await lstat(dir);
  if(!st.isDirectory() || st.isSymbolicLink()) throw new AgoraError('Transfer state must be a private directory, not a link. Select a private AGORA_STATE and retry.');
  return dir;
}
/** @param {string} target @param {unknown} data */
export async function atomicJson(target,data) {
  const temp=`${target}.${randomUUID()}.tmp`;
  try {
    const handle=await open(temp,'wx',0o600);
    try {await handle.writeFile(JSON.stringify(data));await handle.sync();} finally {await handle.close();}
    await rename(temp,target);
  } finally {await rm(temp,{force:true});}
}

/** `create:false` reads an existing identity and refuses rather than minting one. It exists so a
 * caller that must not mint (a route dial: a fresh key cannot match the binding, and leaving one on
 * disk as the side effect of a failed dial is worse than the failure) does its check and its use in
 * ONE call. Checking with lstat and then calling this without the flag is check-then-use: the file
 * can go between the two, and the second call quietly mints.
 * @param {string} stateRoot @param {{resolveBinary?:typeof resolveTailcatBinary, exec?:typeof exec, create?:boolean}} [deps] */
export async function localTransferIdentity(stateRoot,deps={}) {
  const home=path.join(stateRoot,'tailcat');
  // A no-create read creates NOTHING, the directory included. privateDirectory mkdirs before the
  // refusal below can fire, so a failed dial on an un-enrolled seat used to leave an empty
  // tailcat/ behind: a side effect of a call whose whole point is to have none, and a directory a
  // later reader would take as evidence that enrolment had been attempted.
  let dir;
  if(deps.create===false) {
    dir=home;
    // The SAME ancestry check the create path runs, before anything else. Replicating only the
    // check on the directory itself made this read weaker than the write it stands in for.
    await assertPrivateAncestry(home);
    try {
      const st=await lstat(home);
      if(!st.isDirectory() || st.isSymbolicLink()) throw new AgoraError('Transfer state must be a private directory, not a link. Select a private AGORA_STATE and retry.');
    } catch(e) {
      if(/** @type {NodeJS.ErrnoException} */(e).code!=='ENOENT') throw e;
      throw new AgoraError(`enrollment-absent: this seat has no Agora transfer identity under ${home}; run \`agora enroll <room>\` on the room the descriptor came through. This call does not mint one, and has created nothing.`);
    }
  } else dir=await privateDirectory(home);
  const keyPath=path.join(dir,'identity.private.json');
  const runner=deps.exec ?? exec;
  try {
    const st=await lstat(keyPath);
    if(!st.isFile() || st.isSymbolicLink()) throw new AgoraError('Transfer identity is not a regular file. Restore the Agora-owned identity before running agora enroll.');
  } catch(e) {
    if(/** @type {NodeJS.ErrnoException} */(e).code!=='ENOENT') throw e;
    if(deps.create===false) throw new AgoraError(`enrollment-absent: this seat has no Agora transfer identity at ${keyPath}; run \`agora enroll <room>\` on the room the descriptor came through. This call does not mint one.`);
    const binary=await (deps.resolveBinary ?? resolveTailcatBinary)({stateRoot});
    // Upstream genkey uses WriteFile, not exclusive creation. Generate privately and publish
    // with a no-clobber link so concurrent first use cannot rotate another caller's identity.
    const temporary=path.join(dir,`${randomUUID()}.private.json`);
    try {
      await runner(binary.path,['genkey','--client',`--key=${temporary}`],{timeout:15000,maxBuffer:8192,windowsHide:true});
      const generated=await open(temporary,'r+');try{await generated.sync();}finally{await generated.close();}
      try {await link(temporary,keyPath);}catch(e){if(/** @type {NodeJS.ErrnoException} */(e).code!=='EEXIST')throw e;}
    } catch {throw new AgoraError('Could not create the Agora transfer identity. Check state-directory permissions, then run agora enroll <room>.');}
    finally {await rm(temporary,{force:true});}
  }
  const binary=await (deps.resolveBinary ?? resolveTailcatBinary)({stateRoot});
  let nodeKey;
  try {nodeKey=(await runner(binary.path,[`--key=${keyPath}`,'printpub'],{timeout:15000,maxBuffer:8192,windowsHide:true})).stdout.trim();}
  catch {throw new AgoraError('Could not read the Agora transfer identity. Restore its private key or explicitly reset enrollment; ambient Tailcat keys are never used.');}
  if(!nodeKeyValid(nodeKey)) throw new AgoraError('The Agora transfer identity returned an invalid public key. Restore the identity, then run agora enroll <room>.');
  return {keyPath,nodeKey,fingerprint:fingerprint(nodeKey)};
}

/** @param {import('./core.mjs').Transport} transport */
export function requireAuthenticatedTransport(transport) {
  if(transport.kind!=='slack' && transport.kind!=='github') throw new AgoraError('Secure peer transfer requires an authenticated Slack or GitHub room. Local-file author labels are not authentication; use a configured Slack/GitHub room.');
}

/** @param {string} stateRoot @param {import('./core.mjs').Transport} transport */
async function peerDirectory(stateRoot,transport) {
  return privateDirectory(path.join(stateRoot,'tailcat','peers',sha256(Buffer.from(`${transport.kind}:${transport.room}`))));
}

/**
 * Initial authorization selects a transport-authenticated account id/name. A courtesy bearer alias
 * becomes convenient only AFTER that account was explicitly selected and pinned on this seat.
 * @param {import('./core.mjs').Transport} transport @param {string} stateRoot
 * @param {string[]} recipients @param {{pages?:number, messages?:import('./core.mjs').ReadResult}} [options]
 */
export async function resolveTransferRecipients(transport,stateRoot,recipients,options={}) {
  requireAuthenticatedTransport(transport);
  if(!recipients.length || recipients.length>4) throw new AgoraError('Choose one to four recipients: agora share <room> <file> --to <account-id>.',2);
  const pages=options.pages??10;
  const messages=options.messages ?? await transport.read({limit:pages*200,pages});
  if(messages.gap) throw new AgoraError('Peer enrollment scan was incomplete. Retry agora share with --pages 20, or ask the recipient to run agora enroll <room>.');
  const dir=await peerDirectory(stateRoot,transport);
  /** @type {Map<string,{account:string,name:string,nodeKey:string,aliases:string[]}>} */
  const found=new Map();
  const changed=new Set();
  for(const message of messages) {
    const enrollment=decodeTransfer(message.text);
    if(enrollment?.kind!=='enrollment') continue;
    const old=found.get(message.author.id);
    if(old && old.nodeKey!==enrollment.nodeKey) changed.add(message.author.id);
    found.set(message.author.id,{account:message.author.id,name:message.author.name,nodeKey:enrollment.nodeKey,aliases:message.signedAs?[message.signedAs]:[]});
  }
  /** @type {Array<{account:string,name:string,nodeKey:string,aliases:string[],checkpoint?:string}>} */
  const pins=[];
  for(const file of await readdir(dir)) if(/^[a-f0-9]{64}\.json$/.test(file)) {
    try {pins.push(JSON.parse(await readFile(path.join(dir,file),'utf8')));} catch {throw new AgoraError('Peer trust record is corrupt. Restore Agora state before sharing.');}
  }
  /** @type {Array<{account:string,name:string,nodeKey:string,aliases:string[],fingerprint:string}>} */
  const result=[];
  for(const recipient of recipients) {
    const visible=[...found.values()].filter(x=>x.account===recipient || x.name===recipient);
    const direct=visible.length?visible:pins.filter(x=>x.account===recipient || x.name===recipient);
    const aliases=pins.filter(x=>x.aliases.includes(recipient));
    const candidate=direct.length===1?direct[0]:direct.length===0 && aliases.length===1?found.get(aliases[0].account) ?? aliases[0]:undefined;
    if(!candidate) throw new AgoraError(`Recipient ${recipient} is unknown or ambiguous. First use their authenticated account id from agora who <room> --json; ask them to run agora enroll <room>, then retry --to <account-id>.`);
    // Even a known alias cannot be silently reused by another account in this window.
    if([...found.values()].some(x=>x.account!==candidate.account && (x.name===recipient || x.aliases.includes(recipient)))) throw new AgoraError(`Recipient ${recipient} is ambiguous. Retry with --to ${candidate.account} only after checking the intended account.`);
    const previous=pins.find(x=>x.account===candidate.account);
    if(previous && !options.messages){
      if(previous.checkpoint){
        const sincePin=await transport.read({since:previous.checkpoint,limit:pages*200,pages});
        if(sincePin.gap)throw new AgoraError(`Peer trust history is incomplete. Retry agora share with --pages ${pages*2}, or verify the peer fingerprint and use agora enroll <room> --trust ${candidate.account} --fingerprint <verified-fingerprint>.`);
        for(const message of sincePin){const enrollment=decodeTransfer(message.text);if(message.author.id===candidate.account&&enrollment?.kind==='enrollment'&&enrollment.nodeKey!==previous.nodeKey)throw new AgoraError(`Transfer key changed for account ${candidate.account}. Verify it, then run agora enroll <room> --trust ${candidate.account} --fingerprint <verified-fingerprint>.`);}
      }else if(!visible.length)throw new AgoraError(`Peer enrollment is outside the verified window. Ask ${candidate.account} to run agora enroll <room>, then retry agora share.`);
    }
    if((changed.has(candidate.account) && (!previous||previous.nodeKey!==candidate.nodeKey)) || previous && previous.nodeKey!==candidate.nodeKey) throw new AgoraError(`Transfer key changed for account ${candidate.account}; no file was shared. Verify the new fingerprint out of band, then run agora enroll <room> --trust ${candidate.account} --fingerprint <verified-fingerprint>.`);
    const filename=path.join(dir,sha256(Buffer.from(candidate.account))+'.json');
    if(!previous) {
      try {await writeFile(filename,JSON.stringify({...candidate,checkpoint:messages.at(-1)?.cursor}),{flag:'wx',mode:0o600});}
      catch(e) {
        if(/** @type {NodeJS.ErrnoException} */(e).code!=='EEXIST') throw e;
        const raced=JSON.parse(await readFile(filename,'utf8'));
        if(raced.nodeKey!==candidate.nodeKey) throw new AgoraError('Concurrent peer enrollment changed the key. Verify the intended peer before sharing.');
      }
    }else if(!options.messages && messages.at(-1)?.cursor){
      const current=JSON.parse(await readFile(filename,'utf8'));
      if(current.nodeKey!==candidate.nodeKey)throw new AgoraError('Peer trust changed during sharing. Recheck enrollment before retrying agora share.');
      await atomicJson(filename,{...candidate,checkpoint:messages.at(-1)?.cursor});
    }
    if(!result.some(x=>x.account===candidate.account)) result.push({...candidate,fingerprint:fingerprint(candidate.nodeKey)});
  }
  return result;
}

/** Explicit trust repair selects a transport-authenticated account, never a bearer alias.
 * @param {import('./core.mjs').Transport} transport @param {string} stateRoot @param {string} account @param {string} confirmed @param {number} [pages]
 */
export async function trustTransferPeer(transport,stateRoot,account,confirmed,pages=20){
  requireAuthenticatedTransport(transport);
  if(!/^[a-f0-9]{16}$/.test(confirmed))throw new AgoraError('Use --fingerprint <16-hex-fingerprint> after verifying it with the peer.',2);
  const messages=await transport.read({limit:pages*200,pages});
  if(messages.gap)throw new AgoraError('Enrollment scan is incomplete. Retry agora enroll --trust with a larger --pages value.');
  const found=messages.filter(m=>m.author.id===account&&decodeTransfer(m.text)?.kind==='enrollment').at(-1);
  if(!found)throw new AgoraError('No enrollment for that authenticated account id. Ask the peer to run agora enroll <room>, then retry.');
  const nodeKey=decodeTransfer(found.text).nodeKey;
  if(fingerprint(nodeKey)!==confirmed)throw new AgoraError('Fingerprint does not match the latest enrollment. Verify it with the peer before retrying.');
  const dir=await peerDirectory(stateRoot,transport);
  const record={account,name:found.author.name,nodeKey,aliases:found.signedAs?[found.signedAs]:[],checkpoint:messages.at(-1)?.cursor};
  await atomicJson(path.join(dir,sha256(Buffer.from(account))+'.json'),record);
  return {...record,fingerprint:confirmed};
}

/** @param {string} name */
export function portableTransferName(name) {
  if(!name || name.length>128 || name!==name.normalize('NFC') || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name) || name==='.' || name==='..' ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) throw new AgoraError('A transfer filename is unsafe on a supported platform. Rename it to a plain filename, then retry agora share.');
  return name;
}

/** @param {string} filename */
export async function digestFile(filename) {
  const hash=createHash('sha256');let size=0;let prefix=Buffer.alloc(0);
  for await(const chunk of createReadStream(filename)) {
    size+=chunk.length;hash.update(chunk);
    if(prefix.length<12)prefix=Buffer.concat([prefix,chunk.subarray(0,12-prefix.length)]);
  }
  return {size,digest:`sha256:${hash.digest('hex')}`,mimetype:transferMediaType(prefix)};
}

/** Snapshot only named regular files; generated payload ids never double as untrusted paths.
 * @param {string} directory @param {string[]} inputs
 */
export async function snapshotTransferFiles(directory,inputs) {
  if(!inputs.length || inputs.length>MAX_FILES) throw new AgoraError(`Share between one and ${MAX_FILES} regular files per offer.`,2);
  await privateDirectory(path.dirname(directory));
  // This function owns only the directory it created. Never remove a pre-existing payload.
  await mkdir(directory,{mode:0o700});
  /** @type {Array<{id:string,name:string,size:number,mimetype:string,digest:string}>} */
  const files=[];const names=new Set();let total=0;
  try {
    for(const input of inputs) {
      const full=path.resolve(input), name=portableTransferName(path.basename(full)), folded=name.toLowerCase();
      if(names.has(folded)) throw new AgoraError('Transfer filenames collide across platforms. Rename the duplicates, then retry agora share.');
      names.add(folded);
      const st=await lstat(full);
      if(!st.isFile() || st.isSymbolicLink() || st.size>MAX_FILE_BYTES || total+st.size>MAX_OFFER_BYTES) throw new AgoraError('Share accepts regular files up to 128 MiB each and 512 MiB total, without symbolic links. Split or rename the input and retry agora share.');
      if(path.resolve(await realpath(full))!==full) throw new AgoraError('Transfer input traverses a symbolic link. Supply the real file path and retry agora share.');
      const source=await open(full,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const id=String(files.length);
      const dest=await open(path.join(directory,id),'wx',0o600);
      const hash=createHash('sha256');let count=0;let prefix=Buffer.alloc(0);
      try {
        const before=await source.stat();
        if(!before.isFile() || before.ino!==st.ino || before.dev!==st.dev) throw new AgoraError('Transfer source changed while opening. Retry agora share.');
        for await(const chunk of source.createReadStream({autoClose:false})) {
          count+=chunk.length;
          if(count>st.size || count>MAX_FILE_BYTES) throw new AgoraError('Transfer source grew while reading. Retry agora share after the file is stable.');
          if(prefix.length<12)prefix=Buffer.concat([prefix,chunk.subarray(0,12-prefix.length)]);
          hash.update(chunk);await dest.writeFile(chunk);
        }
        const after=await source.stat();
        if(count!==st.size || after.mtimeMs!==st.mtimeMs || after.size!==st.size) throw new AgoraError('Transfer source changed during snapshot. Retry agora share after the file is stable.');
        await dest.sync();
      } finally {await source.close();await dest.close();}
      files.push({id,name,size:count,mimetype:transferMediaType(prefix),digest:`sha256:${hash.digest('hex')}`});total+=count;
    }
    return files;
  } catch(e) {await rm(directory,{recursive:true,force:true});throw e;}
}

/** @param {unknown} input */
export function validateTransferManifest(input) {
  const files=/** @type {any} */(input);
  if(!Array.isArray(files) || !files.length || files.length>MAX_FILES) throw new AgoraError('Offer manifest is invalid; ask the sender to create a new agora share offer.');
  const names=new Set();let total=0;
  for(const [index,file] of files.entries()) {
    if(!file || file.id!==String(index) || typeof file.name!=='string' || !Number.isSafeInteger(file.size) || file.size<0 || file.size>MAX_FILE_BYTES || !/^sha256:[a-f0-9]{64}$/.test(file.digest)) throw new AgoraError('Offer manifest is invalid; ask the sender to create a new agora share offer.');
    portableTransferName(file.name);const folded=file.name.toLowerCase();
    if(names.has(folded) || (total+=file.size)>MAX_OFFER_BYTES) throw new AgoraError('Offer names or size limits are invalid; ask the sender to create a new agora share offer.');
    names.add(folded);
  }
  return files;
}

/** Commit a complete receive directory with no-clobber semantics; retries verify existing bytes.
 * @param {string} staging @param {string} destination @param {ReturnType<typeof validateTransferManifest>} files
 */
export async function commitReceivedFiles(staging,destination,files) {
  validateTransferManifest(files);
  await privateDirectory(destination);
  /** @type {string[]} */const created=[];
  const attachments=[];
  try {
    for(const file of files) {
      const source=path.join(staging,file.id), target=path.join(destination,file.name);
      const sourceStat=await lstat(source);
      if(!sourceStat.isFile()||sourceStat.isSymbolicLink())throw new AgoraError('Received staging file is not regular. Retry agora fetch into a private directory.');
      const actual=await digestFile(source);
      if(actual.size!==file.size || actual.digest!==file.digest) throw new AgoraError('Received file digest mismatch; no receipt was sent. Retry agora fetch <room> <offer-id>.');
      try {await link(source,target);created.push(target);}
      catch(e) {
        if(/** @type {NodeJS.ErrnoException} */(e).code!=='EEXIST') throw e;
        const st=await lstat(target);
        if(!st.isFile() || st.isSymbolicLink()) throw new AgoraError('Destination collision; no existing file was changed. Retry agora fetch with --into <empty-directory>.');
        const existing=await digestFile(target);
        if(existing.size!==file.size || existing.digest!==file.digest) throw new AgoraError('Destination collision; no existing file was changed. Retry agora fetch with --into <empty-directory>.');
      }
      attachments.push({...transferAttachment({...file,mimetype:actual.mimetype}),path:target});
    }
    // Files were fsynced before linking. Persist directory entries where supported before ACK.
    if(process.platform!=='win32') {const dir=await open(destination,'r');try {await dir.sync();} finally {await dir.close();}}
    return attachments;
  } catch(e) {for(const file of created) await rm(file,{force:true});throw e;}
}
