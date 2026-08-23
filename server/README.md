# Turnstone reconstruction service

Takes a session package captured in the browser, reconstructs it, and finalises
the quality class now that the dimensions deferred at capture time can actually
be measured.

The capture client scores what it can while the contributor is still standing in
front of the object, and marks the result **provisional**. This service produces
the final assessment — and **the class is allowed to go down**. That is the
honest direction: a capture-time estimate measures what the camera pointed at,
not what was actually recovered.

---

## Run it

```bash
pip install -r requirements.txt
TURNSTONE_DATA_DIR=./data TURNSTONE_BACKEND=simulated python -m turnstone_server
```

Then `http://127.0.0.1:8080/docs`.

No reconstruction software is required to try it. The `simulated` backend is a
first-class backend, not a test mock, precisely so the service is demonstrable
and testable on a machine with nothing installed. It emits a real, parseable PLY
and writes `SIMULATED.txt` beside it, so its output can never be mistaken for a
record of an object.

### With Docker

```bash
docker compose -f deploy/docker-compose.yaml up --build
```

> The container definition has **not been built or run** — the machine it was
> written on has no Docker engine and no WSL. It follows the DTSF house pattern
> and its YAML is checked in CI, but treat the first real build as unproven.

---

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/_health` | Liveness, DTSF convention |
| `GET` | `/backends` | What can run here, and under what licence |
| `POST` | `/jobs` | Submit a session package (`multipart/form-data`, field `package`) |
| `GET` | `/jobs` | Recent jobs |
| `GET` | `/jobs/{id}` | One job, with its result |
| `GET` | `/jobs/{id}/quality` | Final assessment, with the capture-time class beside it |
| `GET` | `/jobs/{id}/export/crmdig` | CIDOC-CRM / CRMdig provenance graph, for a collections system |
| `GET` | `/jobs/{id}/export/iiif` | IIIF 3D manifest, for delivery (follows a **draft**) |
| `GET` | `/jobs/{id}/outputs/{name}` | Download an output file |
| `POST` | `/jobs/{id}/rerun` | Reconstruct the stored photographs again with a different backend or settings |

---

## The four properties this service exists to hold

**The photographs are the archive; the mesh is derived.** Source images are
stored byte-identical to what the camera produced — never re-encoded, resized or
stripped of EXIF. A job verifies this *after* reconstruction and fails hard if a
backend touched its inputs. A 2026 capture must be able to benefit from a 2034
pipeline, and that is only true if the bytes survive.

**Idempotent on content.** A contributor on an unreliable connection who is
unsure whether an upload succeeded will upload again — that is the correct thing
to do, not a mistake. Identity comes from the sorted SHA-256 digests of the
photographs, so the same images re-exported with a newer build, a corrected
subject name or different compression are still the same capture, and produce
the same job rather than a second reconstruction.

**The class is the worst dimension, never the mean.** Four hundred photographs
that are all out of focus produce an out-of-focus mesh, and no amount of
excellent angular coverage buys that back. The *score* is a separate progress
meter and is allowed to disagree with the class.

**The licence gate is code, not documentation.**

| Backend | Licence | Default |
| --- | --- | --- |
| AliceVision / Meshroom | MPL-2.0 | **enabled** — file-level copyleft does not reach across a process boundary, so an institution can self-host without a licence conversation |
| COLMAP | BSD core, GPL/AGPL dependencies | enabled, dependency-dependent |
| OpenMVS | AGPL-3.0 | **refused** unless `TURNSTONE_ALLOW_AGPL=1` |
| VGGT, MASt3R, DUSt3R | bespoke research / CC BY-NC-SA | **excluded entirely** — non-commercial terms cannot bind a service an institution may charge for |

The AGPL refusal happens *at submission*, on the request that asked for it —
never in a worker thread minutes later, in a log nobody reads.

---

## Outputs

| Artefact | Key | Notes |
| --- | --- | --- |
| Archive geometry | `point_cloud` / `mesh` | As the backend produced it, never simplified |
| Delivery mesh | `delivery_mesh` | glTF 2.0 binary (`.glb`); point clouds render as `POINTS`, not as a mesh that failed |
| Ortho views | `ortho_front` … ×6 | Deterministic PNGs, input to the phase-5 perceptual mesh hash |
| Sidecar record | `sidecar` | `record.json` — rubric identity, both classes, deferred values |
| Source set | — | Byte-identical, under `packages/<content-hash>/images/` |

**E57 is not produced.** The spec asks for it and it is the ISO-recognised
point-cloud standard, but writing its XML-plus-CompressedVector structure without
`libE57Format` risks a file that opens in one program and fails in the one a
conservator uses. It is declared absent in `record.json` under `notProduced`
rather than faked. The PLY is the archive geometry.

Derivation is best-effort: a reconstruction that succeeded is never discarded
because a delivery format could not be produced. The failure is recorded in the
`_geometry` note instead.

---

## Provenance: the record and the binding

C2PA's normative format list is JPEG, PNG, GIF, TIFF, BMFF video and PDF. **glTF, USDZ,
E57 and PLY are absent.** Photographs can be sealed to a very high standard and the mesh
built from them inherits none of it — the chain breaks at exactly the step that produces
the artefact anyone will look at.

The `ReconstructionBinding` spans that gap: a signed statement that these photographs,
through this pipeline, produced this mesh.

**`chainComplete` is true only when every source image carried a verifiable seal.** Not
most. A chain that is 90% sealed is not 90% of a proof — the unsealed 10% is precisely
where a substituted photograph would be inserted, because an attacker picks where to
attack rather than spreading tampering evenly to keep a percentage looking respectable.
The counts are reported for diagnosis; only the boolean means anything.

> Today `chainComplete` is **false for every capture**: the browser client cannot yet
> produce a C2PA capture-time seal. That is the correct answer, and it names exactly what
> is missing before the chain closes.

Two hashes cover the output, and they are not interchangeable:

| | Proves | Survives re-export |
| --- | --- | --- |
| `outputHash` | yes — exact, cryptographic | no |
| `outputPerceptualHash` | **no** — dHash is not collision-resistant | yes |

The perceptual hash re-associates a metadata-stripped copy so a human can then check the
real one. Treating it as evidence of identity would let anyone who can make a
similar-looking mesh claim to hold the original.

### Signing, and what is deliberately not solved

Bindings are signed with **Ed25519**. A test has Node verify a signature made here — a
signature only one codebase can check is not much of a signature.

**Key management is not solved by this service, and that is deliberate.** A key it
generated and stored beside the data it signs would prove nothing: whoever can alter a
binding can re-sign it. That is theatre, and theatre is worse than an honest absence
because it reads as assurance.

```bash
# 32 raw bytes. Supply a key from whatever already establishes your identity.
TURNSTONE_SIGNING_KEY=/run/secrets/turnstone.key \
TURNSTONE_SIGNING_KEY_ID=your-institution \
python -m turnstone_server
```

With no key configured, bindings are emitted **unsigned and say so** in a field a consumer
cannot miss. A key path that does not exist is a **hard failure**, never a silent fall back
— an operator who thought they were signing would otherwise not find out until someone
tried to verify, long after the capture.

### Verifying

```bash
python ../tools/verify-reconstruction.py <job>/outputs --key <hex>
```

Answers four questions separately, because collapsing them into one "VALID" would be worse
than useless: is the record coherent, do the artefacts match their hashes, was the binding
altered since signing, and is the chain actually complete. "Signed by someone" and "signed
by someone you trust" are different facts.

---

## Disclosure defaults

Capture assets **never** default to public.

| Material | Default tier |
| --- | --- |
| Ordinary | `museum` |
| Funerary | `source-community` |
| Sacred | `source-community` |
| *anything unrecognised* | `source-community` — fails closed |

A mesh is a replication asset: good enough to study is good enough to 3D-print or forge
from. Disclosure may be **restricted** by argument but never **relaxed** — relaxing is a
decision someone must own, and it does not belong somewhere a typo can make it.

> **Known gap, carried from DPA and deliberately unresolved:** the `source-community` tier
> was designed with no source-community input. That was tolerable when the system described
> objects in text; it is not tolerable for photorealistic models of funerary material. It
> travels **inside every record** as `disclosureGap`, because a consumer deciding what to do
> with such an asset cannot see our backlog. Marking it resolved without consultation would
> be the precise error the tier exists to prevent.

---

## Exporting for museums and for delivery

```bash
curl localhost:8080/jobs/<id>/export/crmdig        # CIDOC-CRM / CRMdig, JSON-LD
curl localhost:8080/jobs/<id>/export/iiif          # IIIF 3D manifest
```

The CRMdig graph follows the real chain of events, because that is what the ontology
exists to express:

```
E22 Human-Made Object          the artefact
  ← L1 digitized —
D2 Digitization Process        the capture session
  — L11 had output →           the photographs (D1 Digital Object)
  — L10 had input →
D10 Software Execution         the reconstruction
  — L23 used software →        the backend (D14 Software)
  — L11 had output →           the mesh (D1 Digital Object)
```

Quality and the binding attach as `E31 Document` / `P70 documents`. That keeps an assertion
**about** the mesh distinct from a property **of** it — the quality class is a claim someone
made, attributable and disputable, not an intrinsic fact about a file.

**Every term is checked against [`record/vocabulary-v1.json`](../record/vocabulary-v1.json)
at emit time.** Interop fails in a particular way: an invented class name produces a
document that parses, validates as JSON, looks entirely plausible to its author, and means
nothing to the system it was written for — discovered only when an institution tries to
ingest it, usually long after everyone involved has moved on. A term not in the vocabulary
**cannot be written**. Output is verified by expansion under `pyld`, an independent JSON-LD
processor; checking it with our own reader would prove only self-consistency.

> **IIIF 3D is a draft.** It defines `Scene` — absent from Presentation API 3.0 — and targets
> Presentation API 4, whose context URI is not yet published. Every manifest says so **in its
> own `summary`**, where someone opening the file will read it. Expect to regenerate manifests
> when the specification settles.

The manifest carries the legitimacy disclaimer as `requiredStatement`, and states an
incomplete chain of custody and a non-public disclosure tier in its summary. A manifest *is*
a delivery format, and one built from a record that is not cleared for public delivery must
not look like a publication.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TURNSTONE_PORT` | `8080` | Listen port |
| `TURNSTONE_DATA_DIR` | `./data` | Packages, job state and outputs |
| `TURNSTONE_RUBRIC` | repo `rubric/heritage-v1.json` | The rubric scored against |
| `TURNSTONE_DISCLAIMERS` | repo `record/disclaimers-v1.json` | Exact text of what a record attests |
| `TURNSTONE_SIGNING_KEY` | unset | Path to a raw 32-byte Ed25519 seed; unset means unsigned |
| `TURNSTONE_SIGNING_KEY_ID` | unset | Identifier recorded in the signature |
| `TURNSTONE_BACKEND` | `alicevision` | Default backend |
| `TURNSTONE_ALLOW_AGPL` | unset | Accept AGPL backend obligations |
| `TURNSTONE_MAX_UPLOAD_BYTES` | 8 GiB | Guard against a mis-sent file filling the disk |
| `TURNSTONE_MAX_CONCURRENT_JOBS` | `1` | Reconstruction is memory-hungry; parallelism can exhaust RAM and fail the whole batch |

---

## Tests

```bash
python -m pytest tests -q      # 91 tests, no backend required
python ../tools/server-e2e.py  # against a running server, re-runnable
python ../tools/check-verifier.py   # damages a real package 8 ways; each must be caught
```

Cross-implementation checks, because each of these fails silently if it drifts:

- the JavaScript and Python **scorers** must agree on class, score and limiting dimension
  across 200 randomised measurement sets;
- the **disclaimer text** must be byte-identical — a paraphrased legal statement is a
  different statement, and nothing in a record would show which wording was used;
- **Node must verify an Ed25519 signature made by Python**, over canonical bytes both
  implementations produce identically;
- the **perceptual hash** must match across both, since a hash that disagrees cannot
  re-associate anything, which is its only job.

The glTF writer is checked with `pygltflib` — an independent parser. Writing a format and
reading it back with your own reader proves only self-consistency. The CRMdig export is
checked the same way, with `pyld`.

## Storage layout

```
data/
  packages/<content-hash>/    the photographs, verified on arrival, stored once
  jobs/<job-id>/
    job.json                  written by rename, never half-written in place
    work/images/              staged copies handed to the backend
    outputs/                  meshes, point clouds, with sizes and digests
```

Plain files rather than a database. The state is small, the directory is
trivially backed up or inspected, and an operator can see what the server
believes with `ls` and a text editor — which matters for software a museum has
to trust and may have to debug without us.
