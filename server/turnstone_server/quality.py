"""
Deferred dimensions, and recomputing the class after reconstruction.

---------------------------------------------------------------------------
THIS IS WHERE A PROVISIONAL CLASS BECOMES A FINAL ONE.

The capture client scores what it can see while the contributor is still
standing in front of the object, and flags the result `provisional` because two
things cannot be known then:

  device-metadata        needs the EXIF of the stored files, which the client
                         had but a shared package may have lost in transit
  surface-completeness   genuinely cannot be known before reconstruction. You
                         can orbit an object completely and never see inside a
                         cavity or behind a handle.

THE CLASS IS ALLOWED TO GO DOWN. That is the point of calling it provisional,
and it is the honest direction: a capture-time estimate is optimistic by
construction, because it is measuring what the camera pointed at rather than
what was actually recovered. A system that only ever revised upward would be
one that never admitted the estimate was wrong.

The Python scorer here and the JavaScript scorer in the client read the SAME
rubric file, and a test asserts they agree on identical inputs — two
implementations of one rubric is exactly the situation where a threshold
quietly drifts.
---------------------------------------------------------------------------
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

CLASS_ORDER = ["insufficient", "indicative", "study", "reference"]


def class_rank(c: str) -> int:
    return CLASS_ORDER.index(c) if c in CLASS_ORDER else 0


def worst_class(a: str, b: str) -> str:
    return a if class_rank(a) <= class_rank(b) else b


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def normalise(spec: dict, raw: float) -> float:
    """
    The rubric's normalisers, matching lib/rubric.js exactly.

    Referenced by name from the rubric JSON rather than embedded as code, so a
    rubric file stays inert data and can never execute.
    """
    fn = spec.get("fn")
    if fn == "linear":
        floor, ceil = spec["floor"], spec["ceil"]
        return _clamp01((raw - floor) / (ceil - floor))
    if fn == "logScale":
        floor, ceil = spec["floor"], spec["ceil"]
        if raw <= 0:
            return 0.0
        return _clamp01((math.log(raw) - math.log(floor)) / (math.log(ceil) - math.log(floor)))
    if fn == "logScaleInverse":
        worst, best = spec["worst"], spec["best"]
        if raw <= 0:
            return 1.0
        return _clamp01((math.log(worst) - math.log(raw)) / (math.log(worst) - math.log(best)))
    if fn == "clippingFraction":
        return _clamp01(1 - raw / spec["tolerance"])
    raise ValueError(f"unknown normalise function {fn!r}")


def permitted_class(dimension: dict, value: float) -> str:
    t = dimension["thresholds"]
    if value >= t["reference"]:
        return "reference"
    if value >= t["study"]:
        return "study"
    if value >= t["indicative"]:
        return "indicative"
    return "insufficient"


def load_rubric(path: Path) -> dict:
    rubric = json.loads(Path(path).read_text(encoding="utf-8"))
    major = str(rubric.get("schemaVersion", "")).split(".")[0]
    if major != "1":
        raise ValueError(
            f"unsupported rubric schemaVersion {rubric.get('schemaVersion')!r}; "
            "this build implements 1.x. Ignoring an unknown dimension would report a "
            "pass on a rubric that was never applied."
        )
    return rubric


@dataclass
class Assessment:
    cls: str
    score: int
    limiting: str | None
    provisional: bool
    dimensions: list[dict]
    deferred: list[str]

    def to_dict(self) -> dict:
        return {
            "class": self.cls,
            "score": self.score,
            "limitingDimension": self.limiting,
            "provisional": self.provisional,
            "dimensions": self.dimensions,
            "deferred": self.deferred,
        }


def assess(rubric: dict, measurements: dict, *, live_only: bool = False) -> Assessment:
    """
    Score measurements against the rubric.

    `live_only` restricts scoring to dimensions measurable during capture. A
    deferred dimension scored live would cap the class for a reason the
    contributor can neither observe nor act on.
    """
    scored = [d for d in rubric["dimensions"] if d["liveMeasurable"]] if live_only else rubric["dimensions"]
    deferred = [d["id"] for d in rubric["dimensions"] if not d["liveMeasurable"]]

    dims = []
    for d in scored:
        raw = measurements.get(d["id"])
        if raw is None or (isinstance(raw, float) and math.isnan(raw)):
            dims.append({"id": d["id"], "label": d["label"], "state": "unmeasured",
                         "raw": None, "value": 0.0, "permits": "insufficient"})
            continue
        value = normalise(d["normalise"], float(raw))
        dims.append({"id": d["id"], "label": d["label"], "state": "measured",
                     "raw": raw, "value": value, "permits": permitted_class(d, value)})

    # The class is the WORST dimension, never the average. Four hundred
    # photographs that are all out of focus produce an out-of-focus mesh.
    cls = "reference"
    for d in dims:
        cls = worst_class(cls, d["permits"])

    limiting = None
    if dims:
        limiting = sorted(dims, key=lambda d: (class_rank(d["permits"]), d["value"]))[0]["id"]

    measured = [d for d in dims if d["state"] == "measured"]
    score = round(sum(d["value"] for d in measured) / len(measured) * 100) if measured else 0

    return Assessment(
        cls=cls, score=score, limiting=limiting,
        provisional=live_only and bool(deferred),
        dimensions=dims, deferred=deferred,
    )


def device_metadata_completeness(image_paths: list[Path]) -> float:
    """
    Fraction of photographs still carrying focal length and sensor information.

    Frames stripped of EXIF — as most images shared through a messaging app are
    — can still be reconstructed, but the result can no longer be independently
    verified, because there is nothing to check the recovered camera model
    against.
    """
    if not image_paths:
        # NaN, not 0.0. Zero would assert that no photograph carries metadata,
        # which drives the class to insufficient for something never checked.
        # "Nothing to measure" and "measured, and it was absent" are different
        # facts and must not be reported with the same number.
        return float("nan")

    try:
        from PIL import Image, ExifTags  # noqa: PLC0415 — optional at import time
    except ImportError:
        # Refusing to guess: reporting 1.0 would claim metadata we never looked
        # for, and 0.0 would fail captures for a missing server library.
        return float("nan")

    wanted = {"FocalLength", "FocalLengthIn35mmFilm", "Make", "Model"}
    tag_names = {v: k for k, v in ExifTags.TAGS.items()}
    keys = {tag_names[n] for n in wanted if n in tag_names}

    complete = 0
    for p in image_paths:
        try:
            with Image.open(p) as im:
                exif = im.getexif()
                if exif and any(exif.get(k) is not None for k in keys):
                    complete += 1
        except Exception:  # noqa: BLE001 — an unreadable file simply has no metadata
            continue
    return complete / len(image_paths)


def finalise(
    rubric: dict,
    capture_measurements: dict,
    *,
    image_paths: list[Path],
    reconstruction_metrics: dict | None = None,
) -> tuple[Assessment, dict]:
    """
    Produce the final assessment, and the deferred values it used.

    Returns the assessment plus a record of what changed, because "the class
    went down" is not useful on its own — the operator needs to know which
    dimension did it and by how much, or they cannot shoot better next time.
    """
    final = dict(capture_measurements)
    deferred_values: dict = {}

    dm = device_metadata_completeness(image_paths)
    if not math.isnan(dm):
        final["device-metadata"] = dm
        deferred_values["device-metadata"] = dm

    if reconstruction_metrics:
        sc = reconstruction_metrics.get("surface_completeness")
        if sc is not None:
            # OQ-1: the capture-time estimate is KEPT alongside, never
            # overwritten, so the open question of whether that estimate is
            # trustworthy stays answerable from accumulated evidence.
            deferred_values["surface-completeness"] = {
                "captureEstimate": capture_measurements.get("surface-completeness"),
                "postReconstruction": sc,
                "difference": (
                    sc - capture_measurements["surface-completeness"]
                    if capture_measurements.get("surface-completeness") is not None else None
                ),
            }
            final["surface-completeness"] = sc

    return assess(rubric, final, live_only=False), deferred_values
