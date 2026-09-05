// @ts-check
import { mkdir, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgoraError } from './core.mjs';
import { atomicJson, privateDirectory, snapshotTransferFiles, resolveTransferRecipients,
  encodeTransfer, decodeTransfer, localTransferIdentity, validateTransferManifest, commitReceivedFiles, digestFile } from './tailcat.mjs';
import { controlOffer, launchOffer, unloadOfferRegistration } from './tailcat-launcher.mjs';
import { requestTransfer, openTransferClient } from './tailcat-http.mjs';
import { sha256 } from './tailcat-runtime.mjs';

/** @param {string} root @param {string} id */
export function offerDirectory(root,id){if(!/^[a-f0-9-]{36}$/.test(id))throw new AgoraError('Invalid offer id. Run agora share <room> --list.',2);return path.join(root,'offers',id);}
/** @param {string} root */
export async function listOffers(root){
  const parent=await privateDirectory(path.join(root,'offers'));const rows=[];
  for(const id of await readdir(parent))if(/^[a-f0-9-]{36}$/.test(id)){
    const directory=offerDirectory(root,id);
    try{const record=JSON.parse(await readFile(path.join(directory,'publication.json'),'utf8'));
      rows.push({id,room:record.room,status:record.status,expires:record.expires,online:await controlOffer(directory,'health')});}catch{}
  }
  return rows;
}

/** @param {string} root @param {string} id */
export async function stopOffer(root,id){
  const directory=offerDirectory(root,id);
  const stopped=await controlOffer(directory,'stop');
  if(stopped){for(let i=0;i<50;i++){if(!await controlOffer(directory,'health')){await unloadOfferRegistration(id);return;}await delay(100);}}
  if(await controlOffer(directory,'health'))throw new AgoraError(`Offer did not stop yet. Retry agora share <room> --stop ${id}.`);
  await unloadOfferRegistration(id);
}

/**
 * The operation record survives uncertain publication. Retrying identical input is refused until
 * the caller explicitly resumes the existing id; a timeout cannot silently mint another offer.
 * @param {import('./core.mjs').Transport} transport @param {string} sessionRoot @param {string} stateRoot
 * @param {string[]} inputs @param {string[]} to
 * @param {{expiresIn?:number,once?:boolean,pages?:number,sign:(text:string)=>string,room:string,launch?:typeof launchOffer}} options
 */
export async function shareFiles(transport,sessionRoot,stateRoot,inputs,to,options){
  const peers=await resolveTransferRecipients(transport,stateRoot,to,{pages:options.pages});
  const duration=options.expiresIn??3600;
  if(!Number.isInteger(duration)||duration<60||duration>86400)throw new AgoraError('Use --expires-in between 60 and 86400 seconds.',2);
  const parent=await privateDirectory(path.join(sessionRoot,'offers'));
  const operation=sha256(Buffer.from(JSON.stringify({room:transport.room,inputs:inputs.map(x=>path.resolve(x)),peers:peers.map(x=>x.account).sort()})));
  // A stable local publication lock also prevents two concurrent commands from publishing twins.
  const operationDir=path.join(parent,'operation-'+operation);
  const id=randomUUID();const directory=offerDirectory(sessionRoot,id);
  try{await mkdir(operationDir,{mode:0o700});}
  catch(e){if(/** @type {NodeJS.ErrnoException} */(e).code!=='EEXIST')throw e;
    let old='the existing offer';try{old=(await readdir(operationDir)).find(x=>/^[a-f0-9-]{36}\.json$/.test(x))?.slice(0,-5)??old;}catch{}
    throw new AgoraError(`This share already has an operation record (${old}). Run agora share ${options.room} --list, then --resume <id> or --forget <id> after checking its publication.`);}
  await atomicJson(path.join(operationDir,id+'.json'),{id});
  await mkdir(directory,{mode:0o700});
  const expires=Date.now()+duration*1000;
  const publication={id,room:options.room,transportRoom:transport.room,status:'preparing',expires,operation};
  await atomicJson(path.join(directory,'publication.json'),publication);
  try{
    const files=await snapshotTransferFiles(path.join(directory,'payload'),inputs);
    await atomicJson(path.join(directory,'worker.json'),{id,stateRoot,files,expires,once:options.once??false,
      controlSecret:randomBytes(32).toString('hex'),peers:peers.map(peer=>({...peer,
        receiptDigest:'sha256:'+sha256(Buffer.from(JSON.stringify({id,account:peer.account,key:peer.nodeKey,files})))}))});
    await (options.launch??launchOffer)(directory,id);
    let ready;
    for(let i=0;i<1000;i++){
      try{ready=JSON.parse(await readFile(path.join(directory,'ready.json'),'utf8'));break;}catch{}
      try{await readFile(path.join(directory,'failed.json'));throw new AgoraError('Offer startup failed. Run agora doctor --offline, then inspect agora share <room> --list.');}catch(e){if(e instanceof AgoraError)throw e;}
      await delay(100);
    }
    if(!ready)throw new AgoraError('Offer readiness timed out. Check relay connectivity, then run agora share <room> --list.');
    const body=options.sign(`Secure file offer ${id}; expires ${new Date(expires).toISOString()}. Fetch explicitly with agora fetch ${options.room} ${id}.\n${encodeTransfer({version:1,kind:'offer',offer:ready})}`);
    if(body.length>3900)throw new AgoraError('Offer metadata exceeds the room limit. Use fewer recipients/files or shorter filenames, then retry agora share.');
    await atomicJson(path.join(directory,'message.json'),{body});
    await atomicJson(path.join(directory,'publication.json'),{...publication,status:'publication-uncertain'});
    const posted=await transport.post(body);
    await atomicJson(path.join(directory,'publication.json'),{...publication,status:'published',posted});
    return {expires,recipients:peers.map(({account,fingerprint})=>({account,fingerprint})),...posted,offerId:id};
  }catch(e){await stopOffer(sessionRoot,id);throw e;}
}

/** Uncertain publication is reconciled by offer id, never blindly reposted. @param {import('./core.mjs').Transport} transport @param {string} root @param {string} id @param {number} [pages] */
export async function resumeOffer(transport,root,id,pages=20){
  const directory=offerDirectory(root,id),record=JSON.parse(await readFile(path.join(directory,'publication.json'),'utf8'));
  if(record.transportRoom!==transport.room)throw new AgoraError('Offer belongs to another room. Run agora share <original-room> --resume '+id+'.');
  const who=await transport.whoami();const messages=await transport.read({limit:pages*200,pages});
  if(messages.gap)throw new AgoraError('Publication scan is incomplete. Retry --resume with a larger --pages value.');
  const found=messages.filter(m=>m.author.id===who.id&&decodeTransfer(m.text)?.offer?.id===id);
  if(found.length){const status=await controlOffer(directory,'health')?'published':'published-stopped';await atomicJson(path.join(directory,'publication.json'),{...record,status,posted:{id:found[0].id,cursor:found[0].cursor}});
    return {offerId:id,status,messageId:found[0].id};}
  throw new AgoraError(`No matching publication was found in ${pages} pages; absence is not proof it was never sent. Check the room, then explicitly --forget ${id} before sharing anew.`);
}

/** Explicit cleanup cannot kill a reused PID. Publication uncertainty is the caller's decision. @param {string} root @param {string} id */
export async function forgetOffer(root,id){
  const directory=offerDirectory(root,id),record=JSON.parse(await readFile(path.join(directory,'publication.json'),'utf8'));
  await stopOffer(root,id);
  if(!/^[a-f0-9]{64}$/.test(record.operation))throw new AgoraError('Offer operation record is corrupt. Restore local state before cleanup.');
  // Remove only this operation pointer; the immutable offer and receipts stay inspectable.
  const operationDir=path.join(root,'offers','operation-'+record.operation);
  await rm(path.join(operationDir,id+'.json'),{force:true});
  try{await rmdir(operationDir);}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(/** @type {NodeJS.ErrnoException} */(e).code??''))throw e;}
}

/** Remove only expired, offline offers owned by this session. @param {string} root */
export async function pruneOffers(root){
  const removed=[];
  for(const row of await listOffers(root))if(Number.isSafeInteger(row.expires)&&row.expires<=Date.now()&&!row.online){
    await forgetOffer(root,row.id);
    const directory=offerDirectory(root,row.id);
    await rm(directory,{recursive:true,force:true});removed.push(row.id);
  }
  return removed;
}

/** @param {import('./core.mjs').Transport} transport @param {string} stateRoot @param {string} root @param {string} id @param {{into?:string,pages?:number,room?:string}} [options] */
export async function fetchFiles(transport,stateRoot,root,id,options={}){
  offerDirectory(root,id);const who=await transport.whoami();const identity=await localTransferIdentity(stateRoot);
  const pages=options.pages??20;
  const messages=await transport.read({limit:pages*200,pages});
  if(messages.gap)throw new AgoraError('Offer scan is incomplete. Retry agora fetch with a larger --pages value.');
  const found=messages.map(m=>({message:m,envelope:decodeTransfer(m.text)})).filter(x=>x.envelope?.offer?.id===id);
  if(found.length!==1)throw new AgoraError('Offer is absent or ambiguous. Ask the sender for its current agora share offer id.');
  const offer=found[0].envelope.offer;const files=validateTransferManifest(offer.files);
  if(!Number.isSafeInteger(offer.expires)||offer.expires<=Date.now()||offer.expires>Date.now()+86400000)throw new AgoraError('Offer has expired or has an invalid expiry. Ask for a new agora share offer.');
  if(!Array.isArray(offer.routes))throw new AgoraError('Offer routes are invalid. Ask for a new agora share offer.');
  const routes=offer.routes.filter(/** @param {any} x */x=>x.account===who.id&&x.nodeKey===identity.nodeKey);
  if(routes.length!==1)throw new AgoraError('This seat is not enrolled for this offer. Run agora enroll <room>, then ask the sender for a new offer to your account id.');
  const route=routes[0];
  const digest='sha256:'+sha256(Buffer.from(JSON.stringify({id,account:who.id,key:identity.nodeKey,files})));
  if(route.receiptDigest!==digest)throw new AgoraError('Offer route manifest is inconsistent. Ask for a new agora share offer.');
  const destination=await privateDirectory(path.resolve(options.into??path.join(root,'received',id)));
  const connection={...route,stateRoot,keyPath:identity.keyPath,deadline:offer.expires};
  const receiptPath=path.join(destination,'.agora-receipt-'+id+'.json');
  let committed=false;
  try{const receipt=JSON.parse(await readFile(receiptPath,'utf8'));committed=receipt.digest===digest;
    if(committed)for(const file of files){const actual=await digestFile(path.join(destination,file.name));if(actual.size!==file.size||actual.digest!==file.digest){committed=false;break;}}}catch{}
  const client=await openTransferClient(connection);
  try{
  if(!committed){
    const manifest=await client.request('/manifest',{maximum:32768});
    const actual=JSON.parse(manifest.bytes.toString('utf8'));
    if(actual.digest!==digest||JSON.stringify(actual.files)!==JSON.stringify(files))throw new AgoraError('Remote manifest differs from the room offer. No receipt was sent; ask for a new offer.');
    const staging=path.join(destination,'.agora-stage-'+randomUUID());await mkdir(staging,{mode:0o700});
    try{
      for(const file of files)await client.request('/files/'+file.id,{target:path.join(staging,file.id),maximum:file.size});
      await commitReceivedFiles(staging,destination,files);
      await atomicJson(receiptPath,{digest});
    }finally{await rm(staging,{recursive:true,force:true});}
  }
  const attachments=files.map(file=>({...file,kind:'file',path:path.join(destination,file.name)}));
  try{await client.request('/receipt',{body:JSON.stringify({digest}),maximum:256});}
  catch{ return {offerId:id,status:'saved-receipt-pending',attachments,next:{command:'agora',args:['fetch',options.room??'<room>',id,'--into',destination]}}; }
  return {offerId:id,status:'received',attachments};
  }finally{await client.close();}
}
