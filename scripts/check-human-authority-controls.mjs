// Offline test discriminators. Copies only protocol source and its fixture into
// an owned temporary directory; never mutates the checkout or a resident service.
import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'agora-human-controls-'));
try {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'));
  await cp(path.join(repo, 'src/protocol'), path.join(root, 'src/protocol'), { recursive: true });
  await cp(path.join(repo, 'test/protocol-human-authority.test.mjs'), path.join(root, 'test/protocol-human-authority.test.mjs'));
  const file = path.join(root, 'src/protocol/human-authority.mjs');
  const original = await readFile(file, 'utf8');
  const run = () => spawnSync(process.execPath, ['--test', 'test/protocol-human-authority.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const controls = [
    ['nonce-omitted', 'v.challengeId, v.nonce, v.issuedAt', "v.challengeId, 'omitted', v.issuedAt", /not ok \d+ - every authority/],
    ['caller-authority-accepted', "readRecord(value, ['challenge', 'signature'])", "readRecord(value, ['challenge', 'signature'], ['authorKind'])", /not ok \d+ - wire authority labels/],
    ['lifetime-cap-removed', 'span <= 0 || span > HUMAN_CHALLENGE_MAX_MS', 'span <= 0', /not ok \d+ - wire authority labels/],
  ];
  for (const [name, from, to, failure] of controls) {
    assert.equal(original.split(from).length, 2, `control anchor: ${name}`);
    await writeFile(file, original.replace(from, to));
    const result = run();
    assert.equal(result.status, 1, `${name}: expected assertion failure, ${result.error ?? result.stderr}`);
    assert.match(result.stdout, failure, `${name}: unrelated failure is not a discriminator`);
    console.log(JSON.stringify({ control: name, expectedAssertionFailed: true }));
  }
  await writeFile(file, original);
  const restored = run();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  console.log(JSON.stringify({ baseline: 'green', controls: controls.length, restored: 'green' }));
} finally {
  await rm(root, { recursive: true, force: true });
}
