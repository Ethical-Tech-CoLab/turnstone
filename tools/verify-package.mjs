/**
 * verify-package.mjs — check a Turnstone session package is complete and sound.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE TOOL.
 *
 * "The export said it worked" is not verification. The failure that matters is
 * a package that looks fine and is missing frames, or carries images that will
 * not decode — and that is discovered months later by whoever tries to
 * reconstruct from it, long after the object has gone back in its case.
 *
 * So this reads the archive with no knowledge of the code that wrote it,
 * recomputes every checksum, and reconciles the manifest against the actual
 * files rather than against its own frame count.
 *
 * Usage: node tools/verify-package.mjs <package.zip|directory>
 * Exit code is non-zero when the package should not be relied upon.
 * ---------------------------------------------------------------------------
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, basename } from 'node:path';
import { extractAll } from './unzip.mjs';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node tools/verify-package.mjs <package.zip|directory>');
  process.exit(2);
}
if (!existsSync(arg)) {
  console.error(`Not found: ${arg}`);
  process.exit(2);
}

let problems = 0;
let warnings = 0;
const fail = (msg) => { problems++; console.log(`  FAIL     ${msg}`); };
const warn = (msg) => { warnings++; console.log(`  WARN     ${msg}`); };
const ok = (msg) => console.log(`  ok       ${msg}`);

console.log(`\nVerifying ${basename(arg)}\n${'='.repeat(58)}`);

/* ---------------------------------------------------------------- reading */

/**
 * Read the package into memory as a name -> bytes map, from either a .zip or
 * an already-extracted directory. No shell, no external extractor: the first
 * version called PowerShell's Expand-Archive and failed on the first real
 * package because the module would not load. A field tool cannot depend on
 * that.
 */
let files = new Map();

if (statSync(arg).isFile() && extname(arg).toLowerCase() === '.zip') {
  let result;
  try {
    result = extractAll(readFileSync(arg));
  } catch (err) {
    fail(`the archive could not be read: ${err.message}`);
    finish();
  }
  files = result.files;
  if (result.corrupt.length) {
    for (const c of result.corrupt) fail(`corrupt entry — ${c}`);
  } else {
    ok(`archive opens; ${files.size} entries, every checksum in the archive verified`);
  }
} else {
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else files.set(`${prefix}${name}`, readFileSync(p));
    }
  };
  walk(arg);
  ok(`directory read; ${files.size} files`);
}

const text = (name) => {
  const b = files.get(name);
  return b ? new TextDecoder('utf-8').decode(b) : null;
};

/* --------------------------------------------------------------- manifest */

const manifestRaw = text('manifest.json');
if (!manifestRaw) {
  fail('no manifest.json — this is not a Turnstone session package');
  finish();
}

let manifest;
try {
  manifest = JSON.parse(manifestRaw);
  ok('manifest.json parses');
} catch (err) {
  fail(`manifest.json is not valid JSON: ${err.message}`);
  finish();
}

if (manifest.format !== 'turnstone-session/1') {
  warn(`unexpected format "${manifest.format}" — this tool understands turnstone-session/1`);
}

console.log(`\n  Subject   ${manifest.session?.subject || '(untitled)'}`);
console.log(`  Session   ${manifest.session?.id}`);
console.log(`  Captured  ${manifest.session?.startedAt}`);
console.log(`  Build     ${manifest.build}\n`);

/* ------------------------------------------------------- the disclaimers */

// These are mandatory. A record without them misrepresents what is known, and
// downstream consumers have no way to supply them after the fact.
if (!manifest.attests) fail('manifest does not state what the record attests');
else ok('states what the record attests');

if (!manifest.doesNotAttest) fail('manifest does not state what the record does NOT attest');
else ok('states what the record does not attest');

if (!manifest.session?.disclosureTier) {
  fail('no disclosure tier — assets must never default to public');
} else {
  const sens = manifest.session.sensitivity;
  const tier = manifest.session.disclosureTier;
  if (sens !== 'ordinary' && tier !== 'source-community') {
    fail(`${sens} material is marked "${tier}" — it must default to source-community`);
  } else {
    ok(`disclosure tier "${tier}" is consistent with "${sens}" material`);
  }
}

/* ------------------------------------------------------------ the images */

const onDisk = [...files.keys()].filter((n) => /^images\/.+\.(jpe?g|png)$/i.test(n)).sort();
const claimed = (manifest.frames ?? []).filter((f) => f.hasImage);
const noImage = (manifest.frames ?? []).filter((f) => !f.hasImage);

console.log('');
if (!manifest.frames?.length) {
  fail('the manifest lists no frames at all');
} else if (onDisk.length === 0) {
  fail(`the manifest claims ${claimed.length} photographs but the package contains none — `
     + 'this is a record of images that are not in it');
} else if (onDisk.length !== claimed.length) {
  fail(`the manifest claims ${claimed.length} photographs but ${onDisk.length} are present`);
} else {
  ok(`${onDisk.length} photographs present, matching the manifest`);
}

if (noImage.length) {
  warn(`${noImage.length} frame(s) were measured but carry no image — usually storage pressure`);
}

/* --------------------------------------------------------------- checksums */

const sumsRaw = text('SHA256SUMS.txt');
if (!sumsRaw) {
  warn('no SHA256SUMS.txt — completeness cannot be checked independently');
} else {
  const sums = new Map();
  for (const line of sumsRaw.split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m) sums.set(m[2].trim(), m[1]);
  }
  ok(`SHA256SUMS.txt lists ${sums.size} file(s)`);

  let mismatched = 0;
  let missing = 0;
  for (const [name, expected] of sums) {
    const bytes = files.get(name);
    if (!bytes) { missing++; continue; }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) mismatched++;
  }
  if (missing) fail(`${missing} checksummed file(s) are absent from the package`);
  if (mismatched) fail(`${mismatched} file(s) do not match their checksum — the package is corrupt`);
  if (!missing && !mismatched && sums.size) ok('every SHA-256 matches — the photographs are intact');
}

/* ------------------------------------------------------- image soundness */

let unreadable = 0;
let tiny = 0;
for (const name of onDisk) {
  const buf = files.get(name);
  const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  if (!isJpeg && !isPng) unreadable++;
  // An image far smaller than its neighbours is the signature of a truncated
  // or empty capture that still produced a file.
  if (buf.length < 1024) tiny++;
}
if (unreadable) fail(`${unreadable} file(s) in images/ are not decodable images`);
else if (onDisk.length) ok('every image has a valid JPEG or PNG header');
if (tiny) fail(`${tiny} image(s) are under 1 KB — almost certainly empty captures`);

/* ---------------------------------------------- manifest / file agreement */

const named = new Set(claimed.map((f) => f.file).filter(Boolean));
if (named.size) {
  const present = new Set(onDisk);
  const orphanManifest = [...named].filter((n) => !present.has(n));
  const orphanFiles = [...present].filter((n) => !named.has(n));
  if (orphanManifest.length) fail(`${orphanManifest.length} frame(s) name a file that is not present: ${orphanManifest.slice(0, 3).join(', ')}`);
  if (orphanFiles.length) warn(`${orphanFiles.length} image(s) are not referenced by any frame`);
  if (!orphanManifest.length && !orphanFiles.length) ok('every frame maps to exactly one file, and vice versa');
} else if (claimed.length) {
  warn('frames do not name their files — this package predates named images');
}

// The recorded byte count should match the file. A mismatch means the manifest
// and the images came from different moments.
let sizeMismatch = 0;
for (const f of claimed) {
  if (!f.file || f.bytes == null) continue;
  const bytes = files.get(f.file);
  if (bytes && bytes.length !== f.bytes) sizeMismatch++;
}
if (sizeMismatch) fail(`${sizeMismatch} image(s) differ in size from what the manifest recorded`);
else if (claimed.some((f) => f.bytes != null)) ok('recorded image sizes match the files');

/* --------------------------------------------------------------- quality */

console.log('');
const q = manifest.quality ?? {};
console.log(`  Class     ${q.class}${q.provisional ? '  (PROVISIONAL)' : ''}`);
console.log(`  Score     ${q.score}/100`);
console.log(`  Limiting  ${q.limitingDimension ?? 'none'}`);
if (q.provisional) {
  console.log(`  Deferred  ${(q.deferred ?? []).join(', ')} — the final class may be lower`);
}

const fullRes = (manifest.frames ?? []).filter((f) => f.fullResolution).length;
if (manifest.frames?.length && fullRes < manifest.frames.length) {
  warn(`${manifest.frames.length - fullRes} frame(s) are preview-resolution, not archival`);
}

const heading = new Set((manifest.frames ?? []).map((f) => f.headingSource));
if (heading.has('none')) warn('some frames have no heading — their coverage contribution is unknown');
if (heading.has('relative')) warn('some headings are relative, not compass-referenced');

/* ------------------------------------------------------------------ done */

finish();

function finish() {
  console.log('');
  if (problems === 0 && warnings === 0) {
    console.log('  PACKAGE IS COMPLETE AND SOUND.\n');
  } else if (problems === 0) {
    console.log(`  Package is usable, with ${warnings} caveat(s) noted above.\n`);
  } else {
    console.log(`  ${problems} PROBLEM(S). Do not rely on this package.\n`);
  }
  process.exit(problems === 0 ? 0 : 1);
}
