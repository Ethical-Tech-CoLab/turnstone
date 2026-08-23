"""
Configuration.

Environment variables are prefixed TURNSTONE_ to match the DTSF house style, so
this drops into that infrastructure without a translation layer.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _path(env: str, default: str) -> Path:
    return Path(os.environ.get(env, default)).resolve()


@dataclass
class Config:
    """Runtime configuration, resolved once at import."""

    port: int = int(os.environ.get("TURNSTONE_PORT", "8080"))

    #: Where ingested packages, job state and outputs live. A single directory
    #: so the whole service can be backed up, moved, or mounted read-only for
    #: inspection without hunting for scattered state.
    data_dir: Path = _path("TURNSTONE_DATA_DIR", "./data")

    #: Which reconstruction backend to use unless a request says otherwise.
    #:
    #: AliceVision is MPL-2.0 — file-level copyleft that does not reach across a
    #: process boundary — so a museum can self-host this without a licence
    #: conversation. That is the whole reason it is the default.
    default_backend: str = os.environ.get("TURNSTONE_BACKEND", "alicevision")

    #: AGPL-3.0 backends are refused unless this is set. See backends.py for why
    #: this is a deliberate gate rather than a configuration detail.
    allow_agpl: bool = os.environ.get("TURNSTONE_ALLOW_AGPL", "").lower() in {"1", "true", "yes"}

    #: Upper bound on an uploaded package. Not a security boundary — it is a
    #: guard against a mis-sent file filling the disk of a shared server.
    max_upload_bytes: int = int(os.environ.get("TURNSTONE_MAX_UPLOAD_BYTES", str(8 * 1024**3)))

    #: How many reconstructions may run at once. Reconstruction is CPU- and
    #: memory-hungry; running several on one box makes them all slower and can
    #: exhaust RAM, which fails the whole batch rather than queueing it.
    max_concurrent_jobs: int = int(os.environ.get("TURNSTONE_MAX_CONCURRENT_JOBS", "1"))

    #: Explicit paths to backend executables, for installations that do not put
    #: them on PATH.
    backend_paths: dict = field(default_factory=lambda: {
        "alicevision": os.environ.get("TURNSTONE_ALICEVISION_BIN", "meshroom_batch"),
        "colmap": os.environ.get("TURNSTONE_COLMAP_BIN", "colmap"),
        "openmvs": os.environ.get("TURNSTONE_OPENMVS_BIN", "DensifyPointCloud"),
    })

    #: The rubric this service scores against.
    #:
    #: Configurable because the repository layout and the container layout
    #: differ, and deriving it from __file__ silently produces a path that does
    #: not exist once installed. Baked into the image rather than mounted, so a
    #: deployment cannot score against one rubric while reporting another.
    rubric_path: Path = field(default_factory=lambda: Path(
        os.environ.get("TURNSTONE_RUBRIC")
        or (Path(__file__).resolve().parents[2] / "rubric" / "heritage-v1.json")
    ))

    #: The exact text of what a record attests and declines to attest.
    #:
    #: Read by this server and by the JavaScript client from one file, so a legal
    #: statement cannot end up paraphrased differently in two implementations.
    disclaimers_path: Path = field(default_factory=lambda: Path(
        os.environ.get("TURNSTONE_DISCLAIMERS")
        or (Path(__file__).resolve().parents[2] / "record" / "disclaimers-v1.json")
    ))

    #: Ontology terms the interop exporters are allowed to emit.
    #:
    #: Configurable for the same reason as the rubric: the repository layout and
    #: the container layout differ, and a path derived from __file__ silently
    #: resolves to somewhere that does not exist once installed.
    vocabulary_path: Path = field(default_factory=lambda: Path(
        os.environ.get("TURNSTONE_VOCABULARY")
        or (Path(__file__).resolve().parents[2] / "record" / "vocabulary-v1.json")
    ))

    #: Raw 32-byte Ed25519 seed used to sign bindings.
    #:
    #: Supplied by the operator from whatever already establishes their
    #: institutional identity. NOT generated here: a key the service made and
    #: stored beside the data it signs proves nothing, because whoever can alter
    #: a binding can re-sign it. With no key configured, bindings are emitted
    #: unsigned and say so — an honest absence beats convincing theatre.
    signing_key_path: Path | None = field(default_factory=lambda: (
        Path(os.environ["TURNSTONE_SIGNING_KEY"])
        if os.environ.get("TURNSTONE_SIGNING_KEY") else None
    ))

    signing_key_id: str = os.environ.get("TURNSTONE_SIGNING_KEY_ID", "")

    @property
    def packages_dir(self) -> Path:
        return self.data_dir / "packages"

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.packages_dir, self.jobs_dir):
            p.mkdir(parents=True, exist_ok=True)


config = Config()
