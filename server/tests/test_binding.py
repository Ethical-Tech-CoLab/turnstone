"""
Record, binding and signing on the server.

The tests that matter most here are the cross-language ones. The disclaimer
text, the perceptual hash and the signature all have to mean the same thing in
JavaScript and in Python, and each fails silently if they drift:

  * a paraphrased disclaimer is a different legal statement, and nobody can tell
    from the record which wording was used;
  * a perceptual hash that disagrees across implementations cannot re-associate
    anything, which is its only job;
  * a signature made by this server that a JavaScript consumer cannot verify is
    a signature nobody outside this codebase can check.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from turnstone_server.binding import (  # noqa: E402
    DisclaimerMissing, build_binding, canonicalise, check_binding_consistency,
    dhash_image, hamming_distance, load_disclaimers, perceptual_hash_of_views,
    perceptual_similarity, sign_binding, source_set_hash, SigningKey, verify_binding,
    VIEW_ORDER,
)
from turnstone_server.config import Config  # noqa: E402
from turnstone_server.jobs import JobStore  # noqa: E402
from turnstone_server.record import build_record, default_tier, TIERS  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
DISCLAIMERS = REPO / "record" / "disclaimers-v1.json"
RUBRIC = REPO / "rubric" / "heritage-v1.json"


@pytest.fixture(scope="session")
def disclaimers():
    return load_disclaimers(DISCLAIMERS)


def _quality():
    return {"class": "study", "score": 84, "provisional": False}


# ------------------------------------------------------------------ C-4

def test_c4_record_cannot_be_built_without_the_legitimacy_disclaimer(disclaimers):
    stripped = dict(disclaimers)
    stripped["doesNotAttest"] = ""
    with pytest.raises(DisclaimerMissing):
        build_record(stripped, session_id="s", quality=_quality())

    absent = {k: v for k, v in disclaimers.items() if k != "doesNotAttest"}
    with pytest.raises(DisclaimerMissing):
        build_record(absent, session_id="s", quality=_quality())


def test_c4_both_disclaimers_appear_verbatim(disclaimers):
    r = build_record(disclaimers, session_id="s", quality=_quality())
    assert r["attests"] == disclaimers["attests"]
    assert r["doesNotAttest"] == disclaimers["doesNotAttest"]
    assert "lawfully" in r["doesNotAttest"]


def test_disclaimers_file_is_refused_if_corrupt(tmp_path, disclaimers):
    bad = dict(disclaimers)
    bad["attests"] = "An object \u00e2\u0080\u0094 with mojibake"
    p = tmp_path / "d.json"
    p.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="mojibake"):
        load_disclaimers(p)


def test_unsupported_disclaimers_version_is_refused(tmp_path, disclaimers):
    bad = dict(disclaimers)
    bad["schemaVersion"] = "2.0"
    p = tmp_path / "d.json"
    p.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="schemaVersion"):
        load_disclaimers(p)


# ------------------------------------------------------------------ C-5

def test_c5_funerary_and_sacred_default_to_source_community(disclaimers):
    for sensitivity in ("funerary", "sacred"):
        assert default_tier(disclaimers, sensitivity) == "source-community"
        r = build_record(disclaimers, session_id="s", quality=_quality(),
                         sensitivity=sensitivity)
        assert r["disclosureTier"] == "source-community"
        assert r["disclosureTierSource"] == "default-for-sensitivity"


def test_c5_nothing_defaults_to_public(disclaimers):
    for sensitivity in ("ordinary", "funerary", "sacred"):
        r = build_record(disclaimers, session_id="s", quality=_quality(),
                         sensitivity=sensitivity)
        assert r["disclosureTier"] != "public"


def test_unknown_sensitivity_fails_closed(disclaimers):
    assert default_tier(disclaimers, "something-new") == TIERS[0] == "source-community"
    with pytest.raises(ValueError, match="unknown sensitivity"):
        build_record(disclaimers, session_id="s", quality=_quality(),
                     sensitivity="something-new")


def test_disclosure_can_be_restricted_but_not_relaxed(disclaimers):
    r = build_record(disclaimers, session_id="s", quality=_quality(),
                     sensitivity="ordinary", disclosure_tier="source-community")
    assert r["disclosureTier"] == "source-community"

    with pytest.raises(ValueError, match="refusing to publish"):
        build_record(disclaimers, session_id="s", quality=_quality(),
                     sensitivity="sacred", disclosure_tier="public")


def test_explicit_means_a_person_decided_not_that_a_field_was_present(disclaimers):
    """
    The capture client writes its own default tier into every manifest.

    If any supplied value counted as a choice, every ordinary record would claim
    someone deliberately set it — misleading exactly the reviewer scanning for
    records where a judgement was actually made.
    """
    passthrough = build_record(disclaimers, session_id="s", quality=_quality(),
                               sensitivity="ordinary", disclosure_tier="museum")
    assert passthrough["disclosureTier"] == "museum"
    assert passthrough["disclosureTierSource"] == "default-for-sensitivity"

    decided = build_record(disclaimers, session_id="s", quality=_quality(),
                           sensitivity="ordinary", disclosure_tier="source-community")
    assert decided["disclosureTierSource"] == "explicit"


def test_tk_labels_are_a_controlled_vocabulary(disclaimers):
    r = build_record(disclaimers, session_id="s", quality=_quality(),
                     traditional_knowledge_labels=["TK CB"])
    assert r["traditionalKnowledgeLabels"] == [{"code": "TK CB"}]
    assert r["traditionalKnowledgeLabelsState"] == "declared"

    with pytest.raises(ValueError, match="unknown Traditional Knowledge Label"):
        build_record(disclaimers, session_id="s", quality=_quality(),
                     traditional_knowledge_labels=["TK INVENTED"])


def test_the_consultation_gap_travels_with_the_record(disclaimers):
    r = build_record(disclaimers, session_id="s", quality=_quality(), sensitivity="funerary")
    assert r["disclosureGap"]["status"] == "blocking"
    assert "no source-community input" in r["disclosureGap"]["issue"]


# ------------------------------------------------------------------ C-6

def _images(total, sealed):
    return [{"name": f"f{i}.jpg", "sha256": f"{i:064x}", "sealed": i < sealed}
            for i in range(total)]


def _binding(total, sealed, disclaimers, **over):
    kwargs = dict(
        session_id="s", job_id="j", set_hash="h", images=_images(total, sealed),
        pipeline={"backend": "alicevision", "version": "2024.1.0", "parameters": {}},
        output_hash="out", output_perceptual_hash=None, perceptual_views=None,
        chain_note=disclaimers["chainNote"], created_at="2026-08-23T00:00:00Z",
    )
    kwargs.update(over)
    return build_binding(**kwargs)


def test_c6_chain_complete_only_when_every_image_is_sealed(disclaimers):
    assert _binding(10, 10, disclaimers)["chainComplete"] is True
    # One short out of a hundred. The temptation is to call this "essentially
    # complete"; the whole point is that it is not.
    assert _binding(100, 99, disclaimers)["chainComplete"] is False
    assert _binding(10, 0, disclaimers)["chainComplete"] is False


def test_c6_seal_counts_only_on_explicit_true(disclaimers):
    ambiguous = [
        {"name": "a", "sealed": True},
        {"name": "b", "sealed": "true"},
        {"name": "c"},
        {"name": "d", "sealed": None},
    ]
    b = _binding(0, 0, disclaimers, images=ambiguous)
    assert b["sealedImageCount"] == 1
    assert b["chainComplete"] is False


def test_c6_zero_images_is_not_a_complete_chain(disclaimers):
    b = _binding(0, 0, disclaimers)
    assert b["chainComplete"] is False
    assert any("binds nothing" in p for p in check_binding_consistency(b))


def test_c6_consistency_check_catches_a_flipped_flag(disclaimers):
    tampered = dict(_binding(10, 4, disclaimers))
    tampered["chainComplete"] = True
    assert any("chainComplete" in p for p in check_binding_consistency(tampered))
    assert check_binding_consistency(_binding(10, 10, disclaimers)) == []


def test_binding_requires_its_chain_note(disclaimers):
    with pytest.raises(DisclaimerMissing, match="chainNote"):
        _binding(3, 3, disclaimers, chain_note="")


def test_source_set_hash_ignores_listing_order():
    assert source_set_hash(["c", "a", "b"]) == source_set_hash(["a", "b", "c"])
    assert source_set_hash(["a", "b"]) != source_set_hash(["a", "c"])


def test_source_set_hash_treats_a_duplicated_frame_as_one_photograph():
    """
    Two byte-identical files are one photograph.

    A package re-exported with an accidental duplicate must bind to the same
    source set, and must agree with the content hash the job model uses — two
    different hashes over one set of photographs would be a standing invitation
    to compare the wrong pair.
    """
    assert source_set_hash(["a", "b"]) == source_set_hash(["a", "b", "a"])


def test_source_set_hash_matches_the_job_content_hash(tmp_path):
    """
    The binding and the job model must identify a source set the same way, or a
    verifier holding one cannot look up the other.
    """
    import hashlib
    import json as _json
    import zipfile
    from PIL import Image
    from turnstone_server.package import extract_package

    z = tmp_path / "p.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("manifest.json", _json.dumps({"format": "turnstone-session/1"}))
        for i in range(3):
            p = tmp_path / f"i{i}.jpg"
            Image.new("RGB", (32, 32), (i * 60, 40, 90)).save(p, "JPEG")
            zf.write(p, f"images/f{i}.jpg")

    pkg = extract_package(z, tmp_path / "out")
    digests = [hashlib.sha256((pkg.root / n).read_bytes()).hexdigest() for n in pkg.image_names]
    assert source_set_hash(digests) == pkg.content_hash()


# --------------------------------------------------------------- signing

def test_unsigned_bindings_say_so_explicitly(disclaimers):
    """
    An operator must never mistake "no key configured" for "signed".

    A key the service generated for itself would prove nothing — whoever can
    alter a binding can re-sign it — so none is invented, and the absence is
    machine-readable rather than a missing field nobody thinks to check.
    """
    b = sign_binding(_binding(3, 3, disclaimers), None)
    assert b["signature"]["signed"] is False
    assert b["signature"]["algorithm"] is None
    assert "NOT signed" in b["signature"]["note"]

    ok, why = verify_binding(b)
    assert ok is False
    assert "not signed" in why


def test_a_signed_binding_verifies(disclaimers):
    key = SigningKey.generate("test-key")
    b = sign_binding(_binding(5, 5, disclaimers), key)
    assert b["signature"]["signed"] is True
    assert b["signature"]["algorithm"] == "Ed25519"

    ok, why = verify_binding(b, key.public_key_hex())
    assert ok, why


def test_tampering_with_a_signed_binding_is_detected(disclaimers):
    """The flipped-chainComplete attack, this time against the signature."""
    key = SigningKey.generate("test-key")
    b = sign_binding(_binding(10, 3, disclaimers), key)
    assert b["chainComplete"] is False

    b["chainComplete"] = True
    ok, why = verify_binding(b, key.public_key_hex())
    assert ok is False
    assert "altered since signing" in why


def test_verifying_against_the_embedded_key_says_what_it_does_not_prove(disclaimers):
    key = SigningKey.generate("test-key")
    b = sign_binding(_binding(3, 3, disclaimers), key)
    ok, why = verify_binding(b)
    assert ok is True
    # "Valid" must not be readable as "trustworthy".
    assert "does NOT establish who signed it" in why


def test_a_substituted_key_is_refused(disclaimers):
    key = SigningKey.generate("real")
    other = SigningKey.generate("other")
    b = sign_binding(_binding(3, 3, disclaimers), key)
    ok, why = verify_binding(b, other.public_key_hex())
    assert ok is False


def test_signing_key_file_must_be_a_raw_seed(tmp_path):
    p = tmp_path / "key.bin"
    p.write_bytes(b"-----BEGIN PRIVATE KEY-----\n")
    with pytest.raises(ValueError, match="raw seed"):
        SigningKey.from_file(p)


def test_a_misconfigured_signing_key_fails_loudly(tmp_path):
    """
    Never silently falls back to unsigned.

    An operator who configured signing and quietly got unsigned bindings would
    not find out until someone tried to verify one, long after the capture.
    """
    cfg = Config(data_dir=tmp_path / "d", signing_key_path=tmp_path / "absent.key")
    store = JobStore(cfg)
    with pytest.raises(RuntimeError, match="does not exist"):
        store._signing_key()


# ------------------------------------------------- cross-language agreement

def test_disclaimer_text_is_byte_identical_in_javascript(disclaimers):
    """
    The JavaScript client and this server must assert the same words.

    A record whose disclaimer was paraphrased is not the same statement, and
    nothing in the record would show which wording was used.
    """
    harness = (
        "import { readFileSync } from 'node:fs';\n"
        f"import {{ loadDisclaimers }} from {json.dumps((REPO / 'lib' / 'record.js').as_uri())};\n"
        f"const d = loadDisclaimers(readFileSync({json.dumps(str(DISCLAIMERS))}, 'utf8'));\n"
        "process.stdout.write(JSON.stringify({attests: d.attests, doesNotAttest: d.doesNotAttest,"
        " chainNote: d.chainNote, replicationNote: d.replicationNote}));\n"
    )
    out = _run_node(harness)
    js = json.loads(out)
    for key in ("attests", "doesNotAttest", "chainNote", "replicationNote"):
        assert js[key] == disclaimers[key], f"{key} differs between JavaScript and Python"


def test_canonical_bytes_agree_with_javascript(disclaimers):
    """
    Both implementations must serialise a binding to identical bytes, or a
    signature made here cannot be verified there — which is most of the point of
    signing at all.
    """
    b = _binding(4, 4, disclaimers)
    harness = (
        f"import {{ canonicalise }} from {json.dumps((REPO / 'lib' / 'binding.js').as_uri())};\n"
        f"const b = {json.dumps(b)};\n"
        "process.stdout.write(canonicalise(b));\n"
    )
    js_bytes = _run_node(harness).encode("utf-8")
    assert js_bytes == canonicalise(b)


def test_javascript_can_verify_a_signature_made_here(disclaimers):
    """
    The real cross-implementation test: Node verifies a Python Ed25519 signature.

    A signature only this codebase can check is not much of a signature.
    """
    key = SigningKey.generate("cross-check")
    b = sign_binding(_binding(6, 6, disclaimers), key)

    harness = (
        "import { createPublicKey, verify } from 'node:crypto';\n"
        f"import {{ canonicalise }} from {json.dumps((REPO / 'lib' / 'binding.js').as_uri())};\n"
        f"const b = {json.dumps(b)};\n"
        "const raw = Buffer.from(b.signature.publicKey, 'hex');\n"
        # Wrap the raw Ed25519 public key in the DER prefix Node expects.
        "const der = Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), raw]);\n"
        "const key = createPublicKey({ key: der, format: 'der', type: 'spki' });\n"
        "const ok = verify(null, Buffer.from(canonicalise(b), 'utf8'), key,"
        " Buffer.from(b.signature.value, 'hex'));\n"
        "process.stdout.write(JSON.stringify({ ok }));\n"
    )
    assert json.loads(_run_node(harness))["ok"] is True, (
        "Node could not verify a signature made by Python"
    )


def test_perceptual_hash_agrees_with_javascript(tmp_path):
    """
    A perceptual hash that disagrees across implementations cannot re-associate
    anything, which is its only job.
    """
    from PIL import Image
    img = Image.new("RGB", (96, 72))
    px = img.load()
    for y in range(72):
        for x in range(96):
            px[x, y] = ((x * 3) % 256, (y * 5) % 256, ((x + y) * 2) % 256)
    p = tmp_path / "v.png"
    img.save(p, "PNG")

    py_hash = dhash_image(p)

    harness = (
        "import { readFileSync } from 'node:fs';\n"
        f"import {{ dHash, toGrayscale }} from {json.dumps((REPO / 'lib' / 'phash.js').as_uri())};\n"
        "const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));\n"
        "const rgba = new Uint8Array(raw.width * raw.height * 4);\n"
        "for (let i = 0; i < raw.pixels.length; i += 3) {\n"
        "  const p = (i / 3) * 4;\n"
        "  rgba[p] = raw.pixels[i]; rgba[p+1] = raw.pixels[i+1];\n"
        "  rgba[p+2] = raw.pixels[i+2]; rgba[p+3] = 255;\n"
        "}\n"
        "process.stdout.write(dHash(toGrayscale(rgba, raw.width, raw.height)));\n"
    )
    pixels = []
    for y in range(72):
        for x in range(96):
            pixels.extend(px[x, y])
    data = tmp_path / "px.json"
    data.write_text(json.dumps({"width": 96, "height": 72, "pixels": pixels}), encoding="utf-8")

    js_hash = _run_node(harness, str(data))
    assert js_hash == py_hash, f"python {py_hash} vs javascript {js_hash}"


def _run_node(source: str, *args: str) -> str:
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "harness.mjs"
        p.write_text(source, encoding="utf-8")
        proc = subprocess.run(["node", str(p), *args],
                              capture_output=True, text=True, check=False,
                              encoding="utf-8")
        if proc.returncode != 0:
            pytest.fail(f"javascript harness failed:\n{proc.stderr}")
        return proc.stdout


# ------------------------------------------------------- perceptual hashing

def test_dhash_survives_resaving_and_resizing(tmp_path):
    """
    The whole reason for a second hash: the cryptographic one breaks the first
    time anyone opens a model and exports it again.
    """
    from PIL import Image
    img = Image.new("RGB", (256, 256))
    px = img.load()
    for y in range(256):
        for x in range(256):
            v = (x * 2 + y) % 256
            px[x, y] = (v, v, v)

    original = tmp_path / "a.png"
    img.save(original, "PNG")

    # Re-encoded as JPEG and resized — what a round trip through other software
    # does to a file.
    resaved = tmp_path / "b.jpg"
    img.resize((128, 128), Image.BILINEAR).save(resaved, "JPEG", quality=85)

    d = hamming_distance(dhash_image(original), dhash_image(resaved))
    assert d <= 10, f"re-export moved the perceptual hash by {d} bits; it should survive"


def test_dhash_distinguishes_different_geometry(tmp_path):
    from PIL import Image
    a, b = tmp_path / "a.png", tmp_path / "b.png"
    ia, ib = Image.new("RGB", (128, 128)), Image.new("RGB", (128, 128))
    pa, pb = ia.load(), ib.load()
    for y in range(128):
        for x in range(128):
            pa[x, y] = ((x * 2) % 256,) * 3
            pb[x, y] = ((y * 2) % 256,) * 3
    ia.save(a, "PNG")
    ib.save(b, "PNG")
    assert hamming_distance(dhash_image(a), dhash_image(b)) > 16


def test_perceptual_hash_covers_all_six_views(tmp_path):
    from PIL import Image
    paths = {}
    for i, name in enumerate(VIEW_ORDER):
        p = tmp_path / f"{name}.png"
        im = Image.new("RGB", (64, 64))
        px = im.load()
        for y in range(64):
            for x in range(64):
                px[x, y] = (((x + i * 7) * 4) % 256, (y * 3) % 256, 0)
        im.save(p, "PNG")
        paths[f"ortho_{name}"] = p

    combined, per_view = perceptual_hash_of_views(paths)
    assert len(per_view) == 6
    assert len(combined) == 6 * 16

    # Order is part of the identity: a hash that sorted its views would call a
    # mesh and its mirror image the same object.
    swapped = dict(paths)
    swapped["ortho_left"], swapped["ortho_right"] = paths["ortho_right"], paths["ortho_left"]
    other, _ = perceptual_hash_of_views(swapped)
    assert other != combined

    del paths["ortho_top"]
    with pytest.raises(ValueError, match="missing the top view"):
        perceptual_hash_of_views(paths)


def test_similarity_is_a_number_not_a_verdict():
    assert perceptual_similarity("ff" * 8, "ff" * 8) == 1.0
    assert perceptual_similarity("ff" * 8, "00" * 8) == 0.0
    with pytest.raises(ValueError, match="different lengths"):
        hamming_distance("aa", "aaaa")
