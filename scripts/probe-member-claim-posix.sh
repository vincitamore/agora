#!/usr/bin/env bash
# L12 slice 4: the claim's contest arm on a real POSIX filesystem.
#
# Run from a FILE, never `wsl bash -c "<string>"`: the exit status of a chained string is the
# shell's, not the gate's, and this script's whole output is a verdict about exit codes.
#
# And it runs on ext4 under $HOME, never on /mnt/c: drvfs is not POSIX, and the whole reason the
# brief asks for a POSIX arm is that POSIX rename(2) REPLACES an existing destination while Windows
# refuses it. Measuring the Windows filesystem through a Linux kernel would answer the wrong
# question with the right-looking exit code.
set -u
SRC=/mnt/c/Users/AlexMoyer/Documents/opus/projects/agora/.worktrees/opus-builder-native-l12r2
DST=$HOME/l12-posix-arm
rm -rf "$DST"
mkdir -p "$DST"
# Source only: no node_modules, no .git. The suite has zero runtime dependencies.
for d in src test scripts bin spawn tui docs; do
  [ -d "$SRC/$d" ] && cp -r "$SRC/$d" "$DST/$d"
done
cp "$SRC/package.json" "$DST/package.json"
cd "$DST" || exit 90

echo "== filesystem"
df -T . | tail -1
echo "== node"
node --version

echo "== claim cells"
node --test test/native-member-claim.test.mjs
claim=$?
echo "claim-exit=$claim"

echo "== contest cells"
node --test test/native-member-contest.test.mjs
contest=$?
echo "contest-exit=$contest"

echo "== N takers against one stale record, real processes"
node scripts/probe-member-claim-contest.mjs
probe=$?
echo "probe-exit=$probe"

echo "== rename semantics on this filesystem, stated rather than assumed"
node -e '
const { mkdtempSync, writeFileSync, renameSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const dir = mkdtempSync(path.join(tmpdir(), "rename-"));
const a = path.join(dir, "a"); const b = path.join(dir, "b");
writeFileSync(a, "A"); writeFileSync(b, "B");
try { renameSync(a, b); console.log("rename-over-existing=SUCCEEDED, destination now " + readFileSync(b, "utf8")); }
catch (e) { console.log("rename-over-existing=REFUSED " + e.code); }
'

echo "SUMMARY claim=$claim contest=$contest probe=$probe"
[ "$claim" -eq 0 ] && [ "$contest" -eq 0 ] && [ "$probe" -eq 0 ]
exit $?
