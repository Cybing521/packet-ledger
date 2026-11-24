#!/usr/bin/env node
/**
 * Automated Integrity & End-to-End Smoke Test for PacketLedger
 * Verifies:
 *   1. Manifest V3 structure, CSP compliance, and exact PNG icon dimensions
 *   2. Syntax validity of all extension & companion scripts
 *   3. Local JSONL sink server + Bilibili 16-byte Brotli WebSocket frame unpacking
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. Check JS syntax across all modules
const jsFiles = [
  'shared/db.js',
  'background/service-worker.js',
  'content/bridge-isolated.js',
  'content/inject-main.js',
  'sidepanel/sidepanel.js',
  'companion/local-sink.mjs'
];

for (const rel of jsFiles) {
  const full = path.join(ROOT, rel);
  execFileSync(process.execPath, ['--check', full], { stdio: 'inherit' });
}

// 2. Check Manifest V3 & PNG dimensions
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3, 'manifest_version must be 3');
assert.equal('default_popup' in (manifest.action || {}), false, 'action must omit default_popup for Side Panel click trigger');

for (const [sizeStr, relPath] of Object.entries(manifest.icons)) {
  const buf = fs.readFileSync(path.join(ROOT, relPath));
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${relPath} must be valid PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.equal(width, Number(sizeStr), `${relPath} width mismatch`);
  assert.equal(height, Number(sizeStr), `${relPath} height mismatch`);
}

const panelHtml = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
assert.equal(/\bon(?:click|change|input|submit|load|error|keydown|keyup|mousedown|mouseup)\s*=/i.test(panelHtml), false, 'sidepanel.html must not contain inline event attributes');

// 3. E2E test of companion/local-sink.mjs + Brotli WS frame decoding
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-ledger-test-'));
const port = 18992;
const child = spawn(process.execPath, [path.join(ROOT, 'companion/local-sink.mjs'), `--port=${port}`, `--dir=${tmpDir}`], {
  stdio: ['ignore', 'pipe', 'pipe']
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Sink server startup timed out')), 4000);
  child.stdout.on('data', (chunk) => {
    if (String(chunk).includes('127.0.0.1')) {
      clearTimeout(timeout);
      resolve();
    }
  });
});

try {
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ok, true);

  // Construct a Bilibili Live protoVer=3 Brotli frame carrying a DANMU_MSG subpacket
  const payload = Buffer.from(JSON.stringify({ cmd: 'DANMU_MSG', info: [[], 'hello-packet-ledger'] }), 'utf8');
  const inner = Buffer.alloc(16 + payload.length);
  inner.writeUInt32BE(inner.length, 0);
  inner.writeUInt16BE(16, 4);
  inner.writeUInt16BE(0, 6);
  inner.writeUInt32BE(5, 8);
  inner.writeUInt32BE(1, 12);
  payload.copy(inner, 16);

  const brotliBody = zlib.brotliCompressSync(inner);
  const outer = Buffer.alloc(16 + brotliBody.length);
  outer.writeUInt32BE(outer.length, 0);
  outer.writeUInt16BE(16, 4);
  outer.writeUInt16BE(3, 6);
  outer.writeUInt32BE(5, 8);
  outer.writeUInt32BE(1, 12);
  brotliBody.copy(outer, 16);

  const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      siteTag: 'bilibili',
      method: 'WS_RECV',
      status: 101,
      url: 'wss://broadcastlv.chat.bilibili.com/sub',
      wsMeta: {
        biliHeader: { packetLen: outer.length, headerLen: 16, protoVer: 3, op: 5, seq: 1 },
        rawBase64: outer.toString('base64')
      }
    })
  });
  const body = await res.json();
  assert.equal(body.ok, true);

  const persisted = JSON.parse(fs.readFileSync(body.file, 'utf8').trim());
  assert.equal(persisted.wsMeta.decodedMessages[0].cmd, 'DANMU_MSG');
  assert.equal(persisted.wsMeta.decodedMessages[0].info[1], 'hello-packet-ledger');
  console.log('OK: All syntax, Manifest V3, PNG dimension, and Brotli JSONL sink checks passed.');
} finally {
  child.kill('SIGTERM');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
