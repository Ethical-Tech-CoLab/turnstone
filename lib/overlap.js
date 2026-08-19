/**
 * overlap.js — how far apart two frames on an orbit may be.
 *
 * Implements PHOTOGRAMMETRY-SPEC.md §6.3.
 *
 * The useful property: for a camera orbiting an object, the DISTANCE CANCELS.
 *
 *   lateral shift    s = 2·d·sin(Δθ/2)
 *   frame footprint  w = 2·d·tan(φ/2)
 *   overlap          = 1 − s/w = 1 − sin(Δθ/2)/tan(φ/2)
 *
 * So overlap depends only on the angular step and how much of the frame the
 * object fills — which means live overlap guidance is possible on a device with
 * no depth sensor at all. That is the whole reason this is computed rather than
 * estimated from feature matches, which would cost an order of magnitude more.
 *
 * CAVEAT, stated because it matters: this is FRAME overlap for a centred,
 * roughly convex object. It is not SURFACE overlap, and it says nothing about
 * cavities or occlusion behind a handle. Those are surface completeness (§6.6),
 * which is a different dimension precisely because this one cannot see them.
 */

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * Overlap between adjacent frames.
 *
 * @param {number} stepDeg  angular step between shots, degrees
 * @param {number} objectFovDeg  angular width the object subtends in frame
 * @returns {number} overlap fraction, 0..1
 */
export function overlapForStep(stepDeg, objectFovDeg) {
  if (objectFovDeg <= 0 || objectFovDeg >= 180) throw new RangeError('objectFovDeg must be in (0,180)');
  const o = 1 - Math.sin(rad(stepDeg) / 2) / Math.tan(rad(objectFovDeg) / 2);
  return Math.max(0, Math.min(1, o));
}

/**
 * The largest angular step that still achieves a target overlap.
 * Inverted analytically — no search needed.
 *
 *   overlap = 1 − sin(Δθ/2)/tan(φ/2)
 *   =>  Δθ = 2·asin( (1−overlap)·tan(φ/2) )
 */
export function stepForOverlap(targetOverlap, objectFovDeg) {
  if (targetOverlap < 0 || targetOverlap >= 1) throw new RangeError('targetOverlap must be in [0,1)');
  const x = (1 - targetOverlap) * Math.tan(rad(objectFovDeg) / 2);
  if (x >= 1) return 180;                 // any step keeps that little overlap
  return deg(2 * Math.asin(x));
}

/** Shots needed for one full orbit at a target overlap. */
export function shotsPerOrbit(targetOverlap, objectFovDeg) {
  return Math.ceil(360 / stepForOverlap(targetOverlap, objectFovDeg));
}

/**
 * Angular width the object subtends, from its bounding box in the frame.
 * `boxFraction` is the fraction of the frame width the object occupies.
 */
export function objectFovDeg(sensorFovDeg, boxFraction) {
  const f = Math.max(0.01, Math.min(1, boxFraction));
  return deg(2 * Math.atan(f * Math.tan(rad(sensorFovDeg) / 2)));
}
