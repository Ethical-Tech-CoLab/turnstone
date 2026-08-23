/**
 * unzip.mjs — a minimal ZIP reader, for verification.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT SHELL OUT TO AN EXTRACTOR.
 *
 * The first version of the verifier called PowerShell's Expand-Archive. On the
 * very first real package it failed with "the module could not be loaded" —
 * and separately, passing a Windows path through a shell mangled its
 * backslashes. A verification tool that depends on an optional module and on
 * shell quoting is a tool that will fail in the field, which is precisely where
 * it is needed and precisely where nobody can debug it.
 *
 * So this reads the format directly. Node ships `zlib` for the deflate case;
 * everything Turnstone writes is STORE and needs nothing at all.
 *
 * ON CIRCULARITY. Verifying our own archives with our own reader would be weak
 * evidence on its own, so the test suite separately round-trips a real archive
 * through Python's `zipfile` and .NET's `ZipArchive` — two implementations
 * nobody here controls. This reader exists for portability of the field check,
 * not to establish that the format is correct.
 * ---------------------------------------------------------------------------
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054B50;
const CD_SIG = 0x02014B50;

/**
 * Read the central directory — the authoritative index. Reading local headers
 * instead would miss entries that were deleted or rewritten, and would trust
 * data an attacker controls more than the format intends.
 */
export function readZip(buffer) {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // The EOCD sits at the end, after a variable-length comment, so scan back.
  let eocd = -1;
  const limit = Math.max(0, buffer.length - 22 - 0xFFFF);
  for (let i = buffer.length - 22; i >= limit; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');

  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);

  if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) {
    throw new Error('ZIP64 archives are not supported by this verifier');
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== CD_SIG) {
      throw new Error(`central directory entry ${i} is malformed`);
    }
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(buffer.subarray(p + 46, p + 46 + nameLen));

    entries.push({ name, method, crc, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one entry's bytes, following its local header for the true offset. */
export function readEntry(buffer, entry) {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const lo = entry.localOffset;
  if (dv.getUint32(lo, true) !== 0x04034B50) {
    throw new Error(`${entry.name}: local header missing`);
  }
  // The local header's own name/extra lengths are authoritative for the data
  // offset — they may differ from the central directory's extra field.
  const nameLen = dv.getUint16(lo + 26, true);
  const extraLen = dv.getUint16(lo + 28, true);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buffer.subarray(start, start + entry.compSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
}

/* CRC-32, to confirm the extracted bytes are the bytes that were written. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Read every entry, checking each CRC. Returns a name -> bytes map. */
export function extractAll(buffer) {
  const entries = readZip(buffer);
  const files = new Map();
  const corrupt = [];
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;                 // directory marker
    const bytes = readEntry(buffer, e);
    if (bytes.length !== e.size) {
      corrupt.push(`${e.name}: expected ${e.size} bytes, got ${bytes.length}`);
      continue;
    }
    if (crc32(bytes) !== e.crc) {
      corrupt.push(`${e.name}: checksum mismatch`);
      continue;
    }
    files.set(e.name, bytes);
  }
  return { files, entries, corrupt };
}
