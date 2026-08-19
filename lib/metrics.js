/**
 * metrics.js — compute capture quality dimensions from actual pixels.
 *
 * This is the gap DPA names in its own §10: "The rubric is defined; nothing
 * computes it from actual photographs yet." Implements PHOTOGRAMMETRY-SPEC.md §6.
 *
 * Dependency-free and environment-agnostic: every function takes plain arrays,
 * never a canvas or an <img>. That keeps the maths testable against synthetic
 * frames whose correct answer is known by construction, and lets the same code
 * run in a browser, in Node, or on a server.
 *
 * ---------------------------------------------------------------------------
 * THE WORKING IMAGE.
 *
 * All metrics are computed on a frame downscaled to WORKING_EDGE on its long
 * side. Fixing the working resolution is what makes a threshold comparable
 * between a 12 MP phone and a 200 MP back — otherwise "variance of Laplacian
 * > 100" silently means something different on every device, and the rubric's
 * bands would be measuring the sensor rather than the photograph.
 * ---------------------------------------------------------------------------
 */

export const WORKING_EDGE = 1024;

/* -------------------------------------------------------------------------- */
/* Luma and working images                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rec. 709 luma from 8-bit RGBA.
 *
 * Deliberately NOT gamma-linearised. These coefficients are defined against
 * gamma-encoded values, which is what a camera hands us and what every published
 * variance-of-Laplacian threshold was measured on. "Correcting" to linear light
 * here would silently move every threshold in the rubric.
 */
export function toLuma(rgba, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
  }
  return out;
}

/** Long-edge scale factor to reach the working resolution. Never upscales. */
export function workingScale(width, height, edge = WORKING_EDGE) {
  const long = Math.max(width, height);
  return long <= edge ? 1 : edge / long;
}

/* -------------------------------------------------------------------------- */
/* 6.1 Sharpness                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Variance of the Laplacian, over an optional mask.
 *
 * Border pixels are skipped rather than edge-clamped: clamping invents a zero
 * second derivative at the frame edge, which drags the variance down by an
 * amount that depends on image size — exactly the device-dependence the working
 * image exists to remove.
 *
 * WHEN MASKED, THE WHOLE KERNEL FOOTPRINT MUST BE INSIDE THE MASK.
 *
 * This is not a technicality. The object's silhouette against its background is
 * an occlusion boundary: the strongest gradient in the frame, and strong
 * regardless of whether the object's surface is in focus. A mask that only
 * tested the centre pixel would let that edge into the variance, so a blurred
 * object photographed against a contrasty background would score as sharp — and
 * would score differently against a different backdrop. Requiring the footprint
 * to be interior measures the object's own texture, which is what "is this
 * surface in focus" actually asks.
 */
export function varianceOfLaplacian(luma, width, height, mask = null) {
  let n = 0;
  let mean = 0;
  let m2 = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask) {
        if (!mask[i]) continue;
        // 4-neighbourhood is the Laplacian's actual footprint.
        if (!mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width]) continue;
      }

      const v =
        luma[i - width] + luma[i - 1] - 4 * luma[i] + luma[i + 1] + luma[i + width];

      // Welford: one pass, and numerically stable for the large sums a
      // full-frame variance accumulates.
      n++;
      const d = v - mean;
      mean += d / n;
      m2 += d * (v - mean);
    }
  }
  return n > 1 ? m2 / n : 0;
}

/**
 * Judge sharpness against BOTH an absolute floor and a within-session relative
 * rule (spec R-6.1).
 *
 * Variance of the Laplacian is content-dependent: a carved, weathered surface
 * scores higher than a smooth glazed one at identical focus. So an absolute
 * threshold alone mis-rates smooth objects as blurred, and a relative rule alone
 * cannot notice that *every* frame was blurred. Neither is sufficient; both
 * together are.
 */
export const RELATIVE_SHARPNESS_FLOOR = 0.4;

export function judgeSharpness(vol, sessionMedian, { relativeFloor = RELATIVE_SHARPNESS_FLOOR } = {}) {
  const relative = sessionMedian > 0 ? vol / sessionMedian : 1;
  return {
    vol,
    relative,
    // `suspect` means "out of step with this session", not "bad in absolute
    // terms". Suspect frames are retained — reconstruction may still use them —
    // but they are excluded from the session median so they cannot drag the
    // reference point down and make themselves look normal.
    suspect: sessionMedian > 0 && relative < relativeFloor,
  };
}

export function median(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Interquartile range. Used for lighting consistency; robust to one bad frame. */
export function iqr(values) {
  if (values.length < 4) return 0;
  const s = Float64Array.from(values).sort();
  const q = (p) => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  return q(0.75) - q(0.25);
}

/* -------------------------------------------------------------------------- */
/* 6.2 Exposure                                                                */
/* -------------------------------------------------------------------------- */

export const CLIP_LOW = 2;
export const CLIP_HIGH = 253;

/**
 * Fraction of clipped pixels, per channel and on luma, reporting the WORST.
 *
 * Per-channel matters: a blown red channel on terracotta is close to invisible
 * in luma — red contributes only 0.2126 — while the surface it sits on is
 * already unrecoverable. Reporting luma alone would call that capture clean.
 */
export function clippingFraction(rgba, width, height, mask = null) {
  let n = 0;
  const clipped = [0, 0, 0, 0];   // r, g, b, luma

  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    if (mask && !mask[i]) continue;
    n++;
    for (let c = 0; c < 3; c++) {
      const v = rgba[p + c];
      if (v <= CLIP_LOW || v >= CLIP_HIGH) clipped[c]++;
    }
    const y = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
    if (y <= CLIP_LOW || y >= CLIP_HIGH) clipped[3]++;
  }

  if (!n) return { worst: 0, perChannel: [0, 0, 0], luma: 0, worstChannel: 'none' };

  const per = clipped.slice(0, 3).map((c) => c / n);
  const lumaFrac = clipped[3] / n;
  const worst = Math.max(...per, lumaFrac);
  const names = ['red', 'green', 'blue'];
  const wi = per.indexOf(Math.max(...per));
  return {
    worst,
    perChannel: per,
    luma: lumaFrac,
    worstChannel: worst === lumaFrac && lumaFrac > Math.max(...per) ? 'luma' : names[wi],
  };
}

/* -------------------------------------------------------------------------- */
/* 6.4 Ground sample distance                                                  */
/* -------------------------------------------------------------------------- */

/**
 * GSD from a scale reference of known length (preferred: needs no intrinsics).
 * Measured on the FULL-RESOLUTION frame — the working image exists for metrics
 * whose thresholds must be device-independent, and this one must not be.
 */
export function gsdFromScale(knownLengthMm, pixelsSpanned) {
  if (!(knownLengthMm > 0) || !(pixelsSpanned > 0)) return null;
  return knownLengthMm / pixelsSpanned;
}

/** GSD from optics. Requires distance and intrinsics; used as a cross-check. */
export function gsdFromOptics(distanceMm, pixelPitchMm, focalLengthMm) {
  if (!(distanceMm > 0) || !(pixelPitchMm > 0) || !(focalLengthMm > 0)) return null;
  return (distanceMm * pixelPitchMm) / focalLengthMm;
}

export const GSD_CROSSCHECK_TOLERANCE = 0.10;

/**
 * Cross-check the two GSD paths (spec R-6.5).
 *
 * Disagreement beyond the tolerance means a wrong focal length or a mis-scaled
 * print — and a mis-scaled print is the failure that otherwise silently rescales
 * the entire model while every other dimension reads perfect. This is the direct
 * analogue of Plumb's hold-out check.
 */
export function crossCheckGsd(measured, optical, tolerance = GSD_CROSSCHECK_TOLERANCE) {
  if (measured == null || optical == null) {
    return { agree: null, reason: 'only one path available' };
  }
  const rel = Math.abs(measured - optical) / measured;
  return {
    agree: rel <= tolerance,
    relativeDifference: rel,
    reason: rel <= tolerance
      ? 'measured and optical GSD agree'
      : 'measured and optical GSD disagree — check the focal length, or re-measure the printed target',
  };
}

/**
 * The GSD each class actually demands, in mm/px.
 *
 * DPA states this dimension as normalised thresholds (0.75 / 0.5 / 0.25), which
 * are not an instruction anybody can act on. These invert logScaleInverse(3,0.1)
 * back into the units an operator works in. 0.25 mm/px reads as excellent and
 * does NOT meet `reference`.
 */
export function gsdRequiredFor(normalisedThreshold, worst = 3.0, best = 0.1) {
  return Math.exp(Math.log(worst) - normalisedThreshold * (Math.log(worst) - Math.log(best)));
}

/* -------------------------------------------------------------------------- */
/* 6.5 Angular coverage                                                        */
/* -------------------------------------------------------------------------- */

export const AZIMUTH_BINS = 24;         // 15° each, matching the overlap step

export const ELEVATION_BANDS = [
  { id: 'below',     min: -60, max: -20, forStudy: false, forReference: true },
  { id: 'eye',       min: -20, max: 20,  forStudy: true,  forReference: true },
  { id: 'above',     min: 20,  max: 60,  forStudy: true,  forReference: true },
  { id: 'top',       min: 60,  max: 90,  forStudy: false, forReference: true },
];

export function azimuthBin(azimuthDeg, bins = AZIMUTH_BINS) {
  const a = ((azimuthDeg % 360) + 360) % 360;
  return Math.floor((a / 360) * bins) % bins;
}

export function elevationBand(elevationDeg) {
  return ELEVATION_BANDS.find((b) => elevationDeg >= b.min && elevationDeg < b.max)
    ?? (elevationDeg >= 90 ? ELEVATION_BANDS[3] : null);
}

/**
 * Which bins have been visited, and what fraction of those required.
 *
 * A `suspect` frame does not count as coverage. A blurred photograph of a
 * surface is not a record of that surface, and letting it fill a bin would
 * report the one thing the operator most needs to know — go back and reshoot
 * that sector — as already done.
 */
export function angularCoverage(frames, targetClass = 'study', bins = AZIMUTH_BINS) {
  const wanted = ELEVATION_BANDS.filter((b) => (targetClass === 'reference' ? b.forReference : b.forStudy));
  const visited = new Map(wanted.map((b) => [b.id, new Set()]));

  for (const f of frames) {
    if (f.suspect) continue;
    if (f.azimuthDeg == null || f.elevationDeg == null) continue;
    const band = elevationBand(f.elevationDeg);
    if (!band || !visited.has(band.id)) continue;
    visited.get(band.id).add(azimuthBin(f.azimuthDeg, bins));
  }

  const required = wanted.length * bins;
  let filled = 0;
  const perBand = {};
  for (const b of wanted) {
    const s = visited.get(b.id);
    perBand[b.id] = { visited: [...s].sort((x, y) => x - y), fraction: s.size / bins };
    filled += s.size;
  }

  return { coverage: required ? filled / required : 0, perBand, bins, targetClass };
}

/**
 * The largest unvisited azimuth run, so guidance can point somewhere specific.
 * "Keep orbiting" is far less useful than "there is a gap behind the object".
 */
export function largestGap(visitedBins, bins = AZIMUTH_BINS) {
  const seen = new Set(visitedBins);
  if (seen.size === 0) return { start: 0, length: bins, centreDeg: 0 };
  if (seen.size === bins) return null;

  let best = { start: 0, length: 0 };
  let run = 0;
  let runStart = 0;
  // Two passes round the circle so a gap spanning bin 0 is measured whole.
  for (let i = 0; i < bins * 2; i++) {
    const b = i % bins;
    if (!seen.has(b)) {
      if (run === 0) runStart = b;
      run++;
      if (run > best.length && run <= bins) best = { start: runStart, length: run };
    } else {
      run = 0;
    }
  }
  const centre = ((best.start + best.length / 2) % bins) * (360 / bins);
  return { ...best, centreDeg: centre };
}

/* -------------------------------------------------------------------------- */
/* 6.6 Surface completeness — ESTIMATE (see OQ-1)                              */
/* -------------------------------------------------------------------------- */

export const SILHOUETTE_SECTORS = 8;
export const OBSERVATIONS_FOR_COMPLETE = 3;

/**
 * A live ESTIMATE, never a measurement.
 *
 * You can orbit an object completely and never see inside a cavity or behind a
 * handle, so this cannot be truly known before reconstruction. It is reported as
 * an estimate and the post-reconstruction value replaces it later.
 *
 * OQ-1: this knowingly contradicts DPA, which marks the dimension
 * liveMeasurable. Deferred to a specific artefact. Until then BOTH values and
 * their difference are recorded (see session.js), so the eventual decision rests
 * on accumulated evidence rather than on argument.
 */
export function surfaceCompletenessEstimate(frames, { sectors = SILHOUETTE_SECTORS } = {}) {
  const counts = new Array(sectors).fill(0);
  for (const f of frames) {
    if (f.suspect || !f.observedSectors) continue;
    for (const s of f.observedSectors) counts[s % sectors]++;
  }
  const complete = counts.filter((c) => c >= OBSERVATIONS_FOR_COMPLETE).length;
  return {
    estimate: complete / sectors,
    isEstimate: true,
    perSector: counts,
    note: 'Live estimate. Cavities and occluded regions cannot be judged before reconstruction.',
  };
}

/* -------------------------------------------------------------------------- */
/* 6.7 Lighting consistency                                                    */
/* -------------------------------------------------------------------------- */

/** Median luma and median chromaticity for one frame. */
export function frameLightingSignature(rgba, width, height, mask = null) {
  const lumas = [];
  const rs = [];
  const bs = [];
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    if (mask && !mask[i]) continue;
    const R = rgba[p], G = rgba[p + 1], B = rgba[p + 2];
    const sum = R + G + B;
    lumas.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    if (sum > 12) {            // chromaticity is meaningless in near-black
      rs.push(R / sum);
      bs.push(B / sum);
    }
  }
  return { luma: median(lumas), r: median(rs), b: median(bs) };
}

export const LIGHTING_TAU_Y = 40;      // luma IQR, 0..255
export const LIGHTING_TAU_C = 0.08;    // chromaticity IQR

/**
 * Stability of lighting across a session.
 *
 * IQR rather than variance, deliberately: one frame shot into a window should
 * not condemn a session that was otherwise lit consistently, and variance would
 * let it.
 */
export function lightingConsistency(signatures, { tauY = LIGHTING_TAU_Y, tauC = LIGHTING_TAU_C } = {}) {
  if (signatures.length < 4) {
    return { consistency: null, reason: 'not enough frames to judge stability' };
  }
  const spreadY = iqr(signatures.map((s) => s.luma)) / tauY;
  const spreadC = (iqr(signatures.map((s) => s.r)) + iqr(signatures.map((s) => s.b))) / 2 / tauC;
  return {
    consistency: Math.max(0, Math.min(1, 1 - (spreadY + spreadC))),
    lumaIqr: iqr(signatures.map((s) => s.luma)),
    chromaIqr: (iqr(signatures.map((s) => s.r)) + iqr(signatures.map((s) => s.b))) / 2,
  };
}

/* -------------------------------------------------------------------------- */
/* 6.10 Device metadata — DEFERRED                                             */
/* -------------------------------------------------------------------------- */

/**
 * Not live-measurable. Exposed so the session can report it as deferred rather
 * than letting silence read as a pass.
 */
export function deviceMetadataCompleteness(frames) {
  if (!frames.length) return 0;
  const complete = frames.filter(
    (f) => f.focalLengthMm != null && f.sensorWidthMm != null && f.azimuthDeg != null,
  ).length;
  return complete / frames.length;
}
