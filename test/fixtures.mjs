/**
 * fixtures.mjs — test fixtures.
 *
 * The image generators live in lib/synthetic.js, because the demo page uses
 * them too and two implementations of "blur an image" would eventually
 * disagree — at which point the tests would be validating something the browser
 * never runs. This module re-exports them and adds the pose-level helpers,
 * which only the tests need.
 */

export { rng, blank, flat, noisy, checker, blur, clipPixels } from '../lib/synthetic.js';

/** A frame record shaped as the session expects, for pose-level tests. */
export function frameAt(azimuthDeg, elevationDeg, extra = {}) {
  return {
    vol: 300,
    clipping: { worst: 0.001 },
    lighting: { luma: 128, r: 0.333, b: 0.333 },
    azimuthDeg,
    elevationDeg,
    objectFovDeg: 45,
    observedSectors: azimuthDeg == null
      ? []
      : [Math.floor((((azimuthDeg % 360) + 360) % 360) / 45)],
    focalLengthMm: 5.6,
    sensorWidthMm: 7.0,
    ...extra,
  };
}

/** A full orbit at one elevation, evenly spaced. */
export function orbit(count, elevationDeg = 0, extra = {}) {
  return Array.from({ length: count }, (_, i) => frameAt((360 / count) * i, elevationDeg, extra));
}
