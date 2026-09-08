// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/probe-tailcat-live.mjs', import.meta.url));

test('direct probe redacts echoed invocation and credentials before bounding public child output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-probe-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = path.join(root, "private key's file.json");
  const address = 'tco-SYNTHETIC-PRIVATE-ADDRESS';
  const addressFile = path.join(root, 'server.addr');
  // A well-formed identity, because L12 seam 8 made the gate derive the enrolled key digest from
  // this file (a pure read) before it may spawn a key-bearing child. The odd FILENAME is this
  // cell's subject and is unchanged, so path redaction is still what is being tested; only the
  // contents had to become a real identity. The private half here is synthetic.
  await writeFile(key, JSON.stringify({
    Private: 'privkey:' + 'P'.repeat(64),
    Public: { ServerPublic: 'nodekey:' + 'a1b2c3d4'.repeat(8), ServerDiscoPublic: 'discokey:' + 'd'.repeat(64) },
  }));
  await writeFile(addressFile, address);
  const keyPath = await realpath(key);
  // This preload replaces only the gate's child call; no network or enrolled identity is used.
  const preload = path.join(root, 'child-fixture.mjs');
  await writeFile(preload, `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    cp.spawnSync = (_binary, args) => {
      if (!args.includes('ping')) throw Error('unexpected child invocation');
      const echoed = args.join(' ') + '\\n' + JSON.stringify(args);
      const secret = 'privkey:' + 'S'.repeat(3000);
      return { status: Number(process.env.PROBE_CHILD_EXIT), signal: null,
        stdout: 'pong in ' + echoed.replaceAll('\\n', ' ') + ' via DERP(1)\\n' +
          'pong in 1ms via 127.0.0.1:1234\\n',
        stderr: 'x'.repeat(5000) + '\\n' + secret + '\\n' + echoed + '\\n' +
          'tskey-auth-' + 'T'.repeat(32) + '\\n' + 'ghp_' + 'G'.repeat(32) + '\\nTAIL' };
    };
    syncBuiltinESMExports();
  `);
  for (const exit of [0, 1]) {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, '--direct',
      '--binary', process.execPath, '--address-file', addressFile, '--key-file', key,
      '--timeout-ms', '1000'], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PROBE_CHILD_EXIT: String(exit) } });
    assert.equal(child.status, exit, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.pass, exit === 0);
    assert.equal(result.directEndpoint, '127.0.0.1:1234');
    assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= 2048);
    assert.ok(result.stderr.endsWith('TAIL'));
    assert.match(result.stderr, /\[redacted\]/);
    for (const privateValue of [address, key, keyPath, 'S'.repeat(16), 'T'.repeat(16), 'G'.repeat(16)]) {
      assert.ok(!child.stdout.includes(privateValue), 'private fixture text escaped in public output');
    }
    // Compare decoded strings too, so JSON escaping cannot conceal a leaked Windows path.
    assert.ok(!result.stderr.includes(keyPath));
    assert.ok(result.pongs.every((/** @type {string} */ line) => !line.includes(keyPath)));
  }
});
