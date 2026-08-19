# Photogrammetry capture tool — concept

*Research findings, feature list, and recommendations for a second capture tool: full 3D
records of physical objects — statues, cultural artefacts, architectural fragments.*

**Status:** recommendations made; specification written against them; Phase 0 built.
[`PHOTOGRAMMETRY-SPEC.md`](PHOTOGRAMMETRY-SPEC.md) implements what §8–§9 recommend.

> **How the decisions were settled.** Agreement was sought on the four items in §10 and was
> not available at the time, so the recommended option was adopted in each case so the work
> could proceed. All four were subsequently **confirmed**, including the name `Turnstone`.

**Research method.** 92 Tavily queries across five batches (open-source tools, proprietary
products, heritage standards, capture technique, technical decisions), plus direct
verification of licence files and repository status through the GitHub API. Raw results are
in [`research/`](research). Where a Tavily summary made a
load-bearing claim — particularly about licensing — it was checked against the primary
source, and in two cases the summary was materially incomplete. Those are flagged below.

---

## 1. What this tool is, and why it is not Plumb

Plumb photographs **flat things you cannot touch**: a facade across a street, a bridge
tower in the water. It solves for one calibrated plane, and its output is a photograph you
can measure from.

This tool photographs **solid things you can walk around**: a statue, a vessel, a mask, a
carved fragment. Its output is a 3D model.

They share a philosophy and almost no geometry.

| | Plumb | This tool |
|---|---|---|
| Subject | Planar facade, often inaccessible | Solid object, usually reachable |
| Geometry | One homography onto one plane | Full viewing sphere, hundreds of poses |
| Scale from | Printed target in shot | Scale bar in shot, or AR |
| Output | Measurable photograph + sidecar | Mesh / point cloud / splat + sidecar |
| Compute | Entirely in-browser | Capture in-browser, **reconstruction on a server** |
| Failure mode | Wrong number, looks fine | No model at all, or a warped one |

That last row is the important one. Plumb's dangerous failure is a *plausible wrong
measurement*. This tool's dangerous failure is different: the contributor goes home, the
reconstruction runs overnight, and it fails — and the object may be in a country they
cannot return to. **Everything about the design follows from the cost of a second visit.**

---

## 2. The source: DPA already specified the protocol

`Ethical-Tech-CoLab/DPA` — Digital Passport for Artworks — contains
[`docs/CAPTURE-PROTOCOL.md`](https://github.com/Ethical-Tech-CoLab/DPA/blob/main/docs/CAPTURE-PROTOCOL.md)
and a working `packages/capture` TypeScript package. This is unusually complete prior work
and the new tool should implement it rather than reinvent it.

### What DPA has already decided

**A ten-dimension quality rubric** (`packages/capture/src/rubric.ts`), each dimension with
thresholds, a normalisation function, and the one sentence to show a contributor when it is
the thing holding them back:

| # | Dimension | Measures | Live? |
|---|---|---|---|
| 1 | Angular coverage | fraction of viewing sphere visited | yes |
| 2 | Surface completeness | fraction of surface actually observed | yes |
| 3 | Image overlap | mean overlap between adjacent frames | yes |
| 4 | Sharpness | variance of Laplacian | yes |
| 5 | Exposure | fraction of pixels clipped | yes |
| 6 | Ground sample distance | mm of object per pixel | yes |
| 7 | Scale reference | calibrated bar / AR-derived / absent | yes |
| 8 | Colour reference | colour target present | yes |
| 9 | Lighting consistency | stability across frames | yes |
| 10 | Device metadata | frames retaining focal length, sensor, pose | **no** |

**Four fitness classes** — `reference`, `study`, `indicative`, `insufficient` — where the
class is the **worst** dimension, not the average. Four hundred photographs that are all out
of focus produce an out-of-focus mesh. This means there is always exactly one thing worth
fixing next.

**A separate 0–100 score** that *is allowed to disagree with the class*, deliberately: DPA's
protocol gives the worked example of a capture scoring 86/100 that is still only
`indicative` because the scale bar is missing. A test locks the case in — asserting the
score stays above 80 while the class drops — so nobody later "simplifies" the pair into one
misleading number. The record also carries `limitingMetric`, naming the single dimension
holding it back.

**Guidance is one instruction at a time**, driven only by live-measurable dimensions, with
hysteresis so the headline instruction does not flicker between two dimensions hovering at
the same threshold.

**Capture quality may never touch provenance confidence.** `@dpa/capture` may not import
`@dpa/assess`, enforced by a test at the module boundary. The reasoning is worth repeating
because it generalises: if capture quality fed provenance confidence, *a museum could raise
an object's provenance confidence by buying a better camera*.

**What a capture attests, and what it does not**, as mandatory schema fields —
`buildCaptureRecord` throws if the legitimacy disclaimer is missing. A flawless capture of a
looted object is a flawless capture of a looted object.

**Consent defaults.** Capture assets never default to public. Funerary and sacred material
defaults to `source-community` disclosure. A mesh is a replication asset and, for funerary
material, public visibility may itself be the harm.

### What DPA explicitly does *not* have

Quoting its own §10 *What is not built*:

- **No metric extractors.** "The rubric is defined; nothing computes it from actual
  photographs yet."
- **No mobile client.** "`/capture` demonstrates the rubric and the guidance loop against
  fixtures; it does not touch a camera. Whether to build new, extend VANGO, or wrap Apple's
  Object Capture is open."
- **No mesh perceptual hashing.**
- **Not wired to a passport.**

**This tool is precisely that missing client and those missing extractors.** The division of
labour the user described — "DPA specifies the protocol, this tool is generic" — is already
the shape of the code: the rubric is data (thresholds in one file, deliberately, so the
argument can be had against specific numbers), and the tool is the engine that measures
against whatever rubric it is handed.

---

## 3. Open-source landscape — with licences verified

Tavily surfaced the tools; the licence column was then checked directly against each
repository, because the summarised answers were wrong or incomplete in ways that would have
mattered.

| Tool | Licence (verified) | Stars | Status | Role |
|---|---|---|---|---|
| **COLMAP** | BSD-3 core¹ | 12.5k | active | SfM + MVS reference implementation |
| **Meshroom / AliceVision** | **MPL-2.0** | 12.9k / 3.5k | active | Full pipeline, node graph, CLI, Docker |
| **OpenMVG** | MPL-2.0 | 6.5k | active | SfM |
| **gsplat** | Apache-2.0 | 5.6k | active | Gaussian splatting kernels |
| **nerfstudio** | Apache-2.0 | 11.9k | active | NeRF / splat training framework |
| **OpenSfM** | BSD-2 | 3.8k | **unmaintained** | SfM in Python |
| **glomap** | BSD-3 | 2.4k | **ARCHIVED** | Global SfM, far faster than COLMAP |
| **OpenMVS** | **AGPL-3.0** | 4.1k | active | Dense mesh + texturing |
| **OpenDroneMap** | **AGPL-3.0** | 6.4k | active | Aerial pipeline |
| **MeshLab** | **GPL-3.0** | 5.8k | active | Mesh cleanup |
| **CloudCompare** | GPL | 4.7k | active | Point-cloud comparison, validation |
| **VGGT** | **Meta bespoke research licence** | 14.2k | active | Feed-forward 3D |
| **MASt3R / DUSt3R** | **CC BY-NC-SA 4.0 — non-commercial** | 3.1k | active | Dense stereo |

¹ COLMAP's own `COPYING.txt` states the BSD licence "refers only to the license for COLMAP
itself, independent of its dependencies" — several of which are GPL/AGPL. A COLMAP *binary*
is therefore usually effectively GPL even though the source is BSD.

### Three findings that change the design

**The two most impressive new methods are not open source.** VGGT (14.2k stars, the highest
of any tool here) is under a bespoke Meta licence granting rights only to "Research
Materials", with a viral term-propagation clause and an Acceptable Use Policy. MASt3R is
CC BY-NC-SA — explicitly **non-commercial**. Neither can be a dependency of a tool that
museums and community archives are expected to self-host and that carries an open licence.
A casual search ranks them first; the licence check disqualifies both.

**The best-performing dense reconstruction is AGPL.** OpenMVS produces the meshes most
people actually want, and AGPL-3.0's network clause reaches a hosted service. For a project
whose users include institutions with strict legal review, that is a real constraint — not
fatal, but it must be a deliberate, documented choice rather than something discovered
later.

**MPL-2.0 is the sweet spot, and AliceVision sits in it.** MPL-2.0 is file-level copyleft:
it does not reach across a process boundary or contaminate a larger work. Meshroom is
MPL-2.0, actively developed (2025.1.0 released August 2025), has a documented CLI and an
official Docker image. For a pipeline that must be self-hostable by a museum without a
licence conversation, **AliceVision/Meshroom is the defensible default**, with COLMAP as an
alternate backend and OpenMVS available as an opt-in for those who accept AGPL.

**glomap being archived matters.** It was the obvious "make SfM fast" answer. Building on an
archived repository is a maintenance liability worth avoiding for a tool intended to outlive
its authors' attention.

---

## 4. Proprietary products — what they get right

Studied to elicit features, not to copy products.

| Product | Platform | Notable |
|---|---|---|
| **Apple Object Capture** | iOS/macOS only | The only mobile capture API with *publicly documented real-time quality signals*: a segmented dial showing angular coverage, one corrective message at a time, automatic capture |
| **RealityScan 2** (Epic) | iOS + **Android** + desktop | Free for organisations under $1M revenue; AI masking; alignment quality analysis |
| **Polycam** | iOS + Android | LiDAR + photogrammetry + splats; real-time feedback; used by **Backup Ukraine** with UNESCO |
| **KIRI Engine** | iOS + Android | "Featureless Object Scan" for shiny/untextured objects; splats; OBJ export |
| **Scaniverse** (Niantic) | iOS + Android | On-device processing; splats |
| **Metashape** (Agisoft) | Desktop | The heritage incumbent: **coded targets** and **scale bars** as first-class objects, batch processing, one-time $179/$3,499 licence |
| **Qlone** | iOS + Android | Printable AR **mat** that doubles as turntable guide and scale reference |

### The features worth taking

1. **A coverage dial, not a number.** Apple discretises the viewing sphere into segments and
   fills them in. This is the single most effective capture UI ever shipped for this problem,
   and DPA's `angular-coverage` dimension already assumes it.
2. **One corrective message at a time.** Independently arrived at by Apple and by DPA.
3. **Automatic capture on stability.** Removes the hardest part of handheld work: holding
   still *and* pressing a button. Plumb already implements exactly this, and the logic ports.
4. **Coded targets and scale bars as first-class objects** (Metashape). This is how heritage
   professionals actually get metric accuracy, and it maps directly onto DPA dimension 7.
5. **A printable mat** (Qlone) that is simultaneously turntable guide, scale reference, and
   background mask. One printed sheet solving three problems is exactly Plumb's target-card
   pattern, applied to objects.
6. **Featureless-object handling** (KIRI). Shiny, dark and untextured surfaces are the
   commonest hard failure, and cultural objects are disproportionately glazed, polished,
   dark or gilded.

### The gaps none of them fill

- **No signed provenance.** None produces a verifiable record of who captured what, where,
  when — the entire point for DPA.
- **No quality rubric with fitness classes.** They optimise for a pleasing model, not for a
  record whose fitness for a stated purpose is declared and defensible.
- **Not self-hostable or auditable.** A museum cannot run Polycam's pipeline on its own
  hardware, inspect it, or guarantee it will exist in ten years.
- **No consent or sensitivity model.** Nothing distinguishes an ordinary vessel from
  funerary material.
- **Crowd-sourced efforts accept anything.** Rekrei "accepts any photograph with no
  submission quality protocol whatsoever" (DPA's survey). Backup Ukraine used Polycam
  unmodified.

That combination — open, self-hostable, quality-graded, provenance-signed, consent-aware —
is unoccupied.

---

## 5. Heritage standards — what the record must satisfy

- **No ratified numerical rubric exists.** The London Charter (2009) is the most widely
  adopted normative framework and is a *principles* document with no numeric tiers; the
  Seville Principles extend it to archaeology. Historic England (metric survey
  specification, latest edition February 2024), the Smithsonian DPO and the EU VIGIE
  2020/654 study each propose their own. DPA's assessment that "the bands are ours" is
  confirmed, and is the honest position.
- **The London Charter's core requirement is directly relevant**: a visualisation must
  "accurately convey to users the status of the knowledge they represent". A 3D model
  displayed without its capture quality does not satisfy that. Neither does one displayed
  with a single unexplained number. This is the argument for shipping the fitness class
  *with* the model, always.
- **Metadata**: CIDOC-CRM is the ISO standard for cultural heritage documentation;
  **CRMdig** extends it specifically for digitisation provenance and paradata. This is the
  vocabulary a museum's systems already speak.
- **Delivery**: the **IIIF 3D API** is the emerging interoperability layer. Europeana does
  not host 3D — it signposts via metadata, accepting DAE, PLY, WRL, glTF, OBJ.
- **Archival format** is contested. E57 is an open ISO-recognised standard favoured for
  point clouds; glTF/GLB is the delivery format everything can render. These are different
  jobs and the tool should emit both rather than pick a winner.
- **Ethics**: the **CARE principles** (Collective benefit, Authority to control,
  Responsibility, Ethics) govern Indigenous data and sit alongside FAIR. **Traditional
  Knowledge Labels** (Local Contexts) are the established mechanism for embedding
  community-specific access protocols. **Digital Benin** aggregates 3D scans of 5,200+
  looted objects across 131 institutions in 20 countries — the closest existing analogue to
  DPA's ambition, and a natural interoperability target.
- **The provenance chain breaks at reconstruction.** C2PA's normative format list is JPEG,
  PNG, GIF, TIFF, BMFF video and PDF. glTF, USDZ, E57 and PLY are absent. Photographs can be
  sealed to a very high standard and *the mesh built from them inherits none of it*. DPA's
  `ReconstructionBinding` is the proposed answer and this tool must implement it.

---

## 6. Capture technique — the numbers to encode

From the technique batch, these are the defaults the tool should embody so a novice never
has to learn them:

- **Overlap 60–80%** for close-range heritage work (CIPA); ~75% is the practical target.
  Below ~60% the matcher loses the thread and the reconstruction fragments.
- **40–50 photographs minimum** for a small object at one elevation; three elevations
  (eye level, above, below) is the realistic target for `reference`.
- **Camera settings**: ISO 100, f/9–f/13, 1/200s or faster, **consistent across the whole
  set**. Consistency matters more than optimality.
- **Diffuse, non-moving light.** Light that moves with the camera bakes shading into texture
  and can emboss shadow edges into geometry.
- **Cross-polarisation** (polarising filter on lens + polarised light source, rotated 90°)
  is the standard answer for glazed, gilded and polished surfaces.
- **Shiny / dark / transparent objects** are the classic failures. Sprays and powders are the
  common workaround and are **often unacceptable on cultural material** — so the tool must
  route users to cross-polarisation, more diffuse light, and honest refusal instead.
- **The underside requires flipping the object** and capturing a second set, aligned later.
  This is a distinct workflow, not an afterthought, and needs explicit support.
- **Turntable vs orbit**: turntable gives consistent lighting and is faster but demands
  background masking; orbiting suits large or fixed objects. Support both.
- **Validation** against caliper measurements is how accuracy is actually demonstrated —
  which is the direct analogue of Plumb's hold-out check, and should be carried over.

---

## 7. Proposed feature list

### A · Capture client (browser PWA, Android-first, same posture as Plumb)

1. **Guided orbit with a coverage dial** — the viewing sphere discretised into segments,
   filled as visited, at three elevation bands.
2. **One instruction at a time**, from DPA's guidance function, with hysteresis.
3. **Live metric extraction** — sharpness (variance of Laplacian), exposure clipping,
   overlap estimate, GSD, lighting consistency, computed on downscaled frames.
4. **Auto-capture on stability**, one-shot, ported from Plumb's `level.js`.
5. **Full-resolution stills** via `ImageCapture.takePhoto()`, optics locked so the intrinsic
   profile stays valid for the session — Plumb's `camera.js` already does this.
6. **Printable mat/target** doubling as turntable guide, scale reference and mask hint —
   Plumb's target-card pattern, extended.
7. **Scale bar and colour target detection**, satisfying dimensions 7 and 8.
8. **Session model**: multi-pass, with an explicit "flip the object" pass for the underside.
9. **Provisional fitness class shown continuously**, so a contributor knows before leaving
   whether they have a `reference` record, and what single change would get them there.
10. **Wi-Fi-only upload by default**, deferred queue — Plumb's `upload.js` ports directly.
11. **Offline-first.** Field sites lack connectivity; nothing may block on the network.

### B · Reconstruction server (Docker, self-hostable)

12. **Pluggable backend**: AliceVision/Meshroom default (MPL-2.0); COLMAP alternate;
    OpenMVS opt-in behind an explicit AGPL acknowledgement.
13. **Deferred, re-runnable processing.** Same principle Plumb established: the archive is
    the images; the model is a derived artefact that can be regenerated with better software
    in ten years.
14. **Deferred metrics** — dimension 10 and any post-reconstruction acceptance checks.
15. **`ReconstructionBinding`** — signed structure binding source image set hash, count of
    sealed images, pipeline + parameters, output mesh hash, and a perceptual mesh hash.
    `chainComplete` only when *every* source image was sealed.
16. **Outputs**: glTF/GLB for delivery, PLY/E57 for archive, ortho views for the perceptual
    hash, and the sidecar.
17. **CPU fallback.** GPU-only would exclude exactly the institutions that most need this.

### C · Record and governance

18. **Fitness class + score**, never merged, per DPA.
19. **Mandatory attests / does-not-attest fields.**
20. **Sensitivity tiers** with funerary and sacred defaulting to `source-community`.
21. **Operator roles** separate from issuer classes, with verification tracked separately
    from claimed role.
22. **CIDOC-CRM / CRMdig export** and an IIIF 3D manifest.
23. **Traditional Knowledge Label support** as a first-class field.

---

## 8. Recommendation: repository structure

### Recommendation — a **separate repository**, and leave Plumb where it is

I recommend **against** moving Plumb into a subfolder, for four reasons:

1. **It matches the organisation's established, working pattern.** `manhattan-bridge-3d`,
   `brooklyn-bridge-3d`, `williamsburg-bridge-3d` and `dumbo-district-3d` are separate
   repositories sharing `digital-3d-shared-contracts`. That pattern is already proven in
   this org, and Plumb already publishes into it.
2. **It preserves the live URL.** Plumb is deployed at
   `https://ethical-tech-colab.github.io/plumb/`, is linked at the top of its README, and is
   what you have been testing from your phone. Restructuring the repo moves or breaks that
   for no functional gain.
3. **The dependency profiles are incompatible in spirit.** Plumb is deliberately
   dependency-free in the browser with a small FastAPI server. This tool needs a CUDA-capable
   reconstruction pipeline and possibly AGPL components. Keeping the AGPL question inside its
   own repository means it can never contaminate Plumb's licensing story.
4. **DPA consumes this tool, not Plumb.** A DPA integrator should be able to vendor the
   photogrammetry client without acquiring a landmark-photography tool.

**What I would share, later and only once earned:** Plumb has four modules this tool wants
almost unchanged — `camera.js` (optics locking, full-res capture), `level.js` (steadiness,
hysteresis, auto-capture), `upload.js` (Wi-Fi-only deferred queue), `branding.js`. The right
move is to copy them now and extract a shared package *when the second consumer proves the
abstraction*, not before. Premature extraction across two repos costs more than the
duplication.

### Proposed layout of the new repository

```
<name>/
  README.md
  HOW-TO-<NAME>.md            novice field guide, in Plumb's style
  PHOTOGRAMMETRY-SPEC.md      the specification
  LICENSE                     Apache-2.0 (code)
  LICENSE-CONTENT             CC BY 4.0 (docs, diagrams)
  LICENSE-DATA                CC0 (schemas, rubrics)
  docs/
    01-research-findings.md
    02-capture-methodology.md
    03-feature-list.md
    04-implementation-plan.md
    05-reconstruction-backends.md    incl. the licence decision, in the open
    06-provenance-and-binding.md
    07-dpa-integration.md
    08-sensitivity-and-consent.md
    assets/                          explainer SVGs, printable mat/targets
  client/                     browser PWA, dependency-free
    lib/{coverage,metrics,camera,level,session,upload,manifest}.js
    test/
  server/                     FastAPI + Docker, pluggable backends
    backends/{alicevision,colmap,openmvs}/
    deploy/{compose,azure}/
  rubric/                     the rubric as DATA, not code
    heritage-v1.json          DPA's ten dimensions and thresholds
    schema.json
  tools/                      layout probe, research harness
```

**`rubric/` as data is the load-bearing choice.** DPA deliberately put every threshold in
one file so "the argument can be had against specific numbers rather than against a vibe".
Shipping the rubric as JSON keeps the tool generic — DPA supplies a heritage rubric, another
programme supplies its own, and neither forks the code.

### Local disk

Keep clones side by side under `c:\Dev\`, one per repository. The current working directory
name (`survey tools`) is incidental and need not change; if it bothers you, rename it to
`plumb` after the next push.

---

## 9. Recommendation: names

All candidates verified free in the `Ethical-Tech-CoLab` org and free of collisions in the
3D/photogrammetry space on GitHub. (Most short words are taken on npm — `plumb` included —
which has not been a problem, since what matters is the repository URL.)

### Recommended: **Turnstone**

`github.com/Ethical-Tech-CoLab/turnstone` · zero domain collisions

A turnstone is a shorebird that feeds by **flipping stones over to see what is underneath**.
That is, precisely, the hardest and most-skipped part of object capture — DPA's dimensions 1
and 2 exist because contributors orbit once at eye level and never record the underside.
The name teaches the technique. It is also warm and non-technical, which suits crowd-sourced
contributors, and "stone" sits naturally with statuary and carved artefacts.

*Risk:* could read as a birdwatching app without a tagline. Mitigated by
*"Turnstone — 3D records of cultural objects, from every side."*

### Alternate: **Lathe**

`github.com/Ethical-Tech-CoLab/lathe` · zero domain collisions

A lathe rotates a workpiece about an axis so a tool can reach every side — the exact
geometry of turntable and orbit capture. It is a workshop instrument, making it a direct
sibling to Plumb's builder's instrument. One syllable, concrete, memorable.

*Risk:* a lathe *removes* material; this tool records. Machinists may find it odd.

### Also considered

| Name | For | Against |
|---|---|---|
| **Plinth** | What a statue stands on; you walk *around* a plinth; museum-native; pairs with Plumb | Passive furniture — conveys the pedestal, not the act |
| **Facet** | "Every facet" = complete coverage; short, positive | Implies angular/faceted geometry; some collision noise |
| **Maquette** | Precise art-world term for a 3D study | French, hard to spell and say for a global audience |
| **Armature** | The skeleton inside a sculpture | Jargon; suggests structure rather than surface |
| **Rondel** | Circular — the orbit | Obscure; nobody knows the word |
| **Orbit** | Most literally descriptive of the action | Heavily used in software generally; 41 domain hits |

---

## 10. Decisions taken

These four were put forward for agreement, adopted as recommended when agreement was not
immediately available, and subsequently **confirmed**. They are carried into
[`PHOTOGRAMMETRY-SPEC.md`](PHOTOGRAMMETRY-SPEC.md).

| # | Decision | Outcome |
|---|---|---|
| 1 | **Name** | **Turnstone** — confirmed |
| 2 | **Structure** | Separate repository; Plumb untouched — confirmed |
| 3 | **Backend** | AliceVision/Meshroom (MPL-2.0) default; OpenMVS opt-in behind an explicit AGPL acknowledgement — confirmed |
| 4 | **Rubric** | Ships as JSON data, DPA's `heritage-v1` first — confirmed |

The one place the specification knowingly **contradicts** its source is §6.6: DPA marks
surface completeness `liveMeasurable: true`, and the specification treats it as
live-*estimable*, because you can orbit an object completely and never see inside a cavity.

**This is deliberately left open** (OQ-1), to be resolved against a specific artefact that
exposes the problem and settled on the fly with the object in hand. In the meantime the
implementation records both the capture-time estimate and the post-reconstruction truth,
plus their difference, so that when the question is answered it is answered from accumulated
evidence rather than from argument.

---

## Appendix — research corpus

| Batch | Queries | File |
|---|---|---|
| Open-source tools | 18 | `research/oss.md` |
| Proprietary products | 16 | `research/proprietary.md` |
| Heritage standards | 20 | `research/heritage.md` |
| Capture technique | 20 | `research/process.md` |
| Technical decisions | 18 | `research/decisions.md` |

Raw JSON responses are in `research/raw/`. The harness is
[`tools/tavily_research.py`](tools/tavily_research.py); it calls the Tavily REST API
directly, because the Tavily MCP server in this environment carries a stale key and returns
`Invalid API key`. No substitute provider was used.
