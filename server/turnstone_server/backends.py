"""
Reconstruction backends, and the licence gate.

---------------------------------------------------------------------------
WHY THE LICENCE IS ENFORCED IN CODE RATHER THAN DOCUMENTED IN A README.

Turnstone is meant to be self-hosted by museums and community archives, many of
which have strict legal review. The default path must therefore be safe to run
without a licence conversation, and it must stay that way — a well-meant patch
adding a faster backend to the default is the single easiest way to make this
unusable for exactly the institutions it is for.

  AliceVision / Meshroom   MPL-2.0     default. File-level copyleft; does not
                                       reach across a process boundary.
  COLMAP                   BSD-3 core  alternate. Its own licence is permissive,
                                       but several dependencies are GPL/AGPL, so
                                       a BINARY is usually effectively GPL.
  OpenMVS                  AGPL-3.0    opt-in only. Produces the best dense
                                       meshes; its network clause reaches a
                                       hosted service, which is what this is.

Deliberately NOT supported, and not merely unimplemented:

  VGGT      a bespoke Meta research licence granting rights only to "Research
            Materials", with viral term propagation and an acceptable-use policy
  MASt3R    CC BY-NC-SA 4.0 — non-commercial

Both are excellent and both are the most-starred tools in the space, which is
precisely why the exclusion has to be explicit. They may be added by an operator
as user-supplied backends, taking that responsibility themselves.
---------------------------------------------------------------------------
"""
from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


class LicenceRefused(PermissionError):
    """A backend was requested whose licence terms have not been accepted."""


@dataclass
class BackendResult:
    """What a reconstruction produced, and how."""

    backend: str
    version: str
    parameters: dict
    outputs: dict[str, Path] = field(default_factory=dict)
    #: Post-reconstruction measurements the capture client could not know.
    metrics: dict = field(default_factory=dict)
    log: str = ""
    succeeded: bool = True
    failure_reason: str | None = None


class Backend(Protocol):
    id: str
    licence: str
    requires_acknowledgement: bool

    def available(self) -> bool: ...
    def version(self) -> str: ...
    def reconstruct(self, images: list[Path], workdir: Path, params: dict) -> BackendResult: ...


class _Subprocess:
    """Shared shell-out behaviour, so each adapter is only its command line."""

    binary = ""

    def _resolve(self) -> str | None:
        return shutil.which(self.binary) or (self.binary if Path(self.binary).exists() else None)

    def available(self) -> bool:
        return self._resolve() is not None

    def _run(self, argv: list[str], workdir: Path, timeout: int = 60 * 60 * 6) -> tuple[int, str]:
        proc = subprocess.run(
            argv, cwd=workdir, capture_output=True, text=True, timeout=timeout, check=False
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


class AliceVisionBackend(_Subprocess):
    """
    Meshroom's batch runner. The default.

    Chosen for its licence rather than for being the fastest: MPL-2.0 is
    file-level copyleft that stops at the process boundary, so an institution
    can run this on its own hardware without a legal review.
    """

    id = "alicevision"
    licence = "MPL-2.0"
    requires_acknowledgement = False
    binary = "meshroom_batch"

    def __init__(self, binary: str | None = None):
        if binary:
            self.binary = binary

    def version(self) -> str:
        exe = self._resolve()
        if not exe:
            return "not installed"
        try:
            code, out = self._run([exe, "--version"], Path.cwd(), timeout=60)
            return out.strip().splitlines()[0] if out.strip() else "unknown"
        except Exception:  # noqa: BLE001 — a version probe must never be fatal
            return "unknown"

    def build_command(self, images_dir: Path, out_dir: Path, params: dict) -> list[str]:
        """
        Separated from execution so the command line is testable without the
        binary installed — which is the situation on most development machines
        and on CI.
        """
        exe = self._resolve() or self.binary
        argv = [exe, "--input", str(images_dir), "--output", str(out_dir)]
        if params.get("pipeline"):
            argv += ["--pipeline", str(params["pipeline"])]
        # GPU is optional by requirement: a GPU-only server would exclude
        # exactly the institutions that most need this.
        if not params.get("use_gpu", False):
            argv += ["--paramOverrides", "DepthMap.downscale=2"]
        if params.get("max_cores"):
            argv += ["--paramOverrides", f"DepthMap.nbGPUs=0"]
        return argv

    def reconstruct(self, images: list[Path], workdir: Path, params: dict) -> BackendResult:
        images_dir = workdir / "images"
        out_dir = workdir / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        argv = self.build_command(images_dir, out_dir, params)

        if not self.available():
            return BackendResult(
                backend=self.id, version="not installed", parameters=params,
                succeeded=False,
                failure_reason=(
                    "AliceVision (meshroom_batch) is not installed on this server. "
                    "Install it, or select another backend."
                ),
                log=" ".join(argv),
            )

        code, log = self._run(argv, workdir)
        return BackendResult(
            backend=self.id, version=self.version(), parameters=params,
            outputs=_collect_outputs(out_dir), log=log,
            succeeded=code == 0,
            failure_reason=None if code == 0 else f"meshroom_batch exited {code}",
        )


class ColmapBackend(_Subprocess):
    """
    COLMAP. Alternate, not default.

    Its own source is BSD-3, but its COPYING file says plainly that this
    "refers only to the license for COLMAP itself, independent of its
    dependencies" — several of which are GPL/AGPL. A distributed *binary* is
    therefore usually effectively GPL, which is why it is not the default even
    though it is often described as permissive.
    """

    id = "colmap"
    licence = "BSD-3-Clause (dependencies may be GPL/AGPL)"
    requires_acknowledgement = False
    binary = "colmap"

    def __init__(self, binary: str | None = None):
        if binary:
            self.binary = binary

    def version(self) -> str:
        exe = self._resolve()
        if not exe:
            return "not installed"
        try:
            _, out = self._run([exe, "--help"], Path.cwd(), timeout=60)
            for line in out.splitlines():
                if "COLMAP" in line and any(c.isdigit() for c in line):
                    return line.strip()
            return "unknown"
        except Exception:  # noqa: BLE001
            return "unknown"

    def build_command(self, images_dir: Path, out_dir: Path, params: dict) -> list[str]:
        exe = self._resolve() or self.binary
        argv = [
            exe, "automatic_reconstructor",
            "--workspace_path", str(out_dir),
            "--image_path", str(images_dir),
            "--quality", str(params.get("quality", "medium")),
        ]
        # Dense reconstruction needs CUDA. Without it COLMAP still produces a
        # sparse model, which is useful for pose and scale even though it is not
        # a mesh — better than refusing to run at all.
        argv += ["--dense", "1" if params.get("use_gpu", False) else "0"]
        return argv

    def reconstruct(self, images: list[Path], workdir: Path, params: dict) -> BackendResult:
        images_dir = workdir / "images"
        out_dir = workdir / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        argv = self.build_command(images_dir, out_dir, params)

        if not self.available():
            return BackendResult(
                backend=self.id, version="not installed", parameters=params,
                succeeded=False,
                failure_reason="COLMAP is not installed on this server.",
                log=" ".join(argv),
            )

        code, log = self._run(argv, workdir)
        return BackendResult(
            backend=self.id, version=self.version(), parameters=params,
            outputs=_collect_outputs(out_dir), log=log,
            succeeded=code == 0,
            failure_reason=None if code == 0 else f"colmap exited {code}",
        )


class OpenMvsBackend(_Subprocess):
    """
    OpenMVS. Opt-in only.

    It produces the dense meshes people actually want, and it is AGPL-3.0 whose
    network clause reaches a hosted service — which is exactly what this is. An
    operator may accept that; the software may not accept it on their behalf.
    """

    id = "openmvs"
    licence = "AGPL-3.0"
    requires_acknowledgement = True
    binary = "DensifyPointCloud"

    def __init__(self, binary: str | None = None):
        if binary:
            self.binary = binary

    def version(self) -> str:
        return "installed" if self.available() else "not installed"

    def build_command(self, scene: Path, out_dir: Path, params: dict) -> list[str]:
        exe = self._resolve() or self.binary
        return [exe, str(scene), "-w", str(out_dir),
                "--resolution-level", str(params.get("resolution_level", 1))]

    def reconstruct(self, images: list[Path], workdir: Path, params: dict) -> BackendResult:
        out_dir = workdir / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        scene = workdir / "scene.mvs"
        argv = self.build_command(scene, out_dir, params)

        if not self.available():
            return BackendResult(
                backend=self.id, version="not installed", parameters=params,
                succeeded=False,
                failure_reason="OpenMVS is not installed on this server.",
                log=" ".join(argv),
            )

        code, log = self._run(argv, workdir)
        return BackendResult(
            backend=self.id, version=self.version(), parameters=params,
            outputs=_collect_outputs(out_dir), log=log,
            succeeded=code == 0,
            failure_reason=None if code == 0 else f"OpenMVS exited {code}",
        )


class SimulatedBackend:
    """
    A deterministic stand-in.

    Not a mock hidden in the test folder — a first-class backend, because the
    interesting parts of this service (ingest, idempotency, the licence gate,
    byte-identity, quality recomputation) must be exercisable on a machine with
    no reconstruction software installed, which is every development machine and
    every CI runner.

    It emits real, well-formed output files so the packaging path downstream is
    genuinely tested rather than skipped, and it is honest about what it is:
    every artefact it writes says so in its own bytes.
    """

    id = "simulated"
    licence = "n/a"
    requires_acknowledgement = False

    def available(self) -> bool:
        return True

    def version(self) -> str:
        return "simulated-1"

    def reconstruct(self, images: list[Path], workdir: Path, params: dict) -> BackendResult:
        out_dir = workdir / "out"
        out_dir.mkdir(parents=True, exist_ok=True)

        n = len(images)
        # A minimal but valid ASCII PLY, so downstream packaging is exercised.
        #
        # Written as BYTES, not text. Path.write_text applies the platform's
        # newline convention, which on Windows turns every "\n" into "\r\n" —
        # producing a header beginning "ply\r\n" that strict PLY readers reject,
        # and giving the same reconstruction a different sha256 on Windows than
        # in the Linux container. Output must not depend on where it ran.
        ply = out_dir / "model.ply"
        verts = [(i * 0.01, (i % 7) * 0.01, (i % 5) * 0.01) for i in range(max(8, n))]
        header = (
            "ply\nformat ascii 1.0\n"
            f"element vertex {len(verts)}\n"
            "property float x\nproperty float y\nproperty float z\n"
            "end_header\n"
        )
        body = "".join(f"{x:.4f} {y:.4f} {z:.4f}\n" for x, y, z in verts)
        ply.write_bytes((header + body).encode("utf-8"))

        (out_dir / "SIMULATED.txt").write_bytes(
            b"This reconstruction was produced by the simulated backend.\n"
            b"It contains NO geometry recovered from the photographs and must not\n"
            b"be treated as a record of the object.\n"
        )

        # Surface completeness estimated at capture time is optimistic: you can
        # orbit an object completely and never see inside a cavity. A real
        # backend measures what was actually reconstructed.
        return BackendResult(
            backend=self.id, version=self.version(), parameters=params,
            outputs=_collect_outputs(out_dir),
            metrics={"surface_completeness": params.get("simulated_completeness", 0.62)},
            log=f"simulated reconstruction over {n} images",
            succeeded=True,
        )


def _collect_outputs(out_dir: Path) -> dict[str, Path]:
    wanted = {".ply": "point_cloud", ".obj": "mesh_obj", ".glb": "mesh_glb",
              ".gltf": "mesh_gltf", ".e57": "archive_e57", ".abc": "cameras"}
    found: dict[str, Path] = {}
    for p in sorted(out_dir.rglob("*")):
        if p.is_file():
            key = wanted.get(p.suffix.lower())
            if key and key not in found:
                found[key] = p
    return found


REGISTRY: dict[str, type] = {
    "alicevision": AliceVisionBackend,
    "colmap": ColmapBackend,
    "openmvs": OpenMvsBackend,
    "simulated": SimulatedBackend,
}


def get_backend(name: str, *, allow_agpl: bool = False, binary: str | None = None):
    """
    Resolve a backend by name, refusing AGPL ones unless acknowledged.

    The refusal names the licence and says what accepting it means, so an
    operator makes an informed decision rather than hunting for a flag.
    """
    cls = REGISTRY.get(name)
    if cls is None:
        raise ValueError(f"unknown backend {name!r}; available: {', '.join(sorted(REGISTRY))}")

    backend = cls(binary) if cls in (AliceVisionBackend, ColmapBackend, OpenMvsBackend) else cls()

    if getattr(backend, "requires_acknowledgement", False) and not allow_agpl:
        raise LicenceRefused(
            f"The {name} backend is {backend.licence}. Its network clause extends to software "
            f"offered over a network, which includes this server: running it here obliges you to "
            f"offer the corresponding source of the whole service to its users. That may be "
            f"entirely acceptable — but it is your decision to make, not this software's. "
            f"Set TURNSTONE_ALLOW_AGPL=1 to accept it."
        )
    return backend


def describe_backends(allow_agpl: bool = False) -> list[dict]:
    """What this server can actually do, for a client to show before submitting."""
    out = []
    for name, cls in sorted(REGISTRY.items()):
        b = cls()
        out.append({
            "id": name,
            "licence": b.licence,
            "available": b.available(),
            "version": b.version(),
            "requires_acknowledgement": b.requires_acknowledgement,
            "permitted": (not b.requires_acknowledgement) or allow_agpl,
        })
    return out
