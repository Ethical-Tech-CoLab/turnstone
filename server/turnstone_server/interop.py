"""
Exporting a record for museum systems and for delivery.

---------------------------------------------------------------------------
TWO FORMATS, TWO AUDIENCES, TWO VERY DIFFERENT LEVELS OF MATURITY.

CIDOC-CRM / CRMdig is a stable, widely-implemented ontology. A museum
collections system can ingest it today.

IIIF 3D is a DRAFT. It defines `Scene` — which does not exist in Presentation
API 3.0 — and targets Presentation API 4, whose context URI is not yet
published. A manifest emitted against a draft can become invalid when the draft
changes, and it is dishonest to ship one that does not say so. Every manifest
this module writes carries that warning in its own `summary`, where a human
opening the file will see it, not merely in documentation nobody reads.

INTEROP FAILS IN A PARTICULAR WAY. An invented class name produces a document
that parses, validates as JSON, looks entirely plausible to its author, and
means nothing to the system it was written for. Nobody discovers it until an
institution tries to ingest the file, usually long after the people involved
have moved on. So every term emitted here is checked against
record/vocabulary-v1.json, and a term not on that list cannot be written.

WHY PYTHON ONLY. These exports are pure functions of a record, and records are
produced and served by this server. A second implementation in JavaScript would
be a third place for the same mapping to drift — this project already carries
two deliberate cross-language duplications (the scorer and the disclaimers) and
each one needs a test to hold it together. DPA consumes the RECORD, not these
exports, so nothing outside this server needs to generate them.
---------------------------------------------------------------------------
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

VOCABULARY_PATH = Path(__file__).resolve().parents[2] / "record" / "vocabulary-v1.json"


def _default_vocabulary_path() -> Path:
    """
    Where the vocabulary lives.

    Resolved through the config so the container layout works: a path derived
    from __file__ points at the repository, and inside the image
    /app/turnstone_server/interop.py would resolve it to /record — which does
    not exist. That failure would surface as an export endpoint throwing at
    request time, long after the service reported itself healthy.
    """
    from .config import config
    return config.vocabulary_path

# The 3D draft's context is not published yet. Presentation 3.0's context is,
# and is what a client will actually be able to dereference today.
IIIF_PRESENTATION_CONTEXT = "http://iiif.io/api/presentation/3/context.json"
IIIF_3D_DRAFT_CONTEXT = "http://iiif.io/api/presentation/4/context.json"


class UnknownTerm(ValueError):
    """An export tried to emit a term that is not in the vocabulary."""


def load_vocabulary(path: Path | None = None) -> dict:
    p = path or _default_vocabulary_path()
    if not p.exists():
        raise FileNotFoundError(
            f"interop vocabulary not found at {p}. Set TURNSTONE_VOCABULARY. Without it no "
            f"export can be checked, and an unchecked export is how an invented class name "
            f"reaches a museum's ingest queue."
        )
    return json.loads(p.read_text(encoding="utf-8"))


class TermChecker:
    """
    Refuses to emit a class or property that is not in the vocabulary file.

    This is the whole defence against the failure mode that matters: a
    plausible-looking invented term. Checking at emit time rather than in a
    separate linter means a mapping mistake cannot reach a file at all.
    """

    def __init__(self, vocabulary: dict):
        self.crm_classes = set(vocabulary["crm"]["classes"])
        self.crm_properties = set(vocabulary["crm"]["properties"])
        self.dig_classes = set(vocabulary["crmdig"]["classes"])
        self.dig_properties = set(vocabulary["crmdig"]["properties"])
        self.iiif_types = set(vocabulary["iiif"]["types"])
        self.iiif_motivations = set(vocabulary["iiif"]["motivations"])

    def cls(self, name: str) -> str:
        if name in self.crm_classes:
            return f"crm:{name}"
        if name in self.dig_classes:
            return f"crmdig:{name}"
        raise UnknownTerm(
            f"{name!r} is not a class in record/vocabulary-v1.json. An invented class produces "
            f"a document that parses and means nothing to the system it was written for. Add it "
            f"to the vocabulary with its defining source, or use a term that exists."
        )

    def prop(self, name: str) -> str:
        if name in self.crm_properties:
            return f"crm:{name}"
        if name in self.dig_properties:
            return f"crmdig:{name}"
        raise UnknownTerm(
            f"{name!r} is not a property in record/vocabulary-v1.json. Add it with its defining "
            f"source, or use a term that exists."
        )

    def iiif(self, name: str) -> str:
        if name not in self.iiif_types:
            raise UnknownTerm(f"{name!r} is not an IIIF type in record/vocabulary-v1.json")
        return name


def _identifier(chk: TermChecker, value: str, kind: str) -> dict:
    """A hash or id as an E42 Identifier rather than a bare string on the node."""
    return {
        "@type": chk.cls("E42_Identifier"),
        chk.prop("P2_has_type"): {"@type": chk.cls("E55_Type"), "rdfs:label": kind},
        chk.prop("P190_has_symbolic_content"): value,
    }


def _time_span(chk: TermChecker, start: str | None, end: str | None) -> dict | None:
    if not start and not end:
        return None
    span: dict[str, Any] = {"@type": chk.cls("E52_Time-Span")}
    if start:
        span[chk.prop("P82a_begin_of_the_begin")] = start
    if end:
        span[chk.prop("P82b_end_of_the_end")] = end
    return span


def to_crmdig(record: dict, *, base_uri: str = "urn:turnstone", vocabulary: dict | None = None) -> dict:
    """
    A record as CIDOC-CRM / CRMdig JSON-LD.

    The shape follows the actual chain of events, because that is what CRMdig
    exists to express and what makes the result useful rather than decorative:

        E22 Human-Made Object          the artefact
          ← L1 digitized —
        D2 Digitization Process        the capture session
          — L11 had output →           the photographs (D1 Digital Object)
          — L10 had input →
        D10 Software Execution         the reconstruction
          — L23 used software →        the backend (D14 Software)
          — L11 had output →           the mesh (D1 Digital Object)

    The quality record and the binding attach as E31 Documents that P70 document
    the things they describe. That keeps an assertion ABOUT the mesh distinct
    from a property OF the mesh — which matters here, because the whole point of
    the quality class is that it is a claim someone made, attributable and
    disputable, not an intrinsic fact about a file.
    """
    vocab = vocabulary or load_vocabulary()
    chk = TermChecker(vocab)

    sid = record.get("sessionId", "unknown")
    base = f"{base_uri}:{sid}"
    binding = record.get("binding") or {}
    recon = record.get("reconstruction") or {}
    outputs = record.get("outputs") or {}

    graph: list[dict] = []

    # --- the physical artefact ------------------------------------------
    object_uri = f"{base}/object"
    obj: dict[str, Any] = {"@id": object_uri, "@type": chk.cls("E22_Human-Made_Object")}
    if record.get("subject"):
        obj["rdfs:label"] = record["subject"]
    graph.append(obj)

    # --- the photographs ------------------------------------------------
    photo_uris = []
    src = record.get("sourceImages") or {}
    for i in range(src.get("count", 0)):
        uri = f"{base}/photograph/{i:04d}"
        photo_uris.append(uri)
    photographs = [
        {"@id": u, "@type": chk.cls("D1_Digital_Object")} for u in photo_uris
    ]
    graph.extend(photographs)

    # --- the capture session --------------------------------------------
    capture: dict[str, Any] = {
        "@id": f"{base}/capture",
        "@type": chk.cls("D2_Digitization_Process"),
        chk.prop("L1_digitized"): {"@id": object_uri},
        chk.prop("L11_had_output"): [{"@id": u} for u in photo_uris],
        chk.prop("P1_is_identified_by"): _identifier(chk, sid, "Turnstone session identifier"),
    }
    if record.get("capturedAt"):
        capture[chk.prop("L31_has_starting_date-time")] = record["capturedAt"]
        span = _time_span(chk, record["capturedAt"], None)
        if span:
            capture[chk.prop("P4_has_time-span")] = span

    operator = record.get("operator") or {}
    if operator:
        actor_uri = f"{base}/operator"
        graph.append({
            "@id": actor_uri,
            "@type": chk.cls("E39_Actor"),
            chk.prop("P2_has_type"): {
                "@type": chk.cls("E55_Type"),
                "rdfs:label": f"{operator.get('role', 'contributor')} "
                              f"({operator.get('verification', 'self-asserted')})",
            },
        })
        capture[chk.prop("P14_carried_out_by")] = {"@id": actor_uri}
    graph.append(capture)

    # --- the reconstruction ---------------------------------------------
    mesh_uri = f"{base}/mesh"
    primary = outputs.get("mesh") or outputs.get("point_cloud") or {}
    mesh: dict[str, Any] = {"@id": mesh_uri, "@type": chk.cls("D1_Digital_Object")}
    if primary.get("sha256"):
        mesh[chk.prop("P1_is_identified_by")] = _identifier(
            chk, f"sha256:{primary['sha256']}", "SHA-256 of the archive geometry")
    graph.append(mesh)

    if recon.get("backend"):
        software_uri = f"{base}/software"
        graph.append({
            "@id": software_uri,
            "@type": chk.cls("D14_Software"),
            "rdfs:label": f"{recon['backend']} {recon.get('backendVersion') or ''}".strip(),
        })
        execution: dict[str, Any] = {
            "@id": f"{base}/reconstruction",
            "@type": chk.cls("D10_Software_Execution"),
            chk.prop("L10_had_input"): [{"@id": u} for u in photo_uris],
            chk.prop("L11_had_output"): {"@id": mesh_uri},
            chk.prop("L23_used_software_or_firmware"): {"@id": software_uri},
        }
        if recon.get("startedAt"):
            execution[chk.prop("L31_has_starting_date-time")] = recon["startedAt"]
        if recon.get("finishedAt"):
            execution[chk.prop("L32_has_ending_date-time")] = recon["finishedAt"]
        span = _time_span(chk, recon.get("startedAt"), recon.get("finishedAt"))
        if span:
            execution[chk.prop("P4_has_time-span")] = span
        graph.append(execution)

    # --- the quality assessment, as a document ABOUT the mesh -----------
    quality = record.get("quality") or {}
    if quality:
        graph.append({
            "@id": f"{base}/quality",
            "@type": chk.cls("E31_Document"),
            chk.prop("P70_documents"): {"@id": mesh_uri},
            chk.prop("P2_has_type"): {
                "@type": chk.cls("E55_Type"),
                "rdfs:label": f"Turnstone capture quality: {quality.get('class')}",
            },
            chk.prop("P190_has_symbolic_content"): json.dumps({
                "rubric": record.get("rubric"),
                "class": quality.get("class"),
                "score": quality.get("score"),
                "limitingDimension": quality.get("limitingDimension"),
                "provisional": quality.get("provisional"),
            }, sort_keys=True),
        })

    # --- the disclaimers, carried as first-class assertions -------------
    # NOT dropped in translation. A record exported to a museum system without
    # its legitimacy disclaimer is exactly the artefact this project refuses to
    # produce, and an export is where such a field would most easily be lost.
    graph.append({
        "@id": f"{base}/attestation",
        "@type": chk.cls("E31_Document"),
        chk.prop("P70_documents"): {"@id": mesh_uri},
        chk.prop("P2_has_type"): {
            "@type": chk.cls("E55_Type"),
            "rdfs:label": "What this record attests, and what it does not",
        },
        chk.prop("P190_has_symbolic_content"): json.dumps({
            "attests": record["attests"],
            "doesNotAttest": record["doesNotAttest"],
        }, ensure_ascii=False, sort_keys=True),
    })

    # --- the binding ----------------------------------------------------
    if binding:
        graph.append({
            "@id": f"{base}/binding",
            "@type": chk.cls("E31_Document"),
            chk.prop("P70_documents"): {"@id": f"{base}/reconstruction"},
            chk.prop("P2_has_type"): {
                "@type": chk.cls("E55_Type"),
                "rdfs:label": "Turnstone ReconstructionBinding",
            },
            chk.prop("P190_has_symbolic_content"): json.dumps({
                "sourceSetHash": binding.get("sourceSetHash"),
                "chainComplete": binding.get("chainComplete"),
                "sealedImageCount": binding.get("sealedImageCount"),
                "totalImageCount": binding.get("totalImageCount"),
                "outputHash": binding.get("outputHash"),
                "outputPerceptualHash": binding.get("outputPerceptualHash"),
                "signed": (binding.get("signature") or {}).get("signed", False),
                "chainNote": binding.get("chainNote"),
            }, ensure_ascii=False, sort_keys=True),
        })

    ns = vocab["namespaces"]
    return {
        "@context": {
            "crm": ns["crm"],
            "crmdig": ns["crmdig"],
            "rdfs": ns["rdfs"],
        },
        "@graph": graph,
    }


def to_iiif3d(
    record: dict,
    *,
    base_uri: str = "https://example.org/iiif",
    model_url: str | None = None,
    vocabulary: dict | None = None,
) -> dict:
    """
    A record as an IIIF 3D manifest.

    ---------------------------------------------------------------------
    THIS TARGETS A DRAFT. `Scene` is defined by the IIIF 3D draft, not by
    Presentation API 3.0, and the draft targets Presentation API 4 whose context
    URI is not yet published. A manifest written against a moving specification
    can become invalid without anyone touching it.

    The warning goes in the manifest's own `summary`, where someone opening the
    file will read it. Putting it only in documentation would be the same as
    omitting it.
    ---------------------------------------------------------------------
    """
    vocab = vocabulary or load_vocabulary()
    chk = TermChecker(vocab)

    sid = record.get("sessionId", "unknown")
    base = f"{base_uri}/{sid}"
    outputs = record.get("outputs") or {}
    quality = record.get("quality") or {}
    binding = record.get("binding") or {}

    delivery = outputs.get("delivery_mesh") or {}
    body_id = model_url or f"{base}/model.glb"

    label = record.get("subject") or f"Turnstone session {sid}"

    summary_parts = [
        f"3D record produced by Turnstone. Capture quality: {quality.get('class', 'unassessed')}"
        + (f", limited by {quality['limitingDimension']}" if quality.get("limitingDimension") else "")
        + ".",
        # The disclaimer travels into the delivery format too. A viewer is where
        # a model is most likely to be seen by someone who never reads a record.
        record["doesNotAttest"],
        "FORMAT WARNING: this manifest follows the IIIF 3D draft "
        "(https://iiif.github.io/3d/), which is not a finished specification. It uses the "
        "Scene type and targets Presentation API 4, whose context is not yet published. "
        "Expect to regenerate it when the specification settles.",
    ]

    if not binding.get("chainComplete", False):
        summary_parts.append(
            f"CHAIN OF CUSTODY INCOMPLETE: {binding.get('sealedImageCount', 0)} of "
            f"{binding.get('totalImageCount', 0)} source photographs carried a verifiable seal. "
            f"This is not a partial proof — treat the source set as unsealed."
        )

    tier = record.get("disclosureTier")
    if tier and tier != "public":
        # A manifest is a delivery format; delivering something whose tier is not
        # public is a decision, and the file must not look like a publication.
        summary_parts.append(
            f"DISCLOSURE TIER: {tier}. This manifest is not cleared for public delivery."
        )

    annotation = {
        "id": f"{base}/annotation/model",
        "type": chk.iiif("Annotation"),
        "motivation": ["painting"],
        "body": {
            "id": body_id,
            "type": chk.iiif("Model"),
            "format": "model/gltf-binary",
        },
        "target": {"id": f"{base}/scene", "type": chk.iiif("Scene")},
    }
    if delivery.get("sha256"):
        # Not part of IIIF, and namespaced so a strict client ignores it rather
        # than choking. A delivery copy that cannot be tied back to the record is
        # how a model ends up circulating with no provenance at all.
        annotation["body"]["turnstone:sha256"] = delivery["sha256"]

    manifest = {
        "@context": IIIF_3D_DRAFT_CONTEXT,
        "id": f"{base}/manifest.json",
        "type": chk.iiif("Manifest"),
        "label": {"en": [label]},
        "summary": {"en": summary_parts},
        "items": [
            {
                "id": f"{base}/scene",
                "type": chk.iiif("Scene"),
                "label": {"en": [label]},
                "items": [
                    {
                        "id": f"{base}/scene/page/1",
                        "type": chk.iiif("AnnotationPage"),
                        "items": [annotation],
                    }
                ],
            }
        ],
        "rights": "http://rightsstatements.org/vocab/CNE/1.0/",
        "requiredStatement": {
            "label": {"en": ["What this record does not attest"]},
            "value": {"en": [record["doesNotAttest"]]},
        },
        "metadata": _iiif_metadata(record),
        "seeAlso": [
            {
                "id": f"{base}/record.json",
                "type": "Dataset",
                "label": {"en": ["Turnstone capture record"]},
                "format": "application/json",
            },
            {
                "id": f"{base}/crmdig.json",
                "type": "Dataset",
                "label": {"en": ["CIDOC-CRM / CRMdig provenance"]},
                "format": "application/ld+json",
            },
        ],
    }
    return manifest


def _iiif_metadata(record: dict) -> list[dict]:
    quality = record.get("quality") or {}
    binding = record.get("binding") or {}
    recon = record.get("reconstruction") or {}
    src = record.get("sourceImages") or {}

    def entry(label: str, value: str) -> dict:
        return {"label": {"en": [label]}, "value": {"en": [str(value)]}}

    rows = [
        entry("Capture quality class", quality.get("class", "unassessed")),
        entry("Limiting dimension", quality.get("limitingDimension") or "n/a"),
        entry("Source photographs", src.get("count", 0)),
        entry("Disclosure tier", record.get("disclosureTier", "unknown")),
        entry("Sensitivity", record.get("sensitivity", "unknown")),
    ]
    if recon.get("backend"):
        rows.append(entry("Reconstruction pipeline",
                          f"{recon['backend']} {recon.get('backendVersion') or ''}".strip()))
    if binding:
        rows.append(entry(
            "Chain of custody",
            "complete — every source photograph sealed" if binding.get("chainComplete")
            else f"INCOMPLETE — {binding.get('sealedImageCount', 0)} of "
                 f"{binding.get('totalImageCount', 0)} photographs sealed",
        ))
        sig = binding.get("signature") or {}
        rows.append(entry("Binding signature",
                          f"Ed25519, key {sig.get('keyId')}" if sig.get("signed") else "not signed"))

    labels = record.get("traditionalKnowledgeLabels") or []
    if labels:
        rows.append(entry("Traditional Knowledge Labels",
                          ", ".join(l["code"] for l in labels)))
    elif record.get("sensitivity") in ("funerary", "sacred"):
        rows.append(entry("Traditional Knowledge Labels",
                          "not yet determined — NOT 'none apply'"))
    return rows
