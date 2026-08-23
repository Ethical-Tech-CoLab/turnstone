"""
Emitting and signing the ReconstructionBinding.

---------------------------------------------------------------------------
C2PA's normative format list is JPEG, PNG, GIF, TIFF, BMFF video and PDF.
glTF, USDZ, E57 and PLY are absent. Photographs can be sealed to a very high
standard and the mesh built from them inherits none of it — the chain breaks at
exactly the step that produces the artefact anyone will look at.

The binding spans that gap. It is a signed statement that these sealed
photographs, through this pipeline, produced this mesh.

chainComplete IS TRUE ONLY WHEN EVERY SOURCE IMAGE WAS SEALED. A chain that is
90% sealed is not 90% of a proof: the unsealed 10% is precisely where a
substituted photograph would be inserted, and an attacker chooses where to
attack rather than spreading tampering evenly to keep a percentage looking
respectable.

The disclaimer text and the chain note are read from record/disclaimers-v1.json,
the same file the JavaScript client reads. Two implementations each holding
their own copy of a legal sentence will eventually differ by a word.
---------------------------------------------------------------------------
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

VIEW_ORDER = ["front", "back", "left", "right", "top", "bottom"]
BINDING_SCHEMA_VERSION = "1.0"
DHASH_SIZE = 8


class DisclaimerMissing(ValueError):
    """A record or binding was built without text it may not exist without."""


def load_disclaimers(path: Path) -> dict:
    d = json.loads(Path(path).read_text(encoding="utf-8"))

    major = str(d.get("schemaVersion", "")).split(".")[0]
    if major != "1":
        raise ValueError(
            f"unsupported disclaimers schemaVersion {d.get('schemaVersion')!r}; "
            "this build implements 1.x"
        )

    for key in ("attests", "doesNotAttest", "chainNote"):
        if not isinstance(d.get(key), str) or not d[key].strip():
            raise DisclaimerMissing(
                f"disclaimers file has no {key}. A record that does not say what it declines "
                f"to attest is a record that will be read as attesting it."
            )

    # Mojibake passes every logic check: the JSON parses, the fields are
    # present, and the text is wrong only to the human it was written for.
    import re
    bad = re.compile("[\u00e2][\u0080-\u00bf]|\ufffd")
    for key in ("attests", "doesNotAttest", "chainNote", "replicationNote"):
        if bad.search(d.get(key) or ""):
            raise ValueError(f"mojibake in {key} — check the encoding of whatever wrote this file")

    return d


# ----------------------------------------------------------------- hashing

def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def source_set_hash(image_hashes: list[str]) -> str:
    """
    Hash over the sorted, DEDUPLICATED per-image hashes.

    Sorted, so set identity does not depend on the order files happened to be
    listed in. Deduplicated, because two byte-identical files are one
    photograph — a package re-exported with an accidental duplicate frame binds
    to the same source set, which is the answer that matches what a person
    means by "these photographs".

    This is deliberately the same construction the job model uses for
    idempotency: the thing being identified is the same thing, and two different
    hashes over one set of photographs would be a standing invitation to compare
    the wrong pair. Duplicates remain visible through totalImageCount beside it.
    """
    return sha256_hex("\n".join(sorted(set(image_hashes))))


def dhash_image(path: Path, size: int = DHASH_SIZE) -> str:
    """
    Difference hash of a rendered view.

    Records only which of each adjacent pair of samples is brighter, which is
    what makes it survive re-encoding and mild resampling: brightening the whole
    image leaves every comparison unchanged.

    Box-averaged rather than nearest-neighbour sampled, so two renders of the
    same mesh at different resolutions agree. Nearest-neighbour would make the
    hash depend on which source pixels landed on the sample points.
    """
    from PIL import Image

    with Image.open(path) as im:
        # Rec. 601 luma, matching lib/phash.js exactly. The coefficients matter
        # less than both implementations using the SAME ones — a JavaScript hash
        # and a Python hash of one image must agree or cross-checking is
        # meaningless.
        im = im.convert("RGB")
        px = im.load()
        width, height = im.size
        gray = [
            [round(0.299 * px[x, y][0] + 0.587 * px[x, y][1] + 0.114 * px[x, y][2])
             for x in range(width)]
            for y in range(height)
        ]

    w, h = size + 1, size
    cells = [[0.0] * w for _ in range(h)]
    for y in range(h):
        y0 = (y * height) // h
        y1 = max(y0 + 1, ((y + 1) * height) // h)
        for x in range(w):
            x0 = (x * width) // w
            x1 = max(x0 + 1, ((x + 1) * width) // w)
            total, n = 0, 0
            for yy in range(y0, min(y1, height)):
                row = gray[yy]
                for xx in range(x0, min(x1, width)):
                    total += row[xx]
                    n += 1
            cells[y][x] = total / n if n else 0.0

    bits = "".join(
        "1" if cells[y][x] < cells[y][x + 1] else "0"
        for y in range(h) for x in range(size)
    )
    return "".join(f"{int(bits[i:i + 4], 2):x}" for i in range(0, len(bits), 4))


def perceptual_hash_of_views(view_paths: dict[str, Path]) -> tuple[str, dict[str, str]]:
    """
    One identifier over the six orthographic views.

    Concatenated in a FIXED order, and the order is part of the identity: front
    and back of an asymmetric object are different images, and a hash that
    sorted them would call a mesh and its mirror image the same object.
    """
    per_view: dict[str, str] = {}
    for name in VIEW_ORDER:
        key = f"ortho_{name}"
        if key not in view_paths:
            raise ValueError(f"missing the {name} view; the perceptual hash covers all six")
        per_view[name] = dhash_image(view_paths[key])
    return "".join(per_view[n] for n in VIEW_ORDER), per_view


def hamming_distance(a: str, b: str) -> int:
    if len(a) != len(b):
        raise ValueError(f"cannot compare hashes of different lengths ({len(a)} vs {len(b)})")
    return sum(bin(int(x, 16) ^ int(y, 16)).count("1") for x, y in zip(a, b))


def perceptual_similarity(a: str, b: str) -> float:
    return 1 - hamming_distance(a, b) / (len(a) * 4)


# ----------------------------------------------------------------- binding

def build_binding(
    *,
    session_id: str,
    job_id: str,
    set_hash: str,
    images: list[dict],
    pipeline: dict,
    output_hash: str,
    output_perceptual_hash: str | None,
    perceptual_views: dict | None,
    chain_note: str,
    created_at: str,
) -> dict:
    """Build the unsigned binding. Signing is separate so the signed bytes are inspectable."""
    if not chain_note:
        raise DisclaimerMissing(
            "a binding cannot be built without its chainNote. The note is what stops the binding "
            "being read as a claim that the reconstruction can be recreated bit-for-bit."
        )
    if not output_hash:
        raise ValueError("a binding needs the hash of the output it binds to")
    if not pipeline.get("backend"):
        raise ValueError(
            "a binding needs the pipeline that produced the output. A mesh whose provenance "
            "stops at 'some photogrammetry software' cannot be reasoned about later."
        )

    total = len(images)
    sealed = sum(1 for i in images if i.get("sealed") is True)

    return {
        "schemaVersion": BINDING_SCHEMA_VERSION,
        "sessionId": session_id,
        "jobId": job_id,
        "sourceSetHash": set_hash,
        "sealedImageCount": sealed,
        "totalImageCount": total,
        # Never derived from a rounded percentage anywhere.
        "chainComplete": total > 0 and sealed == total,
        # Present for diagnosis only. NOT a confidence level — the field name
        # says so rather than leaving a bare 0.9 to be misread as one.
        "unsealedImageCount": total - sealed,
        "pipeline": {
            "backend": pipeline["backend"],
            "version": pipeline.get("version"),
            "parameters": pipeline.get("parameters", {}),
        },
        "outputHash": output_hash,
        "outputPerceptualHash": output_perceptual_hash,
        "perceptualViews": perceptual_views,
        "perceptualHashNote": (
            "outputPerceptualHash re-associates a re-exported or metadata-stripped copy. It is "
            "NOT evidence of identity: dHash is not collision-resistant. Use it to find a "
            "candidate, then check outputHash."
        ),
        "chainNote": chain_note,
        "createdAt": created_at,
    }


def canonicalise(binding: dict) -> bytes:
    """
    The exact bytes that get signed.

    Sorted keys, no insignificant whitespace, so the same binding signs to the
    same bytes whichever implementation serialised it. Otherwise a signature
    made here could not be verified by a JavaScript consumer, and
    cross-implementation verification is most of the point of signing.

    The signature is excluded: a document cannot contain its own signature at
    the moment it is signed.
    """
    rest = {k: v for k, v in binding.items() if k != "signature"}
    return json.dumps(rest, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def check_binding_consistency(binding: dict) -> list[str]:
    """
    Internal consistency only. Does NOT check the signature — that needs a key
    and a decision about which keys are trusted, which belongs to the caller.
    "This document contradicts itself" and "I do not trust who signed it" are
    different problems with different remedies.
    """
    problems = []
    if binding.get("schemaVersion") != BINDING_SCHEMA_VERSION:
        problems.append(
            f"binding schemaVersion {binding.get('schemaVersion')} is not "
            f"{BINDING_SCHEMA_VERSION}; a newer binding may assert things this build "
            f"does not understand"
        )
    sealed = binding.get("sealedImageCount", 0)
    total = binding.get("totalImageCount", 0)
    if sealed > total:
        problems.append("more images are marked sealed than exist in the set")
    if binding.get("chainComplete") is not (total > 0 and sealed == total):
        problems.append(
            f"chainComplete is {binding.get('chainComplete')} but {sealed} of {total} images "
            f"are sealed. This is the one field an attacker would most want to flip, and it "
            f"must always be recomputable from the counts beside it."
        )
    if total == 0:
        problems.append("a binding over zero images binds nothing")
    if not binding.get("chainNote"):
        problems.append("chainNote is absent; the binding would be read as a reproducibility claim")
    return problems


# ----------------------------------------------------------------- signing

class SigningKey:
    """
    An Ed25519 signing key.

    ---------------------------------------------------------------------
    KEY MANAGEMENT IS DELIBERATELY NOT SOLVED HERE, AND SAYING SO MATTERS
    MORE THAN A CONVENIENT DEFAULT.

    A key generated by the service, stored beside the data it signs, proves
    nothing to anyone: whoever can alter a binding can re-sign it. It is
    theatre, and theatre is worse than an honest absence because it reads as
    assurance.

    So: the key is supplied by the operator, from whatever they already use to
    establish institutional identity. If none is supplied the binding is emitted
    UNSIGNED and says so in a field a consumer cannot miss, rather than being
    quietly self-signed.
    ---------------------------------------------------------------------
    """

    def __init__(self, private_bytes: bytes, key_id: str):
        from cryptography.hazmat.primitives.asymmetric import ed25519
        self._key = ed25519.Ed25519PrivateKey.from_private_bytes(private_bytes)
        self.key_id = key_id

    @classmethod
    def from_file(cls, path: Path, key_id: str | None = None) -> "SigningKey":
        raw = Path(path).read_bytes()
        if len(raw) != 32:
            raise ValueError(
                f"{path} is {len(raw)} bytes; an Ed25519 private key is exactly 32. "
                "Supply the raw seed, not a PEM or an OpenSSH key."
            )
        return cls(raw, key_id or Path(path).stem)

    @classmethod
    def generate(cls, key_id: str = "ephemeral") -> "SigningKey":
        """
        For tests and demonstrations only.

        An ephemeral key signs bindings nobody can verify tomorrow. That is
        correct for a test and useless in production, which is why it is not
        the fallback when no key is configured.
        """
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.hazmat.primitives import serialization
        k = ed25519.Ed25519PrivateKey.generate()
        raw = k.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        return cls(raw, key_id)

    def public_key_hex(self) -> str:
        from cryptography.hazmat.primitives import serialization
        return self._key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        ).hex()

    def private_seed(self) -> bytes:
        """
        The raw 32-byte seed, for writing a generated key to disk.

        Exposed deliberately and narrowly: `from_file` expects a raw seed, so
        without this a caller who generated a key could not persist one in the
        format the loader accepts, and would reach into the private key object
        to do it anyway.
        """
        from cryptography.hazmat.primitives import serialization
        return self._key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )

    def sign(self, payload: bytes) -> str:
        return self._key.sign(payload).hex()


def sign_binding(binding: dict, key: SigningKey | None) -> dict:
    """
    Attach a signature, or state plainly that there is none.

    An unsigned binding is still useful — it records what produced what — and
    pretending otherwise would push operators toward a self-generated key that
    proves nothing. The absence is therefore explicit and machine-readable, not
    a missing field a consumer might not think to check for.
    """
    if key is None:
        binding["signature"] = {
            "algorithm": None,
            "signed": False,
            "note": (
                "This binding is NOT signed. No signing key was configured. It records what "
                "produced what and remains internally checkable, but nothing here establishes "
                "WHO asserts it. A key generated by the service itself would prove nothing — "
                "whoever can alter the binding could re-sign it — so none was invented."
            ),
        }
        return binding

    payload = canonicalise(binding)
    binding["signature"] = {
        "algorithm": "Ed25519",
        "signed": True,
        "keyId": key.key_id,
        "publicKey": key.public_key_hex(),
        "value": key.sign(payload),
        "note": (
            "Signature covers the canonical JSON of every field except this one, with sorted "
            "keys and no insignificant whitespace."
        ),
    }
    return binding


def verify_binding(binding: dict, public_key_hex: str | None = None) -> tuple[bool, str]:
    """
    Verify a signature.

    If no public key is supplied the one embedded in the binding is used, and
    the result says so — a self-described key proves the document has not been
    altered SINCE SIGNING and nothing whatever about who signed it. Returning
    that distinction in the message keeps a caller from reading "valid" as
    "trustworthy".
    """
    sig = binding.get("signature")
    if not sig or not sig.get("signed"):
        return False, "binding is not signed"

    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric import ed25519

    embedded = sig.get("publicKey")
    key_hex = public_key_hex or embedded
    if not key_hex:
        return False, "no public key supplied and none embedded"

    try:
        pub = ed25519.Ed25519PublicKey.from_public_bytes(bytes.fromhex(key_hex))
        pub.verify(bytes.fromhex(sig["value"]), canonicalise(binding))
    except InvalidSignature:
        return False, "signature does not match the binding; it has been altered since signing"
    except Exception as e:  # noqa: BLE001
        return False, f"signature could not be checked: {e}"

    if public_key_hex is None:
        return True, (
            "signature is valid against the key embedded in the binding. This shows the binding "
            "has not been altered since signing; it does NOT establish who signed it. Check the "
            "key against one you already trust."
        )
    if embedded and embedded != public_key_hex:
        return False, "the binding embeds a different key from the one supplied"
    return True, "signature is valid against the supplied key"
