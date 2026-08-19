# Turnstone

**3D records of cultural objects, from every side.**

A tool for photographing a statue, vessel, mask or carved fragment so that the resulting 3D
model is *worth something afterwards* — carrying a machine-readable statement of how good it
is and what it may be relied upon for.

> **Name provisional.** A turnstone is a shorebird that feeds by flipping stones over to see
> what is underneath — the most-skipped part of object capture. The name reaches only this
> folder and one constant, so changing it is a rename. See
> [`PHOTOGRAMMETRY-CONCEPT.md` §9](PHOTOGRAMMETRY-CONCEPT.md).

---

## Status: Phase 0

| | |
|---|---|
| ✅ Research | 92 Tavily queries, licences verified at source ([`research/`](research)) |
| ✅ Concept + recommendations | [`PHOTOGRAMMETRY-CONCEPT.md`](PHOTOGRAMMETRY-CONCEPT.md) |
| ✅ Specification | [`PHOTOGRAMMETRY-SPEC.md`](PHOTOGRAMMETRY-SPEC.md) — 41 requirements, 14 conformance tests |
| ✅ Rubric as data | [`rubric/heritage-v1.json`](rubric/heritage-v1.json) — DPA's ten dimensions, transcribed mechanically |
| ✅ Scoring engine | [`lib/rubric.js`](lib/rubric.js) — worst-dimension class, progress score, limiting dimension |
| ✅ Overlap geometry | [`lib/overlap.js`](lib/overlap.js) — distance cancels, so guidance needs no depth sensor |
| ⬜ Metric extractors | Spec §6 — the gap DPA names |
| ⬜ Capture client | Spec §7 |
| ⬜ Reconstruction server | Spec §8 |

```
node --test turnstone/test/conformance.test.mjs     # 18 passing
```

---

## Why this exists

`Ethical-Tech-CoLab/DPA` defines a ten-dimension capture rubric and states plainly in its own
§10 that there are **"no metric extractors"** and **"no mobile client"**. Turnstone is that
missing client and those missing extractors.

The division of labour is already the shape of DPA's code: the rubric is *data*, with every
threshold in one file so the argument can be had against specific numbers. Turnstone is the
engine that measures against whatever rubric it is handed — DPA supplies `heritage-v1`,
another programme supplies its own, and neither forks this tool.

## What it is not

- **Not [Plumb](https://ethical-tech-colab.github.io/plumb/).** Plumb measures flat facades
  you cannot reach. This handles solid objects you can walk around. Shared philosophy, almost
  no shared geometry.
- **Not a claim of lawful ownership.** A flawless capture of a looted object is a flawless
  capture of a looted object. `attests` / `doesNotAttest` are mandatory fields.
- **Not an input to provenance confidence.** Otherwise a museum raises an object's provenance
  score by buying a better camera. Enforced at the module boundary.

## Three findings that shaped it

1. **The two most impressive recent methods are not open source.** VGGT (14.2k stars — the
   most of any tool in the space) is under a bespoke Meta *research* licence; MASt3R is
   CC BY-NC-SA, **non-commercial**. Neither can sit under a tool museums self-host.
2. **The best dense reconstruction is AGPL.** OpenMVS makes the meshes people want and its
   network clause reaches a hosted service. Default is AliceVision/Meshroom (MPL-2.0);
   OpenMVS is opt-in behind an explicit acknowledgement.
3. **Distance cancels in the overlap geometry.** Overlap depends only on angular step and how
   much of the frame the object fills — so live guidance works with no depth sensor.

## Licences

Code Apache-2.0 · docs CC BY 4.0 · rubrics and schemas CC0, so a rubric can be cited,
forked and argued with freely.
