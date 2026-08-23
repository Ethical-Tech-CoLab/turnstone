/**
 * The ReconstructionBinding: C-6.
 *
 * C-6 is the one that matters. `chainComplete` must be true only when EVERY
 * source image carried a verifiable seal — because a chain that is 90% sealed
 * is not 90% of a proof. The unsealed 10% is exactly where a substituted
 * photograph would be inserted, since an attacker picks where to attack rather
 * than spreading tampering evenly to keep a percentage looking respectable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  buildBinding,
  canonicalise,
  checkBindingConsistency,
  sourceSetHash,
  VIEW_ORDER,
} from '../lib/binding.js';
import { loadDisclaimers } from '../lib/record.js';
import {
  dHash,
  toGrayscale,
  hammingDistance,
  perceptualSimilarity,
  combineViewHashes,
} from '../lib/phash.js';

const disclaimers = loadDisclaimers(
  readFileSync(new URL('../record/disclaimers-v1.json', import.meta.url), 'utf8'),
);

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

function images(total, sealed) {
  return Array.from({ length: total }, (_, i) => ({
    name: `f${i}.jpg`,
    sha256: sha256Hex(`image-${i}`),
    sealed: i < sealed,
  }));
}

function binding(total, sealed, overrides = {}) {
  return buildBinding({
    sessionId: 's_test',
    jobId: 'j_test',
    sourceSetHash: 'set-hash',
    images: images(total, sealed),
    pipeline: { backend: 'alicevision', version: '2024.1.0', parameters: {} },
    outputHash: 'output-hash',
    chainNote: disclaimers.chainNote,
    ...overrides,
  });
}

test('C-6 · chainComplete is false when any single image is unsealed', () => {
  assert.equal(binding(10, 10).chainComplete, true);

  // One image short, out of a hundred. The temptation is to call this
  // "essentially complete"; the whole point is that it is not.
  assert.equal(binding(100, 99).chainComplete, false);
  assert.equal(binding(10, 9).chainComplete, false);
  assert.equal(binding(10, 0).chainComplete, false);
});

test('C-6 · chainComplete never derives from a rounded fraction', () => {
  const b = binding(1000, 999);
  assert.equal(b.chainComplete, false);
  assert.equal(b.sealedImageCount, 999);
  assert.equal(b.unsealedImageCount, 1);
  // The counts are present for diagnosis, but no field invites a reader to
  // treat 99.9% as assurance.
  assert.equal(typeof b.chainComplete, 'boolean');
  assert.ok(!('sealedFraction' in b), 'a bare fraction would be read as a confidence level');
});

test('C-6 · a seal counts only on an explicit positive claim', () => {
  const ambiguous = [
    { name: 'a.jpg', sealed: true },
    { name: 'b.jpg', sealed: 'true' },
    { name: 'c.jpg' },
    { name: 'd.jpg', sealed: null },
  ];
  const b = buildBinding({
    sessionId: 's', jobId: 'j', sourceSetHash: 'h', images: ambiguous,
    pipeline: { backend: 'colmap' }, outputHash: 'o', chainNote: disclaimers.chainNote,
  });
  assert.equal(b.sealedImageCount, 1, 'only strict true is a seal');
  assert.equal(b.chainComplete, false);
});

test('C-6 · a binding over zero images binds nothing', () => {
  const b = binding(0, 0);
  assert.equal(b.chainComplete, false, 'vacuous truth must not read as a complete chain');
  assert.ok(checkBindingConsistency(b).some((p) => /binds nothing/.test(p)));
});

test('C-6 · consistency check catches a flipped chainComplete', () => {
  // The single field an attacker would most want to flip. It must always be
  // recomputable from the counts sitting beside it.
  const tampered = { ...binding(10, 4), chainComplete: true };
  const problems = checkBindingConsistency(tampered);
  assert.ok(problems.some((p) => /chainComplete is true/.test(p)));

  assert.deepEqual(checkBindingConsistency(binding(10, 10)), []);
});

test('a binding cannot be built without its chainNote', () => {
  // R-9.7. Without it the binding reads as a reproducibility claim, and someone
  // will conclude a record was falsified when it merely was not deterministic.
  assert.throws(() => binding(3, 3, { chainNote: '' }), /cannot be built without its chainNote/);
  assert.throws(() => binding(3, 3, { chainNote: undefined }), /chainNote/);
});

test('the chainNote says plainly that reconstruction is not reproducible', () => {
  const b = binding(3, 3);
  assert.match(b.chainNote, /NOT make the reconstruction reproducible/);
  assert.match(b.chainNote, /not bit-deterministic/);
});

test('a binding needs an output and a pipeline to bind them', () => {
  assert.throws(() => binding(3, 3, { outputHash: '' }), /needs the hash of the output/);
  assert.throws(() => binding(3, 3, { pipeline: {} }), /needs the pipeline/);
});

test('the perceptual hash is labelled as re-association, never as proof', () => {
  const b = binding(3, 3, { outputPerceptualHash: 'abc123' });
  assert.match(b.perceptualHashNote, /NOT evidence of identity/);
  assert.match(b.perceptualHashNote, /not collision-resistant/);
});

test('sourceSetHash does not depend on the order images were listed in', async () => {
  const hashes = ['ccc', 'aaa', 'bbb'];
  const a = await sourceSetHash(hashes, sha256Hex);
  const b = await sourceSetHash([...hashes].reverse(), sha256Hex);
  assert.equal(a, b);

  const different = await sourceSetHash(['aaa', 'bbb', 'ddd'], sha256Hex);
  assert.notEqual(a, different);
});

test('sourceSetHash treats a duplicated frame as one photograph', async () => {
  // Two byte-identical files are one photograph. A package re-exported with an
  // accidental duplicate must bind to the same source set, and must agree with
  // the content hash the job model uses — two different hashes over one set of
  // photographs would be a standing invitation to compare the wrong pair.
  const once = await sourceSetHash(['aaa', 'bbb'], sha256Hex);
  const twice = await sourceSetHash(['aaa', 'bbb', 'aaa'], sha256Hex);
  assert.equal(once, twice);
});

test('canonical bytes are stable under key order and exclude the signature', () => {
  // A signature made by the Python server has to verify in a JavaScript
  // consumer, which only works if both serialise to identical bytes.
  const a = canonicalise({ b: 1, a: 2, nested: { z: 1, y: 2 } });
  const b = canonicalise({ a: 2, nested: { y: 2, z: 1 }, b: 1 });
  assert.equal(a, b);

  const signed = canonicalise({ a: 1, signature: { value: 'deadbeef' } });
  assert.equal(signed, canonicalise({ a: 1 }));
  assert.ok(!signed.includes('deadbeef'), 'a document cannot contain its own signature');
});

// --------------------------------------------------------------- phash

function synthetic(width, height, fn) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = fn(x, y);
  }
  return { width, height, data };
}

test('dHash is stable and 64 bits wide', () => {
  const img = synthetic(64, 64, (x) => (x * 4) % 256);
  const h = dHash(img);
  assert.equal(h.length, 16, '64 bits as hex');
  assert.equal(h, dHash(img), 'the same image must hash the same way twice');
});

test('dHash survives a uniform brightness change', () => {
  // Only the direction of each gradient is kept, which is what makes the hash
  // survive re-exposure and re-encoding.
  const base = synthetic(64, 64, (x, y) => (x * 2 + y) % 200);
  const brighter = synthetic(64, 64, (x, y) => Math.min(255, ((x * 2 + y) % 200) + 40));
  assert.equal(dHash(base), dHash(brighter));
});

test('dHash survives a resolution change', () => {
  // Box-averaged sampling, so two renders of one mesh at different sizes agree.
  // Nearest-neighbour would make the hash depend on which source pixels landed
  // on the sample points.
  const small = synthetic(64, 64, (x, y) => (x * 4 + y * 2) % 256);
  const large = synthetic(256, 256, (x, y) => (x + y / 2) % 256);
  assert.ok(hammingDistance(dHash(small), dHash(large)) <= 8,
    'a resampled render should stay close');
});

test('dHash separates genuinely different images', () => {
  const vertical = synthetic(64, 64, (x) => (x * 4) % 256);
  const horizontal = synthetic(64, 64, (_x, y) => (y * 4) % 256);
  assert.ok(hammingDistance(dHash(vertical), dHash(horizontal)) > 16,
    'perpendicular gradients must not collide');
});

test('grayscale conversion uses Rec. 601 luma', () => {
  // The coefficients matter less than JavaScript and Python using the SAME
  // ones; a cross-language hash check is meaningless otherwise.
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
  const gray = toGrayscale(rgba, 2, 1);
  assert.equal(gray.data[0], Math.round(0.299 * 255));
  assert.equal(gray.data[1], Math.round(0.587 * 255));
});

test('view order is part of the identity', () => {
  const views = Object.fromEntries(VIEW_ORDER.map((v, i) => [v, `${i}`.repeat(16)]));
  const combined = combineViewHashes(views, VIEW_ORDER);
  const reversed = combineViewHashes(views, [...VIEW_ORDER].reverse());
  assert.notEqual(combined, reversed,
    'a hash that sorted its views would call a mesh and its mirror image the same object');

  assert.throws(() => combineViewHashes({ front: 'aa' }, VIEW_ORDER), /missing view hash/);
});

test('similarity is reported as a number, not a verdict', () => {
  const a = 'ffffffffffffffff';
  assert.equal(perceptualSimilarity(a, a), 1);
  assert.equal(perceptualSimilarity(a, '0000000000000000'), 0);
  assert.ok(Math.abs(perceptualSimilarity(a, 'fffffffffffffffe') - 63 / 64) < 1e-9);
  assert.throws(() => hammingDistance('aa', 'aaaa'), /different lengths/);
});
