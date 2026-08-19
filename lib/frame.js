/**
 * frame.js — turn a browser image source into the measurements the session wants.
 *
 * This is the only file in lib/ that knows a canvas exists. Everything else
 * takes plain arrays, which is what keeps the maths testable in Node against
 * synthetic frames and portable to a server later.
 */

import {
  WORKING_EDGE, workingScale, toLuma, varianceOfLaplacian,
  clippingFraction, frameLightingSignature, SILHOUETTE_SECTORS,
} from './metrics.js';

let scratch = null;

function scratchCtx(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  return scratch.getContext('2d', { willReadFrequently: true });
}

/**
 * Downscale a source to the working resolution and read its pixels back.
 *
 * The downscale is not an optimisation, it is what makes a threshold mean the
 * same thing on a 12 MP phone and a 200 MP back.
 */
export function workingPixels(source, sourceWidth, sourceHeight, edge = WORKING_EDGE) {
  const s = workingScale(sourceWidth, sourceHeight, edge);
  const w = Math.max(1, Math.round(sourceWidth * s));
  const h = Math.max(1, Math.round(sourceHeight * s));
  const ctx = scratchCtx(w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h, scale: s };
}

/**
 * A coarse centre-weighted mask.
 *
 * This is the declared fallback of spec R-7.4, not a real segmentation: it
 * assumes the object is roughly centred and fills a known share of the frame.
 * Captures relying on it are marked `unmasked` and capped at `study`, because a
 * metric measured over an unknown region is not a measurement of the object.
 */
export function centreMask(width, height, coverage = 0.7) {
  const mask = new Uint8Array(width * height);
  const cx = width / 2;
  const cy = height / 2;
  const rx = (width * coverage) / 2;
  const ry = (height * coverage) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/**
 * Estimate what share of the frame width the object spans, from the mask.
 * Feeds objectFovDeg, which with the angular step gives overlap — and since
 * distance cancels in that geometry, no depth sensor is needed.
 */
export function objectBoxFraction(mask, width, height) {
  let minX = width;
  let maxX = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return maxX < 0 ? 0 : (maxX - minX + 1) / width;
}

/** Which silhouette sectors this pose observed. Coarse, and honestly so. */
export function sectorsFor(azimuthDeg, sectors = SILHOUETTE_SECTORS) {
  if (azimuthDeg == null) return [];
  const a = ((azimuthDeg % 360) + 360) % 360;
  return [Math.floor((a / 360) * sectors) % sectors];
}

/**
 * Extract every per-frame measurement from an image source.
 *
 * Returns the shape `Session.addFrame` expects. Sharpness is returned raw:
 * whether it is `suspect` depends on the session median, which a frame cannot
 * know before joining a session.
 */
export function measureFrame(source, sourceWidth, sourceHeight, pose = {}, options = {}) {
  const { data, width, height, scale } = workingPixels(source, sourceWidth, sourceHeight);
  const mask = options.mask ?? centreMask(width, height, options.coverage ?? 0.7);
  const luma = toLuma(data, width, height);

  const boxFraction = objectBoxFraction(mask, width, height);
  const sensorFov = options.sensorFovDeg ?? 65;

  return {
    vol: varianceOfLaplacian(luma, width, height, mask),
    clipping: clippingFraction(data, width, height, mask),
    lighting: frameLightingSignature(data, width, height, mask),
    azimuthDeg: pose.azimuthDeg ?? null,
    elevationDeg: pose.elevationDeg ?? null,
    objectFovDeg: 2 * (180 / Math.PI) * Math.atan(boxFraction * Math.tan((sensorFov * Math.PI) / 360)),
    observedSectors: sectorsFor(pose.azimuthDeg),
    focalLengthMm: pose.focalLengthMm ?? null,
    sensorWidthMm: pose.sensorWidthMm ?? null,
    workingWidth: width,
    workingHeight: height,
    workingScale: scale,
    masked: !!options.mask,      // false means the centre-weighted fallback
    capturedAt: new Date().toISOString(),
  };
}
