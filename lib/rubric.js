/**
 * rubric.js — load a rubric and score a capture against it.
 *
 * Dependency-free, same posture as Plumb's lib/. The rubric arrives as DATA
 * (see rubric/heritage-v1.json); nothing here knows what a "scale reference"
 * is. That is the point: DPA supplies a heritage rubric, another programme
 * supplies its own, and neither forks this file.
 *
 * Implements PHOTOGRAMMETRY-SPEC.md §4 and §5.
 */

export const CLASS_ORDER = ['insufficient', 'indicative', 'study', 'reference'];

export function classRank(c) {
  return CLASS_ORDER.indexOf(c);
}

export function worstClass(a, b) {
  return classRank(a) <= classRank(b) ? a : b;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * Normalisation functions, transcribed from DPA's rubric.ts.
 *
 * These are referenced by name from the rubric JSON rather than embedded as
 * code, so that a rubric file stays inert data and can never execute.
 */
export const NORMALISERS = {
  linear: ({ floor, ceil }) => (raw) => clamp01((raw - floor) / (ceil - floor)),

  logScale: ({ floor, ceil }) => (raw) =>
    raw <= 0 ? 0 : clamp01((Math.log(raw) - Math.log(floor)) / (Math.log(ceil) - Math.log(floor))),

  /** Lower-is-better, logarithmic. Used for ground sample distance. */
  logScaleInverse: ({ worst, best }) => (raw) =>
    raw <= 0 ? 1 : clamp01((Math.log(worst) - Math.log(raw)) / (Math.log(worst) - Math.log(best))),

  /** Exposure: raw is the fraction of clipped pixels, so less is better. */
  clippingFraction: ({ tolerance }) => (raw) => clamp01(1 - raw / tolerance),
};

export function normaliserFor(dimension) {
  const spec = dimension.normalise;
  const make = NORMALISERS[spec?.fn];
  if (!make) throw new Error(`Unknown normalise function '${spec?.fn}' on '${dimension.id}'`);
  return make(spec);
}

/** The highest class a normalised value permits. */
export function permittedClass(dimension, value) {
  const t = dimension.thresholds;
  if (value >= t.reference) return 'reference';
  if (value >= t.study) return 'study';
  if (value >= t.indicative) return 'indicative';
  return 'insufficient';
}

export function loadRubric(json) {
  const major = String(json.schemaVersion ?? '').split('.')[0];
  if (major !== '1') {
    // Ignoring an unrecognised dimension would report a pass on a rubric that
    // was never actually applied. Refusing is the only honest option.
    throw new Error(`Unsupported rubric schemaVersion '${json.schemaVersion}'; this build implements 1.x`);
  }
  for (const d of json.dimensions) normaliserFor(d);   // fail fast on a bad rubric
  return json;
}

/**
 * Score a set of raw measurements.
 *
 * `measurements` maps dimension id -> raw value. A dimension that is absent is
 * treated as UNMEASURED, which is not the same as failing and is emphatically
 * not the same as passing (spec R-5.6).
 */
export function assess(rubric, measurements) {
  const dimensions = rubric.dimensions.map((d) => {
    const raw = measurements[d.id];
    if (raw === undefined || raw === null || Number.isNaN(raw)) {
      return {
        id: d.id,
        label: d.label,
        state: 'unmeasured',
        raw: null,
        value: 0,
        permits: 'insufficient',
        liveMeasurable: d.liveMeasurable,
      };
    }
    const value = normaliserFor(d)(raw);
    return {
      id: d.id,
      label: d.label,
      state: 'measured',
      raw,
      value,
      permits: permittedClass(d, value),
      liveMeasurable: d.liveMeasurable,
    };
  });

  // The class is the WORST dimension, not the average. Four hundred photographs
  // that are all out of focus produce an out-of-focus mesh, and no amount of
  // excellent angular coverage buys that back.
  let cls = 'reference';
  for (const d of dimensions) cls = worstClass(cls, d.permits);

  // The limiting dimension: lowest permitted class, then lowest normalised
  // value. There is always exactly one thing worth fixing next.
  const limiting = dimensions
    .slice()
    .sort((a, b) => classRank(a.permits) - classRank(b.permits) || a.value - b.value)[0]?.id ?? null;

  // The score is a PROGRESS METER, not a fitness rating. It is allowed to
  // disagree with the class, and a test locks that in (spec R-5.4).
  const measured = dimensions.filter((d) => d.state === 'measured');
  const score = measured.length
    ? Math.round((measured.reduce((s, d) => s + d.value, 0) / measured.length) * 100)
    : 0;

  return {
    class: cls,
    score,
    limitingDimension: limiting,
    dimensions,
    deferred: rubric.dimensions.filter((d) => !d.liveMeasurable).map((d) => d.id),
    unmeasured: dimensions.filter((d) => d.state === 'unmeasured').map((d) => d.id),
  };
}
