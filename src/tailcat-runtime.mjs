// @ts-check
import { readFile, lstat, mkdir, open, rename, rm, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { AgoraError } from './core.mjs';

export const TAILCAT_TARGETS = ['windows-amd64', 'windows-arm64', 'linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
const MAX_BINARY = 100 * 1024 * 1024;
const MAX_CAPSULE = 40 * 1024 * 1024;
const defaultVendor = path.resolve(import.meta.dirname, '../vendor/tailcat');
/** @param {Uint8Array} bytes */
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** @param {string} platform @param {string} arch */
export function tailcatTarget(platform, arch) {
  const target = `${platform === 'win32' ? 'windows' : platform}-${arch === 'x64' ? 'amd64' : arch}`;
  if (!TAILCAT_TARGETS.includes(target)) throw new AgoraError(`Tailcat is unavailable for ${platform}/${arch}. Use Agora on Windows, Linux or macOS with amd64/arm64; ordinary room read/post still work.`);
  return target;
}

/** @param {string} file @param {number} maximum */
async function regularBytes(file, maximum) {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > maximum) throw new AgoraError('Tailcat runtime file is not a bounded regular file. Restore vendor/tailcat from a trusted checkout and run agora doctor --offline.');
  const bytes = await readFile(file);
  if (bytes.length !== st.size || bytes.length > maximum) throw new AgoraError('Tailcat runtime changed while reading. Retry agora doctor --offline.');
  return bytes;
}

/** @param {string} [vendorDir] */
export async function readTailcatLock(vendorDir = defaultVendor) {
  /** @type {any} */
  let lock;
  try { lock = JSON.parse((await regularBytes(path.join(vendorDir, 'lock.json'), 64 * 1024)).toString('utf8')); }
  catch { throw new AgoraError('Tailcat runtime lock is missing or invalid. Pull the complete Agora checkout, then run agora doctor --offline.'); }
  if (lock?.version !== 1 || !/^[a-f0-9]{40}$/.test(lock.source?.revision ?? '') || !/^v\d+\.\d+\.\d+$/.test(lock.source?.tag ?? '') ||
      lock.source?.repository !== 'https://github.com/tailscale/tailcat' || typeof lock.build?.tags !== 'string' || !lock.build.tags || lock.license?.path !== 'LICENSE' ||
      !/^[a-f0-9]{64}$/.test(lock.license?.sha256 ?? '') || !lock.targets || Object.keys(lock.targets).length !== TAILCAT_TARGETS.length) {
    throw new AgoraError('Tailcat lock metadata is invalid. Restore vendor/tailcat from a trusted checkout and run agora doctor --offline.');
  }
  for (const target of TAILCAT_TARGETS) {
    const entry = lock.targets[target];
    if (!entry || entry.path !== `${target}/tailcat.gz` || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-f0-9]{64}$/.test(entry.capsuleSha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_BINARY ||
        !Number.isSafeInteger(entry.capsuleSize) || entry.capsuleSize < 1 || entry.capsuleSize > MAX_CAPSULE) {
      throw new AgoraError(`Tailcat lock target ${target} is invalid. Restore vendor/tailcat and run agora doctor --offline.`);
    }
  }
  const license = await regularBytes(path.join(vendorDir, 'LICENSE'), 64 * 1024);
  if (sha256(license) !== lock.license.sha256) throw new AgoraError('Tailcat license checksum mismatch. Restore vendor/tailcat and run agora doctor --offline.');
  return lock;
}

/** @param {string} root @param {string[]} pieces */
async function cacheDirectory(root, pieces) {
  let current = path.resolve(root);
  await mkdir(current, { recursive: true, mode: 0o700 });
  for (const part of pieces) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const st = await lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new AgoraError('Tailcat cache contains a linked or non-directory path. Use a private AGORA_STATE directory, then run agora doctor --offline.');
  }
  return current;
}

/**
 * Resolve immediately before EVERY process launch. No network, no shell, no ambient binary.
 * @param {{stateRoot:string, vendorDir?:string, platform?:string, arch?:string, override?:string, overrideSha256?:string, repair?:boolean}} options
 */
export async function resolveTailcatBinary(options) {
  const target = tailcatTarget(options.platform ?? process.platform, options.arch ?? process.arch);
  const vendor = options.vendorDir ?? defaultVendor;
  const lock = await readTailcatLock(vendor);
  const entry = lock.targets[target];
  const override = options.override ?? process.env.AGORA_TAILCAT;
  if (override) {
    if (!path.isAbsolute(override)) throw new AgoraError('AGORA_TAILCAT must be an absolute executable path. Unset it to use the bundled runtime.');
    const expected = options.overrideSha256 ?? process.env.AGORA_TAILCAT_SHA256 ?? entry.sha256;
    if (!/^[a-f0-9]{64}$/.test(expected) || sha256(await regularBytes(override, MAX_BINARY)) !== expected) {
      throw new AgoraError('Tailcat override checksum mismatch. Unset AGORA_TAILCAT to use the bundle, or set AGORA_TAILCAT_SHA256 to the independently verified override digest.');
    }
    return { path: override, target, source: 'override', sha256: expected, tag: lock.source.tag };
  }
  const capsule = await regularBytes(path.join(vendor, entry.path), MAX_CAPSULE);
  if (capsule.length !== entry.capsuleSize || sha256(capsule) !== entry.capsuleSha256) throw new AgoraError(`Tailcat capsule checksum mismatch (${target}). Restore vendor/tailcat from a trusted checkout and run agora doctor --offline.`);
  const dir = await cacheDirectory(options.stateRoot, ['bin', 'tailcat', entry.sha256]);
  const executable = path.join(dir, target.startsWith('windows-') ? 'tailcat.exe' : 'tailcat');
  let cached;
  try { cached = await regularBytes(executable, MAX_BINARY); }
  catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e; }
  if (cached && (cached.length !== entry.size || sha256(cached) !== entry.sha256)) {
    if (!options.repair) throw new AgoraError('Tailcat cached executable checksum mismatch; it was not run. Run agora doctor --offline --repair-tailcat to restore it from the verified bundle.');
    cached = undefined;
  }
  if (!cached) {
    let bytes;
    try { bytes = gunzipSync(capsule, { maxOutputLength: entry.size }); }
    catch { throw new AgoraError('Tailcat capsule could not be expanded within its declared size. Restore vendor/tailcat and run agora doctor --offline.'); }
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new AgoraError('Tailcat expanded executable checksum mismatch. Restore vendor/tailcat and run agora doctor --offline.');
    const temp = path.join(dir, `.extract-${randomUUID()}`);
    try {
      const fh = await open(temp, 'wx', 0o700);
      try { await fh.writeFile(bytes); await fh.sync(); } finally { await fh.close(); }
      await rename(temp, executable).catch(async e => {
        // Windows can refuse replacement while a concurrent resolver wins; accept only identical bytes.
        if (sha256(await regularBytes(executable, MAX_BINARY)) !== entry.sha256) throw e;
      });
    } finally { await rm(temp, { force: true }); }
  }
  if (process.platform !== 'win32') await chmod(executable, 0o700);
  if (sha256(await regularBytes(executable, MAX_BINARY)) !== entry.sha256) throw new AgoraError('Tailcat cache changed during verification. Retry agora doctor --offline.');
  return { path: executable, target, source: 'bundle', sha256: entry.sha256, tag: lock.source.tag };
}

/** @param {Parameters<typeof resolveTailcatBinary>[0]} options */
export async function tailcatDoctor(options) {
  try { return { type: 'tailcat', status: 'verified', ...await resolveTailcatBinary(options) }; }
  catch (e) { return { type: 'tailcat', status: 'unavailable', error: e instanceof Error ? e.message : 'Tailcat unavailable; run agora doctor --offline.' }; }
}
