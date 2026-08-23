/**
 * Perceptual hashing of rendered views.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND HASH AT ALL.
 *
 * The binding already carries a SHA-256 over the mesh bytes, and that is the
 * hash that proves anything. But it breaks on the first thing anyone does with
 * a model: open it in Blender, export it again, strip the metadata, convert
 * glTF to OBJ. The bytes change completely and the cryptographic hash — quite
 * correctly — says "not this file".
 *
 * That is the right answer to "is this the same file" and the wrong answer to
 * "is this the same OBJECT", which is the question a museum actually has when a
 * model turns up somewhere without documentation. A perceptual hash over
 * rendered views survives re-export, because it describes what the geometry
 * LOOKS like rather than how it was encoded.
 *
 * THE TWO HASHES ARE NOT INTERCHANGEABLE AND MUST NEVER BE CONFLATED:
 *
 *   outputHash            proves. Exact, brittle, cryptographic.
 *   outputPerceptualHash  suggests. Approximate, robust, NOT a proof — dHash is
 *                         not collision-resistant and was never meant to be. It
 *                         re-associates a candidate so a human can then check
 *                         the real hash.
 *
 * Using a perceptual hash as evidence of identity would let anyone who can make
 * a mesh that renders similarly claim to hold the original.
 * ---------------------------------------------------------------------------
 */

/** dHash grid width. 8 gives a 64-bit hash from a 9x8 sample. */
export const DHASH_SIZE = 8;

/**
 * Difference hash of a single-channel image.
 *
 * Compares each pixel with its right-hand neighbour and records which is
 * brighter. Only the DIRECTION of each gradient is kept, which is what makes it
 * survive re-exposure, re-encoding and mild resampling: brightening the whole
 * image leaves every comparison unchanged.
 *
 * @param {{ width: number, height: number, data: Uint8Array|Uint8ClampedArray }} gray
 *        Single-channel image, row-major.
 * @returns {string} lower-case hex, most significant bit first
 */
export function dHash(gray, size = DHASH_SIZE) {
  const { width, height, data } = gray;
  if (!width || !height) throw new Error('cannot hash an empty image');

  // Sample to (size+1) x size by box-averaging. Nearest-neighbour would make
  // the hash depend on which source pixels happened to land on the sample
  // points, and two renders of the same mesh at different resolutions would
  // then disagree.
  const w = size + 1;
  const h = size;
  const cells = new Float64Array(w * h);

  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < height; yy += 1) {
        for (let xx = x0; xx < x1 && xx < width; xx += 1) {
          sum += data[yy * width + xx];
          n += 1;
        }
      }
      cells[y * w + x] = n ? sum / n : 0;
    }
  }

  let bits = '';
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < size; x += 1) {
      bits += cells[y * w + x] < cells[y * w + x + 1] ? '1' : '0';
    }
  }

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Convert RGBA bytes to the single-channel form dHash expects. */
export function toGrayscale(rgba, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
    // Rec. 601 luma. The exact coefficients matter less than both
    // implementations using the SAME ones — a JavaScript and a Python hash of
    // one image must agree, or cross-checking is meaningless.
    out[p] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  return { width, height, data: out };
}

/** Bits that differ between two equal-length hex hashes. */
export function hammingDistance(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cannot compare hashes of different lengths (${a.length} vs ${b.length})`);
  }
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/**
 * Combine the per-view hashes into one identifier.
 *
 * Views are concatenated in a FIXED order and the order is part of the
 * identity: front and back of an asymmetric object are different images, and a
 * hash that sorted them would call a mesh and its mirror image the same object.
 */
export function combineViewHashes(viewHashes, order) {
  const missing = order.filter((k) => !viewHashes[k]);
  if (missing.length) {
    throw new Error(`missing view hash(es): ${missing.join(', ')}`);
  }
  return order.map((k) => viewHashes[k]).join('');
}

/**
 * How similar two multi-view perceptual hashes are, 0..1.
 *
 * Deliberately returns a similarity and not a verdict. Where the threshold sits
 * depends on what is being asked — "is this plausibly the same object" and "is
 * this the same reconstruction" want very different cut-offs — and burying a
 * constant in here would make that choice invisible to whoever relies on it.
 */
export function perceptualSimilarity(a, b) {
  const bits = a.length * 4;
  return 1 - hammingDistance(a, b) / bits;
}
