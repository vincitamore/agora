// Build-time detector check: production checkout remains unchanged throughout.
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'agora-wake-controls-'));
const controls = [
  ['unknown-to-absent', 'lease.mjs', "? 'absent' : 'unknown'", "? 'absent' : 'absent'", 'all nine wake-route pairs'],
  ['contradictory-aggregate', 'lease.mjs', 'wakeSurface !== deriveWakeSurface(wakeRoutes)', 'false', 'all nine wake-route pairs'],
  ['recipient-unbound', 'delivered-coverage.mjs', 'JSON.stringify(v.recipient) !== JSON.stringify(validateRegistrationRef(e.recipient)) ||', '', 'recipient account, registration and generation'],
  ['service-unbound', 'delivered-coverage.mjs', 'JSON.stringify(v.service) !== JSON.stringify(validateServiceRef(e.service)) ||', '', 'service identity, boot, admission and progress'],
  ['frontier-as-delivery', 'delivered-coverage.mjs', 'parseCursor(v.coverage.toInclusive).sequence >= t.sequence', 'parseCursor(v.coverage.committedThrough).sequence >= t.sequence', 'whole-range coverage uses delivered end'],
  ['omitted-prefix', 'delivered-coverage.mjs', 'parseCursor(v.coverage.fromExclusive).sequence <= a.sequence', 'true', 'whole-range coverage uses delivered end'],
  ['expiry-equality', 'lease.mjs', 'now - acceptedAt < PRESENCE_LEASE_MS', 'now - acceptedAt <= PRESENCE_LEASE_MS', 'lease freshness is receiver-timed'],
  ['renewal-unbound', 'lease.mjs', ' || acceptedRenewal !== v.renewal', '', 'lease freshness is receiver-timed'],
];
try {
  await mkdir(join(scratch, 'src'));
  await mkdir(join(scratch, 'test'));
  await cp(join(root, 'src', 'protocol'), join(scratch, 'src', 'protocol'), { recursive: true });
  await cp(join(root, 'test', 'protocol-wake-coverage.test.mjs'), join(scratch, 'test', 'protocol-wake-coverage.test.mjs'));
  const run = () => spawnSync(process.execPath, ['--test', 'test/protocol-wake-coverage.test.mjs'],
    { cwd: scratch, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stderr + baseline.stdout);
  console.log('baseline: green');
  for (const [name, file, before, after, testName] of controls) {
    const path = join(scratch, 'src', 'protocol', file), source = await readFile(path, 'utf8');
    assert.equal(source.split(before).length, 2, `mutation anchor not unique: ${name}`);
    await writeFile(path, source.replace(before, after));
    try {
      const result = run();
      assert.equal(result.error, undefined, `${name}: harness error`);
      assert.equal(result.signal, null, `${name}: signal is not a discriminating failure`);
      assert.notEqual(result.status, 0, `${name}: detector stayed green`);
      assert.ok(result.stdout.split('\n').some((line) => line.startsWith('not ok ') && line.includes(testName)),
        `${name}: expected semantic assertion did not fail\n${result.stdout}\n${result.stderr}`);
      console.log(`${name}: red at expected assertion`);
    } finally { await writeFile(path, source); }
  }
  assert.equal(run().status, 0, 'restored detector must be green');
  console.log(`${controls.length}/${controls.length} controls discriminate; restored baseline green`);
} finally {
  // Exact directory minted above, never a repository or caller-supplied path.
  await rm(scratch, { recursive: true, force: true });
}
