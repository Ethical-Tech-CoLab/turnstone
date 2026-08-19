# Turnstone — photogrammetry capture specification

*A tool for making 3D records of physical objects — statues, vessels, masks, carved
fragments — that are worth something afterwards.*

**Version** 0.1 · draft for review
**Companion** [`PHOTOGRAMMETRY-CONCEPT.md`](PHOTOGRAMMETRY-CONCEPT.md) — research, findings and
the reasoning behind the recommendations this specification implements.

> **On the name.** `Turnstone` is provisional. It was recommended in the concept document
> and adopted so this specification could be written; it was not confirmed. A turnstone is a
> shorebird that feeds by flipping stones to see underneath — which is the most-skipped part
> of object capture. The name appears in exactly two places that matter (the repository name
> and one `PRODUCT_NAME` constant), so changing it is a rename, not a refactor. See §12.

---

## 1. Scope

### 1.1 What this tool does

Produces a **3D record of a physical object** from photographs taken by a person walking
around it, together with a machine-readable statement of **how good that record is and what
it may be relied upon for**.

### 1.2 What it explicitly does not do

| Not this | Because |
|---|---|
| Assert that an object is lawfully held | A flawless capture of a looted object is a flawless capture of a looted object. Inherited from DPA and enforced structurally (§9.2). |
| Contribute to provenance confidence | Otherwise a museum raises an object's provenance score by buying a better camera. Enforced at the module boundary (§10.3). |
| Reconstruct in the browser | Dense reconstruction needs compute a phone does not have. Capture is local; reconstruction is a server job (§8). |
| Measure flat, inaccessible facades | That is [Plumb](https://ethical-tech-colab.github.io/plumb/). Different geometry, different tool. |
| Guarantee a reproducible reconstruction | Photogrammetry pipelines are not bit-deterministic. The record says so rather than implying a guarantee the format cannot make (§9.4). |

### 1.3 Design constraint that drives everything

**A second visit may be impossible.** The contributor may be a volunteer in a museum for one
afternoon, or in a country they cannot return to. Reconstruction happens hours later,
elsewhere. Therefore:

> Every quality signal that *can* be computed during capture *must* be computed during
> capture, and anything that cannot must be declared as deferred rather than silently
> assumed to pass.

This is the single load-bearing requirement. Most of what follows is a consequence of it.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Session** | One object, one contributor, one sitting. Contains one or more passes. |
| **Pass** | A continuous set of frames in one object orientation. A flip starts a new pass. |
| **Frame** | One captured full-resolution still, plus its measurements and pose. |
| **Rubric** | The dimensions, thresholds and guidance strings, supplied as data (§4). |
| **Dimension** | One measured property of a capture, e.g. sharpness. |
| **Fitness class** | `reference` · `study` · `indicative` · `insufficient`. |
| **Limiting dimension** | The single worst dimension. Determines the class and the guidance. |
| **Target** | A printed sheet carrying fiducial markers, scale and colour patches (§7). |

---

## 3. Architecture

```
   ┌────────────────────────── device (offline-capable) ─────────────────────────┐
   │  capture client (browser PWA, Android-first)                                │
   │    camera control ─ full-res stills, locked optics                          │
   │    live metrics  ─ sharpness, exposure, overlap, GSD, lighting, coverage    │
   │    guidance      ─ ONE instruction, hysteresis, coverage dial               │
   │    session store ─ IndexedDB; survives reload, airplane mode, battery death │
   └───────────────────────────────────┬─────────────────────────────────────────┘
                                       │  deferred upload, Wi-Fi-only by default
   ┌───────────────────────────────────▼─────────────────────────────────────────┐
   │  reconstruction server (Docker, self-hostable, CPU fallback)                 │
   │    backend adapter ─ AliceVision (default) │ COLMAP │ OpenMVS (opt-in)       │
   │    deferred metrics ─ device metadata, reprojection error, watertightness    │
   │    outputs ─ glTF/GLB · PLY · E57 · ortho views · sidecar                    │
   │    ReconstructionBinding ─ signs images→pipeline→mesh                        │
   └───────────────────────────────────┬─────────────────────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │  consumers: DPA · IIIF · CIDOC-CRM  │
                    └─────────────────────────────────────┘
```

**The archive is the photographs.** The mesh is a derived artefact, regenerable with better
software in ten years. This mirrors Plumb's rule that the raw photo stays raw, and it is why
reconstruction being deferred is an *upgrade* rather than a compromise.

---

## 4. The rubric is data

**Requirement R-4.1.** The rubric SHALL be loaded from JSON, not compiled in. The tool
supplies a default; DPA supplies `heritage-v1`; another programme supplies its own.

**Rationale.** DPA deliberately placed every threshold in one file "so the argument can be
had against specific numbers rather than against a vibe". Shipping it as data extends that:
the numbers can be argued with, versioned and cited without forking the tool.

```jsonc
{
  "id": "heritage-v1",
  "title": "Cultural heritage object capture",
  "source": "Ethical-Tech-CoLab/DPA docs/CAPTURE-PROTOCOL.md",
  "classes": ["insufficient", "indicative", "study", "reference"],
  "classIsWorstDimension": true,          // NOT the average. See R-5.2.
  "dimensions": [
    {
      "id": "sharpness",
      "label": "Sharpness",
      "unit": "variance of Laplacian",
      "why": "Motion blur is the single most common reason a phone capture fails, and it is invisible on a small screen at capture time. Blurred frames do not merely add noise — they contribute wrong feature matches, which bends the reconstructed geometry rather than softening it.",
      "normalise": { "fn": "logScale", "min": 20, "max": 500 },
      "thresholds": { "reference": 0.7, "study": 0.5, "indicative": 0.3 },
      "guidance": "Frames are coming out soft. Brace your elbows, pause briefly before each shot, and add light rather than letting the phone lengthen its exposure.",
      "liveMeasurable": true
    }
    // ... nine more
  ]
}
```

**R-4.2.** A rubric SHALL declare a `schemaVersion`, and the tool SHALL refuse to run against
a major version it does not implement. Silently ignoring an unknown dimension would report a
pass on a rubric the tool never applied.

**R-4.3.** `heritage-v1` SHALL be a faithful transcription of DPA's ten dimensions and
thresholds. Where this specification adds detail (§6) it adds *how to measure*, never *what
the threshold is*.

---

## 5. Scoring

**R-5.1.** Each dimension normalises its raw measurement to `0..1` and maps onto the highest
class its thresholds permit.

**R-5.2.** The session's class SHALL be the **worst** dimension's permitted class, never the
mean. Four hundred photographs that are all out of focus produce an out-of-focus mesh, and
no amount of excellent angular coverage buys that back.

**R-5.3.** `qualityScore` (0–100, the mean of normalised dimensions) SHALL be reported
alongside the class and SHALL NOT be merged with it. It is a *progress meter*, not a fitness
rating: it exists so a contributor re-shooting can see movement before the class flips.

**R-5.4.** The two SHALL be permitted to disagree. A conformance test SHALL assert that a
capture excellent on every dimension except a missing scale reference scores above 80 and is
still classed `indicative`. *(This mirrors DPA's own test, which asserts the bound rather
than a specific figure.)*

**R-5.5.** The record SHALL carry `limitingDimension` — the single dimension setting the
class. There is therefore always exactly one thing worth fixing next.

**R-5.6.** An unmeasured dimension SHALL be treated as **absent, not as passing**. Silence is
not a clear result.

---

## 6. Metric extractors

**This section is the substance of the tool.** DPA defines all ten dimensions and states
plainly that "nothing computes it from actual photographs yet". These are the algorithms.

All live metrics are computed on a **working image**: the frame downscaled to 1024 px on its
long edge, linearised, converted to luma `Y = 0.2126R + 0.7152G + 0.0722B`. Fixing the
working resolution is what makes thresholds comparable between a 12 MP and a 200 MP sensor.

Where an **object mask** is available (§7.3) metrics are computed inside it. Measuring
sharpness over a cluttered background rates the room, not the object.

### 6.1 Sharpness — variance of Laplacian

```
K = [[0,1,0],[1,-4,1],[0,1,0]]
VoL = variance( conv2(Y_working, K) )   over the object mask
```

**Caveat that must be stated in the UI, not buried:** VoL is *content-dependent*. A
carved, weathered surface scores higher than a smooth glazed one at identical focus. An
absolute threshold alone will therefore mis-rate smooth objects.

**R-6.1.** Sharpness SHALL be judged by **both** an absolute floor (`logScale(20,500)` per
`heritage-v1`) **and** a within-session relative rule: a frame whose VoL is below 40% of the
session median is flagged regardless of the absolute value. The relative rule catches "this
object is smooth *and* that frame was blurred"; the absolute rule catches "every frame was
blurred". Neither alone is sufficient.

**R-6.2.** Frames failing the relative rule SHALL be marked `suspect`, retained, and excluded
from the session median. They are still uploaded — the reconstruction may use them — but they
do not inflate the quality claim.

### 6.2 Exposure — clipping fraction

```
clipped = ( count(Y <= 2) + count(Y >= 253) ) / count(mask)
```

Computed per channel as well as on luma, and the **worst channel** reported: a blown red
channel on terracotta is invisible in luma and destroys the surface just the same.

### 6.3 Image overlap — angular, not pixel

True overlap needs feature matching. The live estimate is geometric and exact enough:

For a camera orbiting at radius `d`, adjacent frames separated by `Δθ`, with the object
subtending angular width `φ` in the frame:

```
lateral shift    s = 2·d·sin(Δθ/2)
frame footprint  w = 2·d·tan(φ/2)
overlap          = 1 − s/w  =  1 − sin(Δθ/2) / tan(φ/2)
```

**`d` cancels.** Overlap depends only on the angular step and how much of the frame the
object fills — so the client can guide on angle alone, without knowing the distance. This is
what makes live overlap guidance possible on a device with no depth sensor.

Verified against both standard rules of thumb:

| Object fills | Step for 60% | Step for 75% | Step for 80% |
|---|---|---|---|
| 65° | 29.5° (13/orbit) | 18.3° (20/orbit) | 14.6° (25/orbit) |
| 45° | 19.1° (19/orbit) | 11.9° (31/orbit) | 9.5° (38/orbit) |
| 40° | 16.7° (22/orbit) | 10.4° (35/orbit) | 8.3° (44/orbit) |

A 10–15° step yields 64–86% overlap depending on framing, which brackets CIPA's 60–80% for
close-range heritage work, and 36 shots/orbit reconciles with the "40–50 photographs
minimum" advice for a small object.

**R-6.3.** The client SHALL derive `Δθ` from pose (WebXR, else integrated device
orientation) and `φ` from the object's bounding box in frame. Where pose is unavailable it
SHALL fall back to feature-based estimation (ORB matches between consecutive working images,
overlap ≈ matched/detected) and SHALL mark the dimension `estimated`.

**R-6.4.** The formula assumes a centred, roughly convex object and estimates *frame*
overlap, not *surface* overlap. This SHALL be recorded in the sidecar as a stated
approximation. Concave objects and deep recesses are handled by surface completeness (§6.6),
not here.

### 6.4 Ground sample distance

Two paths, in preference order:

1. **From the scale reference** (preferred, no intrinsics needed):
   `GSD = known_length_mm / pixels_spanned`, measured on the full-resolution frame across a
   marker of certified length.
2. **From optics**: `GSD = d · pixel_pitch / f`, needing distance and intrinsics.

**R-6.5.** When a target is visible the measured path SHALL be used and the optical path
SHALL be recorded alongside as a cross-check. A disagreement greater than 10% indicates a
wrong focal length or a mis-scaled print, and SHALL be surfaced — this is the analogue of
Plumb's hold-out check and catches the failure that otherwise silently rescales the model.

**R-6.6.** Guidance SHALL express this dimension in **mm/px, not normalised units**.
`heritage-v1` states thresholds of 0.75 / 0.5 / 0.25, which are meaningless to an operator.
Inverted through DPA's `logScaleInverse(3.0, 0.1)` they mean:

| Class | Requires |
|---|---|
| `reference` | **≤ 0.234 mm/px** |
| `study` | ≤ 0.548 mm/px |
| `indicative` | ≤ 1.282 mm/px |

**This is a trap worth stating plainly: 0.25 mm/px reads as excellent and does not meet
`reference`.** It was caught by the implementation disagreeing with this specification's own
worked fixture. A conformance test now pins all three inverted values, so a change to the
normalisation cannot silently move the real-world requirement.

### 6.5 Angular coverage

The viewing sphere is discretised into bins:

| Band | Elevation | Required for `study` | Required for `reference` |
|---|---|---|---|
| Below | −60°…−20° | — | ✓ |
| Eye | −20°…+20° | ✓ | ✓ |
| Above | +20°…+60° | ✓ | ✓ |
| Top | +60°…+90° | — | ✓ |
| Underside | requires flip pass | — | ✓ |

Azimuth is divided into **24 bins of 15°**, matching the 10–15° step that §6.3 shows is
needed for adequate overlap. A bin counts as visited when a frame's optical axis falls in it
**and** that frame is not `suspect`.

```
coverage = visited_bins / required_bins(target_class)
```

**R-6.7.** Coverage SHALL be displayed as a **filled dial**, not a percentage. This is the
one interaction proprietary tools have converged on independently (Apple's segmented capture
dial), and it converts an abstract number into an obvious spatial gap.

### 6.6 Surface completeness

**R-6.8.** During capture this dimension is an **estimate and SHALL be labelled as one.**
It cannot be truly known before reconstruction: you can orbit an object completely and never
see inside a cavity or behind a handle.

Live estimate: fraction of the object silhouette that has been observed at a
grazing-to-normal incidence in at least three frames, approximated by tracking which
silhouette octants have been foreground in the mask across the session.

**R-6.9.** After reconstruction the authoritative value SHALL replace the estimate, and the
class SHALL be recomputed. If it drops, the record SHALL say so rather than retaining the
optimistic capture-time class.

*This is an honest divergence from DPA's rubric, which marks the dimension `liveMeasurable:
true`. It is live-**estimable**, not live-measurable, and conflating those would tell a
contributor a cavity was recorded when nothing had looked inside it.*

### 6.7 Lighting consistency

Per frame, within the mask: median luma `Ȳ` and median chromaticity
`(r, b) = (R/(R+G+B), B/(R+G+B))`.

```
consistency = 1 − clamp( IQR({Ȳ}) / τ_Y  +  IQR({r,b}) / τ_C , 0, 1 )
```

with `τ_Y`, `τ_C` from the rubric. IQR rather than variance so one frame shot into a window
does not condemn the session.

### 6.8 Scale reference — and 6.9 Colour reference

Detected from the printed target (§7). Reported as `calibrated` (certified marker detected
and its measured length agrees with its declared length within tolerance), `ar-derived`
(pose-based metric scale only), or `absent`.

**R-6.10.** `ar-derived` SHALL NOT satisfy `reference` class. AR scale drifts; a reference
record's size must come from something physical that was in the photograph.

### 6.10 Device metadata — deferred

Fraction of frames retaining focal length, sensor dimensions and pose. Not live-measurable;
reported as **deferred** throughout capture so nobody is told "all good" by a system that has
not finished looking.

---

## 7. The printed target

One sheet solving three problems at once — the Qlone insight, done openly.

**R-7.1.** The target SHALL carry:
- **Fiducial markers** (ArUco 4×4, certified edge length) for pose, scale and identification;
- **A scale bar** with a printed length and a *measure-this* callout;
- **Neutral grey and primary colour patches** for the colour reference;
- **A matte, non-repeating background field** to aid masking.

**R-7.2.** The target SHALL be published as SVG in true millimetres, in A4 and US Letter, and
SHALL instruct the user to **print at 100% and then measure what actually came out**, with a
field for entering the measured length. Consumer printers scale silently; Plumb learned this
and the same discipline applies. The measured length, not the nominal one, is what enters
`GSD` and `scale-reference`.

**R-7.3.** Marker size SHALL be chosen so the marker spans ≥ 80 px at the working distance
implied by the target GSD, and the tool SHALL warn when it does not.

### 7.3 Masking

**R-7.4.** The client SHALL compute a coarse object mask per frame, used for every masked
metric above. Order of preference: segmentation model if available → target-field
subtraction on a turntable → centre-weighted bounding box as a declared fallback.

**R-7.5.** When only the fallback is available the affected dimensions SHALL be marked
`unmasked` and capped at `study`. A metric measured over an unknown region is not a
measurement of the object.

---

## 8. Reconstruction server

### 8.1 Backends and the licence gate

| Backend | Licence | Default | Notes |
|---|---|---|---|
| **AliceVision / Meshroom** | MPL-2.0 | **yes** | File-level copyleft; does not reach across a process boundary. Active, CLI, official Docker image. |
| **COLMAP** | BSD-3 core | alternate | Core is BSD but dependencies pull GPL/AGPL; a *binary* is usually effectively GPL. |
| **OpenMVS** | AGPL-3.0 | opt-in | Best dense meshes. Network clause reaches a hosted service. |

**R-8.1.** The default pipeline SHALL be AliceVision/Meshroom, so that a museum can
self-host without a licence conversation.

**R-8.2.** Selecting OpenMVS SHALL require an explicit, logged acknowledgement of AGPL
obligations. It SHALL NOT be reachable by default configuration.

**R-8.3.** The backend, its version and its full parameter set SHALL be recorded in the
`ReconstructionBinding`. "Which software made this mesh" is a provenance question.

**R-8.4.** GPU SHALL be optional. A CPU path, however slow, SHALL exist — GPU-only would
exclude exactly the institutions that most need this.

**R-8.5.** Feed-forward models under non-open licences — VGGT (bespoke Meta research licence)
and MASt3R/DUSt3R (CC BY-NC-SA, non-commercial) — SHALL NOT be dependencies. They may be
supported as *user-supplied* backends the operator installs themselves and accepts
responsibility for.

### 8.2 Job model

**R-8.6.** Submission SHALL be idempotent on the session content hash. A contributor with an
unreliable connection retrying an upload MUST NOT create a second reconstruction.

**R-8.7.** Jobs SHALL be re-runnable against the same inputs with a different backend or a
later version, producing a new binding that references the same source image set. This is how
a 2026 capture benefits from a 2034 pipeline.

### 8.3 Outputs

| Artefact | Format | Purpose |
|---|---|---|
| Delivery mesh | glTF 2.0 / GLB | Everything renders it; Europeana and IIIF accept it |
| Archive geometry | PLY + E57 | E57 is the open ISO-recognised point-cloud standard |
| Ortho views | PNG ×6 | Input to the perceptual mesh hash |
| Sidecar | JSON | The record (§9) |
| Source set | original bytes, unmodified | The actual archive |

**R-8.8.** Source images SHALL be preserved byte-identical. Re-encoding destroys the hashes
the binding depends on, and the images are the archive.

---

## 9. The record

### 9.1 Structure

```jsonc
{
  "schemaVersion": "1.0",
  "sessionId": "…",
  "capturedAt": "2026-08-18T14:02:11Z",
  "rubric": { "id": "heritage-v1", "version": "1.0.0", "hash": "sha256:…" },
  "quality": {
    "class": "study",
    "score": 84,
    "limitingDimension": "scale-reference",
    "dimensions": [ /* per-dimension raw, normalised, permitted class, state */ ],
    "deferred": ["device-metadata"],
    "estimated": ["surface-completeness"]
  },
  "attests": "An object with these measurable characteristics was observed in this condition, at this place, at this time, by this party — and this is a tamper-evident record of that observation.",
  "doesNotAttest": "This record does not attest that the object was lawfully excavated, exported, acquired, or is lawfully held. It records an observation of an object, not a right to it. Capture quality and provenance legitimacy are unrelated: a high-quality capture of an unlawfully held object is a high-quality capture of an unlawfully held object.",
  "operator": { "role": "contributor", "verification": "self-asserted" },
  "sensitivity": "ordinary",
  "disclosureTier": "museum",
  "binding": { /* §9.4 */ }
}
```

### 9.2 Mandatory disclaimers

**R-9.1.** `attests` and `doesNotAttest` SHALL be mandatory fields. Construction SHALL fail
if the legitimacy disclaimer is absent. A record without it cannot exist — this is enforced
structurally rather than editorially, exactly as DPA's `buildCaptureRecord` does.

### 9.3 Sensitivity and consent

**R-9.2.** Capture assets SHALL NEVER default to public.

| Material | Default tier |
|---|---|
| Ordinary | `museum` |
| Funerary | `source-community` |
| Sacred | `source-community` |

**R-9.3.** The tool SHALL carry Traditional Knowledge Labels (Local Contexts) as a
first-class field, not as a free-text note.

**R-9.4.** A mesh is a **replication asset** — good enough to study is good enough to
3D-print or forge from. The default may be wrong; it is wrong in the direction that can be
corrected, whereas publishing first cannot be undone.

> **Known gap, carried forward from DPA:** the `source-community` tier was designed with no
> source-community input. That was tolerable when the system described objects in text and is
> not tolerable for photorealistic models of funerary material. This SHALL remain flagged as
> blocking in the backlog rather than quietly treated as solved.

### 9.4 ReconstructionBinding

C2PA's normative format list is JPEG, PNG, GIF, TIFF, BMFF video and PDF. **glTF, USDZ, E57
and PLY are absent.** Photographs can be sealed to a very high standard and the mesh built
from them inherits none of it. The chain breaks at exactly the step that produces the
artefact anyone will look at.

**R-9.5.** The server SHALL emit a signed `ReconstructionBinding` covering:

- `sourceSetHash` — hash over the sorted per-image hashes;
- `sealedImageCount` / `totalImageCount`;
- `pipeline` — backend, version, full parameters;
- `outputHash` — hard binding to the mesh bytes;
- `outputPerceptualHash` — dHash over rendered orthographic views, so a re-exported or
  metadata-stripped copy can still be re-associated.

**R-9.6.** `chainComplete` SHALL be true **only** when every source image carried a
verifiable capture-time seal. A chain that is 90% sealed is not 90% of a proof: the unsealed
10% is precisely where a substituted photograph would be inserted, and an attacker chooses
where to attack.

**R-9.7.** The binding SHALL carry `chainNote` stating that it does **not** make the
reconstruction reproducible, because photogrammetry pipelines are not bit-deterministic.

---

## 10. DPA integration

**R-10.1.** Turnstone SHALL depend on no DPA package. DPA supplies a rubric file and consumes
a record; that is the entire interface.

**R-10.2.** A `heritage-v1` rubric SHALL be published that transcribes DPA's ten dimensions,
with a conformance test asserting the thresholds match DPA's `rubric.ts`.

**R-10.3.** Turnstone SHALL NOT import, compute or expose anything resembling provenance
confidence, and a test SHALL assert this at the module boundary — mirroring DPA's own test
that `@dpa/capture` may not import `@dpa/assess`. If capture quality fed provenance
confidence, an institution with a good imaging department and no provenance documentation
would outscore a community with thorough records and a phone, invisibly.

**R-10.4.** Records SHALL be exportable as CIDOC-CRM / **CRMdig** for museum systems and as
an **IIIF 3D** manifest for delivery.

---

## 11. Conformance

A build is conformant when these pass. Each exists because getting it wrong is plausible.

| # | Assertion | Status |
|---|---|---|
| C-1 | Class equals the worst dimension, never the mean | **implemented** |
| C-2 | Score > 80 with class `indicative` when only the scale reference is missing (R-5.4) | **implemented** |
| C-3 | An unmeasured dimension yields `not measured`, never a pass | **implemented** |
| C-4 | Record construction throws without the legitimacy disclaimer | phase 5 |
| C-5 | Funerary and sacred default to `source-community` | phase 5 |
| C-6 | `chainComplete` false when any source image is unsealed | phase 5 |
| C-7 | No module imports a provenance-confidence symbol (R-10.3) | phase 6 |
| C-8 | Overlap formula matches the §6.3 table within 0.5° across the FOV range | **implemented** |
| C-9 | `heritage-v1` thresholds match DPA's `rubric.ts` exactly | **implemented** |
| C-10 | Guidance returns exactly one instruction, stable under hysteresis across jittering input | phase 2 |
| C-11 | `ar-derived` scale never permits `reference` | **implemented** |
| C-12 | Source images are byte-identical after a full round trip | phase 4 |
| C-13 | Reconstruction is idempotent on session content hash | phase 4 |
| C-14 | Post-reconstruction surface completeness can *lower* the class, and the record records that it did | phase 4 |

---

## 12. Delivery plan

| Phase | Contents | Status |
|---|---|---|
| **0 · Foundation** | Project folder; rubric as data + `heritage-v1`; scoring engine; overlap geometry; conformance tests C-1, C-2, C-3, C-8, C-9, C-11 | **done** — 18 tests passing |
| **1 · Metrics** | §6 extractors against a fixture corpus of known-good and known-bad frames | next — closes the gap DPA names |
| **2 · Capture client** | Coverage dial, guidance loop, auto-capture, session store, offline | |
| **3 · Target** | Printable SVG target, marker detection, measured-length entry, masking | |
| **4 · Server** | Docker, AliceVision backend, job model, outputs | |
| **5 · Binding** | `ReconstructionBinding`, perceptual mesh hash, C-6 | |
| **6 · Interop** | CRMdig + IIIF 3D export, DPA passport wiring | |
| **7 · Relocate** | Push `turnstone/` to its own repository once the name is confirmed | gated on the name |

### Phase 0, as built

```
turnstone/
  README.md
  PHOTOGRAMMETRY-CONCEPT.md   research, findings, decisions
  PHOTOGRAMMETRY-SPEC.md      this document
  rubric/heritage-v1.json     DPA's ten dimensions, transcribed mechanically
  lib/rubric.js               loader + scoring (§4, §5)
  lib/overlap.js              orbit geometry (§6.3)
  test/conformance.test.mjs   18 tests
  tools/validate-rubrics.mjs  CI guard for hand-edited rubrics
  tools/tavily_research.py    the research harness
  research/                   92 queries, raw + summarised
```

**On relocation.** The work is staged in the Plumb repository under `turnstone/` because that
is where it was done. It is self-contained: nothing outside the folder references it, it has
its own workflow (`.github/workflows/turnstone.yml`), and Plumb's deploy workflow is
path-filtered to `prototype/**`, `HOW-TO-PLUMB.md` and `docs/assets/**`, so the two cannot
interfere. Moving it is `git mv` into a fresh repository plus one workflow file — deliberately
kept that cheap, because the name is not yet confirmed.

**Two conformance tests were written after the fact and are worth noting**, because the
implementation caught an error in the specification's own fixture rather than the other way
round: a ground sample distance of 0.25 mm/px reads as excellent and does **not** meet the
`reference` threshold, which inverts to **0.234 mm/px**. That number is what a field guide
should quote; "0.75 normalised" is not an instruction anyone can act on. The inverted
thresholds for all three classes are now pinned by a test.

---

## Appendix A — open questions

1. **Name.** `Turnstone` provisional, unconfirmed. Alternate: `Lathe`.
2. **Splats.** 3D Gaussian splatting (gsplat, Apache-2.0) gives better visual fidelity for
   display but is not a mesh and does not measure. Recommended as a *display* output
   alongside the mesh, never as the archival record — but this is not settled.
3. **Surface completeness.** §6.7 knowingly diverges from DPA's rubric by treating this as
   live-*estimable*. This needs agreement with DPA, and is the one place this specification
   contradicts its source.
4. **Source-community consent.** Inherited blocking gap (R-9.4). Cannot be closed by
   engineering.
5. **Where the sealing happens.** Whether capture-time C2PA sealing is feasible in a browser
   PWA at all, given Plumb's finding that conformant claim signing needs X.509 with specific
   EKUs and a Trust List CA. If not, `chainComplete` may be unreachable for web capture and
   the honest answer is to say so rather than to weaken the definition.
