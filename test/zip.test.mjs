/**
 * Tests for the ZIP writer.
 *
 * The archive has to be readable by tools nobody here controls — an operator
 * will open it with Windows Explorer, macOS Archive Utility, or `unzip` on a
 * server, years from now. So these tests check the bytes against the format,
 * and a separate step in the probe round-trips a real archive through Python's
 * zipfile, which is an independent implementation.
 *
 * Run: node --test test/zip.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { crc32, crc32Blob, makeZip, checkZipLimits, ZIP_MAX_ENTRIES } from '../lib/zip.js';

const enc = new TextEncoder();

test('CRC-32 matches the known test vector', () => {
  // "123456789" -> 0xCBF43926 is the standard check value for CRC-32.
  assert.equal(crc32(enc.encode('123456789')), 0xCBF43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('chunked CRC over a Blob equals the one-shot CRC', async () => {
  // Large files are CRC'd in chunks so they never land in memory whole; the
  // running seed has to carry across chunk boundaries or the sum is wrong and
  // every archiver will report the file as corrupt.
  const bytes = new Uint8Array(300_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) & 0xFF;
  const blob = new Blob([bytes]);
  const chunked = await crc32Blob(blob, 4096);
  assert.equal(chunked, crc32(bytes));
});

test('an empty archive is still a valid archive', async () => {
  const zip = await makeZip([]);
  const b = new Uint8Array(await zip.arrayBuffer());
  assert.equal(b.length, 22);                       // end-of-central-directory only
  assert.deepEqual([...b.slice(0, 4)], [0x50, 0x4B, 0x05, 0x06]);
});

test('the archive carries the expected structure', async () => {
  const zip = await makeZip([
    { name: 'manifest.json', text: '{"a":1}' },
    { name: 'images/frame-0000.jpg', blob: new Blob([new Uint8Array([1, 2, 3, 4])]) },
  ]);
  const b = new Uint8Array(await zip.arrayBuffer());
  const dv = new DataView(b.buffer);

  assert.equal(dv.getUint32(0, true), 0x04034B50, 'starts with a local file header');

  // End-of-central-directory is the last 22 bytes when there is no comment.
  const eocd = b.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054B50);
  assert.equal(dv.getUint16(eocd + 8, true), 2, 'records two entries');
  assert.equal(dv.getUint16(eocd + 10, true), 2);
});

test('entry order is preserved so the manifest reads first', async () => {
  // Somebody opening a package of 300 photographs should see what it is before
  // scrolling through them.
  const zip = await makeZip([
    { name: 'manifest.json', text: '{}' },
    { name: 'images/a.jpg', blob: new Blob(['x']) },
  ]);
  const text = new TextDecoder('latin1').decode(new Uint8Array(await zip.arrayBuffer()));
  assert.ok(text.indexOf('manifest.json') < text.indexOf('images/a.jpg'));
});

test('stored entries keep the original bytes exactly', async () => {
  /*
   * STORE rather than DEFLATE, deliberately: JPEGs are already entropy-coded,
   * and storing them means the bytes in the archive are byte-identical to what
   * the camera produced — which is the property a provenance chain depends on.
   */
  const payload = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x10, 0x42]);
  const zip = await makeZip([{ name: 'x.jpg', blob: new Blob([payload]) }]);
  const b = new Uint8Array(await zip.arrayBuffer());

  const nameLen = new DataView(b.buffer).getUint16(26, true);
  const start = 30 + nameLen;
  assert.deepEqual([...b.slice(start, start + payload.length)], [...payload]);
});

test('the size and CRC in the header describe the actual data', async () => {
  const payload = enc.encode('hello archive');
  const zip = await makeZip([{ name: 'a.txt', blob: new Blob([payload]) }]);
  const b = new Uint8Array(await zip.arrayBuffer());
  const dv = new DataView(b.buffer);
  assert.equal(dv.getUint32(14, true), crc32(payload));
  assert.equal(dv.getUint32(18, true), payload.length, 'compressed size');
  assert.equal(dv.getUint32(22, true), payload.length, 'uncompressed size');
});

test('unicode filenames are flagged as UTF-8', async () => {
  // Without the flag, an archiver may decode the name as CP437 and mangle it.
  const zip = await makeZip([{ name: 'Bura-askos-café.jpg', blob: new Blob(['x']) }]);
  const dv = new DataView(await zip.arrayBuffer());
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800);
});

test('format limits are refused rather than silently truncated', () => {
  // Beyond these the archive would be written wrong and only fail on opening,
  // which is the worst possible time to find out.
  assert.equal(checkZipLimits(10, 1000).ok, true);
  assert.equal(checkZipLimits(ZIP_MAX_ENTRIES + 1, 1000).ok, false);
  assert.match(checkZipLimits(ZIP_MAX_ENTRIES + 1, 1000).reason, /Export in parts/);
  assert.equal(checkZipLimits(10, 5e9).ok, false);
  assert.match(checkZipLimits(10, 5e9).reason, /4 GB/);
});

test('a realistic session assembles correctly', async () => {
  // 30 frames of ~40 KB each, plus the three metadata files.
  const frames = Array.from({ length: 30 }, (_, i) => {
    const bytes = new Uint8Array(40_000);
    bytes[0] = 0xFF; bytes[1] = 0xD8;
    for (let j = 2; j < bytes.length; j++) bytes[j] = (i + j) & 0xFF;
    return { name: `images/frame-${String(i).padStart(4, '0')}.jpg`, blob: new Blob([bytes]) };
  });
  const zip = await makeZip([
    { name: 'manifest.json', text: '{}' },
    { name: 'README.txt', text: 'x' },
    { name: 'SHA256SUMS.txt', text: 'x' },
    ...frames,
  ]);
  const dv = new DataView(await zip.arrayBuffer());
  const b = new Uint8Array(dv.buffer);
  const eocd = b.length - 22;
  assert.equal(dv.getUint16(eocd + 8, true), 33);
  assert.ok(zip.size > 30 * 40_000, 'payload is actually present');
});
