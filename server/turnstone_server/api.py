"""
The HTTP interface.

---------------------------------------------------------------------------
The endpoints are deliberately few. This service does one thing: take a
verified session package, reconstruct it, and hand back the result together
with an honest account of its quality.

Two decisions are worth stating because they look like omissions:

NO AUTHENTICATION IS BUILT IN. This is designed to run inside DTSF's internal
network or behind an institution's own gateway, where identity is already
established. Inventing a second, weaker auth scheme here would be worse than
having none — it would look like protection while being trivially bypassed, and
it would fight whatever the host institution already runs.

UPLOADS ARE STREAMED TO DISK, NEVER HELD IN MEMORY. A session of several
hundred full-resolution photographs is gigabytes. Reading that into RAM to hash
it would take the server down at exactly the moment a contributor finally got a
connection good enough to send it.
---------------------------------------------------------------------------
"""
from __future__ import annotations

import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from .backends import LicenceRefused, describe_backends
from .config import config
from .jobs import JobStore, JobState
from .package import PackageError

RUBRIC_PATH = config.rubric_path

if not RUBRIC_PATH.exists():
    # Fail at import, not on the first job. A service that starts happily and
    # then fails every reconstruction at the last step is far harder to diagnose
    # than one that refuses to start and says why.
    raise RuntimeError(
        f"rubric not found at {RUBRIC_PATH}. Set TURNSTONE_RUBRIC to the rubric this "
        f"service should score against. Without it no quality class can be assigned, "
        f"and a reconstruction without a class is not evidence."
    )

app = FastAPI(
    title="Turnstone reconstruction service",
    version="1.0.0",
    description=(
        "Turns a Turnstone session package into a 3D reconstruction, and finalises "
        "the quality class now that the deferred dimensions can be measured."
    ),
)

store = JobStore(config)

# Reconstruction is CPU- and memory-bound, so the pool is small by default and
# the queue is where work waits. Running four reconstructions at once on one box
# makes all four slower and can exhaust RAM, which fails the batch instead of
# queueing it.
_executor = ThreadPoolExecutor(max_workers=config.max_concurrent_jobs,
                               thread_name_prefix="turnstone-job")
_inflight: set[str] = set()
_inflight_lock = threading.Lock()


def _run_job(job_id: str) -> None:
    try:
        job = store.find(job_id)
        if job is not None:
            store.run(job, RUBRIC_PATH)
    finally:
        with _inflight_lock:
            _inflight.discard(job_id)


def _dispatch(job_id: str) -> None:
    with _inflight_lock:
        if job_id in _inflight:
            return
        _inflight.add(job_id)
    _executor.submit(_run_job, job_id)


@app.get("/_health")
def health() -> dict:
    """Liveness, following the DTSF convention of a leading-underscore path."""
    return {
        "status": "ok",
        "dataDir": str(config.data_dir),
        "backend": config.default_backend,
        "queued": len(_inflight),
        "maxConcurrent": config.max_concurrent_jobs,
    }


@app.get("/backends")
def backends() -> dict:
    """
    What can run here, and under what licence.

    Exposed because the licence position is not an implementation detail to the
    institutions using this — an AGPL backend has obligations that reach their
    own deployment, and they need to see that before they choose one, not after.
    """
    return {"backends": describe_backends(config.allow_agpl),
            "default": config.default_backend,
            "agplPermitted": config.allow_agpl}


@app.post("/jobs")
async def create_job(
    package: UploadFile = File(..., description="A .zip exported by the Turnstone capture client"),
    backend: str = Form(default=""),
    quality: str = Form(default="normal"),
) -> JSONResponse:
    """
    Submit a session package.

    Returns 200 with `created: false` for a package already reconstructed with
    these settings, rather than 409. A duplicate upload is not a client error —
    it is what someone does when they are not sure the first one arrived, and it
    should be answered with the result rather than a complaint.
    """
    chosen = backend or config.default_backend
    parameters = {"quality": quality}

    tmpdir = Path(tempfile.mkdtemp(prefix="turnstone-upload-"))
    tmpzip = tmpdir / "package.zip"
    try:
        written = 0
        with tmpzip.open("wb") as f:
            while chunk := await package.read(1 << 20):
                written += len(chunk)
                if written > config.max_upload_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"package exceeds the {config.max_upload_bytes / 1024**3:.1f} GB limit. "
                            "Raise TURNSTONE_MAX_UPLOAD_BYTES if this is a genuine session."
                        ),
                    )
                f.write(chunk)

        if written == 0:
            raise HTTPException(status_code=400, detail="the uploaded package is empty")

        try:
            pkg = store.ingest(tmpzip)
        except PackageError as e:
            # 400, not 500: the package is the problem and the message says what
            # is wrong with it, so the contributor can fix and resend.
            raise HTTPException(status_code=400, detail=str(e)) from e

        try:
            job, created = store.submit(pkg, chosen, parameters)
        except LicenceRefused as e:
            raise HTTPException(status_code=403, detail=str(e)) from e
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

        if created or job.state in {JobState.QUEUED.value, JobState.FAILED.value}:
            _dispatch(job.id)

        return JSONResponse(
            status_code=200 if not created else 202,
            content={
                "job": job.to_dict(),
                "created": created,
                "sourceImages": len(pkg.image_names),
                "duplicateFrames": len(pkg.image_names) - len(pkg.digests),
                "contentHash": pkg.content_hash(),
            },
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.get("/jobs")
def list_jobs(limit: int = 50) -> dict:
    return {"jobs": [j.to_dict() for j in store.list_jobs(limit)]}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = store.find(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no job {job_id}")
    return job.to_dict()


@app.post("/jobs/{job_id}/rerun")
def rerun(job_id: str, backend: str = Form(default=""), quality: str = Form(default="normal")) -> dict:
    """
    Reconstruct stored photographs again with a different backend or settings.

    This is R-8.7, and it is why packages are stored separately from jobs: the
    photographs are the archive and the mesh is derived, so a 2026 capture must
    be able to benefit from a 2034 pipeline without anyone going back to the
    site. The new run is a NEW job — overwriting the old one would destroy the
    ability to compare them, which is usually the reason for re-running.
    """
    original = store.find(job_id)
    if original is None:
        raise HTTPException(status_code=404, detail=f"no job {job_id}")

    pkg_dir = store.package_dir(original.content_hash)
    if not pkg_dir.exists():
        raise HTTPException(
            status_code=410,
            detail="the source photographs for this job are no longer stored, so it cannot be re-run",
        )

    from .package import open_package
    pkg = open_package(pkg_dir)

    try:
        job, created = store.submit(pkg, backend or config.default_backend, {"quality": quality})
    except LicenceRefused as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if created or job.state in {JobState.QUEUED.value, JobState.FAILED.value}:
        _dispatch(job.id)
    return {"job": job.to_dict(), "created": created, "rerunOf": job_id}


@app.get("/jobs/{job_id}/outputs/{name}")
def get_output(job_id: str, name: str):
    job = store.find(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no job {job_id}")

    # Resolve and confine. A job id and filename both arrive from the network,
    # and `..` in either would otherwise read anywhere the process can.
    out_dir = (store.job_dir(job_id) / "outputs").resolve()
    target = (out_dir / name).resolve()
    if not str(target).startswith(str(out_dir)) or not target.is_file():
        raise HTTPException(status_code=404, detail=f"no output {name!r} for job {job_id}")

    return FileResponse(target, filename=target.name)


@app.get("/jobs/{job_id}/quality")
def get_quality(job_id: str) -> dict:
    """
    The final assessment on its own, with the capture-time class beside it.

    Separated from the job because this is the part a records system stores, and
    it needs the before and after together: a class that dropped after
    reconstruction is the honest outcome, but only if the record shows what it
    dropped from and which dimension caused it.
    """
    job = store.find(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no job {job_id}")
    if not job.result or "quality" not in job.result:
        raise HTTPException(status_code=409, detail=f"job {job_id} is {job.state}; no assessment yet")

    q = job.result["quality"]
    return {
        "jobId": job.id,
        "sessionId": job.session_id,
        "subject": job.subject,
        "captureClass": job.result.get("captureClass"),
        "finalClass": q["class"],
        "direction": job.result.get("classDirection"),
        "limitingDimension": q["limitingDimension"],
        "score": q["score"],
        "provisional": q["provisional"],
        "dimensions": q["dimensions"],
        "deferredValues": job.result.get("deferredValues", {}),
    }
