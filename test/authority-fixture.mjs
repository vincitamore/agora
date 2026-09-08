// Approved-act fixtures: real key possession and public service methods, never an unsigned bypass.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { NativeRoomService } from '../src/native-service.mjs';
import { publicNodeKeyDigest } from '../src/protocol/route.mjs';
import { humanKeyId } from '../src/protocol/human-authority.mjs';
import { authorityIdForKey, createAuthorityEnrollmentChallenge, authorityEnrollmentSigningBytes,
  enrollAuthorityRecord, authoritySigningBytes } from '../src/authority.mjs';

const LOCAL_KEY = `nodekey:${'1'.repeat(64)}`;
/** @type {WeakMap<NativeRoomService, import('node:crypto').KeyObject>} */
const signers = new WeakMap();

/** @param {ConstructorParameters<typeof NativeRoomService>[0]} options
 * @param {{roomId: string, publicNodeKeys: string[]}[]} scope */
export async function authorityFixtureService(options, scope) {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(/** @type {string} */ (keys.publicKey.export({format:'jwk'}).x), 'base64url').toString('hex');
  const now = new Date().toISOString();
  const record = { version:1, algorithm:'ed25519', authorityId:authorityIdForKey(publicKey), publicKey,
    keyId:humanKeyId(publicKey), boundNodeKeyDigest:publicNodeKeyDigest(`nodekey:${'2'.repeat(64)}`),
    enrolledAt:now, enrolledBy:'operator-local-bootstrap', label:'fixture counter-seat', profile:'pinned-cooperative',
    policy:{policyId:'3'.repeat(32),revision:1,validFrom:now,expiresAt:new Date(Date.now()+86400000).toISOString(),
      entries:scope.flatMap(row=>row.publicNodeKeys.map(key=>({roomId:row.roomId,
        allowedKeyDigest:publicNodeKeyDigest(key), actions:['room-enroll','room-revoke']})))}};
  const targetNodeKeyDigest=publicNodeKeyDigest(LOCAL_KEY);
  const challenge=createAuthorityEnrollmentChallenge(record,targetNodeKeyDigest,now);
  await enrollAuthorityRecord(options.root,record,record.keyId,{targetNodeKeyDigest,retainedChallenge:challenge,now,
    proof:{challenge,signature:sign(null,authorityEnrollmentSigningBytes(challenge),keys.privateKey).toString('hex')}});
  const service=new NativeRoomService({...options,authorityId:record.authorityId,
    readLocalIdentity:async()=>({nodeKey:LOCAL_KEY})});
  signers.set(service,keys.privateKey);
  return service;
}

/** @param {NativeRoomService} service @param {unknown} challenge */
export function fixtureProof(service,challenge) {
  const key=signers.get(service);assert.ok(key,'fixture service has no signing key');
  return {challenge,signature:sign(null,authoritySigningBytes(challenge),key).toString('hex')};
}
/** @param {NativeRoomService} service @param {Parameters<NativeRoomService['openRoute']>[0]} input */
export async function approvedOpen(service,input) {
  const pending=await service.createRouteChallenge({action:'room-enroll',roomId:input.roomId,publicNodeKey:input.publicNodeKey});
  return service.openRoute({...input,proof:fixtureProof(service,pending.challenge)});
}
/** @param {NativeRoomService} service @param {{roomId:string,publicNodeKey:string}} input */
export async function approvedClose(service,input) {
  const pending=await service.createRouteChallenge({action:'room-revoke',...input});
  return service.closeRoute({...input,proof:fixtureProof(service,pending.challenge)});
}
