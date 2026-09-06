# Human-key authority: contract, not a deployed protection boundary

This design extends [the native contracts](PROTOCOL.md) for two first consumers:
board break and TUI compose. The new module validates candidates, challenges and
proof envelopes and defines signing bytes. It does **not** enroll a key, start a
signer, verify a signature, admit an operation or change the store. Current native
`authorKind: human` remains a cooperative claim, not this proof.

## Custody and the first trust anchor

The human has an independent Ed25519 key, not the service nonce, a Tailcat route
key or an agent session key. The initial local design is a confirming signer
under a separate human-controlled OS principal, outside agent read/write/process
control. It generates the private key with the platform cryptographic RNG there;
only the raw 32-byte public key and its full SHA-256 fingerprint leave it. No
private-key export through the CLI, environment, shared state or room is allowed.

The signer is not an unrestricted signing socket. In its protected human session
it displays the target, room, exact compose content/attachments or break subject
and current holder/fence, and signs only after explicit confirmation of that exact
request. It verifies the target's authenticated challenge and independently hashes
the bytes shown. A caller's `confirmed`, `human`, window title or PID is no evidence.
Ordinary signing requests never enroll or replace a key.

Bootstrap is a protected local administrative action: the human independently
compares the full signer fingerprint, approves this target and operation scopes,
and installs a grant into the target's protected authority registry. A possession
challenge proves the candidate key is held, not that its holder is the operator.
An empty registry refuses privileged operations; it never trusts the first socket
or first self-signed candidate. Candidate parsing is deliberately inert.

**This is a deployment prerequisite, not a claim about the current seat.** The
registry, admission code, signer executable/UI and replay journal must also be
outside agent modification. Separate key custody with an agent-writable verifier
does not protect anything. This profile excludes agents with administrator/kernel
control or control of the human's protected input session. Same-account file
permissions, an agent-accessible credential vault or a second nonce in shared state
are cooperative only. No platform backend is selected or installed in this unit;
no OS account, ACL or credential is changed. Before enabling enforcement, the
implementation must exhibit denied key reads, denied registry/verifier writes,
denied unattended signing and a real human-approved operation on this seat. Until
then enforcement is unavailable, not silently emulated with a label.

## Proof and admission

`HumanKeyCandidate` is `{version:1, authorityId, algorithm:'ed25519', publicKey,
keyId}`. `publicKey` is raw lowercase hex, `keyId` is SHA-256 of the 32 raw bytes.
The protected registry separately binds that key to a human principal, current
grant revision, active/revoked state, allowed actions/rooms and custody evidence.
None of those decisions comes from a candidate or proof body.

For each operation, the target issues a fresh random 32-byte nonce and unique
challenge ID and retains the full `HumanOperationChallenge`:

- action (`board-break` or `message-compose`), authority/key IDs;
- enrolled target host and service identity including boot ID;
- room ID/epoch, admitted requester registration including generation;
- operation ID, exact immutable request digest, authority policy revision;
- challenge ID, nonce, target-issued times (positive lifetime at most 120 seconds).

The target computes `requestDigest` over its closed, validated operation payload
using the existing native canonical digest, excluding the proof and derived
authority fields. Compose includes full text, attachments, reply and face choices;
break includes subject and expected holder lease/fence (or explicit absence).
If state or the bytes shown change, ask again. The signer receives those bytes,
not merely a digest beside caller-authored friendly text.

`humanOperationSigningBytes` defines the exact domain-separated UTF-8 tuple; all
fields are signed. The returned proof contains the challenge and a 64-byte
Ed25519 signature as lowercase hex. This reuses the challenge/proof **pattern**,
not the shared-secret HMAC: the service knows only the enrolled public key and
cannot manufacture human consent. No fresh signature is a standing delegation.

Target admission, under the same serialized decision as the operation, must:

1. Resolve the existing operation by authenticated identity and operation ID.
   A committed exact retry returns its original receipt, with no new effect, even
   after reboot or challenge expiry. A changed request or different requester
   refuses. Do not require a fresh approval to discover a completed outcome.
2. For a new effect, retrieve its own pending challenge; match every field against
   the current target, admitted requester, payload digest and policy revision.
   Check `issuedAt <= targetNow < expiresAt`; reject old boots and reused nonces.
3. Retrieve the active protected grant. Verify scope, current key/revision and
   signature over the exact tuple. Missing custody evidence cannot become an
   enforced grant. An untrusted caller cannot supply the grant or verifier result.
4. Recheck the live board fence/policy inside the append turn, consume the approval
   and commit mutation plus receipt atomically and durably. Response loss is
   unknown acceptance until reconciled; it is not permission to retry a new ID.

A replay journal lost on restart cannot satisfy this contract. Revocation blocks
new effects immediately, including issued but unused challenges. Rotation creates
a new grant/key revision through an already protected approval or independently
verified recovery; there is no automatic overlap or same-name recovery. Historical
records and committed retry receipts keep their original attribution.

## What the store stamps; first consumer joins

P1 retains an opaque in-process verified admission handle, not a caller-supplied
`verified:true`. From it the store derives human principal, key/grant reference,
approval digest and `authorityProfile: enforced`. The submitting session/bearer
remains separate attribution; it does not become the human principal. Labels
without proof may be shown as cooperative but cannot reach the enforced break
path. Existing records are not reclassified retroactively.

For break, approve exactly the observed holder/fence, then compare it again before
dropping anything. For compose, each send is its own approved immutable operation;
editing the draft invalidates approval. The TUI never receives the private key or
a session-wide human capability. Cancellation/timeout leaves the draft and makes
no append. Whether repeated confirms need a future bounded delegation is separate
design work; it must not be called fresh human consent.

P3 owns these shapes and byte fixtures. P1 owns challenge issuance, enrollment
registry/admission, atomic consumption and stamps; key custody/enrollment plumbing
and TUI approval UX remain explicit implementation joins. The reference fixture
uses real Node Ed25519 signatures but an in-memory policy oracle: it proves the
byte contract and negative cases, **not** OS custody, a service integration, replay
durability or a deployed human gate. Those tests are required before enforcement.
The original real-service relabel counterexample must be refused by that future
integration, while a genuinely approved compose/break still succeeds.

Run `node --test test/protocol-human-authority.test.mjs` for the seven fixtures.
`node scripts/check-human-authority-controls.mjs` copies the fixture to private
temporary state: dropping nonce binding, accepting a caller authority field and
removing the lifetime cap each fail at the named assertion, with the baseline
restored green. It does not mutate the checkout.

Cryptographic fixture API: [Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptosignalgorithm-data-key-callback)
(`sign`/`verify` with null algorithm for Ed25519). This is a new-wire contract, not
a modification of the existing general `OperatorAct` enum or an authorization for
its other actions. No new CLI verb or operator configuration is claimed here.
