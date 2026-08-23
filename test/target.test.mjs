/**
 * Tests for the scale and colour reference logic.
 *
 * Run: node --test test/target.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_TARGETS, checkPrintedLength, scaleReferenceValue,
  gsdFromSpan, spanFromFraction, findScaleBarSpan, PRINT_TOLERANCE,
} from '../lib/target.js';
import { toLuma } from '../lib/metrics.js';
import { flat } from '../lib/synthetic.js';

test('every known target declares what to measure', () => {
  for (const [id, t] of Object.entries(KNOWN_TARGETS)) {
    assert.equal(t.id, id);
    assert.ok(t.label?.length, `${id} has no label`);
    assert.ok(t.note?.length, `${id} has no note`);
    if (t.nominalMm) assert.ok(t.measureLabel?.length, `${id} says no what to measure`);
  }
});

test('the Plumb card is accepted as a scale reference', () => {
  // Anyone already doing landmark work has one printed and measured, and a
  // card whose length is already verified beats a fresh print of a better one.
  const t = KNOWN_TARGETS['plumb-card'];
  assert.equal(t.nominalMm, 150);
  assert.equal(t.hasColour, false, 'it carries no colour patches, and must say so');
  assert.match(t.note, /colour/i);
});

// ------------------------------------------------------- printed length

test('a print within tolerance is accepted quietly', () => {
  const r = checkPrintedLength('plumb-card', 150.5);
  assert.equal(r.ok, true);
});

test('a scaled print is flagged, and the measured value still used', () => {
  /*
   * A real card measured 137.5 mm against a 150 mm nominal — the printer had
   * scaled the page to about 92%. Silently accepting the nominal would make
   * every measurement from that session 8% wrong, with nothing downstream able
   * to detect it.
   */
  const r = checkPrintedLength('plumb-card', 137.5);
  assert.equal(r.ok, false);
  assert.ok(Math.abs(r.relative - (-0.08333)) < 0.0001);
  assert.match(r.note, /scaled the page/i);
  assert.match(r.note, /Actual size|100%/i, 'should say how to fix it');
  assert.match(r.note, /Using the measured value/i, 'must not imply the capture is unusable');
});

test('the tolerance is loose enough for ordinary printer variation', () => {
  // 2% covers paper humidity and normal drift; beyond that "fit to page" is
  // the likeliest explanation and is worth saying out loud.
  assert.equal(PRINT_TOLERANCE, 0.02);
  assert.equal(checkPrintedLength('plumb-card', 150 * 1.019).ok, true);
  assert.equal(checkPrintedLength('plumb-card', 150 * 1.025).ok, false);
});

test('a target with no nominal length cannot be checked', () => {
  assert.equal(checkPrintedLength('none', 100).ok, null);
  assert.equal(checkPrintedLength('nonexistent', 100).ok, null);
});

// ------------------------------------------------------ scale reference

test('a measured physical reference scores full marks', () => {
  assert.equal(scaleReferenceValue({ targetId: 'plumb-card', measuredMm: 137.5 }), 1);
});

test('AR-derived scale scores half, and can never reach reference class', () => {
  // AR tracking drifts. A reference record's size must come from something
  // physical that was actually in the photograph.
  assert.equal(scaleReferenceValue({ targetId: 'none', arScale: true }), 0.5);
});

test('a target selected but not measured does not count', () => {
  // Choosing a card from a menu is not the same as putting it in the frame and
  // measuring it.
  assert.equal(scaleReferenceValue({ targetId: 'plumb-card', measuredMm: 0 }), 0);
  assert.equal(scaleReferenceValue({ targetId: 'plumb-card' }), 0);
});

test('no reference scores zero', () => {
  assert.equal(scaleReferenceValue({ targetId: 'none' }), 0);
});

// ------------------------------------------------------------------ GSD

test('GSD is measured length over pixels spanned', () => {
  assert.equal(gsdFromSpan(150, 1500), 0.1);
  // The user's actual card: 137.5 mm spanning 1100 px.
  assert.ok(Math.abs(gsdFromSpan(137.5, 1100) - 0.125) < 1e-9);
});

test('a scaled card changes the GSD, which is the whole point', () => {
  // Using nominal 150 where the card is really 137.5 overstates the resolution
  // by 9%, and every distance measured from the model inherits that error.
  const wrong = gsdFromSpan(150, 1100);
  const right = gsdFromSpan(137.5, 1100);
  assert.ok(wrong > right);
  assert.ok(Math.abs(wrong / right - 150 / 137.5) < 1e-9);
});

test('GSD refuses nonsense rather than returning it', () => {
  assert.equal(gsdFromSpan(0, 1000), null);
  assert.equal(gsdFromSpan(150, 0), null);
  assert.equal(gsdFromSpan(-5, 1000), null);
});

test('span from frame fraction is clamped to something physical', () => {
  assert.equal(spanFromFraction(4000, 0.5), 2000);
  assert.equal(spanFromFraction(4000, 2), 4000, 'cannot exceed the frame');
  assert.equal(spanFromFraction(4000, 0), 80, 'cannot be zero');
});

// -------------------------------------------------------- bar detection

test('a dark bar on white paper is found', () => {
  const W = 200, H = 100;
  const img = flat(W, H, 250);
  for (let y = 40; y < 60; y++) {
    for (let x = 30; x < 170; x++) {
      const p = (y * W + x) * 4;
      img[p] = 10; img[p + 1] = 10; img[p + 2] = 10;
    }
  }
  const r = findScaleBarSpan(toLuma(img, W, H), W, H);
  assert.ok(r, 'should find the bar');
  assert.equal(r.spanPx, 140);
});

test('a flat frame yields nothing rather than a guess', () => {
  /*
   * A wrong scale is far worse than no scale. No scale is visible in the record
   * as scale-reference: none; a wrong one silently rescales every measurement
   * anyone will ever take from the model.
   */
  const W = 200, H = 100;
  assert.equal(findScaleBarSpan(toLuma(flat(W, H, 128), W, H), W, H), null);
});

test('rows that disagree are rejected', () => {
  // A scan line crossing the object rather than a bar gives inconsistent
  // spans, and the median of nonsense is still nonsense.
  const W = 200, H = 100;
  const img = flat(W, H, 250);
  for (let y = 40; y < 60; y++) {
    const wedge = (y - 40) * 6;                  // a triangle, not a bar
    for (let x = 30; x < 30 + wedge; x++) {
      const p = (y * W + x) * 4;
      img[p] = 10; img[p + 1] = 10; img[p + 2] = 10;
    }
  }
  assert.equal(findScaleBarSpan(toLuma(img, W, H), W, H), null);
});

test('low contrast is not treated as a bar', () => {
  const W = 200, H = 100;
  const img = flat(W, H, 128);
  for (let y = 40; y < 60; y++) {
    for (let x = 30; x < 170; x++) {
      const p = (y * W + x) * 4;
      img[p] = 118; img[p + 1] = 118; img[p + 2] = 118;   // only 10 levels down
    }
  }
  assert.equal(findScaleBarSpan(toLuma(img, W, H), W, H), null);
});
