"""
The job model.

---------------------------------------------------------------------------
TWO REQUIREMENTS SHAPE ALL OF THIS.

IDEMPOTENT ON CONTENT (C-13). A contributor on an unreliable connection who is
unsure whether an upload succeeded will upload again — that is not a mistake,
it is the correct thing to do. It must not produce a second reconstruction, a
second bill, or two records of one object that later have to be reconciled.
Identity therefore comes from the photographs themselves, not from the upload:
the same images re-exported with a newer build, a corrected subject name or
different compression are still the same capture.

RE-RUNNABLE FOREVER (R-8.7). The photographs are the archive and the mesh is
derived. A 2026 capture must be able to benefit from a 2034 pipeline, so a job
records exactly which backend, version and parameters produced its output, and
a new run against the same source set is a NEW job rather than an overwrite.
Overwriting would destroy the ability to compare them.
---------------------------------------------------------------------------
"""
from __future__ import annotations

import hashlib
import json
import shutil
import threading
import time
import traceback
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

from .backends import LicenceRefused, get_backend
from .config import Config
from .outputs import build_sidecar, derive_outputs
from .package import SessionPackage, extract_package, open_package, sha256_file
from .quality import finalise, load_rubric


class JobState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Job:
    id: str
    content_hash: str
    session_id: str
    subject: str | None
    backend: str
    parameters: dict
    state: str = JobState.QUEUED.value
    created_at: str = field(default_factory=_now)
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    result: dict | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def job_identity(content_hash: str, backend: str, parameters: dict) -> str:
    """
    A job's identity: these photographs, through this backend, with these
    parameters.

    Parameters are part of it because re-running at a different quality is a
    genuinely different reconstruction whose result should not silently replace
    the first. Sorting the keys means dictionary ordering cannot produce two ids
    for one request.
    """
    payload = json.dumps(
        {"content": content_hash, "backend": backend, "params": parameters},
        sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


class JobStore:
    """
    Job and artefact storage, on plain files.

    A database would be defensible and is not needed: the state is small, the
    directory is trivially backed up or inspected, and an operator can see what
    the server believes with `ls` and a text editor. That matters for software
    a museum has to trust and may have to debug without us.
    """

    def __init__(self, config: Config):
        self.config = config
        config.ensure_dirs()
        self._lock = threading.Lock()

    # ---------------------------------------------------------------- paths

    def job_dir(self, job_id: str) -> Path:
        return self.config.jobs_dir / job_id

    def package_dir(self, content_hash: str) -> Path:
        return self.config.packages_dir / content_hash

    # -------------------------------------------------------------- ingest

    def ingest(self, zip_path: Path) -> SessionPackage:
        """
        Verify and store a package, keyed by the content of its photographs.

        Re-uploading the same photographs lands on the same directory and does
        not duplicate storage — a session of several hundred full-resolution
        frames is not something to keep two copies of by accident.
        """
        staging = self.config.packages_dir / f".staging-{int(time.time()*1000)}"
        try:
            pkg = extract_package(zip_path, staging)
            final = self.package_dir(pkg.content_hash())

            with self._lock:
                if final.exists():
                    # Already have these photographs. Keep the stored copy: it
                    # is the one whose checksums were verified on arrival, and
                    # replacing it would gain nothing.
                    shutil.rmtree(staging, ignore_errors=True)
                    return open_package(final)
                staging.rename(final)

            return open_package(final)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    # ---------------------------------------------------------------- jobs

    def find(self, job_id: str) -> Job | None:
        p = self.job_dir(job_id) / "job.json"
        if not p.exists():
            return None
        return Job(**json.loads(p.read_text(encoding="utf-8")))

    def save(self, job: Job) -> None:
        d = self.job_dir(job.id)
        d.mkdir(parents=True, exist_ok=True)
        # Write-then-rename: a job file half-written by a process that died is
        # worse than no job file, because it looks readable.
        tmp = d / "job.json.tmp"
        tmp.write_text(json.dumps(job.to_dict(), indent=2), encoding="utf-8")
        tmp.replace(d / "job.json")

    def list_jobs(self, limit: int = 100) -> list[Job]:
        jobs = []
        for d in sorted(self.config.jobs_dir.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            p = d / "job.json"
            if p.exists():
                try:
                    jobs.append(Job(**json.loads(p.read_text(encoding="utf-8"))))
                except Exception:  # noqa: BLE001 — one bad file must not hide the rest
                    continue
            if len(jobs) >= limit:
                break
        return sorted(jobs, key=lambda j: j.created_at, reverse=True)

    def submit(self, pkg: SessionPackage, backend: str, parameters: dict) -> tuple[Job, bool]:
        """
        Create a job, or return the existing one.

        The boolean says which happened, so a client can tell "your upload
        started work" from "we already had this" — silently returning an old
        result would make a re-upload look like it did something.

        The backend is resolved HERE, before the job exists, so an unknown name
        or a refused licence is answered on the request that made it. Deferring
        that check to the worker would accept the job, return success, and fail
        it minutes later in a log the caller never sees — which is precisely the
        shape of failure a licence gate must not have.
        """
        get_backend(backend, allow_agpl=self.config.allow_agpl,
                    binary=self.config.backend_paths.get(backend))

        content = pkg.content_hash()
        jid = job_identity(content, backend, parameters)

        with self._lock:
            existing = self.find(jid)
            if existing is not None:
                return existing, False

            job = Job(
                id=jid, content_hash=content, session_id=pkg.session_id,
                subject=pkg.subject, backend=backend, parameters=parameters,
            )
            self.save(job)
            return job, True

    # ------------------------------------------------------------ run

    def run(self, job: Job, rubric_path: Path) -> Job:
        """
        Execute a job to completion. Synchronous by design — the caller decides
        whether to run it in a worker thread, a queue, or a batch script.
        """
        job.state = JobState.RUNNING.value
        job.started_at = _now()
        self.save(job)

        workdir = self.job_dir(job.id) / "work"
        try:
            pkg = open_package(self.package_dir(job.content_hash))
            images_dir = workdir / "images"
            images_dir.mkdir(parents=True, exist_ok=True)

            # Copy rather than symlink, and verify afterwards. The source set is
            # the archive; a backend that rewrites its inputs in place would
            # destroy it, and copy2 preserves the bytes exactly (R-8.8, C-12).
            copied: list[Path] = []
            for name in pkg.image_names:
                src = pkg.root / name
                dst = images_dir / Path(name).name
                shutil.copy2(src, dst)
                if sha256_file(src) != sha256_file(dst):
                    raise RuntimeError(f"{name} changed while being staged for reconstruction")
                copied.append(dst)

            backend = get_backend(
                job.backend,
                allow_agpl=self.config.allow_agpl,
                binary=self.config.backend_paths.get(job.backend),
            )
            result = backend.reconstruct(copied, workdir, job.parameters)

            # The photographs must be byte-identical afterwards. A backend that
            # modifies its inputs has corrupted the archive, and that has to be
            # a hard failure rather than a warning nobody reads.
            for name in pkg.image_names:
                src = pkg.root / name
                dst = images_dir / Path(name).name
                if sha256_file(src) != sha256_file(dst):
                    raise RuntimeError(
                        f"the {job.backend} backend modified {name}. The source photographs are "
                        f"the archive and must survive reconstruction unchanged."
                    )

            if not result.succeeded:
                job.state = JobState.FAILED.value
                job.error = result.failure_reason or "reconstruction failed"
                job.result = {"backend": result.backend, "version": result.version,
                              "log": result.log[-4000:]}
                job.finished_at = _now()
                self.save(job)
                return job

            rubric = load_rubric(rubric_path)
            capture_measurements = _capture_measurements(pkg)
            assessment, deferred_values = finalise(
                rubric, capture_measurements,
                image_paths=[pkg.root / n for n in pkg.image_names],
                reconstruction_metrics=result.metrics,
            )

            outputs = self._store_outputs(job, result)
            capture_class = (pkg.manifest.get("quality") or {}).get("class")

            # Stamped BEFORE the sidecar is built. The record embeds this, and a
            # record that says the reconstruction never finished is wrong about
            # the one thing it exists to attest to.
            job.finished_at = _now()

            sidecar = build_sidecar(
                job=job, package=pkg, assessment=assessment.to_dict(),
                deferred=deferred_values, backend=result.backend,
                backend_version=result.version, outputs=outputs, rubric=rubric,
            )
            sidecar_path = self.job_dir(job.id) / "outputs" / "record.json"
            sidecar_path.write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
            outputs["sidecar"] = {"file": sidecar_path.name,
                                  "bytes": sidecar_path.stat().st_size,
                                  "sha256": sha256_file(sidecar_path)}

            job.result = {
                "backend": result.backend,
                "backendVersion": result.version,
                "parameters": result.parameters,
                "outputs": outputs,
                "quality": assessment.to_dict(),
                "captureClass": capture_class,
                "classChanged": capture_class is not None and capture_class != assessment.cls,
                # Stated explicitly because a class going DOWN is the expected
                # direction and looks like a bug to anyone who has not been told.
                "classDirection": _direction(capture_class, assessment.cls),
                "deferredValues": deferred_values,
                "sourceImages": len(pkg.image_names),
                "log": result.log[-4000:],
            }
            job.state = JobState.SUCCEEDED.value
            self.save(job)
            return job

        except LicenceRefused as e:
            job.state = JobState.FAILED.value
            job.error = str(e)
            job.finished_at = _now()
            self.save(job)
            return job
        except Exception as e:  # noqa: BLE001 — a failed job must be recorded, not lost
            job.state = JobState.FAILED.value
            job.error = f"{type(e).__name__}: {e}"
            job.result = {"traceback": traceback.format_exc()[-4000:]}
            job.finished_at = _now()
            self.save(job)
            return job

    def _store_outputs(self, job: Job, result) -> dict:
        out_dir = self.job_dir(job.id) / "outputs"
        out_dir.mkdir(parents=True, exist_ok=True)
        stored: dict = {}
        for key, path in result.outputs.items():
            dst = out_dir / path.name
            shutil.copy2(path, dst)
            stored[key] = {"file": dst.name, "bytes": dst.stat().st_size,
                           "sha256": sha256_file(dst)}

        # Derive the delivery mesh and ortho views from the archive geometry.
        # Best-effort by design: the reconstruction already succeeded, and losing
        # it over a failed format conversion would be a poor trade for a
        # contributor who is no longer standing in front of the object.
        primary = None
        for key in ("mesh", "point_cloud"):
            if key in result.outputs:
                primary = out_dir / result.outputs[key].name
                break
        if primary is not None and primary.exists():
            derived, notes = derive_outputs(primary, out_dir)
            for key, path in derived.items():
                stored[key] = {"file": path.name, "bytes": path.stat().st_size,
                               "sha256": sha256_file(path)}
            if notes:
                stored["_geometry"] = notes
        return stored


def _direction(before: str | None, after: str) -> str:
    from .quality import class_rank
    if before is None:
        return "unknown"
    if class_rank(after) < class_rank(before):
        return "lowered"
    if class_rank(after) > class_rank(before):
        return "raised"
    return "unchanged"


def _capture_measurements(pkg: SessionPackage) -> dict:
    """
    Recover the capture-time measurements from the manifest.

    Frame-level values are aggregated the same way the client does — median for
    per-frame quantities — so the server's figure for a dimension is comparable
    with the one the contributor saw, rather than being a different statistic
    that happens to have the same name.
    """
    quality = pkg.manifest.get("quality") or {}
    measurements: dict = {}

    for d in quality.get("dimensions", []) or []:
        if d.get("raw") is not None:
            measurements[d["id"]] = d["raw"]

    if measurements:
        return measurements

    # Older packages carry per-frame measurements but no scored dimensions.
    frames = pkg.manifest.get("frames") or []
    vols = [f["measurements"]["vol"] for f in frames
            if f.get("measurements", {}).get("vol") is not None]
    clips = [f["measurements"]["clipping"]["worst"] for f in frames
             if (f.get("measurements", {}).get("clipping") or {}).get("worst") is not None]
    if vols:
        measurements["sharpness"] = sorted(vols)[len(vols) // 2]
    if clips:
        measurements["exposure"] = sorted(clips)[len(clips) // 2]
    return measurements
