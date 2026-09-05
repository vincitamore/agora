// Maintainer-only build/collect tool. End users run the checked-in binaries, never Go.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
const root = resolve(import.meta.dirname, '..');
const vendor = resolve(root, 'vendor/tailcat');
const source = JSON.parse(readFileSync(resolve(vendor, 'source.json'), 'utf8'));
const targets = ['windows-amd64', 'windows-arm64', 'linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (args, cwd, env = process.env) => execFileSync('go', args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const [mode, input, os] = process.argv.slice(2);
if (mode === 'build') {
  const cwd = resolve(input);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const tagRevision = execFileSync('git', ['rev-parse', `${source.tag}^{commit}`], { cwd, encoding: 'utf8' }).trim();
  if (revision !== source.revision || tagRevision !== source.revision) throw Error('Pinned tag/revision mismatch');
  const goVersion = run(['env', 'GOVERSION'], cwd);
  if (goVersion !== `go${source.go}`) throw Error(`Expected go${source.go}, got ${goVersion}`);
  const tags = readFileSync(resolve(cwd, 'build-tags.txt'), 'utf8').trim();
  if (!tags || /\s/.test(tags)) throw Error('Invalid upstream release build tags');
  const license = readFileSync(resolve(cwd, 'LICENSE'));
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
  copyFileSync(resolve(cwd, 'LICENSE'), resolve(vendor, 'LICENSE'));
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
    if (licenseSha256 && licenseSha256 !== entry.licenseSha256) throw Error('Different licenses across targets');
    build = entry.build;
    licenseSha256 = entry.licenseSha256;
    const capsule = readFileSync(resolve(dir, expected));
    if (capsule.length !== entry.capsuleSize || hash(capsule) !== entry.capsuleSha256) throw Error(`Capsule mismatch: ${target}`);
    const bytes = gunzipSync(capsule, { maxOutputLength: 100 * 1024 * 1024 });
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.size) throw Error(`Artifact integrity mismatch: ${target}`);
    const license = readFileSync(resolve(dir, 'LICENSE'));
    if (hash(license) !== licenseSha256) throw Error('License mismatch');
    const out = resolve(vendor, expected);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, capsule);
    writeFileSync(resolve(vendor, 'LICENSE'), license);
    entries[target] = { path: expected, capsuleSha256: entry.capsuleSha256, capsuleSize: entry.capsuleSize, sha256: entry.sha256, size: entry.size };
  }
  writeFileSync(resolve(vendor, 'lock.json'), JSON.stringify({ version: 1, source, build, license: { path: 'LICENSE', sha256: licenseSha256 }, targets: entries }, null, 2) + '\n');
  console.log('Collected all six verified capsules; no executable bits needed until local expansion.');
} else throw Error('Usage: node scripts/vendor-tailcat.mjs build <upstream-checkout> <windows|linux|darwin> | collect <artifact-directory>');
