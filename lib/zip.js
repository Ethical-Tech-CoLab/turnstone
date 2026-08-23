/**
 * zip.js — a minimal, dependency-free ZIP writer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS.
 *
 * The photographs are the archive; the mesh is a derived artefact that can be
 * regenerated with better software in ten years. So a capture tool that cannot
 * hand the operator their photographs has not finished the job — and browser
 * storage is not an archive. It is evicted under pressure, wiped by "clear
 * browsing data", and lives at a path no contributor could find or interpret.
 *
 * STORE, NOT DEFLATE. JPEGs are already entropy-coded; deflating them costs CPU
 * on a phone and saves a percent or two. Storing them also means the bytes in
 * the archive are byte-identical to the bytes the camera produced, which is the
 * property the provenance chain depends on.
 *
 * BLOB-BASED, NOT BUFFER-BASED. A reference session can be hundreds of
 * megabytes. Concatenating ArrayBuffers would hold all of it in memory at once
 * and kill the tab on a phone. Assembling the archive from Blob parts lets the
 * browser keep the payload backed by disk and copy it out lazily, so peak
 * memory stays near one frame rather than the whole session.
 * ---------------------------------------------------------------------------
 */

/* CRC-32, table built once. Required by the format; there is no way to omit it. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** CRC a Blob in chunks, so a large file never lands in memory whole. */
export async function crc32Blob(blob, chunkSize = 1 << 20) {
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const slice = blob.slice(offset, Math.min(offset + chunkSize, blob.size));
    const buf = new Uint8Array(await slice.arrayBuffer());
    // Continue the running CRC rather than restarting per chunk.
    let c = (crc ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    crc = (c ^ 0xFFFFFFFF) >>> 0;
  }
  return crc;
}

const enc = new TextEncoder();

function dosDateTime(date) {
  const d = date ?? new Date();
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const dt = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, dt };
}

function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
function u16(view, offset, value) { view.setUint16(offset, value & 0xFFFF, true); }

/**
 * Build a ZIP from `[{ name, blob | text, date }]`.
 *
 * Returns a Blob. Entry order is preserved, which matters: the manifest is
 * placed first so anyone opening the archive sees what it is before wading
 * through several hundred photographs.
 */
export async function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const blob = entry.blob ?? new Blob([entry.text ?? ''], { type: 'text/plain' });
    const size = blob.size;
    const crc = await crc32Blob(blob);
    const { time, dt } = dosDateTime(entry.date);

    const local = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(local);
    u32(lv, 0, 0x04034B50);      // local file header signature
    u16(lv, 4, 20);              // version needed (2.0 = store/deflate)
    u16(lv, 6, 0x0800);          // UTF-8 filename flag
    u16(lv, 8, 0);               // method 0 = STORE
    u16(lv, 10, time);
    u16(lv, 12, dt);
    u32(lv, 14, crc);
    u32(lv, 18, size);           // compressed size
    u32(lv, 22, size);           // uncompressed size
    u16(lv, 26, nameBytes.length);
    u16(lv, 28, 0);              // extra field length
    new Uint8Array(local, 30).set(nameBytes);

    parts.push(local, blob);

    const cd = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(cd);
    u32(cv, 0, 0x02014B50);      // central directory signature
    u16(cv, 4, 20);              // version made by
    u16(cv, 6, 20);              // version needed
    u16(cv, 8, 0x0800);
    u16(cv, 10, 0);
    u16(cv, 12, time);
    u16(cv, 14, dt);
    u32(cv, 16, crc);
    u32(cv, 20, size);
    u32(cv, 24, size);
    u16(cv, 28, nameBytes.length);
    u16(cv, 30, 0);              // extra
    u16(cv, 32, 0);              // comment
    u16(cv, 34, 0);              // disk number
    u16(cv, 36, 0);              // internal attrs
    u32(cv, 38, 0);              // external attrs
    u32(cv, 42, offset);         // offset of local header
    new Uint8Array(cd, 46).set(nameBytes);
    central.push(cd);

    offset += local.byteLength + size;
  }

  const centralSize = central.reduce((n, c) => n + c.byteLength, 0);
  const end = new ArrayBuffer(22);
  const ev = new DataView(end);
  u32(ev, 0, 0x06054B50);        // end of central directory
  u16(ev, 4, 0);
  u16(ev, 6, 0);
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, offset);
  u16(ev, 20, 0);

  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/**
 * The format's hard limits, checked so a session is refused rather than
 * silently truncated. ZIP64 lifts these; we do not implement it because a
 * session that large should be split anyway — a single 4 GB archive is not
 * something a museum can move or verify conveniently.
 */
export const ZIP_MAX_ENTRIES = 0xFFFF;
export const ZIP_MAX_BYTES = 0xFFFFFFFF;

export function checkZipLimits(entryCount, totalBytes) {
  if (entryCount > ZIP_MAX_ENTRIES) {
    return { ok: false, reason: `${entryCount} files exceeds the ${ZIP_MAX_ENTRIES} limit of this archive format. Export in parts.` };
  }
  if (totalBytes > ZIP_MAX_BYTES) {
    return { ok: false, reason: `${(totalBytes / 1e9).toFixed(1)} GB exceeds the 4 GB limit of this archive format. Export in parts.` };
  }
  return { ok: true };
}
