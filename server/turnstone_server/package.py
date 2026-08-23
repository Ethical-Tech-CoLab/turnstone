"""
Reading and verifying session packages.

---------------------------------------------------------------------------
THE PHOTOGRAPHS ARE THE ARCHIVE.

Everything here exists to keep that true across the boundary between the
capture client and the server. Images are stored byte-identical to what the
camera produced — never re-encoded, never resized, never stripped of EXIF —
because a reconstruction can be re-run with better software in ten years and
the images cannot be recreated from the mesh.

Re-encoding would also break every checksum in the package, which is how a
consumer establishes that what they received is what was captured.
---------------------------------------------------------------------------
"""
from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path


class PackageError(ValueError):
    """The package cannot be trusted. The message says why, in plain language."""


@dataclass
class SessionPackage:
    """A verified package, unpacked on disk."""

    root: Path
    manifest: dict
    image_names: list[str]
    #: sha256 -> filename, so duplicate frames are visible rather than silently
    #: counted twice toward coverage.
    digests: dict[str, str]

    @property
    def session_id(self) -> str:
        return self.manifest.get("session", {}).get("id", "unknown")

    @property
    def subject(self) -> str | None:
        return self.manifest.get("session", {}).get("subject")

    @property
    def image_paths(self) -> list[Path]:
        return [self.root / n for n in self.image_names]

    def content_hash(self) -> str:
        """
        A stable identity for *the photographs*, independent of the manifest.

        Hashing the sorted per-image digests rather than the zip bytes means the
        same photographs re-exported — with a newer build, a corrected subject
        name, a different compression — produce the same identity. That is what
        makes the job model idempotent in a way that matches how people actually
        behave: they re-upload when they are unsure whether the first attempt
        worked.
        """
        joined = "\n".join(sorted(self.digests.keys()))
        return hashlib.sha256(joined.encode()).hexdigest()


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def _safe_member(name: str) -> bool:
    """
    Refuse absolute paths and traversal.

    An uploaded archive is untrusted input. `../../etc/passwd` inside a zip is
    the oldest trick there is, and Python's extractall historically honoured it.
    """
    if name.startswith("/") or name.startswith("\\"):
        return False
    parts = Path(name.replace("\\", "/")).parts
    return ".." not in parts and not any(p.endswith(":") for p in parts)


def extract_package(zip_path: Path, dest: Path) -> SessionPackage:
    """
    Unpack and verify a session package.

    Verification is not a formality. The failure that matters is a package that
    looks complete and is missing frames, or carries images that will not
    decode — discovered months later by whoever tries to reconstruct from it.
    """
    dest.mkdir(parents=True, exist_ok=True)

    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as e:
        raise PackageError(f"not a readable archive: {e}") from e

    with zf:
        bad = zf.testzip()
        if bad is not None:
            raise PackageError(f"archive is corrupt at {bad}")

        members = [m for m in zf.namelist() if not m.endswith("/")]
        unsafe = [m for m in members if not _safe_member(m)]
        if unsafe:
            raise PackageError(f"archive contains unsafe paths: {unsafe[:3]}")

        if "manifest.json" not in members:
            raise PackageError("no manifest.json — this is not a Turnstone session package")

        for m in members:
            zf.extract(m, dest)

    manifest_path = dest / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise PackageError(f"manifest.json is not valid JSON: {e}") from e

    if manifest.get("format") != "turnstone-session/1":
        raise PackageError(
            f"unsupported package format {manifest.get('format')!r}; this server understands turnstone-session/1"
        )

    images = sorted(
        n for n in (p.relative_to(dest).as_posix() for p in dest.rglob("*"))
        if n.startswith("images/") and n.lower().endswith((".jpg", ".jpeg", ".png"))
    )
    if not images:
        raise PackageError(
            "the package contains no photographs. A manifest without images is a record "
            "of a capture, not the capture itself, and nothing can be reconstructed from it."
        )

    digests: dict[str, str] = {}
    for name in images:
        d = sha256_file(dest / name)
        if d in digests:
            # Not fatal: a duplicate is usable, it simply contributes no new
            # viewpoint. Recording it lets coverage be judged honestly.
            continue
        digests[d] = name

    _verify_checksums(dest, images)

    return SessionPackage(root=dest, manifest=manifest, image_names=images, digests=digests)


def open_package(root: Path) -> SessionPackage:
    """
    Build a package view over an already-extracted directory.

    Used for packages that were verified when they arrived and have been sitting
    in storage since. Checksums are not re-verified here — that happened at
    ingest, and repeating it on every read would make listing jobs cost a full
    rehash of every photograph.
    """
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    images = sorted(
        n for n in (p.relative_to(root).as_posix() for p in root.rglob("*"))
        if n.startswith("images/") and n.lower().endswith((".jpg", ".jpeg", ".png"))
    )
    digests: dict[str, str] = {}
    for name in images:
        digests.setdefault(sha256_file(root / name), name)
    return SessionPackage(root=root, manifest=manifest, image_names=images, digests=digests)


def _verify_checksums(root: Path, images: list[str]) -> None:
    """
    Check SHA256SUMS.txt if present.

    Absent, we warn by omission rather than refusing: packages from other tools
    and hand-assembled directories are legitimate. Present and WRONG is a hard
    failure, because it means the bytes changed somewhere between the camera and
    here, and nothing downstream would detect it.
    """
    sums_path = root / "SHA256SUMS.txt"
    if not sums_path.exists():
        return

    expected: dict[str, str] = {}
    for line in sums_path.read_text(encoding="utf-8").splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and len(parts[0]) == 64:
            expected[parts[1].strip()] = parts[0]

    mismatched, missing = [], []
    for name, digest in expected.items():
        p = root / name
        if not p.exists():
            missing.append(name)
        elif sha256_file(p) != digest:
            mismatched.append(name)

    if missing:
        raise PackageError(
            f"{len(missing)} checksummed file(s) are absent from the package: {missing[:3]}"
        )
    if mismatched:
        raise PackageError(
            f"{len(mismatched)} file(s) do not match their checksum — the package is corrupt "
            f"and the photographs cannot be trusted: {mismatched[:3]}"
        )
