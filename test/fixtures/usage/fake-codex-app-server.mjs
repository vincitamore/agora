#!/usr/bin/env node
// Synthetic Codex app-server for N3 CLI subprocess tests. No network, no credentials.
// Speaks the measured handshake: reply to `initialize`, ignore `initialized`, reply to
// `account/rateLimits/read`. The collector spawn is `<bin> app-server --stdio`.
import { createInterface } from 'node:readline';

const reply = {
  accountId: process.env.FAKE_CODEX_ACCOUNT_ID || 'account-synthetic-0001',
  rateLimits: null,
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: 'Codex',
      primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1789269881 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: false,
      planType: 'pro',
      rateLimitReachedType: null,
    },
  },
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize' && msg.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ id: msg.id, result: {} })}\n`);
    return;
  }
  if (msg.method === 'account/rateLimits/read' && msg.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ id: msg.id, result: reply })}\n`);
  }
});
