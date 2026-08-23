/**
 * C-7 · the module boundary (R-10.3).
 *
 * ---------------------------------------------------------------------------
 * Turnstone must never compute, import or expose anything resembling
 * PROVENANCE CONFIDENCE.
 *
 * The reason is not tidiness. If capture quality fed provenance confidence,
 * then an institution with a good imaging department and no documentation would
 * outscore a community with thorough records and a phone — and it would happen
 * invisibly, inside a number nobody could argue with. The bias would look like
 * measurement.
 *
 * DPA enforces the same separation in its own codebase (`@dpa/capture` may not
 * import `@dpa/assess`). This is the mirror of that test, and it is checked
 * mechanically rather than trusted to reviewers, because the pressure to
 * combine them is constant and reasonable-sounding: someone will eventually
 * observe that a reference-grade capture "obviously" says something about how
 * seriously an object is documented. It does not.
 * ---------------------------------------------------------------------------
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Names that would mean this boundary had been crossed. */
const FORBIDDEN = [
  /\bprovenanceConfidence\b/i,
  /\bprovenance[_-]?score\b/i,
  /\blegitimacyScore\b/i,
  /\bownershipConfidence\b/i,
  /\btitleConfidence\b/i,
  /\bacquisitionScore\b/i,
  /\bassessProvenance\b/i,
  /@dpa\/assess/,
];

function sourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    // Scratch and generated directories are not source. Scanning the extracted
    // session packages under .testdata also made this test take 14 seconds.
    if (['node_modules', '.git', 'research', 'docs', 'data', '.testdata',
      '.pytest_cache', '__pycache__'].includes(entry)) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) sourceFiles(p, acc);
    else if (['.js', '.mjs', '.py', '.json'].includes(extname(entry))) acc.push(p);
  }
  return acc;
}

test('C-7 · no module computes or imports provenance confidence', () => {
  const offenders = [];
  for (const file of sourceFiles(ROOT)) {
    // This test names the forbidden symbols in order to look for them, so it
    // would otherwise flag itself.
    if (file.endsWith('boundary.test.mjs')) continue;

    const text = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) {
        offenders.push(`${file.slice(ROOT.length)}: ${pattern}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'Turnstone measures how well an object was PHOTOGRAPHED. Nothing here may score how ' +
      'well its ownership is documented — a good imaging department is not evidence of ' +
      'good title, and merging the two hides that behind a number.\n' +
      offenders.join('\n'),
  );
});

test('C-7 · the rubric scores only capture, never custody', async () => {
  const rubric = JSON.parse(
    readFileSync(new URL('../rubric/heritage-v1.json', import.meta.url), 'utf8'),
  );

  // Every dimension must be something a camera can observe about an object in
  // front of it, not something about the object's history.
  const custody = /provenance|ownership|title|acquisition|legitima|export|excavat/i;
  const offending = rubric.dimensions.filter(
    (d) => custody.test(d.id) || custody.test(d.label) || custody.test(d.unit ?? ''),
  );
  assert.deepEqual(offending.map((d) => d.id), []);
});

test('C-7 · the record separates observation from legitimacy in words too', async () => {
  const { buildRecord, loadDisclaimers } = await import('../lib/record.js');
  const disclaimers = loadDisclaimers(
    readFileSync(new URL('../record/disclaimers-v1.json', import.meta.url), 'utf8'),
  );
  const record = buildRecord(disclaimers, {
    sessionId: 's',
    quality: { class: 'reference', score: 100 },
  });

  // A reference-grade capture is the strongest thing this system can say, and
  // the record must still state plainly that it says nothing about title.
  assert.equal(record.quality.class, 'reference');
  assert.match(record.doesNotAttest, /Capture quality and provenance legitimacy are unrelated/);

  const flat = JSON.stringify(record);
  for (const pattern of [/provenanceConfidence/i, /legitimacyScore/i]) {
    assert.ok(!pattern.test(flat), `record exposes ${pattern}`);
  }
});
