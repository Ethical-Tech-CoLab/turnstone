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

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TURNSTONE_PORT` | `8080` | Listen port |
| `TURNSTONE_DATA_DIR` | `./data` | Packages, job state and outputs |
| `TURNSTONE_RUBRIC` | repo `rubric/heritage-v1.json` | The rubric scored against |
| `TURNSTONE_BACKEND` | `alicevision` | Default backend |
| `TURNSTONE_ALLOW_AGPL` | unset | Accept AGPL backend obligations |
| `TURNSTONE_MAX_UPLOAD_BYTES` | 8 GiB | Guard against a mis-sent file filling the disk |
| `TURNSTONE_MAX_CONCURRENT_JOBS` | `1` | Reconstruction is memory-hungry; parallelism can exhaust RAM and fail the whole batch |

---

## Tests

```bash
python -m pytest tests -q      # 37 tests, no backend required
python ../tools/server-e2e.py  # against a running server, re-runnable
```

One test runs the JavaScript scorer and the Python scorer over 200 randomised
measurement sets and requires them to agree on class, score and limiting
dimension. Two implementations of one rubric is exactly where a threshold
quietly drifts, and the failure is silent: the phone tells a contributor "study
grade" and the server later files the same capture as "indicative".

The glTF writer is checked with `pygltflib` — an independent parser. Writing a
format and reading it back with your own reader proves only self-consistency.

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
