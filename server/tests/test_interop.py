"""
CRMdig and IIIF 3D export.

The test that matters here is the one that uses an INDEPENDENT JSON-LD
processor. Interop formats fail in a particular way: an invented class name
produces a document that parses, validates as JSON, looks entirely plausible to
its author, and means nothing to the system it was written for. Checking the
output with our own reader would prove only that we are self-consistent.

pyld expands the document against its context, which resolves every prefixed
term to a full IRI. A term that does not expand is a term no consumer can
interpret — which is precisely the invisible failure.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from turnstone_server.binding import (  # noqa: E402
    SigningKey, build_binding, load_disclaimers, sign_binding,
)
from turnstone_server.interop import (  # noqa: E402
    IIIF_3D_DRAFT_CONTEXT, TermChecker, UnknownTerm, load_vocabulary,
    to_crmdig, to_iiif3d,
)
from turnstone_server.record import build_record  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
DISCLAIMERS = REPO / "record" / "disclaimers-v1.json"


@pytest.fixture(scope="session")
def disclaimers():
    return load_disclaimers(DISCLAIMERS)


@pytest.fixture(scope="session")
def vocabulary():
    return load_vocabulary()


@pytest.fixture
def record(disclaimers):
    binding = sign_binding(
        build_binding(
            session_id="s_export", job_id="j_export", set_hash="a" * 64,
            images=[{"name": f"f{i}.jpg", "sealed": False} for i in range(9)],
            pipeline={"backend": "alicevision", "version": "2024.1.0", "parameters": {}},
            output_hash="b" * 64,
            output_perceptual_hash="c" * 96,
            perceptual_views={"front": "c" * 16},
            chain_note=disclaimers["chainNote"],
            created_at="2026-08-23T12:00:00Z",
        ),
        SigningKey.generate("test-institution"),
    )
    r = build_record(
        disclaimers,
        session_id="s_export",
        captured_at="2026-08-23T10:00:00Z",
        subject="Carved limestone fragment",
        rubric={"id": "heritage-v1", "version": "1.0.0"},
        quality={"class": "study", "score": 84, "limitingDimension": "scale-reference",
                 "provisional": False},
        sensitivity="ordinary",
        source_images={"count": 9, "distinct": 9, "byteIdentical": True},
        binding=binding,
    )
    r["reconstruction"] = {
        "backend": "alicevision", "backendVersion": "2024.1.0", "parameters": {},
        "startedAt": "2026-08-23T11:00:00Z", "finishedAt": "2026-08-23T11:42:00Z",
    }
    r["outputs"] = {
        "point_cloud": {"file": "model.ply", "bytes": 100, "sha256": "d" * 64},
        "delivery_mesh": {"file": "model.glb", "bytes": 90, "sha256": "e" * 64},
    }
    return r


# ------------------------------------------------------- vocabulary guard

def test_an_invented_term_cannot_be_emitted(vocabulary):
    """
    The whole defence. An invented class produces a document that parses and
    means nothing, and nobody discovers it until an institution tries to ingest.
    """
    chk = TermChecker(vocabulary)
    assert chk.cls("E22_Human-Made_Object") == "crm:E22_Human-Made_Object"
    assert chk.cls("D1_Digital_Object") == "crmdig:D1_Digital_Object"
    assert chk.prop("L11_had_output") == "crmdig:L11_had_output"

    with pytest.raises(UnknownTerm, match="not a class"):
        chk.cls("E999_Imaginary_Thing")
    with pytest.raises(UnknownTerm, match="not a property"):
        chk.prop("P999_probably_relates_to")
    with pytest.raises(UnknownTerm, match="not an IIIF type"):
        chk.iiif("Hologram")


def test_every_vocabulary_term_has_a_definition(vocabulary):
    """A term with no scope note is one nobody can check was used correctly."""
    for section in ("crm", "crmdig"):
        for kind in ("classes", "properties"):
            for term, definition in vocabulary[section][kind].items():
                assert definition.strip(), f"{section}.{kind}.{term} has no definition"


# ---------------------------------------------------------------- CRMdig

def test_crmdig_expands_under_an_independent_processor(record):
    """
    Expansion resolves every prefixed term to a full IRI. A term that does not
    expand is one no consumer can interpret.
    """
    pyld = pytest.importorskip("pyld")
    doc = to_crmdig(record)
    expanded = pyld.jsonld.expand(doc)

    assert expanded, "the document expanded to nothing"

    iris = set()

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k.startswith("@"):
                    if k == "@type":
                        for t in (v if isinstance(v, list) else [v]):
                            if isinstance(t, str):
                                iris.add(t)
                else:
                    iris.add(k)
                walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(expanded)

    # Anything left with a colon-prefix rather than a full IRI failed to expand.
    unresolved = [i for i in iris if not i.startswith("http")]
    assert unresolved == [], f"terms did not expand to IRIs: {unresolved}"

    assert any("cidoc-crm" in i for i in iris), "no CIDOC-CRM terms survived expansion"
    assert any("CRMdig" in i for i in iris), "no CRMdig terms survived expansion"


def test_crmdig_models_the_actual_chain_of_events(record):
    doc = to_crmdig(record)
    by_type: dict[str, list] = {}
    for node in doc["@graph"]:
        by_type.setdefault(node["@type"], []).append(node)

    assert "crm:E22_Human-Made_Object" in by_type, "the physical artefact must be present"
    assert "crmdig:D2_Digitization_Process" in by_type, "the capture session"
    assert "crmdig:D10_Software_Execution" in by_type, "the reconstruction"
    assert "crmdig:D14_Software" in by_type, "the backend"
    assert len(by_type["crmdig:D1_Digital_Object"]) == 10, "9 photographs plus the mesh"

    capture = by_type["crmdig:D2_Digitization_Process"][0]
    # L1 digitized is what ties the digital chain to the physical object. Without
    # it the export describes files that came from nowhere.
    assert capture["crmdig:L1_digitized"]["@id"].endswith("/object")
    assert len(capture["crmdig:L11_had_output"]) == 9

    execution = by_type["crmdig:D10_Software_Execution"][0]
    assert len(execution["crmdig:L10_had_input"]) == 9
    assert execution["crmdig:L11_had_output"]["@id"].endswith("/mesh")
    assert execution["crmdig:L23_used_software_or_firmware"]["@id"].endswith("/software")
    assert execution["crmdig:L31_has_starting_date-time"] == "2026-08-23T11:00:00Z"
    assert execution["crmdig:L32_has_ending_date-time"] == "2026-08-23T11:42:00Z"


def test_the_disclaimer_survives_export_to_crmdig(record):
    """
    The field most likely to be lost in translation, and the one that must not
    be. A record exported to a museum system without its legitimacy disclaimer
    is exactly the artefact this project refuses to produce.
    """
    doc = to_crmdig(record)
    flat = json.dumps(doc, ensure_ascii=False)
    assert record["doesNotAttest"] in flat
    assert record["attests"] in flat


def test_quality_is_a_document_about_the_mesh_not_a_property_of_it(record):
    """
    The quality class is a claim someone made — attributable and disputable —
    not an intrinsic fact about a file. E31 Document / P70 documents keeps that
    distinction, which collapses the moment it becomes a property of the mesh.
    """
    doc = to_crmdig(record)
    docs = [n for n in doc["@graph"] if n["@type"] == "crm:E31_Document"]
    quality = [d for d in docs if "quality" in d["@id"]]
    assert quality, "the assessment must appear as a document"
    assert quality[0]["crm:P70_documents"]["@id"].endswith("/mesh")

    mesh = [n for n in doc["@graph"] if n["@id"].endswith("/mesh")][0]
    for key in mesh:
        assert "quality" not in key.lower(), "quality must not become a property of the mesh"


def test_the_binding_is_exported_with_its_chain_state(record):
    doc = to_crmdig(record)
    binding = [n for n in doc["@graph"] if n["@id"].endswith("/binding")][0]
    content = json.loads(binding["crm:P190_has_symbolic_content"])
    assert content["chainComplete"] is False
    assert content["sealedImageCount"] == 0
    assert content["totalImageCount"] == 9
    assert content["signed"] is True


def test_hashes_are_identifiers_not_bare_strings(record):
    """P1 is identified by / E42 Identifier, rather than inventing a hash property."""
    doc = to_crmdig(record)
    mesh = [n for n in doc["@graph"] if n["@id"].endswith("/mesh")][0]
    ident = mesh["crm:P1_is_identified_by"]
    assert ident["@type"] == "crm:E42_Identifier"
    assert ident["crm:P190_has_symbolic_content"].startswith("sha256:")


# ------------------------------------------------------------------ IIIF

def test_iiif_manifest_has_the_draft_structure(record):
    m = to_iiif3d(record)
    assert m["type"] == "Manifest"
    assert m["@context"] == IIIF_3D_DRAFT_CONTEXT

    scene = m["items"][0]
    assert scene["type"] == "Scene", "3D content lives in a Scene, not a Canvas"

    page = scene["items"][0]
    assert page["type"] == "AnnotationPage"

    anno = page["items"][0]
    assert anno["type"] == "Annotation"
    assert anno["motivation"] == ["painting"]
    assert anno["body"]["type"] == "Model"
    assert anno["body"]["format"] == "model/gltf-binary"
    assert anno["target"]["type"] == "Scene"
    assert anno["target"]["id"] == scene["id"]


def test_the_manifest_warns_that_it_follows_a_draft(record):
    """
    A manifest written against a moving specification can become invalid without
    anyone touching it. The warning belongs in the file, where someone opening
    it will read it — not only in documentation nobody sees.
    """
    m = to_iiif3d(record)
    summary = " ".join(m["summary"]["en"])
    assert "draft" in summary.lower()
    assert "not a finished specification" in summary


def test_the_disclaimer_survives_export_to_iiif(record):
    """
    A viewer is where a model is most likely to be seen by someone who never
    reads a record, so requiredStatement is exactly the right place for it.
    """
    m = to_iiif3d(record)
    assert m["requiredStatement"]["value"]["en"] == [record["doesNotAttest"]]
    assert record["doesNotAttest"] in " ".join(m["summary"]["en"])


def test_an_incomplete_chain_is_stated_in_the_manifest(record):
    m = to_iiif3d(record)
    summary = " ".join(m["summary"]["en"])
    assert "CHAIN OF CUSTODY INCOMPLETE" in summary
    assert "not a partial proof" in summary

    labels = {e["label"]["en"][0]: e["value"]["en"][0] for e in m["metadata"]}
    assert "INCOMPLETE" in labels["Chain of custody"]


def test_a_non_public_tier_says_it_is_not_cleared_for_delivery(record):
    """
    A manifest IS a delivery format. One built from a record that is not cleared
    for public delivery must not look like a publication.
    """
    m = to_iiif3d(record)
    assert record["disclosureTier"] == "museum"
    assert "not cleared for public delivery" in " ".join(m["summary"]["en"])


def test_undetermined_tk_labels_are_not_reported_as_none(disclaimers, record):
    record["sensitivity"] = "funerary"
    record["disclosureTier"] = "source-community"
    m = to_iiif3d(record)
    labels = {e["label"]["en"][0]: e["value"]["en"][0] for e in m["metadata"]}
    assert labels["Traditional Knowledge Labels"] == "not yet determined — NOT 'none apply'"


def test_the_manifest_points_back_to_the_record_and_provenance(record):
    m = to_iiif3d(record)
    formats = {s["format"] for s in m["seeAlso"]}
    assert "application/json" in formats
    assert "application/ld+json" in formats


def test_a_supplied_model_url_is_used(record):
    m = to_iiif3d(record, model_url="https://cdn.example.org/objects/frag.glb")
    assert m["items"][0]["items"][0]["items"][0]["body"]["id"] == \
        "https://cdn.example.org/objects/frag.glb"


def test_the_delivery_copy_carries_its_hash(record):
    """A delivery copy that cannot be tied back to the record circulates with no provenance."""
    m = to_iiif3d(record)
    body = m["items"][0]["items"][0]["items"][0]["body"]
    assert body["turnstone:sha256"] == "e" * 64


def test_export_refuses_a_record_with_no_disclaimer(record):
    """The exporters must not quietly produce a document the record could not be."""
    del record["doesNotAttest"]
    with pytest.raises(KeyError):
        to_crmdig(record)
    with pytest.raises(KeyError):
        to_iiif3d(record)


def test_exports_use_only_terms_the_vocabulary_defines(record, vocabulary):
    """
    Sweep the whole emitted document, not just the terms a test remembered.

    A mapping added later without a corresponding vocabulary entry is exactly
    the drift this guards against, and it would otherwise pass every test above.
    """
    doc = to_crmdig(record)
    known = (
        {f"crm:{t}" for t in vocabulary["crm"]["classes"]}
        | {f"crm:{t}" for t in vocabulary["crm"]["properties"]}
        | {f"crmdig:{t}" for t in vocabulary["crmdig"]["classes"]}
        | {f"crmdig:{t}" for t in vocabulary["crmdig"]["properties"]}
        | {"@id", "@type", "@context", "@graph", "rdfs:label"}
    )

    seen: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                seen.add(k)
                if k == "@type":
                    for t in (v if isinstance(v, list) else [v]):
                        if isinstance(t, str):
                            seen.add(t)
                walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(doc["@graph"])
    unknown = sorted(seen - known)
    assert unknown == [], f"terms emitted that the vocabulary does not define: {unknown}"


def test_iiif_uses_only_declared_types(record, vocabulary):
    m = to_iiif3d(record)
    declared = set(vocabulary["iiif"]["types"])
    # `Dataset` is a Web Annotation type used in seeAlso, not a IIIF container.
    declared.add("Dataset")

    seen: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            if isinstance(node.get("type"), str):
                seen.add(node["type"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(m)
    assert seen <= declared, f"undeclared IIIF types: {sorted(seen - declared)}"
