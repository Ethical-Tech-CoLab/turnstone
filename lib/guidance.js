/**
 * guidance.js — decide the single thing to say next.
 *
 * Implements PHOTOGRAMMETRY-SPEC.md §5 guidance behaviour and conformance C-10.
 *
 * ---------------------------------------------------------------------------
 * ONE INSTRUCTION AT A TIME.
 *
 * Somebody walking backwards around a plinth holding a phone can act on one
 * instruction. Presenting ten dimensions and inviting them to optimise produces
 * a contributor who ignores all ten. Apple's ObjectCaptureSession — the only
 * mobile capture API with publicly documented real-time quality signals — shows
 * a single corrective message against a segmented dial, and that convergence is
 * not a UI preference.
 *
 * ONLY LIVE DIMENSIONS MAY DRIVE IT.
 *
 * Reprojection error, mesh watertightness and point-cloud density are outputs of
 * reconstruction, which happens minutes to hours later and often on another
 * machine. Guidance built on them is a post-mortem, and a contributor who has
 * packed up and gone home cannot act on it. Deferred dimensions are reported as
 * deferred, explicitly, so nobody is told "all good" by a system that has not
 * finished looking.
 *
 * STABILITY MATTERS MORE THAN PRECISION.
 *
 * Two dimensions hovering either side of the same threshold will otherwise swap
 * the headline instruction several times a second. That reads as malfunction and
 * cannot be obeyed — it is the same failure Plumb hit with a flickering pose
 * readout. `advise()` takes the previous instruction and keeps it unless a
 * competitor is worse by a clear margin.
 * ---------------------------------------------------------------------------
 */

import { classRank, permittedClass, worstClass, normaliserFor } from './rubric.js';

export const DEFAULT_HYSTERESIS = 0.08;

/**
 * @param {object} rubric      loaded rubric
 * @param {object} measurements  dimension id -> raw value
 * @param {object} options
 *   target            class being aimed for, default 'study'
 *   previousDimension id currently being advised on, to keep guidance stable
 *   hysteresis        how much worse a competitor must be to take over
 */
export function advise(rubric, measurements, options = {}) {
  const target = options.target ?? 'study';
  const hysteresis = options.hysteresis ?? DEFAULT_HYSTERESIS;
  const previous = options.previousDimension ?? null;

  const live = rubric.dimensions.filter((d) => d.liveMeasurable);
  const deferred = rubric.dimensions.filter((d) => !d.liveMeasurable).map((d) => d.id);

  const signals = live.map((d) => {
    const raw = measurements[d.id];
    if (raw === undefined || raw === null || Number.isNaN(raw)) {
      // Unknown is actionable — it is a dimension nobody has looked at yet, and
      // treating it as satisfied is how a system reports a pass it never earned.
      return { id: d.id, label: d.label, state: 'unknown', value: 0, permits: 'insufficient', measured: 'not measured' };
    }
    const value = normaliserFor(d)(raw);
    const permits = permittedClass(d, value);
    const state = permits === 'insufficient' ? 'blocking'
      : classRank(permits) < classRank(target) ? 'attention'
      : 'ok';
    return { id: d.id, label: d.label, state, value, permits, measured: formatRaw(d, raw) };
  });

  let provisionalClass = 'reference';
  for (const s of signals) provisionalClass = worstClass(provisionalClass, s.permits);

  const primary = pickPrimary(rubric, signals, target, previous, hysteresis);
  const spec = primary ? rubric.dimensions.find((d) => d.id === primary) : null;

  const meetsTarget = signals.length > 0
    && signals.every((s) => s.state !== 'unknown' && classRank(s.permits) >= classRank(target));

  return {
    provisionalClass,
    primaryAction: spec ? spec.guidance : null,
    primaryDimension: primary,
    signals,
    deferred,
    meetsTarget,
    summary: buildSummary(provisionalClass, target, meetsTarget, deferred.length),
  };
}

/**
 * Which dimension to advise on.
 *
 * Anything blocking outranks anything merely below target, because a blocking
 * dimension makes the session unusable however good the rest is. Within a rank,
 * the largest shortfall wins. The previously advised dimension is kept unless a
 * competitor beats it by more than the hysteresis margin.
 */
function pickPrimary(rubric, signals, target, previous, hysteresis) {
  const actionable = signals.filter((s) => s.state !== 'ok');
  if (actionable.length === 0) return null;

  const shortfall = (s) => {
    const d = rubric.dimensions.find((x) => x.id === s.id);
    const needed = d.thresholds[target] ?? d.thresholds.study;
    // A blocking or unknown dimension is always ranked above a merely
    // below-target one, whatever the arithmetic says.
    const rankBonus = (s.state === 'blocking' || s.state === 'unknown') ? 1 : 0;
    return rankBonus + (needed - s.value);
  };

  const ranked = actionable.slice().sort((a, b) => shortfall(b) - shortfall(a));
  const leader = ranked[0];

  const held = actionable.find((s) => s.id === previous);
  if (held && shortfall(leader) - shortfall(held) <= hysteresis) return held.id;

  return leader.id;
}

function formatRaw(dimension, raw) {
  const u = dimension.unit ?? '';
  if (u.includes('mm per pixel')) return `${raw.toFixed(2)} mm/px`;
  if (u.includes('variance')) return `VoL ${Math.round(raw)}`;
  if (u.includes('fraction of pixels')) return `${(raw * 100).toFixed(1)}% clipped`;
  if (u.startsWith('present')) return raw >= 1 ? 'present' : raw > 0 ? 'AR-derived' : 'none';
  if (u.includes('fraction') || u.includes('consistency') || u.includes('overlap')) {
    return `${Math.round(raw * 100)}%`;
  }
  return String(raw);
}

function buildSummary(provisional, target, meetsTarget, deferredCount) {
  const tail = deferredCount
    ? ` ${deferredCount} dimension${deferredCount > 1 ? 's' : ''} can only be checked after processing.`
    : '';
  if (meetsTarget) return `Meets ${target}. Stop here, or keep going for a better class.${tail}`;
  return `Currently ${provisional}; aiming for ${target}.${tail}`;
}
