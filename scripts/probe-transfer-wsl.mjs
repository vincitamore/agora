// Deliberate live Windows/WSL2 dogfood, not an offline CI test.
// node scripts/probe-transfer-wsl.mjs <distro> <absolute guest node path>
// Account announcements are synthetic and move only over the private RPC pipe.
// Payloads travel through real Agora offers/Tailcat, never through that pipe.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { localTransferIdentity, encodeTransfer } from '../src/tailcat.mjs';
import { shareFiles, fetchFiles, stopOffer, offerDirectory } from '../src/tailcat-offers.mjs';
import { controlOffer } from '../src/tailcat-launcher.mjs';
import { requestTransfer } from '../src/tailcat-http.mjs';
import { redact } from '../src/core.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=', 'base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const body = direction => Buffer.from(`VM dogfood ${direction}\nUnicode: λ 雪\nLiteral: \\n\n`, 'utf8');
const observation = value => console.log(JSON.stringify(value));

async function endpoint(account) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agora-vm-dogfood-')));
  const state = path.join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const identity = await localTransferIdentity(state);
  let messages = [];
  const offers = [];
  let cleaned = false;
  const transport = {
    kind: 'slack', room: 'synthetic-vm-dogfood', threads: false,
    whoami: async () => ({ id: account, name: account }),
    read: async () => messages,
    post: async text => {
      const id = `${account}-${messages.length}`;
      messages.push({ id, cursor: id, author: { id: account, name: account, kind: 'agent' }, text });
      return { id, cursor: id };
    },
  };
  return async ({ action, ...args }) => {
    if (action === 'identity') return { account, nodeKey: identity.nodeKey, platform: process.platform, runtime: process.version };
    if (action === 'share') {
      const peer = args.peer;
      messages = [{ id: 'enrollment', cursor: '0', author: { id: peer.account, name: peer.account, kind: 'agent' },
        text: encodeTransfer({ version: 1, kind: 'enrollment', nodeKey: peer.nodeKey }) }];
      const text = path.join(root, `${args.direction}.txt`);
      const picture = path.join(root, `${args.direction}.png`);
      await writeFile(text, body(args.direction));
      await writeFile(picture, png);
      const offer = await shareFiles(transport, state, state, [text, picture], [peer.account],
        { room: 'vm-dogfood', sign: value => value, once: true, expiresIn: 300 });
      offers.push(offer.offerId);
      const ready = JSON.parse(await readFile(path.join(offerDirectory(state, offer.offerId), 'ready.json'), 'utf8'));
      // Route metadata is a capability. It stays in this private pipe, never observations.
      return { offerId: offer.offerId, messages, route: ready.routes[0] };
    }
    if (action === 'deny') {
      const strangerState = path.join(root, 'stranger');
      const stranger = await localTransferIdentity(strangerState);
      let refused = false;
      try {
        await requestTransfer({ ...args.route, keyPath: stranger.keyPath, stateRoot: strangerState, deadline: Date.now() + 3000 }, '/manifest', { maximum: 32768 });
      } catch (error) {
        // A successful authorized fetch on this exact route is the paired control below.
        assert.match(String(error.message), /^Transfer (connection failed|timed out); no receipt was sent\./,
          'A setup, route-validation or unrelated crash is not an unauthorized-client observation');
        refused = true;
      }
      assert.equal(refused, true, 'unauthorized key unexpectedly obtained a manifest');
      return { unauthorizedManifestObtained: false };
    }
    if (action === 'fetch') {
      messages = args.messages;
      const result = await fetchFiles(transport, state, state, args.offerId);
      assert.equal(result.status, 'received');
      const text = await readFile(result.attachments[0].path);
      const picture = await readFile(result.attachments[1].path);
      assert.deepEqual(text, body(args.direction));
      assert.deepEqual(picture, png);
      assert.equal(result.attachments[1].kind, 'image');
      const retry = await fetchFiles(transport, state, state, args.offerId);
      assert.equal(retry.status, 'received');
      assert.deepEqual(retry.attachments.map(a => a.path), result.attachments.map(a => a.path));
      return { platform: process.platform, textBytes: text.length, textSha256: digest(text),
        imageBytes: picture.length, imageSha256: digest(picture), receipt: result.status, retrySamePaths: true };
    }
    if (action === 'cleanup') {
      if (cleaned) return { platform: process.platform, alreadyCleaned: true };
      for (const id of offers) {
        await stopOffer(state, id);
        assert.equal(await controlOffer(offerDirectory(state, id), 'health'), false);
      }
      // root is an exact mkdtemp result owned by this probe; never a user-supplied path.
      await rm(root, { recursive: true, force: true });
      cleaned = true;
      return { platform: process.platform, offerControlsStopped: true, temporaryStateRemoved: true };
    }
    throw new Error('Unknown probe action');
  };
}

async function guest() {
  const run = await endpoint('guest');
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      try { observation({ id: request.id, result: await run(request) }); }
      catch (error) { observation({ id: request.id, error: redact(String(error.message)) }); }
      if (request.action === 'cleanup') return;
    }
  } finally { await run({ action: 'cleanup' }); }
}

async function host() {
  assert.equal(process.platform, 'win32', 'Run the coordinator on Windows');
  const [distro, runtime] = process.argv.slice(2);
  assert.ok(distro && runtime?.startsWith('/'), 'Supply a non-CI WSL distro and its absolute Node path');
  const script = execFileSync('wsl.exe', ['-d', distro, '--', 'wslpath', '-u', fileURLToPath(import.meta.url).replaceAll('\\', '/')], { encoding: 'utf8', windowsHide: true }).trim();
  const child = spawn('wsl.exe', ['-d', distro, '--', runtime, script, '--guest'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let next = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const value = JSON.parse(line);
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    if (value.error) entry.reject(new Error(value.error)); else entry.resolve(value.result);
  });
  // Never echo raw guest output, which can include private capabilities on failure.
  child.stderr.resume();
  child.on('close', code => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Guest exited ${code}`)); }
    pending.clear();
  });
  const remote = request => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Guest RPC exceeded 150 seconds')); }, 150000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
  });
  const local = await endpoint('host');
  try {
    const hostIdentity = await local({ action: 'identity' });
    const guestIdentity = await remote({ action: 'identity' });
    assert.notEqual(hostIdentity.nodeKey, guestIdentity.nodeKey);
    observation({ scope: 'Windows-WSL2', distro, hostRuntime: hostIdentity.runtime, guestRuntime: guestIdentity.runtime,
      distinctKeys: true, accountTransport: 'synthetic-private-pipe', physicalSeat: false, relayOnly: 'unmeasured' });
    for (const [sender, receiver, peer, direction] of [[local, remote, guestIdentity, 'windows-to-linux'], [remote, local, hostIdentity, 'linux-to-windows']]) {
      const offer = await sender({ action: 'share', peer, direction });
      const denied = await receiver({ action: 'deny', route: offer.route });
      const received = await receiver({ action: 'fetch', ...offer, direction });
      observation({ direction, ...denied, ...received });
    }
  } finally {
    try { observation(await local({ action: 'cleanup' })); }
    finally { try { observation(await remote({ action: 'cleanup' })); } finally { child.stdin.end(); } }
  }
}

if (process.env.AGORA_TAILCAT || process.env.AGORA_TAILCAT_SHA256) throw new Error('Remove Tailcat overrides before this bundled-runtime probe');
try { if (process.argv[2] === '--guest') await guest(); else await host(); }
catch (error) { console.error(redact(String(error.message))); process.exitCode = 1; }
