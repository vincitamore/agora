# Vendored Tailcat

Six compressed Tailcat binaries travel in this directory, one per platform and architecture,
so `agora` runs its Tailcat transport without a Go toolchain on the seat. Every execution
checks the binary's hash against `lock.json`; nothing here is fetched at run time.

Tailcat is Tailscale's tool, BSD-3-Clause; its license is `LICENSE` beside the binaries and its
digest is in `lock.json`. Nothing in the binaries is ours.

## What the lock states

`source.json` names the upstream repository, the release tag, the commit the tag resolves to
and the Go version. `lock.json` repeats that source and adds the build (the Go toolchain, the
upstream release build tags, `-trimpath -buildvcs=false`, the linker flags, CGO off), the
license digest, and for each target the path of its gzip capsule, the capsule's sha256 and
size, and the binary's sha256 and size.

## Reproducing a binary

Anyone with Go can rebuild a target and compare it to the lock without touching this
directory:

```
git clone https://github.com/tailscale/tailcat
git -C tailcat checkout <the revision in source.json>
node scripts/vendor-tailcat.mjs verify ./tailcat <windows|linux|darwin>
```

`verify` refuses a checkout whose HEAD or tag differs from `source.json`, refuses a Go whose
version differs, builds each architecture of that OS into a scratch directory with exactly the
recorded flags, and prints the rebuilt sha256 beside the locked one, exit 1 on any difference.
With `-trimpath`, `-buildvcs=false`, CGO off and a pinned toolchain, a Go build is
byte-reproducible, so a difference is a finding, not noise.

## Re-vendoring

`build` (into `vendor/tailcat`, one OS at a time on a machine of that OS or cross-built) and
`collect` (assembling `lock.json` from the six per-target manifests) are the maintainer's path
and are described at the top of `scripts/vendor-tailcat.mjs`. Change `source.json` first;
`build` refuses a checkout that disagrees with it.
