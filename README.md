# Turnstone

**3D records of cultural objects, from every side.**

### ▶ [**Try it live — ethical-tech-colab.github.io/turnstone**](https://ethical-tech-colab.github.io/turnstone/)

*Runs in any browser, works offline, installs to a home screen.*

| | |
|---|---|
| [**Capture**](https://ethical-tech-colab.github.io/turnstone/capture.html) | Record an object. Coverage dial, one instruction at a time, and a session that survives a reload. |
| [**Print a mat**](https://ethical-tech-colab.github.io/turnstone/targets.html) | Scale bar and colour patches. Print at 100%, then **measure what came out**. |
| [**Quality demo**](https://ethical-tech-colab.github.io/turnstone/) | Watch a session score itself, and see what each dimension actually measures. |

*Every number is computed from actual pixels — nothing is simulated.*

---

A tool for photographing a statue, vessel, mask or carved fragment so that the resulting 3D
model is *worth something afterwards* — carrying a machine-readable statement of how good it
is and what it may be relied upon for.

> A turnstone is a shorebird that feeds by flipping stones over to see what is underneath —
> the most-skipped part of object capture, and the reason a capture rubric needs angular
> coverage and surface completeness as separate dimensions at all.

---

## Status

| | |
|---|---|
| ✅ Research | 92 Tavily queries, licences verified at source ([`research/`](research)) |
| ✅ Concept + decisions | [`PHOTOGRAMMETRY-CONCEPT.md`](PHOTOGRAMMETRY-CONCEPT.md) |
| ✅ Specification | [`PHOTOGRAMMETRY-SPEC.md`](PHOTOGRAMMETRY-SPEC.md) — 42 requirements, 14 conformance tests |
| ✅ **Phase 0** · rubric as data | [`rubric/heritage-v1.json`](rubric/heritage-v1.json) — DPA's ten dimensions, transcribed mechanically |
| ✅ **Phase 0** · scoring engine | [`lib/rubric.js`](lib/rubric.js) — worst-dimension class, progress score, limiting dimension |
| ✅ **Phase 0** · orbit geometry | [`lib/overlap.js`](lib/overlap.js) — distance cancels, so guidance needs no depth sensor |
| ✅ **Phase 1** · metric extractors | [`lib/metrics.js`](lib/metrics.js) — the gap DPA names in its own §10 |
| ✅ **Phase 1** · guidance loop | [`lib/guidance.js`](lib/guidance.js) — one instruction at a time, with hysteresis |
| ✅ **Phase 1** · live demo | [`web/`](web) — the extractors running on real pixels |
| ✅ **Phase 2** · camera control | [`lib/camera.js`](lib/camera.js) — full-res stills with a fallback chain, optics locking |
| ✅ **Phase 2** · persistent sessions | [`lib/store.js`](lib/store.js) — IndexedDB; frames survive reload, phone call, flat battery |
| ✅ **Phase 2** · auto-capture | [`lib/steady.js`](lib/steady.js) — one-shot on stability, so the tap never blurs the shot |
| ✅ **Phase 2** · offline client | [`web/capture.html`](web/capture.html) — installable, boots with no network |
| ✅ **Phase 2** · session packages | [`lib/zip.js`](lib/zip.js) — photographs, manifest and checksums leave the device as a `.zip` |
| ✅ **Phase 3** · printable mats | [`docs/assets/`](docs/assets) — scale bar, colour patches, fiducials; verified 180.00 mm |
| ✅ **Phase 3** · scale reference | [`lib/target.js`](lib/target.js) — measured length → GSD, with a scaled-print warning |
| ✅ **Phase 4** · reconstruction service | [`server/`](server) — FastAPI; ingest, licence gate, final quality class |
| ✅ **Phase 4** · backend adapters | [`server/turnstone_server/backends.py`](server/turnstone_server/backends.py) — AliceVision, COLMAP, OpenMVS, simulated |
| ✅ **Phase 4** · final assessment | [`server/turnstone_server/quality.py`](server/turnstone_server/quality.py) — deferred dimensions; the class may fall |
| ✅ **Phase 4** · container | [`server/Dockerfile`](server/Dockerfile) — DTSF pattern, internal network, non-root ([unbuilt](server/README.md#with-docker)) |

```bash
node --test test/*.test.mjs           # 137 passing
node tools/validate-rubrics.mjs       # rubric files load and score
node tools/check-targets.mjs          # printable mats measure what they claim
node tools/demo-probe.mjs             # drives the demo in headless Chrome
node tools/capture-probe.mjs          # drives the capture client, incl. offline
node tools/check-archive-interop.mjs  # archives open in Python's zipfile
node tools/verify-package.mjs <zip>   # check a session package is complete
node tools/analyse-session.mjs <dir> [manifest.json]   # what can be built from a real session

python -m pytest server/tests -q      # 28 passing, no backend required
python tools/server-e2e.py            # end-to-end against a running server
```

---

## Getting your photographs out

**The photographs are the archive.** The 3D model is derived from them and can be rebuilt
later with better software; the photographs cannot be recreated from the model, and for many
objects they cannot be recaptured at all.

**Export session** produces a `.zip` containing:

```
manifest.json      every measurement, the quality assessment, and what the
                   record does and does not attest
images/            the photographs, byte-identical to what the camera produced
SHA256SUMS.txt     a checksum per photograph
README.txt         what this package is, in plain language
```

Verify it before leaving the site:

```bash
node tools/verify-package.mjs bura-askos_s_xxxx.zip
```

The verifier reconciles the manifest against the actual files, recomputes every checksum, and
checks that funerary or sacred material has not been marked public. It exits non-zero if the
package should not be relied upon.

> **Browser storage is not an archive.** Until you export, the photographs live in IndexedDB,
> which is evicted under storage pressure and wiped by "clear browsing data". The client warns
> once a session has frames that have not been exported.

---

## What it measures, and how

| Dimension | Method | Live? |
|---|---|---|
| Sharpness | Variance of the Laplacian, plus a within-session relative rule | ✅ |
| Exposure | Clipping fraction per channel, **worst** reported | ✅ |
| Image overlap | Angular: `1 − sin(Δθ/2)/tan(φ/2)` | ✅ |
| Ground sample distance | From the scale bar, cross-checked against optics | ✅ |
| Angular coverage | 24 azimuth bins × 4 elevation bands | ✅ |
| Surface completeness | Silhouette sectors — an **estimate**, see OQ-1 | ~ |
| Lighting consistency | IQR of luma and chromaticity across frames | ✅ |
| Scale / colour reference | Target detection | ✅ |
| Device metadata | Fraction of frames retaining focal length, sensor, pose | ❌ deferred |

### Eight things that are easy to get wrong

**Sharpness is content-dependent.** A carved, weathered surface outscores a smooth glazed one
at identical focus. An absolute threshold alone marks every smooth object blurred; a relative
rule alone cannot notice that *every* frame was soft. Both are required.

**The silhouette edge must not leak into a masked measurement.** An object against its
background is an occlusion boundary — the strongest gradient in the frame, and strong whether
or not the surface is in focus. A mask that only tests the centre pixel lets the kernel read
across it, so a blurred object scores as sharp, and scores differently against a different
backdrop.

**Distance cancels in the overlap geometry.** Overlap depends only on the angular step and how
much of the frame the object fills, so live guidance works with no depth sensor. A 10–15° step
gives 64–86% overlap depending on framing, which brackets CIPA's 60–80% for close-range
heritage work.

**A deferred dimension must not cap a live class.** Device metadata cannot be known during a
session. Scoring it live reports a contributor as `insufficient` for a reason they can neither
observe nor act on — a post-mortem, not guidance. It is listed as deferred, the class is
flagged `provisional`, and it still gates the *final* record.

**Autofocus invalidates the lens profile.** It silently changes the effective focal length, so
a session shot with autofocus active has a different camera model in every frame and the
reconstruction has no way to know. Locking optics is a metrology feature, not a convenience —
and `lens_profile_valid` is false whenever it could not be done.

**A session must survive the device.** Frames are written to IndexedDB as they are captured,
not accumulated and saved at the end, because "save at the end" makes the failure mode losing
everything rather than losing the last frame. The measurements are written before the image:
if storage runs out, the record of what was measured survives, and that is the part that
cannot be recreated from the object afterwards.

**Printers scale silently.** A card printed from a 150 mm design came out at 137.5 mm — a 92%
reduction, invisible to the eye. Using the nominal length would have made every measurement
from that session 8% wrong, and nothing downstream could have detected it. The tool asks for
the **measured** length, uses it, and tells you when it disagrees with nominal.

**Metadata can be wrong while the measurements are right.** A field session recorded
1920 × 1440 in its manifest while the photographs were 2560 × 1920: `captureProfile()` reports
the video *preview* stream, and `takePhoto()` returns a larger full-sensor still. The
measurements were computed from the still and were correct; the metadata was not, and metadata
is what a reconstruction pipeline reads.

---

## Why this exists

[`Ethical-Tech-CoLab/DPA`](https://github.com/Ethical-Tech-CoLab/DPA) defines a ten-dimension
capture rubric and states plainly in its own §10 that there are **"no metric extractors"** and
**"no mobile client"**. Turnstone is those extractors and that client.

The rubric is *data*, with every threshold in one file so the argument can be had against
specific numbers rather than against a vibe. Turnstone measures against whatever rubric it is
handed — DPA supplies `heritage-v1`, another programme supplies its own, and neither forks
this tool.

## What it is not

- **Not [Plumb](https://github.com/Ethical-Tech-CoLab/plumb).** Plumb measures flat facades
  you cannot reach; this handles solid objects you can walk around. Shared philosophy, almost
  no shared geometry.
- **Not a claim of lawful ownership.** A flawless capture of a looted object is a flawless
  capture of a looted object. `attests` / `doesNotAttest` are mandatory fields.
- **Not an input to provenance confidence.** Otherwise a museum raises an object's provenance
  score by buying a better camera.

## Licences

Code **Apache-2.0** · docs **CC BY 4.0** · rubrics and schemas **CC0**, so a rubric can be
cited, forked and argued with freely.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rules that are not up for negotiation, and
[`SECURITY.md`](SECURITY.md) for what counts as a security issue in a project that makes
claims about objects.
