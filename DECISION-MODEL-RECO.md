# Decision-model recommendation: curator metadata triage only

Date: 2026-10-11. Public-source proposal; no measured integration.
Reviewed [README](https://github.com/Ethical-Tech-CoLab/turnstone/blob/6355964f89dd1fa6d242ae9b7876baf650cec09e/README.md)
and [contribution rules](https://github.com/Ethical-Tech-CoLab/turnstone/blob/6355964f89dd1fa6d242ae9b7876baf650cec09e/CONTRIBUTING.md).
This is a documentation-level assessment, not a complete metric-engine audit.

## Recommendation and impact

Keep the capture pipeline model-free. The project computes pixel-derived
measurements, uses a worst-dimension fitness class, and separates progress
score, missing dimensions and provenance confidence. A language model must
not replace these measurements or live one-instruction guidance.

An optional **post-capture curator queue** could classify metadata conflicts
or rank already-authorized documentation by relevance to an object. Allow
related-but-not-identical and insufficient evidence. This would affect only
derived review annotations, not the DPA rubric or Plumb geometry.

Never raise provenance confidence using capture quality. Never use a model to
authorize capture/publication, infer community consent, or change the default
disclosure of sacred/funerary records. Rubric files remain data, never code.

## Alternatives and test

Compare a curator checklist and exact metadata rules with a local classifier
first. Jev's [entity-alignment pattern](https://docs.typesafe.ai/cookbooks/entity_alignment.md),
Microsoft-Decision-1 or Sage are possible hosted comparisons only on approved
public records. Their exact hosted checkpoints are not local models.

Split by object, capture session and source community where appropriate.
Measure false identity links, missing-evidence handling, reviewer time,
calibration and cost per accepted annotation. Include replicas, missing scales,
unmeasured dimensions and source restrictions. Do not use capture labels as
ground truth for authenticity.

## Gate

No change to fitness class, score, permissions, reconstruction or live guidance.
Start offline, with reversible annotations and retained source IDs. Stop if
review efficiency is bought by suppressing uncertainty or source-community
control. Any future scoring change requires the repository's conformance tests.
This document proposes a discussion, not a new dependency or runtime feature.
