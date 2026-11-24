#!/usr/bin/env node
/**
 * PacketLedger Companion Local Disk Sink (零第三方依赖，适配 Node v20+/v24)
 *
 * 作用：
 *   接收 Chrome 扩展推送的抓包记录，按站点与日期自动分文件实时追加写入本地 .jsonl 日志，
 *   并利用 Node 内置 zlib.brotliDecompressSync 自动解压 B站直播间 protoVer=3 的 Brotli 二进制弹幕帧。
 *
 * 启动方式：
 *   node companion/local-sink.mjs
 *
 * 可选参数：
 *   --port=17890
 *   --dir=./logs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const eq = arg.indexOf('=');
    return eq === -1 ? [arg.slice(2), true] : [arg.slice(2, eq), arg.slice(eq + 1)];
  })
);

const PORT = Number(args.port || 17890);
const OUT_DIR = path.resolve(
  String(args.dir || path.join(os.homedir(), 'Downloads', 'packet-ledger-logs'))
);

fs.mkdirSync(OUT_DIR, { recursive: true });

function splitBiliSubpackets(buf) {
  const messages = [];
  let offset = 0;
  while (offset + 16 <= buf.length) {
    const pktLen = buf.readUInt32BE(offset);
    const hdrLen = buf.readUInt16BE(offset + 4);
    if (pktLen < 16 || offset + pktLen > buf.length) break;
    const body = buf.subarray(offset + hdrLen, offset + pktLen);
    const text = body.toString('utf8');
    try {
      messages.push(JSON.parse(text));
    } catch {
      messages.push(text);
    }
    offset += pktLen;
  }
  return messages;
}

function enrichBiliBrotliIfPresent(record) {
  const header = record?.wsMeta?.biliHeader;
  const b64 = record?.wsMeta?.rawBase64;
  if (!header || header.protoVer !== 3 || typeof b64 !== 'string') return record;
  try {
    const rawBuf = Buffer.from(b64, 'base64');
    if (rawBuf.length <= 16) return record;
    const decompressed = zlib.brotliDecompressSync(rawBuf.subarray(16));
    record.wsMeta.decodedMessages = splitBiliSubpackets(decompressed);
    delete record.wsMeta.rawBase64;
  } catch (err) {
    record.wsMeta.decompressError = err.message;
  }
  return record;
}

function sanitizeFileSegment(raw) {
  return String(raw || 'other')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .slice(0, 48) || 'other';
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, outDir: OUT_DIR, port: PORT }));
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/ingest')) {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= 25 * 1024 * 1024) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      try {
        const rawJson = Buffer.concat(chunks).toString('utf8');
        const parsed = enrichBiliBrotliIfPresent(JSON.parse(rawJson));
        const siteSeg = sanitizeFileSegment(parsed.siteTag);
        const dateSeg = new Date().toISOString().slice(0, 10);
        const targetFile = path.join(OUT_DIR, `${siteSeg}-${dateSeg}.jsonl`);

        fs.appendFileSync(targetFile, JSON.stringify(parsed) + '\n', 'utf8');
        console.log(
          `${new Date().toISOString()} [${siteSeg}] ${parsed.method || 'REQ'} ${parsed.status ?? '-'} ${parsed.url} -> ${path.basename(targetFile)}`
        );

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, file: targetFile }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PacketLedger 本地实时落盘接收器已启动: http://127.0.0.1:${PORT}`);
  console.log(`日志写入目录: ${OUT_DIR}`);
  console.log('按站点自动分文件: chatgpt-YYYY-MM-DD.jsonl / bilibili-YYYY-MM-DD.jsonl');
});
