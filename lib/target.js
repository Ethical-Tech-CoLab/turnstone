/**
 * target.js — scale and colour references.
 *
 * Implements PHOTOGRAMMETRY-SPEC.md §6.4 and §7.
 *
 * ---------------------------------------------------------------------------
 * WHY A PRINTED TARGET IS THE HIGHEST-VALUE OBJECT IN THE FRAME.
 *
 * A calibrated length in shot satisfies two rubric dimensions at once:
 *
 *   scale-reference        directly, and it is the ONLY dimension that cannot
 *                          be recovered later by any amount of processing;
 *   ground-sample-distance because GSD = known length / pixels spanned, which
 *                          needs no focal length, no sensor size and no
 *                          distance — the three things a phone browser is
 *                          least able to report reliably.
 *
 * Without it a model has shape but no size, and an object with no size cannot
 * be measured, compared against a written description, or matched to an
 * excavation record.
 *
 * PRINT AT 100%, THEN MEASURE WHAT CAME OUT. Consumer printers scale silently:
 * "fit to page" is often the default, and a 4% reduction is invisible to the
 * eye and fatal to the measurement. The nominal length is a starting point; the
 * MEASURED length is what enters the calculation. Plumb learned this the
 * expensive way and the same discipline applies here.
 * ---------------------------------------------------------------------------
 */

/**
 * Known targets.
 *
 * The Plumb calibration card is included deliberately: anyone already doing
 * landmark work has one printed and measured, and a card whose length is
 * already verified is worth more than a fresh print of a better design.
 */
export const KNOWN_TARGETS = {
  'turnstone-mat-a4': {
    id: 'turnstone-mat-a4',
    label: 'Turnstone object mat (A4)',
    nominalMm: 180,
    measureLabel: 'the long scale bar, outer tick to outer tick',
    hasColour: true,
    hasFiducials: true,
    note: 'Object sits on the mat. Fiducials round the perimeter stay visible as you orbit.',
  },
  'turnstone-mat-letter': {
    id: 'turnstone-mat-letter',
    label: 'Turnstone object mat (US Letter)',
    nominalMm: 180,
    measureLabel: 'the long scale bar, outer tick to outer tick',
    hasColour: true,
    hasFiducials: true,
    note: 'Object sits on the mat. Fiducials round the perimeter stay visible as you orbit.',
  },
  'plumb-card': {
    id: 'plumb-card',
    label: 'Plumb calibration card',
    nominalMm: 150,
    measureLabel: 'the WIDTH, saddle 1 to saddle 2',
    hasColour: false,
    hasFiducials: true,
    note: 'Designed for planar work, but its calibrated width is a perfectly good scale reference here. It carries no colour patches, so the colour dimension stays unmet.',
  },
  'ruler': {
    id: 'ruler',
    label: 'A ruler or steel rule',
    nominalMm: 150,
    measureLabel: 'the span you will point at, end to end',
    hasColour: false,
    hasFiducials: false,
    note: 'Works, and is what most conservation labs already have. Lay it in the same plane as the widest part of the object.',
  },
  'none': {
    id: 'none',
    label: 'No scale reference',
    nominalMm: null,
    hasColour: false,
    hasFiducials: false,
    note: 'The model will have shape but no size. It cannot be measured or matched to a record.',
  },
};

/**
 * How far a printed length may differ from nominal before it is suspicious.
 *
 * 2% covers ordinary printer variation and paper humidity. Beyond that the
 * likeliest explanation is "fit to page" scaling, which is worth saying out
 * loud rather than silently accepting — a 94% print produces a model 6% wrong
 * in every dimension, and nothing downstream would ever detect it.
 */
export const PRINT_TOLERANCE = 0.02;

export function checkPrintedLength(targetId, measuredMm) {
  const t = KNOWN_TARGETS[targetId];
  if (!t?.nominalMm || !(measuredMm > 0)) return { ok: null };
  const rel = (measuredMm - t.nominalMm) / t.nominalMm;
  if (Math.abs(rel) <= PRINT_TOLERANCE) {
    return { ok: true, relative: rel, note: 'Printed size matches nominal.' };
  }
  const pct = (rel * 100).toFixed(1);
  return {
    ok: false,
    relative: rel,
    note: `Printed ${pct}% off nominal (${t.nominalMm} mm). That usually means the printer scaled the page — check "Actual size" / 100% and print again. Using the measured value regardless, which is correct, but a scaled print may also be distorted.`,
  };
}

/**
 * Scale state for a session.
 *
 * `scale-reference` is scored 1 for a calibrated physical reference, 0.5 for
 * AR-derived, 0 for absent — and AR can never reach `reference` class, because
 * AR tracking drifts and a reference record's size must come from something
 * physical that was actually in the photograph.
 */
export function scaleReferenceValue({ targetId, measuredMm, arScale = false }) {
  if (targetId && targetId !== 'none' && measuredMm > 0) return 1;
  if (arScale) return 0.5;
  return 0;
}

/**
 * GSD from a measured length spanning a known number of pixels.
 *
 * Measured on the FULL-RESOLUTION frame. The working image exists so that
 * thresholds mean the same thing on every device; this quantity must not be
 * device-independent — it is precisely the resolution of the record.
 */
export function gsdFromSpan(measuredMm, pixelsSpanned) {
  if (!(measuredMm > 0) || !(pixelsSpanned > 0)) return null;
  return measuredMm / pixelsSpanned;
}

/**
 * Estimate the pixel span of the reference from how much of the frame it fills.
 *
 * A stop-gap until per-frame marker detection lands: the operator says roughly
 * what fraction of the frame width the scale bar covers, which is a judgement
 * people make accurately enough for a quantity that then gets reported with its
 * own uncertainty. Flagged as `estimated` so nobody mistakes it for a
 * measurement.
 */
export function spanFromFraction(imageWidthPx, fractionOfWidth) {
  const f = Math.max(0.02, Math.min(1, fractionOfWidth));
  return imageWidthPx * f;
}

/**
 * Detect a high-contrast scale bar along a scan line.
 *
 * Deliberately simple and deliberately honest about it. Full fiducial decoding
 * is a larger job; what this does is find the outermost strong edges along a
 * horizontal band, which is enough to measure a black bar on white paper lying
 * flat and square to the camera.
 *
 * Returns null rather than a guess when the evidence is weak. A wrong scale is
 * far worse than no scale: no scale is visible in the record as
 * `scale-reference: none`, whereas a wrong one silently rescales every
 * measurement that will ever be taken from the model.
 */
export function findScaleBarSpan(luma, width, height, { band = 0.15, minContrast = 60 } = {}) {
  const y0 = Math.floor(height * (0.5 - band / 2));
  const y1 = Math.ceil(height * (0.5 + band / 2));
  const rows = [];

  for (let y = y0; y < y1; y++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = 0; x < width; x++) {
      const v = luma[y * width + x];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo < minContrast) continue;

    const threshold = (hi + lo) / 2;
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x++) {
      if (luma[y * width + x] < threshold) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0 && last > first) rows.push(last - first + 1);
  }

  if (rows.length < 3) return null;

  rows.sort((a, b) => a - b);
  const median = rows[rows.length >> 1];

  // Rows should agree. Wide disagreement means the scan line crossed the object
  // or the background rather than a bar, and the span means nothing.
  const spread = (rows[rows.length - 1] - rows[0]) / median;
  if (spread > 0.25) return null;

  return { spanPx: median, rowsAgreeing: rows.length, spread };
}
