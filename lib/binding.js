/**
 * ReconstructionBinding.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS EXISTS TO SOLVE.
 *
 * C2PA's normative format list is JPEG, PNG, GIF, TIFF, BMFF video and PDF.
 * glTF, USDZ, E57 and PLY are absent. So photographs can be sealed to a very
 * high standard, and the mesh built from them inherits NONE of it. The chain of
 * custody breaks at precisely the step that produces the artefact anyone will
 * actually look at, cite, print or sell.
 *
 * The binding spans that gap: a signed statement that these specific sealed
 * photographs, through this specific pipeline, produced this specific mesh.
 *
 * THE HARD RULE IS chainComplete.
 *
 * It is true only when EVERY source image carried a verifiable capture-time
 * seal. Not most. Not 90%.
 *
 * A chain that is 90% sealed is not 90% of a proof. The unsealed 10% is exactly
 * where a substituted photograph would be inserted, because an attacker picks
 * where to attack — they will not distribute their tampering evenly across the
 * set to keep a percentage looking respectable. Reporting a fraction as though
 * it were partial assurance invites the reader to round it up.
 *
 * So the fraction is reported (it is useful for chasing down what went wrong)
 * and the BOOLEAN is separate, and only the boolean means anything.
 * ---------------------------------------------------------------------------
 */

export const BINDING_SCHEMA_VERSION = '1.0';

/** The order views are hashed in. Fixed: it is part of the identity. */
export const VIEW_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom'];

/**
 * Hash over the sorted, DEDUPLICATED per-image hashes.
 *
 * Sorted, so set identity does not depend on the order files happened to be
 * listed in. Deduplicated, because two byte-identical files are one photograph
 * — a package re-exported with an accidental duplicate frame binds to the same
 * source set, which is what a person means by "these photographs".
 *
 * Deliberately the same construction the job model uses for idempotency: the
 * thing being identified is the same thing, and two different hashes over one
 * set of photographs would be a standing invitation to compare the wrong pair.
 * Duplicates stay visible through totalImageCount beside it.
 */
export async function sourceSetHash(imageHashes, sha256Hex) {
  const joined = [...new Set(imageHashes)].sort().join('\n');
  return sha256Hex(joined);
}

/**
 * Build the unsigned binding.
 *
 * Kept separate from signing so the exact bytes that get signed are
 * constructible and inspectable without a key. A signing routine that also
 * builds its payload cannot be tested for what it actually signed.
 */
export function buildBinding({
  sessionId,
  jobId,
  sourceSetHash: setHash,
  images,
  pipeline,
  outputHash,
  outputPerceptualHash = null,
  perceptualViews = null,
  chainNote,
  createdAt = null,
}) {
  if (!chainNote || typeof chainNote !== 'string') {
    // R-9.7. Without this note the binding reads as a reproducibility claim,
    // and someone will eventually try to reproduce a mesh from it and conclude
    // the record was falsified when it merely was not deterministic.
    throw new Error(
      'a binding cannot be built without its chainNote. The note is what stops the binding ' +
        'being read as a claim that the reconstruction can be recreated bit-for-bit, which it ' +
        'cannot: photogrammetry pipelines are not deterministic.',
    );
  }
  if (!outputHash) {
    throw new Error('a binding needs the hash of the output it binds to');
  }
  if (!pipeline || !pipeline.backend) {
    throw new Error(
      'a binding needs the pipeline that produced the output. A mesh whose provenance stops at ' +
        '"some photogrammetry software" cannot be reasoned about later.',
    );
  }

  const total = images.length;
  const sealed = images.filter((i) => i.sealed === true).length;

  // C-6. The boolean is not derived from a rounded percentage anywhere.
  const chainComplete = total > 0 && sealed === total;

  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    sessionId,
    jobId,

    sourceSetHash: setHash,
    sealedImageCount: sealed,
    totalImageCount: total,
    chainComplete,
    // Present for diagnosis only. It is NOT a confidence level, and the field
    // name says so rather than leaving a bare 0.9 to be misread as one.
    unsealedImageCount: total - sealed,

    pipeline: {
      backend: pipeline.backend,
      version: pipeline.version ?? null,
      parameters: pipeline.parameters ?? {},
    },

    outputHash,
    outputPerceptualHash,
    perceptualViews,
    perceptualHashNote:
      'outputPerceptualHash re-associates a re-exported or metadata-stripped copy. It is NOT ' +
      'evidence of identity: dHash is not collision-resistant. Use it to find a candidate, then ' +
      'check outputHash.',

    chainNote,
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

/**
 * Canonical bytes for signing.
 *
 * Sorted keys and no insignificant whitespace, so the same binding signs to the
 * same bytes regardless of which implementation serialised it — otherwise a
 * signature made by the Python server could not be verified by a JavaScript
 * consumer, and cross-implementation verification is most of the point of
 * signing at all.
 *
 * The signature field itself is excluded: a document cannot contain its own
 * signature at the moment it is signed.
 */
export function canonicalise(binding) {
  const { signature, ...rest } = binding;
  return canonicalJson(rest);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * Check a binding's internal consistency.
 *
 * Deliberately does NOT check the signature — that needs a key and a decision
 * about which keys are trusted, which is the caller's to make. Splitting them
 * keeps "this document contradicts itself" separate from "I do not trust who
 * signed it", which are different problems with different remedies.
 */
export function checkBindingConsistency(binding) {
  const problems = [];

  if (binding.schemaVersion !== BINDING_SCHEMA_VERSION) {
    problems.push(
      `binding schemaVersion ${binding.schemaVersion} is not ${BINDING_SCHEMA_VERSION}; ` +
        `a newer binding may assert things this build does not understand`,
    );
  }
  if (binding.sealedImageCount > binding.totalImageCount) {
    problems.push('more images are marked sealed than exist in the set');
  }
  const shouldBeComplete =
    binding.totalImageCount > 0 && binding.sealedImageCount === binding.totalImageCount;
  if (binding.chainComplete !== shouldBeComplete) {
    problems.push(
      `chainComplete is ${binding.chainComplete} but ${binding.sealedImageCount} of ` +
        `${binding.totalImageCount} images are sealed. This is the one field an attacker would ` +
        `most want to flip, and it must always be recomputable from the counts beside it.`,
    );
  }
  if (binding.totalImageCount === 0) {
    problems.push('a binding over zero images binds nothing');
  }
  if (!binding.chainNote) {
    problems.push('chainNote is absent; the binding would be read as a reproducibility claim');
  }
  return problems;
}
