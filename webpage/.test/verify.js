/*
 * Temporary verification harness: proves whether the page's audio path
 * (bare Opus frames -> Ogg page wrapping -> decoder worker) preserves
 * amplitude and pitch. Runs the EXACT logic from app.js against the real
 * vendored encoderWorker/decoderWorker WASM in Node.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---- preload decoder wasm into the emscripten Module (avoids fetch) ----
const wasmBytes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'decoderWorker.min.wasm'));
global.Module = { wasmBinary: wasmBytes };
global.fetch = (url) => {
  const u = String(url);
  if (u.endsWith('.wasm')) {
    return Promise.resolve(new Response(wasmBytes, { status: 200, headers: { 'Content-Type': 'application/wasm' } }));
  }
  throw new Error('unexpected fetch ' + u);
};

// ---- load workers; capture their global onmessage handlers ----
const encModule = require(path.join(__dirname, '..', 'lib', 'encoderWorker.min.js'));
const encOnmessage = global.onmessage;
const decModule = require(path.join(__dirname, '..', 'lib', 'decoderWorker.min.js'));
const decOnmessage = global.onmessage;
console.log('encOnmessage:', typeof encOnmessage, 'decOnmessage:', typeof decOnmessage);

// ---- ported from app.js (exact same logic) ----
let packetParts = [];
function extractOpusPackets(page) {
  const packets = [];
  if (page.length < 27) return packets;
  const segCount = page[26];
  const bodyStart = 27 + segCount;
  if (bodyStart > page.length) return packets;
  if (bodyStart + 8 <= page.length && isOpusHeaderMagic(page, bodyStart)) return packets;
  let offset = bodyStart;
  for (let i = 0; i < segCount; i++) {
    const lacing = page[27 + i];
    if (offset + lacing > page.length) break;
    packetParts.push(page.slice(offset, offset + lacing));
    offset += lacing;
    if (lacing < 255) { packets.push(concatParts()); packetParts = []; }
  }
  return packets;
}
function isOpusHeaderMagic(page, offset) {
  return (page[offset] === 0x4F && page[offset + 1] === 0x70 &&
          page[offset + 2] === 0x75 && page[offset + 3] === 0x73 &&
          page[offset + 4] === 0x48 && page[offset + 5] === 0x65 &&
          page[offset + 6] === 0x61 && page[offset + 7] === 0x64) ||
         (page[offset] === 0x4F && page[offset + 1] === 0x70 &&
          page[offset + 2] === 0x75 && page[offset + 3] === 0x73 &&
          page[offset + 4] === 0x54 && page[offset + 5] === 0x61 &&
          page[offset + 6] === 0x67 && page[offset + 7] === 0x73);
}
function concatParts() {
  if (packetParts.length === 1) return packetParts[0];
  let total = 0;
  for (const p of packetParts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of packetParts) { out.set(p, pos); pos += p.length; }
  return out;
}
function buildOpusHeadPage() {
  const body = new Uint8Array(19);
  body.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
  body[8] = 1; body[9] = 1;
  body[12] = 0x80; body[13] = 0xBB;
  return buildOggPage(body, 0x02, 0, 12345);
}
let audioPageIndex = 0;
function buildAudioPage(opus) {
  const pageIndex = 2 + audioPageIndex;
  audioPageIndex++;
  return buildOggPage(opus, 0x00, pageIndex, 12345);
}
function buildOggPage(body, headerType, pageIndex, serial) {
  const lacing = [];
  let remaining = body.length;
  while (remaining >= 255) { lacing.push(255); remaining -= 255; }
  lacing.push(remaining);
  const page = new Uint8Array(27 + lacing.length + body.length);
  page.set([0x4F, 0x67, 0x67, 0x53], 0);
  page[4] = 0;
  page[5] = headerType;
  writeUint32LE(page, 14, serial);
  writeUint32LE(page, 18, pageIndex);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(body, 27 + lacing.length);
  return page;
}
function writeUint32LE(out, offset, value) {
  out[offset] = value & 0xFF;
  out[offset + 1] = (value >>> 8) & 0xFF;
  out[offset + 2] = (value >>> 16) & 0xFF;
  out[offset + 3] = (value >>> 24) & 0xFF;
}

async function main() {
  await encModule.Module.mainReady;
  console.log('encoder ready');
  await decModule.mainReady;
  console.log('decoder ready');

  // ---- sine input ----
  const SR = 48000, FRAME = 960, N = 100;
  const frames = [];
  for (let f = 0; f < N; f++) {
    const buf = new Float32Array(FRAME);
    for (let j = 0; j < FRAME; j++) {
      buf[j] = 0.5 * Math.sin(2 * Math.PI * 440 * (f * FRAME + j) / SR);
    }
    frames.push(buf);
  }
  const inputRms = Math.sqrt(frames.reduce((s, b) => s + b.reduce((x, y) => x + y * y, 0), 0) / (N * FRAME));
  console.log('input rms:', inputRms.toFixed(4));

  // ---- encode ----
  let encPages = [];
  global.postMessage = (msg) => { if (msg && msg.page) encPages.push(msg.page); };
  encOnmessage({ data: {
    command: 'init',
    encoderApplication: 2048, encoderFrameSize: 20, encoderSampleRate: 48000,
    encoderBitRate: 32000, maxFramesPerPage: 1, numberOfChannels: 1,
    originalSampleRate: 48000, resampleQuality: 3, serial: 12345
  }});
  encOnmessage({ data: { command: 'getHeaderPages' } });
  for (const buf of frames) encOnmessage({ data: { command: 'encode', buffers: [buf] } });
  const headerPages = encPages.slice(0, 2);
  const audioPages = encPages.slice(2);
  console.log('pages total:', encPages.length, '(2 header +', audioPages.length, 'audio)');

  // my extraction of bare packets
  const packets = [];
  for (const page of audioPages) packets.push(...extractOpusPackets(page));
  console.log('extracted packets:', packets.length, 'avg bytes:', Math.round(packets.reduce((s, p) => s + p.length, 0) / packets.length));

  // ---- PHASE A: native Ogg (header + audio pages concatenated) ----
  await runDecode('native Ogg', [headerPages[0], headerPages[1], ...audioPages], inputRms);

  // ---- PHASE B: my synthetic pages (fake OpusHead + per-frame pages) ----
  audioPageIndex = 0;
  const myPages = [buildOpusHeadPage()];
  for (const p of packets) myPages.push(buildAudioPage(p));
  await runDecode('synthetic pages', myPages, inputRms);
}

async function runDecode(label, pages, inputRms) {
  let totalLen = 0;
  for (const p of pages) totalLen += p.length;
  const full = new Uint8Array(totalLen);
  let off = 0;
  for (const p of pages) { full.set(p, off); off += p.length; }

  let chunks = [];
  global.postMessage = (msg) => { if (msg) chunks.push(msg[0]); };
  decOnmessage({ data: { command: 'init', decoderSampleRate: 48000, outputBufferSampleRate: 48000, bufferLength: 2048 }});
  await new Promise(r => setTimeout(r, 50)); // let the deferred handler run
  decOnmessage({ data: { command: 'decode', pages: full } });
  await new Promise(r => setTimeout(r, 50)); // let decode + chunk posts run

  let total = 0;
  for (const c of chunks) total += c.length;
  console.log(`${label}: chunks=${chunks.length} samples=${total}`);
  if (total < 10000) return;
  const merged = new Float32Array(total);
  off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const n = merged.length;
  const start = Math.floor(n * 0.15), end = Math.floor(n * 0.85);
  let sum = 0;
  for (let i = start; i < end; i++) sum += merged[i] * merged[i];
  const rms = Math.sqrt(sum / (end - start));
  let crossings = 0;
  for (let i = start + 1; i < end; i++) {
    if ((merged[i - 1] < 0 && merged[i] >= 0) || (merged[i - 1] >= 0 && merged[i] < 0)) crossings++;
  }
  const freq = crossings * 48000 / (2 * (end - start));
  console.log(`${label}: rms=${rms.toFixed(4)} (ratio ${(rms / inputRms).toFixed(3)}) freq=${freq.toFixed(2)} Hz (expect 440)`);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
