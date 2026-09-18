// Maintainer build/collect tool, and a stranger's verify: rebuild a target from the pinned source with the locked recipe and compare to lock.json. End users run the checked-in binaries, never Go.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
const root = resolve(import.meta.dirname, '..');
const vendor = resolve(root, 'vendor/tailcat');
const source = JSON.parse(readFileSync(resolve(vendor, 'source.json'), 'utf8'));
const targets = ['windows-amd64', 'windows-arm64', 'linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const GO = process.env.AGORA_GO ?? 'go'; // a stranger's Go, or a test's stand-in
const run = (args, cwd, env = process.env) => execFileSync(GO, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const [mode, input, os] = process.argv.slice(2);
/** the checkout at `cwd` must be the pinned source, and the Go on PATH the pinned toolchain */
function assertPinnedSource(cwd) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const tagRevision = execFileSync('git', ['rev-parse', `${source.tag}^{commit}`], { cwd, encoding: 'utf8' }).trim();
  if (revision !== source.revision || tagRevision !== source.revision) throw Error(`Pinned tag/revision mismatch: HEAD ${revision}, ${source.tag} ${tagRevision}, source.json ${source.revision}`);
  const goVersion = run(['env', 'GOVERSION'], cwd);
  if (goVersion !== `go${source.go}`) throw Error(`Expected go${source.go}, got ${goVersion}`);
  return goVersion;
}
if (mode === 'verify') {
  // A stranger's row: rebuild each architecture of one OS from the pinned source with the locked
  // recipe into a scratch directory, and compare the bytes' sha256 with lock.json. Writes nothing
  // under vendor/. With -trimpath, -buildvcs=false, CGO off and the pinned toolchain a Go build is
  // byte-reproducible, so a difference is a finding.
  if (!input || !['windows', 'linux', 'darwin'].includes(os)) throw Error('Usage: verify <upstream-checkout> <windows|linux|darwin>');
  const cwd = resolve(input);
  const lock = JSON.parse(readFileSync(resolve(vendor, 'lock.json'), 'utf8'));
  if (JSON.stringify(lock.source) !== JSON.stringify(source)) throw Error('lock.json and source.json disagree; re-vendor before verifying');
  const goVersion = assertPinnedSource(cwd);
  if (goVersion !== lock.build.go) throw Error(`lock.json was built with ${lock.build.go}, this is ${goVersion}`);
  const tags = readFileSync(resolve(cwd, 'build-tags.txt'), 'utf8').trim();
  if (tags !== lock.build.tags) throw Error('build-tags.txt differs from the tags lock.json recorded');
  const scratch = mkdtempSync(resolve(tmpdir(), 'tailcat-verify-'));
  let failed = false;
  for (const arch of ['amd64', 'arm64']) {
    const target = `${os}-${arch}`;
    const entry = lock.targets[target];
    if (!entry) throw Error(`lock.json has no target ${target}`);
    const out = resolve(scratch, `${target}-tailcat${os === 'windows' ? '.exe' : ''}`);
    run(['build', ...lock.build.flags, '-tags', tags, '-ldflags', lock.build.ldflags.join(' '), '-o', out, './cmd/tailcat'], cwd,
      { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: lock.build.cgo ? '1' : '0' });
    const bytes = readFileSync(out);
    const rebuilt = hash(bytes);
    const same = rebuilt === entry.sha256 && bytes.length === entry.size;
    if (!same) failed = true;
    console.log(`${same ? 'ok   ' : 'DIFF '}${target}: rebuilt ${rebuilt} (${bytes.length} bytes), locked ${entry.sha256} (${entry.size} bytes)`);
  }
  rmSync(scratch, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
} else if (mode === 'build') {
  const cwd = resolve(input);
  const goVersion = assertPinnedSource(cwd);
  const tags = readFileSync(resolve(cwd, 'build-tags.txt'), 'utf8').trim();
  if (!tags || /\s/.test(tags)) throw Error('Invalid upstream release build tags');
  // Git object bytes avoid Windows checkout autocrlf changing the shipped license hash.
  const license = execFileSync('git', ['show', 'HEAD:LICENSE'], { cwd });
  if (!license.toString().startsWith('BSD 3-Clause License')) throw Error('Unexpected upstream license');
  if (!['windows', 'linux', 'darwin'].includes(os)) throw Error('Expected windows, linux or darwin');
  for (const arch of ['amd64', 'arm64']) {
    const target = `${os}-${arch}`;
    const relative = `${target}/tailcat${os === 'windows' ? '.exe' : ''}`;
    const out = resolve(vendor, relative);
    mkdirSync(dirname(out), { recursive: true });
    const flags = ['-s', '-w', `-X main.version=${source.tag}`];
    run(['build', '-trimpath', '-buildvcs=false', '-tags', tags, '-ldflags', flags.join(' '), '-o', out, './cmd/tailcat'], cwd,
      { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0' });
    chmodSync(out, 0o755);
    const bytes = readFileSync(out);
    const capsule = gzipSync(bytes, { level: 9 });
    const capsulePath = `${target}/tailcat.gz`;
    writeFileSync(resolve(vendor, capsulePath), capsule);
    writeFileSync(resolve(vendor, `${target}.json`), JSON.stringify({ target, path: capsulePath, capsuleSha256: hash(capsule), capsuleSize: capsule.length, sha256: hash(bytes), size: bytes.length,
      source, build: { go: goVersion, tags, flags: ['-trimpath', '-buildvcs=false'], ldflags: flags, cgo: false }, licenseSha256: hash(license) }, null, 2) + '\n');
    if ((process.platform === os || process.platform === 'win32' && os === 'windows') &&
        (process.arch === arch || process.arch === 'x64' && arch === 'amd64')) {
      const version = execFileSync(out, ['version'], { encoding: 'utf8', timeout: 15000 }).trim();
      if (version !== source.tag) throw Error(`Native smoke returned ${version}`);
      console.log(`${target}: built, hash=${hash(bytes)}, native version PASS`);
    } else console.log(`${target}: cross-built, hash=${hash(bytes)}`);
  }
  writeFileSync(resolve(vendor, 'LICENSE'), license);
} else if (mode === 'collect') {
  const artifacts = resolve(input);
  const entries = {};
  let build;
  let licenseSha256;
  for (const target of targets) {
    const dir = resolve(artifacts, target.split('-')[0]);
    const entry = JSON.parse(readFileSync(resolve(dir, `${target}.json`), 'utf8'));
    const expected = `${target}/tailcat.gz`;
    if (entry.target !== target || entry.path !== expected || JSON.stringify(entry.source) !== JSON.stringify(source)) throw Error(`Bad manifest: ${target}`);
    if (build && JSON.stringify(build) !== JSON.stringify(entry.build)) throw Error('Different build flags across targets');
    build = entry.build;
    const capsule = readFileSync(resolve(dir, expected));
    if (capsule.length !== entry.capsuleSize || hash(capsule) !== entry.capsuleSha256) throw Error(`Capsule mismatch: ${target}`);
    const bytes = gunzipSync(capsule, { maxOutputLength: 100 * 1024 * 1024 });
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.size) throw Error(`Artifact integrity mismatch: ${target}`);
    const license = readFileSync(resolve(dir, 'LICENSE'));
    if (hash(license) !== entry.licenseSha256) throw Error('License mismatch');
    // Accept the initial Windows runner's CRLF checkout only after verifying its artifact hash.
    // Content must be identical across targets; canonical repository text is LF.
    const canonicalLicense = Buffer.from(license.toString('utf8').replaceAll('\r\n', '\n'));
    if (licenseSha256 && licenseSha256 !== hash(canonicalLicense)) throw Error('Different license text across targets');
    licenseSha256 = hash(canonicalLicense);
    const out = resolve(vendor, expected);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, capsule);
    writeFileSync(resolve(vendor, 'LICENSE'), canonicalLicense);
    entries[target] = { path: expected, capsuleSha256: entry.capsuleSha256, capsuleSize: entry.capsuleSize, sha256: entry.sha256, size: entry.size };
  }
  writeFileSync(resolve(vendor, 'lock.json'), JSON.stringify({ version: 1, source, build, license: { path: 'LICENSE', sha256: licenseSha256 }, targets: entries }, null, 2) + '\n');
  console.log('Collected all six verified capsules; no executable bits needed until local expansion.');
} else throw Error('Usage: node scripts/vendor-tailcat.mjs verify <upstream-checkout> <windows|linux|darwin> | build <upstream-checkout> <windows|linux|darwin> | collect <artifact-directory>');
