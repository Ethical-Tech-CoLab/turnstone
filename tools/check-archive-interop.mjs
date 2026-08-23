/**
 * check-archive-interop.mjs — open our archive with somebody else's code.
 *
 * ---------------------------------------------------------------------------
 * Verifying our own ZIP with our own reader proves that two bugs agree. The
 * package is meant to be opened years from now by Windows Explorer, macOS
 * Archive Utility, or a Python script on a museum's server — none of which we
 * control, and none of which will forgive a malformed central directory.
 *
 * So this writes a realistic package with `lib/zip.js` and reads it back with
 * Python's `zipfile`, which is an independent implementation that also
 * validates every CRC. If Python can open it and the checksums match, the
 * format is right.
 * ---------------------------------------------------------------------------
 */
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { makeZip } from '../lib/zip.js';

const dir = mkdtempSync(join(tmpdir(), 'turnstone-interop-'));
const zipPath = join(dir, 'session.zip');
let failures = 0;

const expect = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

try {
  // A package shaped like a real one: metadata, then photographs with the
  // awkward cases — a unicode subject name and a byte pattern that includes
  // the ZIP signature itself, which naive readers mistake for a header.
  const images = Array.from({ length: 8 }, (_, i) => {
    const bytes = new Uint8Array(60_000);
    bytes[0] = 0xFF; bytes[1] = 0xD8; bytes[2] = 0xFF; bytes[3] = 0xE1;
    for (let j = 4; j < bytes.length; j++) bytes[j] = (i * 29 + j * 7) & 0xFF;
    bytes.set([0x50, 0x4B, 0x03, 0x04], 1000);       // a false local header
    bytes.set([0x50, 0x4B, 0x05, 0x06], 2000);       // a false EOCD
    return { name: `images/frame-${String(i).padStart(4, '0')}.jpg`, blob: new Blob([bytes]) };
  });

  const sums = [];
  for (const img of images) {
    const buf = Buffer.from(await img.blob.arrayBuffer());
    sums.push(`${createHash('sha256').update(buf).digest('hex')}  ${img.name}`);
  }

  const zip = await makeZip([
    { name: 'manifest.json', text: JSON.stringify({ format: 'turnstone-session/1', subject: 'Bura askos — café' }) },
    { name: 'README.txt', text: 'The photographs are the archive.' },
    { name: 'SHA256SUMS.txt', text: sums.join('\n') + '\n' },
    ...images,
  ]);
  writeFileSync(zipPath, Buffer.from(await zip.arrayBuffer()));
  console.log(`\n  wrote ${(zip.size / 1024).toFixed(0)} KB, 11 entries\n`);

  const script = `
import zipfile, hashlib, json, sys
p = ${JSON.stringify(zipPath)}
try:
    z = zipfile.ZipFile(p)
except Exception as e:
    print("OPEN_FAILED", type(e).__name__, e); sys.exit(0)
bad = z.testzip()
names = z.namelist()
sums = {}
for line in z.read("SHA256SUMS.txt").decode().splitlines():
    if line.strip():
        h, n = line.split(None, 1)
        sums[n.strip()] = h
mismatch = 0
for n, h in sums.items():
    if hashlib.sha256(z.read(n)).hexdigest() != h:
        mismatch += 1
m = json.loads(z.read("manifest.json").decode("utf-8"))
print(json.dumps({
    "opened": True,
    "crc_ok": bad is None,
    "entries": len(names),
    "first": names[0],
    "images": sum(1 for n in names if n.startswith("images/")),
    "sha_mismatch": mismatch,
    "unicode_ok": m["subject"] == "Bura askos — café",
    "stored": all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()),
    "sizes_ok": all(len(z.read(i.filename)) == i.file_size for i in z.infolist()),
}))
`;
  const out = execFileSync('python', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const line = out.trim().split('\n').pop();

  if (line.startsWith('OPEN_FAILED')) {
    expect('Python zipfile opens the archive', false, line);
  } else {
    const r = JSON.parse(line);
    expect('Python zipfile opens the archive', r.opened === true);
    expect('every CRC validates independently', r.crc_ok === true);
    expect('all 11 entries are present', r.entries === 11, `${r.entries}`);
    expect('the manifest is the first entry', r.first === 'manifest.json', r.first);
    expect('all 8 photographs are present', r.images === 8, `${r.images}`);
    expect('every SHA-256 matches after extraction', r.sha_mismatch === 0, `${r.sha_mismatch} mismatched`);
    expect('unicode survives the round trip', r.unicode_ok === true);
    expect('entries are STORED, so bytes are unchanged', r.stored === true);
    expect('extracted sizes match the recorded sizes', r.sizes_ok === true);
  }

  // And our own reader must agree with Python, or the verifier is lying.
  const { extractAll } = await import('./unzip.mjs');
  const { readFileSync } = await import('node:fs');
  const mine = extractAll(readFileSync(zipPath));
  expect('our reader agrees on entry count', mine.files.size === 11, `${mine.files.size}`);
  expect('our reader finds no corruption', mine.corrupt.length === 0, mine.corrupt.join('; '));
} catch (err) {
  failures++;
  console.log(`  FAIL  interop check threw: ${err.message}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ }
}

console.log(failures === 0 ? '\n  Archives are readable by independent tools.\n' : `\n  ${failures} interop check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
