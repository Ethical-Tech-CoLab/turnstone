"""
Tests for the reconstruction service.

The ones that matter most here are not the happy paths — those were proven
end-to-end against a real 9-frame field package. They are:

  * that a class can go DOWN after reconstruction (C-14). The real package was
    already at the floor, so it could not demonstrate this; a synthetic one can.
  * that the Python scorer and the JavaScript scorer agree. Two implementations
    of one rubric is exactly where a threshold quietly drifts, and the failure
    is silent: the phone tells a contributor "study grade" and the server later
    files the same capture as "indicative".
"""
from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from turnstone_server.backends import LicenceRefused, get_backend  # noqa: E402
from turnstone_server.config import Config  # noqa: E402
from turnstone_server.jobs import JobStore, job_identity  # noqa: E402
from turnstone_server.package import PackageError, extract_package  # noqa: E402
from turnstone_server.quality import (  # noqa: E402
    assess, class_rank, finalise, load_rubric, normalise,
)

REPO = Path(__file__).resolve().parents[2]
RUBRIC = REPO / "rubric" / "heritage-v1.json"


@pytest.fixture(scope="session")
def rubric():
    return load_rubric(RUBRIC)


def _good_measurements(rubric):
    """Measurements that score 'reference' on every dimension."""
    m = {}
    for d in rubric["dimensions"]:
        spec = d["normalise"]
        fn = spec["fn"]
        if fn == "linear":
            m[d["id"]] = spec["ceil"]
        elif fn == "logScale":
            m[d["id"]] = spec["ceil"]
        elif fn == "logScaleInverse":
            m[d["id"]] = spec["best"]
        elif fn == "clippingFraction":
            m[d["id"]] = 0.0
    return m


def _jpeg_with_exif(path: Path, *, focal=4.2, make="Test", model="Camera") -> Path:
    """
    A real JPEG carrying the EXIF the device-metadata dimension looks for.

    Written rather than stubbed so the extraction path is genuinely exercised —
    a mocked EXIF reader would pass while the real one silently found nothing.
    """
    from PIL import Image
    img = Image.new("RGB", (64, 48), (120, 90, 60))
    exif = img.getexif()
    exif[271] = make          # Make
    exif[272] = model         # Model
    exif[37386] = focal       # FocalLength
    exif[41989] = int(focal * 6)  # FocalLengthIn35mmFilm
    img.save(path, "JPEG", exif=exif)
    return path


# --------------------------------------------------------------- rubric core

def test_rubric_has_ten_dimensions(rubric):
    assert len(rubric["dimensions"]) == 10


def test_class_is_worst_dimension_not_mean(rubric):
    """
    One bad dimension sets the class regardless of how good the rest are.

    This is the single most important property of the rubric: a mean would let
    four hundred sharp, well-exposed, well-covered photographs of a subject that
    was never in focus average out to something respectable.
    """
    m = _good_measurements(rubric)
    assert assess(rubric, m).cls == "reference"

    sharpness = next(d for d in rubric["dimensions"] if d["id"] == "sharpness")
    m["sharpness"] = sharpness["normalise"]["floor"]
    result = assess(rubric, m)
    assert result.cls == "insufficient"
    assert result.limiting == "sharpness"
    # The score stays high: it is a progress meter and is allowed to disagree.
    assert result.score > 50


def test_unmeasured_dimension_is_insufficient_not_ignored(rubric):
    m = _good_measurements(rubric)
    del m["sharpness"]
    r = assess(rubric, m)
    assert r.cls == "insufficient"
    assert next(d for d in r.dimensions if d["id"] == "sharpness")["state"] == "unmeasured"


def test_live_only_excludes_deferred_and_flags_provisional(rubric):
    """
    Only device-metadata is deferred in heritage-v1.

    surface-completeness is marked liveMeasurable BY DESIGN — that is DPA's
    position, and it is the open question recorded as OQ-1 in the spec. The
    rubric encodes their view; the server records both their live estimate and
    the post-reconstruction measurement so the question stays answerable from
    accumulated evidence rather than argument.
    """
    m = _good_measurements(rubric)
    live = assess(rubric, m, live_only=True)
    assert live.provisional is True
    assert live.deferred == ["device-metadata"]
    scored_ids = {d["id"] for d in live.dimensions}
    assert "device-metadata" not in scored_ids
    assert "surface-completeness" in scored_ids


def test_unsupported_schema_version_is_refused(tmp_path):
    bad = json.loads(RUBRIC.read_text(encoding="utf-8"))
    bad["schemaVersion"] = "2.0"
    p = tmp_path / "r.json"
    p.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError, match="schemaVersion"):
        load_rubric(p)


# ------------------------------------------------------------------ C-14

def test_post_reconstruction_completeness_can_lower_the_class(rubric, tmp_path):
    """
    C-14. The whole reason a live class is called provisional.

    A capture can orbit an object perfectly and still never see inside a cavity
    or behind a handle. Reconstruction is the first moment that is knowable, and
    the honest response is to lower the class rather than keep the optimistic
    capture-time estimate.
    """
    imgs = [_jpeg_with_exif(tmp_path / f"e{i}.jpg") for i in range(4)]

    m = _good_measurements(rubric)
    m["surface-completeness"] = 0.99

    before = assess(rubric, m, live_only=True)
    assert before.cls == "reference"
    assert before.provisional is True

    after, deferred = finalise(
        rubric, m, image_paths=imgs,
        reconstruction_metrics={"surface_completeness": 0.30},
    )
    assert class_rank(after.cls) < class_rank(before.cls), "class must be able to fall"
    assert after.limiting == "surface-completeness"
    assert after.provisional is False
    assert deferred["device-metadata"] == 1.0, "EXIF should have been found in every frame"


def test_reconstruction_that_confirms_the_estimate_leaves_the_class_alone(rubric, tmp_path):
    """The class falls only when the evidence says so, not on every finalise."""
    imgs = [_jpeg_with_exif(tmp_path / f"e{i}.jpg") for i in range(3)]
    m = _good_measurements(rubric)
    after, _ = finalise(rubric, m, image_paths=imgs,
                        reconstruction_metrics={"surface_completeness": m["surface-completeness"]})
    assert after.cls == "reference"


def test_stripped_exif_lowers_the_class(rubric, tmp_path):
    """
    Photographs shared through a messaging app arrive without EXIF.

    They can still be reconstructed, but the result can no longer be
    independently verified — there is nothing to check the recovered camera
    model against — and the class must reflect that.
    """
    from PIL import Image
    bare = []
    for i in range(3):
        p = tmp_path / f"b{i}.jpg"
        Image.new("RGB", (64, 48), (10, 10, 10)).save(p, "JPEG")
        bare.append(p)

    m = _good_measurements(rubric)
    after, deferred = finalise(rubric, m, image_paths=bare, reconstruction_metrics=None)
    assert deferred["device-metadata"] == 0.0
    assert after.cls == "insufficient"
    assert after.limiting == "device-metadata"


def test_capture_estimate_is_kept_beside_the_measured_value(rubric, tmp_path):
    """
    OQ-1. Both values are recorded, never overwritten.

    Whether surface completeness is live-measurable or only live-estimable is an
    open question, deferred until a specific artefact forces it. It stays
    answerable only if every job keeps both numbers and their difference.
    """
    imgs = [_jpeg_with_exif(tmp_path / f"e{i}.jpg") for i in range(2)]
    m = _good_measurements(rubric)
    m["surface-completeness"] = 0.95
    _, deferred = finalise(rubric, m, image_paths=imgs,
                           reconstruction_metrics={"surface_completeness": 0.62})
    sc = deferred["surface-completeness"]
    assert sc["captureEstimate"] == 0.95
    assert sc["postReconstruction"] == 0.62
    assert sc["difference"] == pytest.approx(-0.33)


def test_finalise_does_not_invent_device_metadata_when_there_are_no_images(rubric):
    """
    "Nothing to measure" must not be reported as "measured, and absent".

    Returning 0.0 for an empty set would drive the class to insufficient for a
    check that never ran.
    """
    m = _good_measurements(rubric)
    del m["device-metadata"]
    after, deferred = finalise(rubric, m, image_paths=[], reconstruction_metrics=None)
    assert "device-metadata" not in deferred
    assert next(d for d in after.dimensions if d["id"] == "device-metadata")["state"] == "unmeasured"


# ----------------------------------------------------- JS / Python agreement

def test_python_and_javascript_scorers_agree(rubric, tmp_path):
    """
    The same rubric, the same inputs, the same answer.

    Two implementations of one rubric drift silently: the phone tells a
    contributor 'study' and the server files 'indicative' for the same capture,
    and nobody notices until an institution asks why the record disagrees with
    the screenshot.
    """
    import random
    rng = random.Random(20260823)

    cases = []
    for _ in range(200):
        m = {}
        for d in rubric["dimensions"]:
            spec = d["normalise"]
            if spec["fn"] == "linear":
                lo, hi = spec["floor"], spec["ceil"]
            elif spec["fn"] == "logScale":
                lo, hi = spec["floor"], spec["ceil"]
            elif spec["fn"] == "logScaleInverse":
                lo, hi = spec["best"], spec["worst"]
            else:
                lo, hi = 0.0, spec["tolerance"] * 1.5
            span = hi - lo
            v = lo - span * 0.2 + rng.random() * span * 1.4
            if rng.random() < 0.1:
                continue  # sometimes leave a dimension unmeasured
            m[d["id"]] = round(max(v, 1e-6), 6)
        cases.append(m)

    harness = tmp_path / "harness.mjs"
    # Windows absolute paths are not valid ESM specifiers; they must be file:// URLs.
    rubric_js = (REPO / "lib" / "rubric.js").as_uri()
    harness.write_text(
        "import { readFileSync } from 'node:fs';\n"
        f"import {{ assess, loadRubric }} from {json.dumps(rubric_js)};\n"
        f"const rubric = loadRubric(JSON.parse(readFileSync({json.dumps(str(RUBRIC))}, 'utf8')));\n"
        "const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));\n"
        "const out = cases.map((m) => {\n"
        "  const a = assess(rubric, m);\n"
        "  const b = assess(rubric, m, { liveOnly: true });\n"
        "  return { cls: a.class, score: a.score, limiting: a.limitingDimension,\n"
        "           liveCls: b.class, liveScore: b.score };\n"
        "});\n"
        "process.stdout.write(JSON.stringify(out));\n",
        encoding="utf-8",
    )
    cases_file = tmp_path / "cases.json"
    cases_file.write_text(json.dumps(cases), encoding="utf-8")

    proc = subprocess.run(
        ["node", str(harness), str(cases_file)],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        pytest.fail(f"javascript harness failed:\n{proc.stderr}")

    js = json.loads(proc.stdout)
    assert len(js) == len(cases)

    for i, (m, expected) in enumerate(zip(cases, js)):
        py = assess(rubric, m)
        py_live = assess(rubric, m, live_only=True)
        assert py.cls == expected["cls"], f"case {i}: class {py.cls} vs js {expected['cls']}"
        assert py.score == expected["score"], f"case {i}: score {py.score} vs js {expected['score']}"
        assert py.limiting == expected["limiting"], f"case {i}: limiting dimension differs"
        assert py_live.cls == expected["liveCls"], f"case {i}: live class differs"
        assert py_live.score == expected["liveScore"], f"case {i}: live score differs"


def test_normalisers_clamp_outside_their_range(rubric):
    for d in rubric["dimensions"]:
        spec = d["normalise"]
        if spec["fn"] == "linear":
            assert normalise(spec, spec["floor"] - 1e6) == 0.0
            assert normalise(spec, spec["ceil"] + 1e6) == 1.0
        elif spec["fn"] == "logScale":
            assert normalise(spec, 1e-12) == 0.0
            assert normalise(spec, spec["ceil"] * 1e6) == 1.0
        elif spec["fn"] == "logScaleInverse":
            assert normalise(spec, spec["worst"] * 1e6) == 0.0
            assert normalise(spec, spec["best"] / 1e6) == 1.0


# ------------------------------------------------------------------ packages

def _make_package(tmp_path: Path, name="p.zip", *, images=2, manifest=None, extra=None) -> Path:
    from PIL import Image
    zpath = tmp_path / name
    m = manifest if manifest is not None else {
        "format": "turnstone-session/1",
        "session": {"id": "s_test", "subject": "test object"},
        "frames": [],
    }
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.writestr("manifest.json", json.dumps(m))
        for i in range(images):
            img = tmp_path / f"tmp{i}.jpg"
            Image.new("RGB", (64, 48), (i * 30 % 255, 100, 150)).save(img, "JPEG")
            zf.write(img, f"images/frame{i:03d}.jpg")
        for n, data in (extra or {}).items():
            zf.writestr(n, data)
    return zpath


def test_package_without_images_is_refused(tmp_path):
    z = _make_package(tmp_path, images=0)
    with pytest.raises(PackageError, match="no photographs"):
        extract_package(z, tmp_path / "out")


def test_package_with_wrong_format_is_refused(tmp_path):
    z = _make_package(tmp_path, manifest={"format": "something-else/9"})
    with pytest.raises(PackageError, match="unsupported package format"):
        extract_package(z, tmp_path / "out")


def test_zip_traversal_is_refused(tmp_path):
    """An uploaded archive is untrusted input; `..` inside it is the oldest trick there is."""
    z = tmp_path / "evil.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("manifest.json", json.dumps({"format": "turnstone-session/1"}))
        zf.writestr("../../escaped.txt", "should never be written")
    with pytest.raises(PackageError, match="unsafe paths"):
        extract_package(z, tmp_path / "out")
    assert not (tmp_path.parent / "escaped.txt").exists()


def test_wrong_checksum_is_a_hard_failure(tmp_path):
    z = _make_package(tmp_path, extra={
        "SHA256SUMS.txt": f"{'0' * 64}  images/frame000.jpg\n"
    })
    with pytest.raises(PackageError, match="do not match their checksum"):
        extract_package(z, tmp_path / "out")


def test_content_hash_ignores_the_manifest(tmp_path):
    """
    Re-exporting the same photographs with a corrected subject name is the same
    capture, and must not produce a second reconstruction.
    """
    from PIL import Image
    imgs = []
    for i in range(3):
        p = tmp_path / f"i{i}.jpg"
        Image.new("RGB", (32, 32), (i * 40, 90, 200)).save(p, "JPEG")
        imgs.append(p)

    def build(name, subject):
        z = tmp_path / name
        with zipfile.ZipFile(z, "w") as zf:
            zf.writestr("manifest.json", json.dumps({
                "format": "turnstone-session/1",
                "session": {"id": "s_" + subject, "subject": subject},
            }))
            for i, p in enumerate(imgs):
                zf.write(p, f"images/f{i}.jpg")
        return z

    a = extract_package(build("a.zip", "statue"), tmp_path / "oa")
    b = extract_package(build("b.zip", "Statue of Someone"), tmp_path / "ob")
    assert a.content_hash() == b.content_hash()


def test_duplicate_frames_are_visible_not_double_counted(tmp_path):
    from PIL import Image
    p = tmp_path / "one.jpg"
    Image.new("RGB", (32, 32), (10, 20, 30)).save(p, "JPEG")
    z = tmp_path / "d.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("manifest.json", json.dumps({"format": "turnstone-session/1"}))
        zf.write(p, "images/a.jpg")
        zf.write(p, "images/b.jpg")
    pkg = extract_package(z, tmp_path / "out")
    assert len(pkg.image_names) == 2
    assert len(pkg.digests) == 1, "a duplicate frame contributes no new viewpoint"


# ---------------------------------------------------------------- job model

def test_job_identity_is_stable_across_key_order():
    a = job_identity("abc", "alicevision", {"quality": "high", "mesh": True})
    b = job_identity("abc", "alicevision", {"mesh": True, "quality": "high"})
    assert a == b


def test_job_identity_changes_with_backend_and_parameters():
    base = job_identity("abc", "alicevision", {"quality": "normal"})
    assert base != job_identity("abc", "colmap", {"quality": "normal"})
    assert base != job_identity("abc", "alicevision", {"quality": "high"})
    assert base != job_identity("xyz", "alicevision", {"quality": "normal"})


def test_resubmitting_the_same_package_returns_the_same_job(tmp_path):
    cfg = Config(data_dir=tmp_path / "data")
    store = JobStore(cfg)
    z = _make_package(tmp_path, images=3)

    pkg1 = store.ingest(z)
    job1, created1 = store.submit(pkg1, "simulated", {"quality": "normal"})
    pkg2 = store.ingest(z)
    job2, created2 = store.submit(pkg2, "simulated", {"quality": "normal"})

    assert created1 is True and created2 is False
    assert job1.id == job2.id
    assert len(list((cfg.packages_dir).iterdir())) == 1, "the package was stored twice"


def test_agpl_backend_is_refused_at_submission_not_after(tmp_path):
    """
    The refusal must land on the request that asked for it.

    Checking the licence inside the worker would accept the job, answer 202, and
    fail it minutes later in a log nobody reads — the one shape of failure a
    licence gate must not have.
    """
    cfg = Config(data_dir=tmp_path / "data", allow_agpl=False)
    store = JobStore(cfg)
    pkg = store.ingest(_make_package(tmp_path, images=2))
    with pytest.raises(LicenceRefused, match="AGPL"):
        store.submit(pkg, "openmvs", {})
    assert not any(cfg.jobs_dir.iterdir()), "a refused job must not be recorded"


def test_agpl_backend_is_permitted_once_acknowledged():
    b = get_backend("openmvs", allow_agpl=True)
    assert b.id == "openmvs"


def test_excluded_licences_are_not_in_the_registry():
    """
    VGGT (bespoke Meta research licence) and MASt3R (CC BY-NC-SA, non-commercial)
    cannot be offered by a service institutions may charge for. Excluded in code,
    not in a document.
    """
    for name in ("vggt", "mast3r", "dust3r"):
        with pytest.raises(ValueError, match="unknown backend"):
            get_backend(name, allow_agpl=True)


def test_simulated_backend_runs_without_any_software_installed(tmp_path):
    """
    The simulated backend is a first-class backend, not a test mock: the service
    must be exercisable — and the API demonstrable — on a machine with no
    reconstruction software at all.
    """
    from PIL import Image
    imgs = []
    for i in range(4):
        p = tmp_path / f"s{i}.jpg"
        Image.new("RGB", (32, 32), (i * 50, 10, 10)).save(p, "JPEG")
        imgs.append(p)

    b = get_backend("simulated")
    result = b.reconstruct(imgs, tmp_path / "work", {})
    assert result.succeeded
    assert result.outputs
    ply = next(iter(result.outputs.values()))
    assert ply.read_bytes().startswith(b"ply\n"), "must emit a real, parseable PLY"
    assert (ply.parent / "SIMULATED.txt").exists(), "simulated output must say so on disk"


def test_full_run_produces_a_final_non_provisional_assessment(tmp_path):
    cfg = Config(data_dir=tmp_path / "data")
    store = JobStore(cfg)
    pkg = store.ingest(_make_package(tmp_path, images=4))
    job, _ = store.submit(pkg, "simulated", {"quality": "normal"})
    done = store.run(job, RUBRIC)

    assert done.state == "succeeded", done.error
    assert done.result["quality"]["provisional"] is False
    assert done.result["sourceImages"] == 4
    assert done.result["outputs"]


def test_source_images_survive_reconstruction_byte_identical(tmp_path):
    """C-12 / R-8.8. The photographs are the archive; the mesh is derived."""
    import hashlib
    cfg = Config(data_dir=tmp_path / "data")
    store = JobStore(cfg)
    z = _make_package(tmp_path, images=3)
    pkg = store.ingest(z)

    before = {n: hashlib.sha256((pkg.root / n).read_bytes()).hexdigest() for n in pkg.image_names}
    job, _ = store.submit(pkg, "simulated", {})
    store.run(job, RUBRIC)
    after = {n: hashlib.sha256((pkg.root / n).read_bytes()).hexdigest() for n in pkg.image_names}
    assert before == after

    with zipfile.ZipFile(z) as zf:
        for n in pkg.image_names:
            assert hashlib.sha256(zf.read(n)).hexdigest() == after[n]


def test_a_failed_job_is_recorded_rather_than_lost(tmp_path):
    cfg = Config(data_dir=tmp_path / "data")
    store = JobStore(cfg)
    pkg = store.ingest(_make_package(tmp_path, images=2))
    job, _ = store.submit(pkg, "simulated", {})

    # Remove the stored photographs out from under the job.
    import shutil
    shutil.rmtree(store.package_dir(job.content_hash))

    done = store.run(job, RUBRIC)
    assert done.state == "failed"
    assert done.error
    assert store.find(job.id).state == "failed", "the failure must be readable back from disk"


# ------------------------------------------------------------------- outputs

def _cube() -> "Mesh":
    from turnstone_server.outputs import Mesh
    v = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
         (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    f = [(0, 1, 2), (0, 2, 3), (4, 6, 5), (4, 7, 6), (0, 4, 5), (0, 5, 1),
         (1, 5, 6), (1, 6, 2), (2, 6, 7), (2, 7, 3), (3, 7, 4), (3, 4, 0)]
    return Mesh(vertices=[tuple(map(float, x)) for x in v], faces=f)


def test_ply_round_trips_through_ascii(tmp_path):
    from turnstone_server.outputs import read_ply
    mesh = _cube()
    p = tmp_path / "c.ply"
    lines = ["ply", "format ascii 1.0", f"element vertex {len(mesh.vertices)}",
             "property float x", "property float y", "property float z",
             f"element face {len(mesh.faces)}", "property list uchar int vertex_index",
             "end_header"]
    lines += [f"{x} {y} {z}" for x, y, z in mesh.vertices]
    lines += [f"3 {a} {b} {c}" for a, b, c in mesh.faces]
    p.write_bytes(("\n".join(lines) + "\n").encode())

    got = read_ply(p)
    assert got.vertices == mesh.vertices
    assert got.faces == mesh.faces


def test_ply_reads_binary_little_endian(tmp_path):
    import struct
    from turnstone_server.outputs import read_ply
    mesh = _cube()
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {len(mesh.vertices)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        f"element face {len(mesh.faces)}\n"
        "property list uchar int vertex_index\nend_header\n"
    ).encode()
    body = b"".join(struct.pack("<3f", *v) for v in mesh.vertices)
    body += b"".join(struct.pack("<B3i", 3, *f) for f in mesh.faces)
    p = tmp_path / "b.ply"
    p.write_bytes(header + body)

    got = read_ply(p)
    assert len(got.vertices) == 8
    assert got.faces == mesh.faces


def test_ply_with_unsupported_format_is_refused(tmp_path):
    from turnstone_server.outputs import PlyError, read_ply
    p = tmp_path / "be.ply"
    p.write_bytes(b"ply\nformat binary_big_endian 1.0\nelement vertex 1\n"
                  b"property float x\nend_header\n\x00\x00\x00\x00")
    with pytest.raises(PlyError, match="unsupported PLY format"):
        read_ply(p)


def test_glb_is_valid_to_an_independent_parser(tmp_path):
    """
    Checked with pygltflib, not with our own reader.

    Writing a format and then reading it back with the same code proves only
    that it is self-consistent. The question that matters is whether anything
    else can open it.
    """
    pygltflib = pytest.importorskip("pygltflib")
    from turnstone_server.outputs import write_glb

    out = write_glb(_cube(), tmp_path / "model.glb")
    g = pygltflib.GLTF2().load(str(out))

    assert g.asset.version == "2.0"
    assert len(g.meshes) == 1
    prim = g.meshes[0].primitives[0]
    assert prim.mode == 4, "a mesh with faces must be TRIANGLES"

    pos = g.accessors[prim.attributes.POSITION]
    assert pos.count == 8
    assert pos.type == "VEC3"
    # Required by the glTF spec; without them a viewer cannot frame the model
    # and opens to an empty screen.
    assert pos.min == [0.0, 0.0, 0.0]
    assert pos.max == [1.0, 1.0, 1.0]

    idx = g.accessors[prim.indices]
    assert idx.count == 36, "12 triangles"

    # The vertex data must survive the trip, not merely be structurally present.
    blob = g.binary_blob()
    view = g.bufferViews[pos.bufferView]
    import struct
    verts = struct.unpack_from("<24f", blob, view.byteOffset)
    assert set(verts) == {0.0, 1.0}


def test_point_cloud_is_written_as_points_not_a_broken_mesh(tmp_path):
    pygltflib = pytest.importorskip("pygltflib")
    from turnstone_server.outputs import Mesh, write_glb

    cloud = Mesh(vertices=[(float(i), 0.0, 0.0) for i in range(10)])
    out = write_glb(cloud, tmp_path / "cloud.glb")
    g = pygltflib.GLTF2().load(str(out))
    prim = g.meshes[0].primitives[0]
    assert prim.mode == 0, "a point cloud must render as POINTS"
    assert prim.indices is None


def test_ortho_views_are_deterministic(tmp_path):
    """
    Byte-identical across runs.

    These feed the perceptual mesh hash in phase 5. A renderer that varies by a
    pixel between runs makes the hash meaningless without anyone noticing.
    """
    import hashlib
    from turnstone_server.outputs import render_ortho_views

    a = render_ortho_views(_cube(), tmp_path / "a")
    b = render_ortho_views(_cube(), tmp_path / "b")
    assert len(a) == 6, "six views, one down each axis"

    for key in a:
        ha = hashlib.sha256(a[key].read_bytes()).hexdigest()
        hb = hashlib.sha256(b[key].read_bytes()).hexdigest()
        assert ha == hb, f"{key} is not reproducible"


def test_ortho_views_actually_contain_the_object(tmp_path):
    """A renderer that silently produces six blank pages would pass a hash test."""
    from PIL import Image
    from turnstone_server.outputs import render_ortho_views

    views = render_ortho_views(_cube(), tmp_path / "v")
    for key, p in views.items():
        img = Image.open(p).convert("L")
        colours = img.getcolors(maxcolors=256 * 256)
        non_white = sum(n for n, val in colours if val < 250)
        assert non_white > 1000, f"{key} looks blank ({non_white} marked pixels)"


def test_a_full_job_produces_the_declared_artefacts(tmp_path):
    cfg = Config(data_dir=tmp_path / "data")
    store = JobStore(cfg)
    pkg = store.ingest(_make_package(tmp_path, images=3))
    job, _ = store.submit(pkg, "simulated", {})
    done = store.run(job, RUBRIC)

    assert done.state == "succeeded", done.error
    outputs = done.result["outputs"]
    assert "point_cloud" in outputs, "archive geometry"
    assert "delivery_mesh" in outputs, "glTF delivery mesh"
    assert "sidecar" in outputs, "the record"
    assert sum(1 for k in outputs if k.startswith("ortho_")) == 6

    out_dir = store.job_dir(job.id) / "outputs"
    record = json.loads((out_dir / "record.json").read_text(encoding="utf-8"))
    assert record["sourceImages"]["count"] == 3
    assert record["quality"]["provisional"] is False
    assert record["rubric"]["id"] == "heritage-v1"
    # E57 is asked for by the spec and is not produced. It must be declared
    # absent by decision rather than quietly missing.
    assert "e57" in record["notProduced"]

    # The record embeds the finish time, so it must be stamped before the record
    # is written — and it must agree with the job, not be a second reading of
    # the clock.
    assert record["reconstruction"]["startedAt"], "record has no start time"
    assert record["reconstruction"]["finishedAt"], "record says the job never finished"
    assert record["reconstruction"]["finishedAt"] == done.finished_at


def test_output_derivation_failure_does_not_fail_the_reconstruction(tmp_path, monkeypatch):
    """
    A reconstruction that succeeded must not be thrown away because a delivery
    format could not be derived.
    """
    from turnstone_server import outputs as outputs_mod

    def boom(*a, **k):
        raise RuntimeError("synthetic conversion failure")

    monkeypatch.setattr(outputs_mod, "read_ply", boom)

    cfg = Config(data_dir=tmp_path / "data")
    store = JobStore(cfg)
    pkg = store.ingest(_make_package(tmp_path, images=2))
    job, _ = store.submit(pkg, "simulated", {})
    done = store.run(job, RUBRIC)

    assert done.state == "succeeded"
    assert "point_cloud" in done.result["outputs"]
    assert "delivery_mesh" not in done.result["outputs"]
    assert "synthetic conversion failure" in json.dumps(done.result["outputs"]["_geometry"])
