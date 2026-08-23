"""
Turning whatever a backend produced into the declared artefact set.

---------------------------------------------------------------------------
Spec §8.3 names five artefacts. Each exists for a different consumer, and the
reason matters because it decides what may be lossy:

  delivery mesh (glTF 2.0 / GLB)  everything renders it; Europeana and IIIF
                                  accept it. MAY be simplified — it is for
                                  looking at.
  archive geometry (PLY)          the geometry as reconstructed. MUST NOT be
                                  simplified.
  ortho views (PNG x6)            input to the perceptual mesh hash in phase 5.
                                  MUST be deterministic: the same mesh has to
                                  produce the same bytes on every machine, or
                                  the hash is worthless.
  sidecar (JSON)                  the record.
  source set                      the actual archive, byte-identical.

The glTF writer here is dependency-free, and a test checks its output with
pygltflib — an independent implementation. Writing a format and then reading it
back with your own reader proves only that you are self-consistent.

E57 IS NOT PRODUCED. It is the ISO-recognised point-cloud standard and the spec
asks for it, but writing its XML-plus-CompressedVector binary structure without
libE57Format is the kind of thing that produces a file which looks right and
fails in the one program a conservator uses. It is recorded as a declared gap in
the sidecar rather than faked.
---------------------------------------------------------------------------
"""
from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Mesh:
    """Geometry recovered from a backend's output file."""

    vertices: list[tuple[float, float, float]] = field(default_factory=list)
    faces: list[tuple[int, int, int]] = field(default_factory=list)
    colours: list[tuple[int, int, int]] = field(default_factory=list)

    @property
    def is_point_cloud(self) -> bool:
        return not self.faces

    def bounds(self) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
        xs = [v[0] for v in self.vertices]
        ys = [v[1] for v in self.vertices]
        zs = [v[2] for v in self.vertices]
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


class PlyError(ValueError):
    """The geometry file could not be read. The message says what was wrong."""


def read_ply(path: Path) -> Mesh:
    """
    Read an ASCII or little-endian binary PLY.

    Only the subset backends actually emit is supported, and anything else is
    refused loudly. A reader that guesses at an unexpected property layout
    produces geometry that is silently wrong — vertices in the wrong places, at
    the wrong scale — which is far worse than a file that would not open.
    """
    data = path.read_bytes()
    if not data.startswith(b"ply"):
        raise PlyError(f"{path.name} is not a PLY file")

    header_end = data.find(b"end_header")
    if header_end < 0:
        raise PlyError(f"{path.name} has no end_header")
    nl = data.find(b"\n", header_end)
    header = data[:nl].decode("ascii", errors="replace")
    body_start = nl + 1

    fmt = None
    elements: list[tuple[str, int, list[tuple[str, str]]]] = []
    for line in header.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[0] == "element":
            elements.append((parts[1], int(parts[2]), []))
        elif parts[0] == "property" and elements:
            if parts[1] == "list":
                elements[-1][2].append(("list", f"{parts[2]}:{parts[3]}:{parts[4]}"))
            else:
                elements[-1][2].append((parts[2], parts[1]))

    if fmt not in ("ascii", "binary_little_endian"):
        raise PlyError(f"unsupported PLY format {fmt!r}; expected ascii or binary_little_endian")

    mesh = Mesh()
    if fmt == "ascii":
        tokens = data[body_start:].split()
        pos = 0
        for name, count, props in elements:
            if name == "vertex":
                names = [p[0] for p in props]
                for _ in range(count):
                    row = tokens[pos:pos + len(props)]
                    pos += len(props)
                    vals = {n: row[i] for i, n in enumerate(names)}
                    mesh.vertices.append((float(vals["x"]), float(vals["y"]), float(vals["z"])))
                    if {"red", "green", "blue"} <= vals.keys():
                        mesh.colours.append(
                            (int(float(vals["red"])), int(float(vals["green"])), int(float(vals["blue"])))
                        )
            elif name == "face":
                for _ in range(count):
                    n = int(tokens[pos]); pos += 1
                    idx = [int(tokens[pos + i]) for i in range(n)]
                    pos += n
                    for i in range(1, n - 1):  # fan-triangulate
                        mesh.faces.append((idx[0], idx[i], idx[i + 1]))
            else:
                pos += count * len(props)
    else:
        sizes = {"char": 1, "uchar": 1, "int8": 1, "uint8": 1,
                 "short": 2, "ushort": 2, "int16": 2, "uint16": 2,
                 "int": 4, "uint": 4, "int32": 4, "uint32": 4, "float": 4, "float32": 4,
                 "double": 8, "float64": 8}
        codes = {"char": "b", "uchar": "B", "int8": "b", "uint8": "B",
                 "short": "h", "ushort": "H", "int16": "h", "uint16": "H",
                 "int": "i", "uint": "I", "int32": "i", "uint32": "I",
                 "float": "f", "float32": "f", "double": "d", "float64": "d"}
        off = body_start
        for name, count, props in elements:
            if name == "vertex":
                names = [p[0] for p in props]
                types = [p[1] for p in props]
                if any(t not in codes for t in types):
                    raise PlyError(f"unsupported vertex property type in {path.name}")
                struct_fmt = "<" + "".join(codes[t] for t in types)
                size = struct.calcsize(struct_fmt)
                for _ in range(count):
                    row = struct.unpack_from(struct_fmt, data, off)
                    off += size
                    vals = dict(zip(names, row))
                    mesh.vertices.append((float(vals["x"]), float(vals["y"]), float(vals["z"])))
                    if {"red", "green", "blue"} <= vals.keys():
                        mesh.colours.append((int(vals["red"]), int(vals["green"]), int(vals["blue"])))
            elif name == "face":
                for _ in range(count):
                    # "property list uchar int vertex_index" stores
                    # count-type : index-type : property-name, in that order.
                    cnt_t, idx_t, _prop = props[0][1].split(":")
                    n = struct.unpack_from("<" + codes[cnt_t], data, off)[0]
                    off += sizes[cnt_t]
                    idx = struct.unpack_from(f"<{n}{codes[idx_t]}", data, off)
                    off += sizes[idx_t] * n
                    for i in range(1, n - 1):
                        mesh.faces.append((idx[0], idx[i], idx[i + 1]))
            else:
                for _ in range(count):
                    for _, t in props:
                        off += sizes.get(t, 0)

    if not mesh.vertices:
        raise PlyError(f"{path.name} contains no vertices")
    return mesh


def _pad(b: bytes, alignment: int, fill: bytes) -> bytes:
    rem = len(b) % alignment
    return b if rem == 0 else b + fill * (alignment - rem)


def write_glb(mesh: Mesh, path: Path) -> Path:
    """
    Write a binary glTF 2.0 file.

    Point clouds are written with primitive mode 0 (POINTS) rather than being
    forced into a mesh: a reconstruction that recovered no surface should look
    like a point cloud in a viewer, not like a mesh that failed to render.
    """
    buf = bytearray()
    views: list[dict] = []
    accessors: list[dict] = []

    def add_view(payload: bytes, target: int | None = None) -> int:
        # Accessor byteOffsets must satisfy component alignment; 4 covers every
        # component type used here.
        while len(buf) % 4:
            buf.append(0)
        offset = len(buf)
        buf.extend(payload)
        v = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        if target is not None:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    positions = b"".join(struct.pack("<3f", *v) for v in mesh.vertices)
    pos_view = add_view(positions, 34962)
    lo, hi = mesh.bounds()
    accessors.append({
        "bufferView": pos_view, "componentType": 5126, "count": len(mesh.vertices),
        "type": "VEC3",
        # min/max are REQUIRED on POSITION by the glTF spec — viewers use them to
        # frame the model, and omitting them makes it open to an empty screen.
        "min": [float(x) for x in lo], "max": [float(x) for x in hi],
    })
    attributes = {"POSITION": 0}

    if mesh.colours and len(mesh.colours) == len(mesh.vertices):
        colours = b"".join(
            struct.pack("<3f", r / 255.0, g / 255.0, b / 255.0) for r, g, b in mesh.colours
        )
        cview = add_view(colours, 34962)
        accessors.append({"bufferView": cview, "componentType": 5126,
                          "count": len(mesh.colours), "type": "VEC3"})
        attributes["COLOR_0"] = len(accessors) - 1

    primitive = {"attributes": attributes, "mode": 4 if mesh.faces else 0}

    if mesh.faces:
        flat = [i for f in mesh.faces for i in f]
        idx = b"".join(struct.pack("<I", i) for i in flat)
        iview = add_view(idx, 34963)
        accessors.append({"bufferView": iview, "componentType": 5125,
                          "count": len(flat), "type": "SCALAR"})
        primitive["indices"] = len(accessors) - 1

    gltf = {
        "asset": {"version": "2.0", "generator": "turnstone-server"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [primitive]}],
        "buffers": [{"byteLength": len(buf)}],
        "bufferViews": views,
        "accessors": accessors,
    }

    json_chunk = _pad(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), 4, b" ")
    bin_chunk = _pad(bytes(buf), 4, b"\0")

    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    out += struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk

    path.write_bytes(bytes(out))
    return path


ORTHO_VIEWS = [
    ("front", (0, 2, 1, 1, 1)),
    ("back", (0, 2, 1, -1, 1)),
    ("left", (1, 2, 0, 1, 1)),
    ("right", (1, 2, 0, -1, 1)),
    ("top", (0, 1, 2, 1, 1)),
    ("bottom", (0, 1, 2, -1, 1)),
]


def render_ortho_views(mesh: Mesh, out_dir: Path, size: int = 512) -> dict[str, Path]:
    """
    Six orthographic renders, one down each axis.

    DETERMINISM IS THE REQUIREMENT, not beauty. These feed the perceptual mesh
    hash in phase 5, so the same geometry must produce the same bytes on every
    machine: a fixed canvas, a fixed projection, faces drawn in a fixed order,
    and shading computed from geometry alone. No lighting model, no anti-alias
    jitter, no timestamps.
    """
    from PIL import Image, ImageDraw

    out_dir.mkdir(parents=True, exist_ok=True)
    lo, hi = mesh.bounds()
    centre = [(lo[i] + hi[i]) / 2 for i in range(3)]
    extent = max(hi[i] - lo[i] for i in range(3)) or 1.0
    scale = (size * 0.9) / extent

    written: dict[str, Path] = {}
    for name, (ax, ay, az, flip, _) in ORTHO_VIEWS:
        img = Image.new("RGB", (size, size), (255, 255, 255))
        draw = ImageDraw.Draw(img)

        def project(v):
            x = (v[ax] - centre[ax]) * flip * scale + size / 2
            y = -(v[ay] - centre[ay]) * scale + size / 2
            return x, y

        if mesh.faces:
            # Painter's algorithm on depth. Sorted by depth then by index so the
            # order is total and ties cannot resolve differently between runs.
            order = sorted(
                range(len(mesh.faces)),
                key=lambda i: (
                    -sum(mesh.vertices[k][az] for k in mesh.faces[i]) / 3 * flip,
                    i,
                ),
            )
            for i in order:
                f = mesh.faces[i]
                pts = [project(mesh.vertices[k]) for k in f]
                a, b, c = (mesh.vertices[k] for k in f)
                u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
                w = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
                nx = u[1] * w[2] - u[2] * w[1]
                ny = u[2] * w[0] - u[0] * w[2]
                nz = u[0] * w[1] - u[1] * w[0]
                mag = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                shade = int(90 + 130 * abs((nx, ny, nz)[az] / mag))
                draw.polygon(pts, fill=(shade, shade, shade))
        else:
            for v in mesh.vertices:
                x, y = project(v)
                draw.rectangle([x - 1, y - 1, x + 1, y + 1], fill=(40, 40, 40))

        p = out_dir / f"ortho-{name}.png"
        img.save(p, "PNG", optimize=False)
        written[f"ortho_{name}"] = p
    return written


def build_sidecar(*, job, package, assessment: dict, deferred: dict,
                  backend: str, backend_version: str, outputs: dict,
                  rubric: dict) -> dict:
    """
    The JSON record that travels with the reconstruction.

    Carries the rubric identity and the *capture* class alongside the final one.
    A record showing only the final class cannot be audited: nobody can tell
    whether reconstruction confirmed the capture estimate or contradicted it,
    which is the single most interesting thing about it.
    """
    return {
        "schemaVersion": "1.0",
        "sessionId": package.session_id,
        "subject": package.subject,
        "jobId": job.id,
        "contentHash": job.content_hash,
        "rubric": {"id": rubric.get("id"), "version": rubric.get("version")},
        "reconstruction": {
            "backend": backend,
            "backendVersion": backend_version,
            "parameters": job.parameters,
            "startedAt": job.started_at,
            "finishedAt": job.finished_at,
        },
        "quality": assessment,
        "deferredValues": deferred,
        "sourceImages": {
            "count": len(package.image_names),
            "distinct": len(package.digests),
            "byteIdentical": True,
        },
        "outputs": outputs,
        "notProduced": {
            # Declared rather than silently omitted. A consumer looking for the
            # spec's E57 needs to know it is absent by decision, not by failure.
            "e57": (
                "E57 requires libE57Format, which is not installed. Writing its "
                "XML-plus-CompressedVector structure by hand risks a file that opens "
                "in one program and fails in another, which is worse than its absence. "
                "The PLY is the archive geometry."
            ),
        },
        "attests": (
            "An object with these measurable characteristics was observed in this "
            "condition, at this place, at this time, by this party — and this is a "
            "tamper-evident record of that observation."
        ),
    }


def derive_outputs(primary: Path, out_dir: Path) -> tuple[dict[str, Path], dict]:
    """
    Produce the delivery mesh and ortho views from a backend's geometry.

    Failure here must not fail the job. The reconstruction succeeded; a delivery
    format that could not be derived is a missing convenience, and throwing the
    reconstruction away over it would be a poor trade for a contributor who is
    no longer standing in front of the object.
    """
    derived: dict[str, Path] = {}
    notes: dict = {}
    try:
        mesh = read_ply(primary)
    except (PlyError, Exception) as e:  # noqa: BLE001
        return derived, {"geometry": f"could not read {primary.name}: {e}"}

    notes["vertices"] = len(mesh.vertices)
    notes["faces"] = len(mesh.faces)
    notes["kind"] = "point-cloud" if mesh.is_point_cloud else "mesh"

    try:
        derived["delivery_mesh"] = write_glb(mesh, out_dir / "model.glb")
    except Exception as e:  # noqa: BLE001
        notes["delivery_mesh"] = f"glTF conversion failed: {e}"

    try:
        derived.update(render_ortho_views(mesh, out_dir))
    except Exception as e:  # noqa: BLE001
        notes["ortho_views"] = f"ortho rendering failed: {e}"

    return derived, notes
