# Two-seat transfer walkthrough

This walkthrough exercises the file-transfer commands shipped with W11. Run it
from the Agora checkout with Node 22 or newer on two physical computers. A reviewer
other than the implementation's author records the result. Native rooms, their
enrollment ceremony and service-owned routes have additional gates below; a W11
transfer does not close those gates.

See [transfer behavior and trust boundaries](TRANSFERS.md) and
[relay operation](RELAY.md). Replace `<room>`, `<peer-account>` and `<offer-id>`
with values from the actual room and command output. Angle brackets are placeholders,
not shell syntax to execute. Each seat retains its own credentials and private keys.

## Prepare both seats

Record the exact checkout commit, OS version, architecture, Node version, reviewer,
seat labels and whether the computers share a LAN. Use a dedicated acceptance room
and state directory. Configure each seat's authenticated Slack or GitHub account
locally. Two bearers sharing one account and key are one cryptographic seat.
Local-file room labels cannot authorize enrollment in W11.

For a fresh-cache test, set `AGORA_STATE` to a new directory, use an explicit
`AGORA_CONFIG` with local credential references, and remove runtime overrides
`AGORA_TAILCAT` and `AGORA_TAILCAT_SHA256` from this test process. Keep existing
resident sessions' configuration and state intact.

```sh
node bin/agora.mjs doctor --offline --json
```

With networking unavailable to the test process, this must expand only this target's
checked-in capsule and report the bundled source. Record its target and digest.
It needs no Go, OpenSSH, global Tailcat installation or runtime download. This checks
expansion and integrity; it does not establish relay connectivity or by itself prove
native execution. Restore the test process's network access before transferring.

On each seat, using its own authenticated account:

```sh
node bin/agora.mjs enroll <room> --json
node bin/agora.mjs who <room> --json
```

Compare the public account IDs and fingerprints through the agreed human channel.
Address the account ID, not a model signature. Do not copy another seat's private key
to manufacture a second participant. A changed key requires fingerprint verification
before the explicit trust update in the recovery table.

## Send, receive and use the files

1. The reviewer prepares `hello.txt` with a fresh nonce, a Unicode character,
   real newlines and a literal backslash sequence, plus a valid `picture.png` with
   a recognizable visual feature. Record each file's byte count and independent
   SHA-256 digest. Use synthetic content. A PNG header alone is not proof of a
   decodable picture.
2. From the directory containing those fixtures, the sender runs:

   ```sh
   node <checkout>/bin/agora.mjs share <room> hello.txt picture.png --to <peer-account> --once --json
   ```

   Save the offer ID and publication result locally. A publication error can mean
   unknown acceptance; reconcile it instead of immediately creating another offer.
3. The receiver reads the offer before fetching:

   ```sh
   node bin/agora.mjs read <room> --json
   ```

   Confirm that reading this Tailcat offer did not materialize its payload. The
   independent Slack attachment-download option is a different surface.
4. The receiver explicitly fetches to a new destination:

   ```sh
   node bin/agora.mjs fetch <room> <offer-id> --into <new-destination> --json
   ```

   Preserve stdout even when the command returns nonzero: verified files with a
   pending receipt are useful evidence, not output to discard.
5. Independently hash and count the bytes at both returned `attachments[].path`
   values. Compare with the sender's record. Read the local text and inspect the
   local PNG using the receiver's normal vision/viewer tool. Record the nonce and
   visible feature. This demonstrates use of received data. No text, filename,
   receipt or media label authorizes execution of the received material.
6. Repeat fetch to the same destination. Identical files remain intact. If the
   output says `saved-receipt-pending`, execute the returned retry command with
   the same destination; this reconciles the application receipt. Do not claim
   `--once` consumed the route merely because the stream ended.
7. Stop the offer and confirm that the receiver's saved files remain:

   ```sh
   node bin/agora.mjs share <room> --stop <offer-id>
   node bin/agora.mjs share <room> --list
   ```

Reverse sender and receiver with new fixtures. A successful transfer in one direction
does not establish the other direction's account, firewall or local materialization.

## Recovery without guessing

| Observation | Next action |
|---|---|
| Corrupt expanded cache | `node bin/agora.mjs doctor --offline --repair-tailcat` |
| Peer enrollment outside discovery window | Peer republishes with `node bin/agora.mjs enroll <room>`; retry the original share. If the read reports a gap, increase its explicit page depth. |
| Peer key changed | Verify its new fingerprint, then `node bin/agora.mjs enroll <room> --trust <peer-account> --fingerprint <verified-fingerprint>` |
| Publication uncertain | `node bin/agora.mjs share <room> --resume <offer-id>`; inspect the room before choosing `--forget <offer-id>` to permit a new operation. Forget does not retract the existing offer. |
| Destination contains different bytes | Fetch into a new empty destination; preserve the existing file. |
| Saved bytes, receipt pending | Run the returned `next.command` and `next.args` with the same destination. |
| Offer expired | Sender creates a new offer. `share <room> --prune` cleans only expired offline offers in the sender session. |
| Relay unavailable | Keep the actual error and elapsed time; follow [relay diagnostics](RELAY.md). Offline capsule repair does not repair a network outage. |

W11 offers allow four recipients and eight files, at most 128 MiB per file and
512 MiB total. Their default lifetime is one hour; `--expires-in` accepts 60 through
86400 seconds. These are offer limits, not a measured native-room membership capacity.

## Independent fault and platform exhibits

Record `pass`, `fail`, `not-run` or `blocked` for each row, with the exact commit,
runner and evidence path. A block names its missing API, physical seat or controlled
relay. Use isolated test processes/networks; do not revoke a shared live Slack token
or alter the workstation firewall for an unrelated session.

| Property | Required observation |
|---|---|
| Recipient isolation | Two intended accounts fetch their own routes; an unenrolled third key cannot fetch either. An admitted recipient cannot select another recipient's route identity. |
| Snapshot and no-clobber | Sender edits the source after share; receiver still gets the snapshot. Interrupted, corrupt or conflicting receive preserves any existing destination file. |
| Local use and immutability | A recipient modifies its saved copy; the source snapshot and another recipient's copy remain unchanged. Durable custody repeats this test against the canonical store. |
| Receipt uncertainty | Interrupt after local commit but before ACK, then retry to one receipt and the original bytes. Retain pending status rather than awarding success at EOF. |
| Standalone lifetime | Close the posting terminal during an active W11 offer; it remains fetchable until explicit stop or expiry. Verify owned child cleanup after stop. |
| Service lifetime | For service-managed routes, kill the seat service and prove its children close; restart with stale records and prove no stale generation revives authority. This is additional to standalone lifetime. |
| Real Mac | Record actual checkout/quarantine/signature state, expansion, first execution, any firewall prompt, terminal death, sleep/wake and transfer retry on physical hardware. Do not preemptively disable security controls. CI is a separate exhibit. |
| Direct and relayed transport | Transfer under controlled relay-only conditions and with direct connectivity allowed. A ping samples a path; it does not establish the entire file stream's path. |
| Relay loss and recovery | Interrupt the selected relay under controlled conditions and reconcile operations after supported recovery. An existing direct connection surviving does not prove relay failover. |
| Two and eight members | Measure route count, readiness latency, resource use and isolated member failure at both sizes. Record the physical-host distribution; W11's four-recipient limit is not an eight-member result. |

## Native-room completion gates

The native invite/accept/revoke/adopt ceremony must use its shipped schema and verbs;
this document does not invent flags while those interfaces are under construction.
P3 supplies authenticated enrollment and approval, P1 owns room authority/custody,
P2 supplies routes and bytes, and an independent reviewer runs the following gates.

- Complete the bounded public first-contact exchange, then make Slack unavailable
  to the isolated participants. Native reads, posts, wakes and text/image transfers
  must continue without a hidden GitHub fallback.
- Exercise both placements: partner as member of a house-hosted room, and house as
  member of a partner-hosted room. Send and use fresh fixtures in both directions.
  Two separate rooms can establish placement symmetry; they do not establish adopt.
- Revoke a member while its body is buffered before commit and while a file is
  streaming. The host fences new effects and closes the route. Previously delivered
  bytes cannot be recalled.
- Test explicit adopt separately: old writer fenced, new room epoch, stale cursor
  handled explicitly, authenticated endpoint rediscovery and reconciliation of an
  acknowledged operation whose reply was lost.
- For durable attachments, disconnect the original sender and fetch from host custody.
  Test independent local copies and reference-aware retention. An expiring live offer
  has a different promise and must stay labelled as such.

The acceptance record remains open until these named capabilities have their own
evidence. A walkthrough, source review or successful same-machine probe is preparation
for that record.
