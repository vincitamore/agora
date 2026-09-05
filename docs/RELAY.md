# Relay operation and recovery

Agora bundles the Tailcat client/server runtime. It does not bundle or deploy a
public rendezvous service. W11 currently starts offers with `serve --key=new
--full-address`: the sender selects from Tailcat's default map, and the resulting
address embeds the selected relay. A map cache can avoid a new fetch; the relay
remains a network dependency. `doctor --offline` checks local runtime integrity.

An operator-managed relay can remove dependence on Tailcat's public relay hosts.
It does not remove the need for rendezvous, reachable endpoints or certificate
management. Tailcat itself supplies account-free connectivity; vendoring supplies
the executable. See [the two-seat walkthrough](PARTNER-WALKTHROUGH.md).

## The pinned CLI has one effective relay node

This applies to Tailcat v0.4.0, commit
`ce6fedcabc220bab3b94d470ab330219111eeae8`, used by the checked-in capsules.
`genkey --region=relay-a.example,relay-b.example` writes both nodes into a key.
During `serve`, `clearUnnecessaryRegionFields` truncates that region to its first
node before constructing the server and publishing its address. Listing a second
node therefore does not provide connection failover through this CLI.

Source: [server startup](https://github.com/tailscale/tailcat/blob/ce6fedcabc220bab3b94d470ab330219111eeae8/cmd/tailcat/tailcat.go#L1105)
and [region cleanup](https://github.com/tailscale/tailcat/blob/ce6fedcabc220bab3b94d470ab330219111eeae8/cmd/tailcat/tailcat.go#L1664).
This is a source finding, not a performed two-relay outage experiment.

Failover remains a required capability to design and verify. Candidate mechanisms
include a reviewed upstream/runtime change with compatible relay topology, or
authenticated route replacement and operation reconciliation after relay failure.
The latter restores service with a new route; it is not transparent continuation of
an existing connection. Any chosen mechanism must preserve the enrolled principal,
reject stale route generations and reconcile unknown acceptance with the original
operation ID. A public hostname appended second is not an implementation of either.

## Deployment inputs

No deployment target is selected by this runbook. Before installing a relay, record
the host and its operator, public address/DNS name, certificate method, network
exposure and recovery owner. A DNS name alone does not establish host authority or
reachability. Keep the relay's private key and certificate material on that host.

The relay server is Tailscale's separate `cmd/derper`. A reproducible build may use
the Tailscale module revision already pinned by this Tailcat version:

```sh
go install tailscale.com/cmd/derper@v1.103.0-pre.0.20260830144538-72780705eda8
```

That is a relay-maintainer build step, not a new prerequisite on participating Agora
seats. Validate the resulting binary and deployment artifact before installation.
It has not been built or deployed by this document.

For a hostname with Let's Encrypt, the launch template is:

```sh
derper -c /var/lib/derper/derper.key --hostname=relay.example.com -a :443 --http-port=80 --stun --stun-port=3478 --certmode=letsencrypt --verify-clients=false
```

Replace the example name and choose service-owned storage/permissions on the actual
host. The host needs TCP 443, UDP 3478, and TCP 80 for this certificate path. Keep it
outside an HTTP reverse proxy. Let's Encrypt certificates renew automatically;
manual certificate replacement requires restart. Tailnet-based `--verify-clients`
expects a local tailscaled and tailnet-visible clients; it does not authorize Agora's
Tailcat keys. Recipient authorization remains at each Tailcat route's `--allow` and
Agora's application boundary.
[Pinned derper operations guide](https://github.com/tailscale/tailscale/blob/72780705eda8/cmd/derper/README.md),
[pinned flags](https://github.com/tailscale/tailscale/blob/72780705eda8/cmd/derper/derper.go).

Monitor process health, certificate expiry, DERP connectivity and STUN separately.
An HTTP response alone does not establish an encrypted transfer. Keep debug endpoints
restricted. Choose capacity from measured member/transfer load rather than assuming
a host size from the small number of initial peers.

## Selecting the relay in Agora

Tailcat can bake a hostname into an explicit server key using
`genkey --key=<path> --region=<hostname>`; the subsequent server address embeds it.
It also accepts an alternate DERP map. These are upstream capabilities, not presently
shipped Agora configuration flags. W11's current `--key=new` launch does not inherit
a hostname merely because a relay was installed elsewhere.

The integration must choose the relay from validated configuration and pass an
explicit Agora-owned key/map to each route. It must preserve one recipient-specific
listener/process and verify the embedded endpoint before advertising readiness.
P3 supplies descriptor authorization; P1 owns publication and current membership.
No route may silently fall back to public relays after an operator-selected endpoint
fails. Existing addresses continue to name their original endpoint; changing a
configuration file does not retarget already-published addresses.

Tailcat's default map is `https://tailcat.dev/derpmap.json`. Do not substitute
Tailscale's control-plane map by assuming their region IDs are interchangeable.
Embedded addresses let recipients avoid fetching a map, but they still connect to
the named endpoint. Preserve endpoint discovery and failure status in diagnostics.

## Independent network acceptance

Run on dedicated fixtures or isolated test networks, then repeat on the required
physical seats. Do not change shared production firewall/DNS or tokens for this test.

| Exhibit | What establishes it |
|---|---|
| Configured endpoint | Inspect the generated route and show only the intended relay host/address. Record public identity and hashes, not private keys or control nonces. |
| Public-map independence | With `tailcat.dev` and public relay hosts unavailable to the fixtures, create a new route and transfer verified text and PNG through the configured relay. A warmed cache alone is insufficient evidence. |
| Relay-only success | Prevent direct UDP between the test peers while preserving relay TCP reachability. Transfer and reconcile the receipt. Record observed path throughout the relevant interval. |
| Direct success | Allow direct reachability, observe its establishment and transfer the same fixture class. A relay-only result remains a valid transfer; report the actual path. |
| Cold-start outage | Make the selected relay unavailable before route readiness. Show bounded failure, no offer publication, confirmed owned-resource cleanup and an actionable retry. |
| Mid-stream outage | Interrupt the selected relay while direct transport is unavailable. Show bounded failure/unknown acceptance, no claimed send without receipt and no silent public fallback. |
| Original-relay restoration | Restore the same relay and reconcile to one original operation/receipt. This establishes restoration, not second-endpoint failover. |
| Different-relay recovery/failover | With the primary still unavailable, use the implemented protocol and a second nominated endpoint; authenticate replacement descriptors, reject stale generations and reconcile to one original operation/receipt. Keep this required row unfulfilled until that mechanism and endpoint exist. Record whether the connection survived or a new route was established. |
| Authorization | An unapproved key remains unable to fetch on the operator-managed relay; the intended recipient succeeds. |

Upstream `tailcat ping` can report a DERP or direct path. A diagnostic for an
Agora-restricted route must use the verified bundled executable and that recipient's
explicit enrolled client key; a bare invocation may use the wrong ambient identity.
Agora integration of this diagnostic is pending. `ping --until-direct`
measures whether an upgrade occurs within its timeout; it is not a prerequisite for
share/fetch. A ping is not proof of the entire file stream's path. An existing direct
connection that survives relay shutdown is not proof that a new connection can
bootstrap during the outage.

Retain exact runtime and Agora revisions, physical-host distribution, network
restrictions, timestamps, observed mode, operation/receipt states and cleanup result.
Source inspection, loopback fixtures and physical acceptance each retain their own
evidence tier.
