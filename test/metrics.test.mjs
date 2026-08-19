/**
 * Tests for the metric extractors — PHOTOGRAMMETRY-SPEC.md §6.
 *
 * Every assertion is against a frame whose correct answer is known by
 * construction, not against a photograph whose true sharpness nobody knows.
 *
 * Run: node --test test/metrics.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toLuma, workingScale, varianceOfLaplacian, judgeSharpness, median, iqr,
  clippingFraction, gsdFromScale, gsdFromOptics, crossCheckGsd, gsdRequiredFor,
  azimuthBin, elevationBand, angularCoverage, largestGap,
  surfaceCompletenessEstimate, frameLightingSignature, lightingConsistency,
  deviceMetadataCompleteness, AZIMUTH_BINS,
} from '../lib/metrics.js';
import { noisy, checker, blur, clipPixels, flat, orbit, frameAt } from './fixtures.mjs';

const W = 128, H = 128;

// ------------------------------------------------------------ working image

test('working scale never upscales a small frame', () => {
  assert.equal(workingScale(800, 600), 1);
  assert.equal(workingScale(4032, 3024), 1024 / 4032);
  // Long edge, whichever way the phone was held.
  assert.equal(workingScale(3024, 4032), 1024 / 4032);
});

test('luma uses Rec. 709 weights', () => {
  const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  const y = toLuma(px, 3, 1);
  // Tolerance is float32 ULP, not arbitrary: luma is stored in a Float32Array,
  // where one unit in the last place near 54 is already ~6e-6. A tighter bound
  // would be testing the storage format rather than the coefficients.
  const eps = 1e-4;
  assert.ok(Math.abs(y[0] - 0.2126 * 255) < eps);
  assert.ok(Math.abs(y[1] - 0.7152 * 255) < eps);
  assert.ok(Math.abs(y[2] - 0.0722 * 255) < eps);
});

// ------------------------------------------------------------ 6.1 sharpness

test('blurring a frame always lowers its sharpness score', () => {
  // The property that must hold whatever the frame contains.
  for (const make of [() => noisy(W, H, { seed: 7 }), () => checker(W, H)]) {
    const sharp = make();
    const soft = blur(sharp, W, H, 2);
    const vs = varianceOfLaplacian(toLuma(sharp, W, H), W, H);
    const vb = varianceOfLaplacian(toLuma(soft, W, H), W, H);
    assert.ok(vb < vs, `blur did not reduce VoL (${vb} vs ${vs})`);
  }
});

test('more blur means less sharpness, monotonically', () => {
  const sharp = noisy(W, H, { seed: 3 });
  let last = Infinity;
  for (const r of [0, 1, 2, 3, 4]) {
    const img = r === 0 ? sharp : blur(sharp, W, H, r);
    const v = varianceOfLaplacian(toLuma(img, W, H), W, H);
    assert.ok(v < last, `radius ${r} was not softer than the previous step`);
    last = v;
  }
});

test('a flat frame has essentially zero Laplacian variance', () => {
  assert.ok(varianceOfLaplacian(toLuma(flat(W, H), W, H), W, H) < 1e-9);
});

test('sharpness is content-dependent — which is why the relative rule exists', () => {
  /*
   * A textured surface outscores a smooth one at identical focus. This is the
   * reason R-6.1 requires BOTH an absolute floor and a within-session relative
   * rule: an absolute threshold alone would mark every smooth glazed object
   * blurred, and a relative rule alone could not notice a session in which
   * every frame was soft.
   */
  const textured = varianceOfLaplacian(toLuma(noisy(W, H, { amplitude: 90 }), W, H), W, H);
  const smooth = varianceOfLaplacian(toLuma(noisy(W, H, { amplitude: 6 }), W, H), W, H);
  assert.ok(textured > smooth * 5, 'expected a large content-driven gap');
});

test('a frame far below the session median is suspect; a typical one is not', () => {
  assert.equal(judgeSharpness(300, 300).suspect, false);
  assert.equal(judgeSharpness(290, 300).suspect, false);
  assert.equal(judgeSharpness(50, 300).suspect, true);      // 0.17 of median
  assert.equal(judgeSharpness(130, 300).suspect, false);    // 0.43, just above floor
});

test('with no session median yet, nothing is suspect', () => {
  // The first frame has nothing to be out of step with.
  assert.equal(judgeSharpness(10, 0).suspect, false);
});

test('median and IQR behave', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(iqr([1, 2, 3, 4, 5]), 2);
  assert.equal(iqr([1, 2]), 0);            // too few to judge spread
});

// ------------------------------------------------------------ 6.2 exposure

test('clipping fraction matches the fraction actually clipped', () => {
  const img = clipPixels(flat(W, H, 128), W, H, { fraction: 0.10, value: 255 });
  const c = clippingFraction(img, W, H);
  assert.ok(Math.abs(c.worst - 0.10) < 0.005, `expected ~10%, got ${c.worst}`);
});

test('a clean mid-grey frame reports no clipping', () => {
  assert.equal(clippingFraction(flat(W, H, 128), W, H).worst, 0);
});

test('crushed blacks count as clipped, not just blown highlights', () => {
  const img = clipPixels(flat(W, H, 128), W, H, { fraction: 0.08, value: 0 });
  assert.ok(Math.abs(clippingFraction(img, W, H).worst - 0.08) < 0.005);
});

test('a blown single channel is caught even though luma looks fine', () => {
  /*
   * The terracotta case. Red contributes only 0.2126 to luma, so a fully blown
   * red channel barely moves it — while the surface it sits on is already
   * unrecoverable. Reporting luma alone would call this capture clean.
   */
  const img = clipPixels(flat(W, H, 120), W, H, { fraction: 0.25, value: 255, channels: [0] });
  const c = clippingFraction(img, W, H);
  assert.ok(c.luma < 0.01, `luma should barely notice, saw ${c.luma}`);
  assert.ok(Math.abs(c.perChannel[0] - 0.25) < 0.005, 'red channel should report 25%');
  assert.ok(Math.abs(c.worst - 0.25) < 0.005, 'worst channel must be reported');
  assert.equal(c.worstChannel, 'red');
});

// ------------------------------------------------------------ 6.4 GSD

test('GSD from a scale reference is length over pixels', () => {
  assert.equal(gsdFromScale(150, 1500), 0.1);
  assert.equal(gsdFromScale(0, 1500), null);
  assert.equal(gsdFromScale(150, 0), null);
});

test('GSD from optics uses distance, pitch and focal length', () => {
  // 1000 mm away, 0.0008 mm pixels, 5 mm lens -> 0.16 mm/px
  assert.ok(Math.abs(gsdFromOptics(1000, 0.0008, 5) - 0.16) < 1e-9);
});

test('the GSD cross-check catches a mis-scaled print', () => {
  assert.equal(crossCheckGsd(0.20, 0.205).agree, true);
  // A target printed at 94% - the classic silent failure - shows up here.
  const bad = crossCheckGsd(0.20, 0.26);
  assert.equal(bad.agree, false);
  assert.match(bad.reason, /focal length|re-measure/);
  assert.equal(crossCheckGsd(0.2, null).agree, null);
});

test('normalised GSD thresholds invert to the mm/px an operator can act on', () => {
  assert.ok(Math.abs(gsdRequiredFor(0.75) - 0.2340) < 0.001);
  assert.ok(Math.abs(gsdRequiredFor(0.5) - 0.5477) < 0.001);
  assert.ok(Math.abs(gsdRequiredFor(0.25) - 1.2819) < 0.001);
});

// ------------------------------------------------------ 6.5 angular coverage

test('azimuth bins wrap correctly', () => {
  assert.equal(azimuthBin(0), 0);
  assert.equal(azimuthBin(14.9), 0);
  assert.equal(azimuthBin(15), 1);
  assert.equal(azimuthBin(359), 23);
  assert.equal(azimuthBin(360), 0);
  assert.equal(azimuthBin(-15), 23);      // negative headings must not crash
});

test('elevation bands cover the sphere from below to top', () => {
  assert.equal(elevationBand(-45).id, 'below');
  assert.equal(elevationBand(0).id, 'eye');
  assert.equal(elevationBand(35).id, 'above');
  assert.equal(elevationBand(75).id, 'top');
  assert.equal(elevationBand(90).id, 'top');
  assert.equal(elevationBand(-80), null);   // outside any band, explicitly
});

test('one full orbit at eye level is only half of what study needs', () => {
  // study wants eye AND above. One orbit fills eye completely and above not at all.
  const c = angularCoverage(orbit(AZIMUTH_BINS, 0), 'study');
  assert.ok(Math.abs(c.coverage - 0.5) < 1e-9, `got ${c.coverage}`);
  assert.equal(c.perBand.eye.fraction, 1);
  assert.equal(c.perBand.above.fraction, 0);
});

test('two orbits at the right elevations satisfy study completely', () => {
  const c = angularCoverage([...orbit(AZIMUTH_BINS, 0), ...orbit(AZIMUTH_BINS, 35)], 'study');
  assert.equal(c.coverage, 1);
});

test('reference demands four bands, so the same two orbits fall short', () => {
  const c = angularCoverage([...orbit(AZIMUTH_BINS, 0), ...orbit(AZIMUTH_BINS, 35)], 'reference');
  assert.ok(Math.abs(c.coverage - 0.5) < 1e-9, `got ${c.coverage}`);
});

test('a blurred frame does not fill a coverage bin', () => {
  /*
   * Otherwise the system reports the one thing the operator most needs to know
   * — go back and reshoot that sector — as already done.
   */
  const frames = orbit(AZIMUTH_BINS, 0);
  frames[5].suspect = true;
  const c = angularCoverage(frames, 'study');
  assert.equal(c.perBand.eye.fraction, (AZIMUTH_BINS - 1) / AZIMUTH_BINS);
});

test('coverage ignores frames with no pose rather than crediting them', () => {
  const frames = [...orbit(4, 0), frameAt(null, null)];
  const c = angularCoverage(frames, 'study');
  assert.equal(c.perBand.eye.visited.length, 4);
});

test('the largest gap is found, including one that wraps past zero', () => {
  // Visited everything except bins 22, 23, 0, 1 - a gap straddling north.
  const visited = [];
  for (let i = 2; i <= 21; i++) visited.push(i);
  const g = largestGap(visited);
  assert.equal(g.length, 4);
  assert.equal(g.start, 22);

  assert.equal(largestGap([...Array(AZIMUTH_BINS).keys()]), null);   // nothing missing
  assert.equal(largestGap([]).length, AZIMUTH_BINS);                 // nothing visited
});

// ------------------------------------------- 6.6 surface completeness (OQ-1)

test('surface completeness is always labelled an estimate', () => {
  const s = surfaceCompletenessEstimate(orbit(24, 0));
  assert.equal(s.isEstimate, true);
  assert.match(s.note, /cannot be judged before reconstruction/i);
});

test('a sector seen once is not counted as complete', () => {
  // Three observations required: one glancing look at a surface is not a record.
  const frames = [frameAt(0, 0), frameAt(1, 0)];
  assert.equal(surfaceCompletenessEstimate(frames).estimate, 0);
  const more = [frameAt(0, 0), frameAt(1, 0), frameAt(2, 0)];
  assert.ok(surfaceCompletenessEstimate(more).estimate > 0);
});

// --------------------------------------------------- 6.7 lighting consistency

test('a stable session scores high; a drifting one scores low', () => {
  const steady = Array.from({ length: 12 }, () => ({ luma: 128, r: 0.333, b: 0.333 }));
  assert.ok(lightingConsistency(steady).consistency > 0.99);

  const drifting = Array.from({ length: 12 }, (_, i) => ({ luma: 40 + i * 15, r: 0.333, b: 0.333 }));
  assert.ok(lightingConsistency(drifting).consistency < 0.5);
});

test('one frame shot into a window does not condemn the session', () => {
  /*
   * The reason this uses IQR rather than variance. A single outlier is a fact
   * about one frame; variance would let it rewrite the verdict on all of them.
   */
  const s = Array.from({ length: 20 }, () => ({ luma: 128, r: 0.333, b: 0.333 }));
  s[7] = { luma: 250, r: 0.4, b: 0.28 };
  assert.ok(lightingConsistency(s).consistency > 0.95);
});

test('too few frames yields null, never a confident answer', () => {
  const r = lightingConsistency([{ luma: 100, r: 0.3, b: 0.3 }]);
  assert.equal(r.consistency, null);
  assert.match(r.reason, /not enough frames/);
});

test('lighting signature reads a flat frame as its actual level', () => {
  const sig = frameLightingSignature(flat(W, H, 100), W, H);
  assert.ok(Math.abs(sig.luma - 100) < 1);
  assert.ok(Math.abs(sig.r - 1 / 3) < 0.01);
});

// ----------------------------------------------------- 6.10 device metadata

test('metadata completeness is the fraction of frames retaining it', () => {
  const frames = [
    frameAt(0, 0),
    frameAt(15, 0),
    frameAt(30, 0, { focalLengthMm: null }),   // stripped, as a messaging app would
    frameAt(45, 0, { sensorWidthMm: null }),
  ];
  assert.equal(deviceMetadataCompleteness(frames), 0.5);
  assert.equal(deviceMetadataCompleteness([]), 0);
});

// ------------------------------------------------------------------- masking

test('a mask confines a metric to the object', () => {
  /*
   * Measuring sharpness over a cluttered background rates the room, not the
   * object — and a museum background is often busier than the artefact.
   */
  const img = flat(W, H, 128);
  const noise = noisy(W, H, { seed: 5 });
  // Left half object (flat), right half busy background.
  for (let y = 0; y < H; y++) {
    for (let x = W / 2; x < W; x++) {
      const p = (y * W + x) * 4;
      img[p] = noise[p]; img[p + 1] = noise[p + 1]; img[p + 2] = noise[p + 2];
    }
  }
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) mask[y * W + x] = 1;

  const masked = varianceOfLaplacian(toLuma(img, W, H), W, H, mask);
  const unmasked = varianceOfLaplacian(toLuma(img, W, H), W, H);
  assert.ok(masked < 1e-6, `object region is flat, expected ~0, got ${masked}`);
  assert.ok(unmasked > 100, 'unmasked should be dominated by the background');
});

test('the silhouette edge does not leak into a masked measurement', () => {
  /*
   * Found by the test above failing at 41.3 instead of 0.
   *
   * The object/background boundary is an occlusion edge: the strongest gradient
   * in the frame, and strong whether or not the object's surface is in focus. A
   * mask that only tested the centre pixel let the Laplacian kernel read across
   * it, so a blurred object shot against a contrasty backdrop scored as sharp —
   * and scored differently against a different backdrop. The whole kernel
   * footprint must be interior to the mask.
   *
   * Constructed so the leak, if present, is the ONLY thing that could register:
   * the object is perfectly flat, so its true interior sharpness is exactly 0.
   */
  const img = flat(W, H, 30);                    // dark, flat object everywhere
  for (let y = 0; y < H; y++) {                  // bright background right half
    for (let x = W / 2; x < W; x++) {
      const p = (y * W + x) * 4;
      img[p] = 250; img[p + 1] = 250; img[p + 2] = 250;
    }
  }
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) mask[y * W + x] = 1;

  const v = varianceOfLaplacian(toLuma(img, W, H), W, H, mask);
  assert.ok(v < 1e-6, `silhouette edge leaked into the measurement: ${v}`);

  // And the edge really is there to leak — the unmasked frame sees it plainly.
  assert.ok(varianceOfLaplacian(toLuma(img, W, H), W, H) > 100);
});

test('a one-pixel-wide mask yields no measurable interior, not a false reading', () => {
  // Every pixel of a 1px sliver has a neighbour outside the mask, so there is
  // no interior to measure. Zero is the honest answer; a number would not be.
  const img = noisy(W, H, { seed: 11 });
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) mask[y * W + 64] = 1;
  assert.equal(varianceOfLaplacian(toLuma(img, W, H), W, H, mask), 0);
});
