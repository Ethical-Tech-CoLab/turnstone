/**
 * Conformance tests — PHOTOGRAMMETRY-SPEC.md §11.
 *
 * Each exists because getting it wrong is plausible, and in most cases because
 * the wrong version would look perfectly reasonable in a demo.
 *
 * Run: node --test turnstone/test/conformance.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { loadRubric, assess, classRank, worstClass, permittedClass } from '../lib/rubric.js';
import { overlapForStep, stepForOverlap, shotsPerOrbit, objectFovDeg } from '../lib/overlap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const rubric = loadRubric(JSON.parse(readFileSync(join(HERE, '..', 'rubric', 'heritage-v1.json'), 'utf8')));

/** A capture that is excellent on every dimension. */
const EXCELLENT = {
  'angular-coverage': 0.97,
  'surface-completeness': 0.98,
  'image-overlap': 0.78,
  sharpness: 320,
  exposure: 0.002,
  // 0.20 mm/px. Note this must beat 0.234 — see the GSD test below; 0.25 mm/px
  // looks excellent and is not, which is exactly the trap that test documents.
  'ground-sample-distance': 0.20,
  'scale-reference': 1,
  'colour-reference': 1,
  'lighting-consistency': 0.93,
  'device-metadata': 0.99,
};

// ---------------------------------------------------------------- C-1

test('C-1 · class is the worst dimension, never the mean', () => {
  const good = assess(rubric, EXCELLENT);
  assert.equal(good.class, 'reference');

  // Nine dimensions flawless, one catastrophic. The mean would still be high;
  // the class must not be.
  const oneBad = assess(rubric, { ...EXCELLENT, sharpness: 5 });
  assert.equal(oneBad.class, 'insufficient');
  assert.equal(oneBad.limitingDimension, 'sharpness');
  assert.ok(oneBad.score > 80, `score should stay high (was ${oneBad.score})`);
});

// ---------------------------------------------------------------- C-2

test('C-2 · a high score may coexist with a low class, deliberately', () => {
  // DPA's own worked example: everything excellent except the scale bar.
  const q = assess(rubric, { ...EXCELLENT, 'scale-reference': 0 });

  assert.ok(q.score > 80, `expected score > 80, got ${q.score}`);
  assert.equal(q.class, 'indicative');
  assert.equal(q.limitingDimension, 'scale-reference');

  // If someone later "simplifies" these into one number, this is what stops them.
});

// ---------------------------------------------------------------- C-3

test('C-3 · an unmeasured dimension is absent, never passing', () => {
  const { 'scale-reference': _omitted, ...withoutScale } = EXCELLENT;
  const q = assess(rubric, withoutScale);

  assert.notEqual(q.class, 'reference');
  assert.ok(q.unmeasured.includes('scale-reference'));

  const dim = q.dimensions.find((d) => d.id === 'scale-reference');
  assert.equal(dim.state, 'unmeasured');
  assert.equal(dim.permits, 'insufficient');
  assert.equal(dim.raw, null);
});

test('C-3b · an unmeasured dimension does not inflate the score', () => {
  // The score averages MEASURED dimensions only. Counting an unmeasured one as
  // zero would punish, and counting it as full would reward, not looking.
  const { sharpness: _s, ...withoutSharpness } = EXCELLENT;
  const partial = assess(rubric, withoutSharpness);
  const full = assess(rubric, EXCELLENT);
  assert.ok(Math.abs(partial.score - full.score) <= 3,
    `score should barely move (${full.score} -> ${partial.score})`);
});

// ---------------------------------------------------------------- C-8

test('C-8 · overlap formula matches the specification table within 0.5deg', () => {
  // Table from PHOTOGRAMMETRY-SPEC.md §6.3.
  const TABLE = [
    { fov: 65, 0.60: 29.5, 0.75: 18.3, 0.80: 14.6 },
    { fov: 45, 0.60: 19.1, 0.75: 11.9, 0.80: 9.5 },
    { fov: 40, 0.60: 16.7, 0.75: 10.4, 0.80: 8.3 },
  ];
  for (const row of TABLE) {
    for (const target of [0.60, 0.75, 0.80]) {
      const step = stepForOverlap(target, row.fov);
      assert.ok(Math.abs(step - row[target]) <= 0.5,
        `fov ${row.fov}, target ${target}: spec says ${row[target]}, computed ${step.toFixed(2)}`);
    }
  }
});

test('C-8b · stepForOverlap inverts overlapForStep exactly', () => {
  for (const fov of [30, 40, 45, 55, 65, 75]) {
    for (const target of [0.5, 0.6, 0.7, 0.75, 0.8, 0.9]) {
      const step = stepForOverlap(target, fov);
      assert.ok(Math.abs(overlapForStep(step, fov) - target) < 1e-9,
        `round trip failed at fov=${fov} target=${target}`);
    }
  }
});

test('C-8c · distance cancels, so overlap is purely angular', () => {
  // The property the whole live-guidance design rests on. If a future change
  // introduced a distance term, this is what would catch it: the function
  // signature simply has nowhere to put one.
  assert.equal(overlapForStep.length, 2);
  assert.equal(stepForOverlap.length, 2);
});

test('C-8d · a 10-15deg step brackets CIPA 60-80% overlap', () => {
  // Reconciles the two rules of thumb that circulate independently.
  for (const fov of [40, 45, 65]) {
    for (const step of [10, 15]) {
      const o = overlapForStep(step, fov);
      assert.ok(o >= 0.60 && o <= 0.90, `fov ${fov} step ${step} gave ${(o * 100).toFixed(1)}%`);
    }
  }
  // And 36 shots/orbit is in the "40-50 photographs for a small object" region
  // once more than one elevation band is captured.
  assert.ok(shotsPerOrbit(0.75, 40) >= 30 && shotsPerOrbit(0.75, 40) <= 40);
});

test('C-8e · objectFovDeg shrinks as the object fills less of the frame', () => {
  const full = objectFovDeg(65, 1.0);
  const half = objectFovDeg(65, 0.5);
  assert.ok(Math.abs(full - 65) < 1e-9);
  assert.ok(half < full);
  // Filling less of the frame means a smaller step is needed for equal overlap.
  assert.ok(stepForOverlap(0.75, half) < stepForOverlap(0.75, full));
});

// ---------------------------------------------------------------- C-9

test('C-9 · heritage-v1 transcribes DPA rubric.ts exactly', () => {
  // Thresholds and normalisation, checked against the values in DPA's source.
  // If DPA changes its numbers, this test must be updated deliberately rather
  // than the drift going unnoticed.
  const EXPECTED = {
    'angular-coverage':       { t: [0.9, 0.75, 0.5],   fn: 'linear',           live: true },
    'surface-completeness':   { t: [0.95, 0.85, 0.6],  fn: 'linear',           live: true },
    'image-overlap':          { t: [0.78, 0.6, 0.4],   fn: 'linear',           live: true },
    sharpness:                { t: [0.7, 0.5, 0.3],    fn: 'logScale',         live: true },
    exposure:                 { t: [0.85, 0.65, 0.4],  fn: 'clippingFraction', live: true },
    'ground-sample-distance': { t: [0.75, 0.5, 0.25],  fn: 'logScaleInverse',  live: true },
    'scale-reference':        { t: [1.0, 0.5, 0.0],    fn: 'linear',           live: true },
    'colour-reference':       { t: [1.0, 0.0, 0.0],    fn: 'linear',           live: true },
    'lighting-consistency':   { t: [0.85, 0.65, 0.4],  fn: 'linear',           live: true },
    'device-metadata':        { t: [0.95, 0.8, 0.5],   fn: 'linear',           live: false },
  };

  assert.equal(rubric.dimensions.length, 10);
  for (const d of rubric.dimensions) {
    const e = EXPECTED[d.id];
    assert.ok(e, `unexpected dimension '${d.id}'`);
    assert.deepEqual(
      [d.thresholds.reference, d.thresholds.study, d.thresholds.indicative], e.t,
      `thresholds drifted on '${d.id}'`);
    assert.equal(d.normalise.fn, e.fn, `normalise drifted on '${d.id}'`);
    assert.equal(d.liveMeasurable, e.live, `liveMeasurable drifted on '${d.id}'`);
  }
});

test('C-9b · exactly one dimension is deferred, and it is device metadata', () => {
  const q = assess(rubric, EXCELLENT);
  assert.deepEqual(q.deferred, ['device-metadata']);
});

test('C-9c · every dimension carries the text a contributor is shown', () => {
  // A dimension that can limit a capture without being able to say why is a
  // dead end for whoever is holding the phone.
  for (const d of rubric.dimensions) {
    assert.ok(d.label?.length, `${d.id} has no label`);
    assert.ok(d.why?.length > 40, `${d.id} has no usable 'why'`);
    assert.ok(d.guidance?.length > 20, `${d.id} has no usable guidance`);
    assert.ok(d.unit?.length, `${d.id} has no unit`);
  }
});

// ---------------------------------------------------------------- R-4.2

test('R-4.2 · a rubric with an unsupported major version is refused', () => {
  assert.throws(() => loadRubric({ ...rubric, schemaVersion: '2.0' }), /Unsupported rubric schemaVersion/);
  // Silently ignoring an unknown dimension would report a pass on a rubric that
  // was never applied.
});

test('R-4.2b · a rubric naming an unknown normaliser is refused at load', () => {
  const broken = { ...rubric, dimensions: [{ ...rubric.dimensions[0], normalise: { fn: 'vibes' } }] };
  assert.throws(() => loadRubric(broken), /Unknown normalise function/);
});

// ---------------------------------------------------------------- ordering

test('class ordering and worstClass behave as an ordered lattice', () => {
  assert.deepEqual(
    ['insufficient', 'indicative', 'study', 'reference'].map(classRank), [0, 1, 2, 3]);
  assert.equal(worstClass('reference', 'indicative'), 'indicative');
  assert.equal(worstClass('study', 'study'), 'study');
});

test('permittedClass respects boundaries exactly at the threshold', () => {
  const d = rubric.dimensions.find((x) => x.id === 'sharpness');
  assert.equal(permittedClass(d, d.thresholds.reference), 'reference');
  assert.equal(permittedClass(d, d.thresholds.reference - 1e-9), 'study');
  assert.equal(permittedClass(d, d.thresholds.indicative - 1e-9), 'insufficient');
});

// ------------------------------------------------------- ar-derived scale

test('C-11 · AR-derived scale can never permit reference', () => {
  // scale-reference is 1.0 for a calibrated bar, 0.5 for AR, 0 for none.
  // AR drift means a reference record's size must come from something physical
  // that was actually in the photograph.
  const arScale = assess(rubric, { ...EXCELLENT, 'scale-reference': 0.5 });
  assert.notEqual(arScale.class, 'reference');
  assert.equal(arScale.class, 'study');
});

// ------------------------------------------------------- derived thresholds

test('the GSD a class actually demands, in mm/px', () => {
  /*
   * `ground-sample-distance` is the one dimension whose threshold is expressed
   * in normalised units that tell an operator nothing. "0.75" is not an
   * instruction; "get within 0.234 mm per pixel" is.
   *
   * These are inverted from DPA's logScaleInverse(3.0, 0.1) and are the numbers
   * the field guide should quote. Pinning them here means a change to the
   * normalisation cannot silently move the real-world requirement.
   *
   * They are also a trap worth knowing: 0.25 mm/px reads as excellent and is
   * NOT good enough for a reference record.
   */
  const need = (cls) => {
    let lo = 0.001, hi = 10;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const q = assess(rubric, { ...EXCELLENT, 'ground-sample-distance': mid });
      const d = q.dimensions.find((x) => x.id === 'ground-sample-distance');
      if (classRank(d.permits) >= classRank(cls)) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  assert.ok(Math.abs(need('reference') - 0.2340) < 0.001, `reference: ${need('reference')}`);
  assert.ok(Math.abs(need('study') - 0.5477) < 0.001, `study: ${need('study')}`);
  assert.ok(Math.abs(need('indicative') - 1.2819) < 0.001, `indicative: ${need('indicative')}`);

  // The trap, asserted directly.
  const looksFine = assess(rubric, { ...EXCELLENT, 'ground-sample-distance': 0.25 });
  assert.equal(looksFine.class, 'study');
  assert.equal(looksFine.limitingDimension, 'ground-sample-distance');
});
