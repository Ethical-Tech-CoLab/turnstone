# Turnstone

**3D records of cultural objects, from every side.**

### ▶ [**Try it live — ethical-tech-colab.github.io/turnstone**](https://ethical-tech-colab.github.io/turnstone/)

*Runs in any browser. Tap **Run demo** to watch a capture session score itself, or **Camera**
to point it at a real object. Every number is computed from actual pixels — nothing is
simulated.*

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
| ⬜ Phase 2 | Full capture client: full-resolution stills, session store, offline |
| ⬜ Phase 3 | Printable target: scale bar, colour patches, fiducials, masking |
| ⬜ Phase 4 | Reconstruction server (Docker, AliceVision) |

```bash
node --test test/conformance.test.mjs test/metrics.test.mjs test/guidance.test.mjs   # 76 passing
node tools/validate-rubrics.mjs        # rubric files load and score
node tools/demo-probe.mjs              # drives the demo in headless Chrome
```

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

### Four things that are easy to get wrong

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
