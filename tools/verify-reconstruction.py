"""
Verify a reconstruction package: the record, the binding, and the artefacts.

---------------------------------------------------------------------------
This is the tool for someone who did NOT produce the reconstruction. A museum
handed a folder, a repatriation claim reviewed years later, an auditor checking
what a service actually emitted.

It answers four separate questions, and keeping them separate is the point:

  1. Is the record internally coherent, and does it carry the disclaimers it
     may not exist without?
  2. Do the artefacts match the hashes the binding claims for them?
  3. Was the binding altered since it was signed?
  4. Is the chain of custody actually complete?

A tool that collapsed these into one "VALID" would be worse than useless.
"Signed by someone" and "signed by someone you trust" are different facts, and
so are "the mesh matches" and "the photographs behind it were sealed".

Usage:
    python tools/verify-reconstruction.py <job-outputs-dir> [--key <hex>]
---------------------------------------------------------------------------
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

# The disclaimer text contains an em-dash, and Windows consoles default to a
# codepage that cannot render it. Without this the tool prints '?' in the middle
# of the very sentences it exists to check — which is the same class of fault as
# the mojibake this project has already shipped once.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from turnstone_server.binding import (  # noqa: E402
    check_binding_consistency, hamming_distance, perceptual_hash_of_views, verify_binding,
)

OK, WARN, BAD = "ok   ", "warn ", "FAIL "


class Report:
    def __init__(self) -> None:
        self.failures = 0
        self.warnings = 0

    def line(self, status: str, text: str, detail: str = "") -> None:
        if status is BAD:
            self.failures += 1
        elif status is WARN:
            self.warnings += 1
        print(f"  {status} {text}" + (f"\n        {detail}" if detail else ""))

    def section(self, title: str) -> None:
        print(f"\n{title}")


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def verify(out_dir: Path, public_key: str | None) -> int:
    r = Report()
    record_path = out_dir / "record.json"

    if not record_path.exists():
        print(f"no record.json in {out_dir}")
        return 2

    record = json.loads(record_path.read_text(encoding="utf-8"))

    # ---------------------------------------------------------- the record
    r.section("The record")
    for field in ("attests", "doesNotAttest"):
        if record.get(field):
            r.line(OK, f"{field} present")
        else:
            r.line(BAD, f"{field} is MISSING",
                   "A record without the legitimacy disclaimer is one an institution can cite "
                   "as though capture quality established provenance. It should not exist.")

    q = record.get("quality") or {}
    r.line(OK, f"quality class: {q.get('class')} (score {q.get('score')}, "
               f"limited by {q.get('limitingDimension')})")
    if q.get("provisional"):
        r.line(WARN, "the assessment is still PROVISIONAL",
               "Deferred dimensions were never measured; this class may yet fall.")

    tier = record.get("disclosureTier")
    if tier == "public":
        r.line(WARN, "disclosure tier is 'public'",
               "A mesh is a replication asset. Confirm this was a decision someone owns.")
    else:
        r.line(OK, f"disclosure tier: {tier} ({record.get('disclosureTierSource')})")

    if record.get("sensitivity") in ("funerary", "sacred"):
        state = record.get("traditionalKnowledgeLabelsState")
        r.line(
            OK if state == "declared" else WARN,
            f"{record['sensitivity']} material, TK Labels: {state}",
            "" if state == "declared" else
            "Recorded as undetermined, NOT as 'none apply'. Someone must still determine them.",
        )

    # --------------------------------------------------------- the binding
    binding = record.get("binding")
    if not binding:
        r.line(BAD, "no ReconstructionBinding",
               "Nothing connects this mesh to the photographs it came from.")
        return _finish(r)

    r.section("The binding")
    for problem in check_binding_consistency(binding):
        r.line(BAD, "binding contradicts itself", problem)
    if not check_binding_consistency(binding):
        r.line(OK, "binding is internally consistent")

    sealed = binding["sealedImageCount"]
    total = binding["totalImageCount"]
    if binding["chainComplete"]:
        r.line(OK, f"chain of custody COMPLETE — all {total} photographs sealed")
    else:
        r.line(
            WARN, f"chain of custody INCOMPLETE — {sealed} of {total} photographs sealed",
            "This is not a partial proof. The unsealed frames are precisely where a "
            "substituted photograph would be inserted. Treat the set as unsealed.",
        )

    # -------------------------------------------------------- the artefacts
    r.section("The artefacts")
    outputs = record.get("outputs") or {}
    checked = 0
    for key, meta in sorted(outputs.items()):
        if not isinstance(meta, dict) or "file" not in meta:
            continue
        p = out_dir / meta["file"]
        if not p.exists():
            r.line(BAD, f"{key}: {meta['file']} is missing")
            continue
        actual = sha256_file(p)
        checked += 1
        if actual == meta.get("sha256"):
            r.line(OK, f"{key}: {meta['file']} matches its hash")
        elif key == "sidecar":
            # The record cannot contain its own hash; it was computed after the
            # file was written. Not a finding.
            checked -= 1
        else:
            r.line(BAD, f"{key}: {meta['file']} does NOT match its recorded hash",
                   f"recorded {meta.get('sha256', '')[:16]}…, found {actual[:16]}…")

    primary = outputs.get("mesh") or outputs.get("point_cloud")
    if primary and (out_dir / primary["file"]).exists():
        actual = sha256_file(out_dir / primary["file"])
        if actual == binding.get("outputHash"):
            r.line(OK, "the mesh is the one the binding covers")
        else:
            r.line(BAD, "the mesh is NOT the one the binding covers",
                   "The binding attests to different bytes than the file present here.")

    # ------------------------------------------------- the perceptual hash
    views = {k: out_dir / v["file"] for k, v in outputs.items()
             if k.startswith("ortho_") and isinstance(v, dict) and "file" in v
             and (out_dir / v["file"]).exists()}
    if len(views) == 6 and binding.get("outputPerceptualHash"):
        recomputed, _ = perceptual_hash_of_views(views)
        claimed = binding["outputPerceptualHash"]
        if recomputed == claimed:
            r.line(OK, "perceptual hash recomputes exactly")
        else:
            d = hamming_distance(recomputed, claimed)
            bits = len(claimed) * 4
            r.line(WARN if d <= bits * 0.1 else BAD,
                   f"perceptual hash differs by {d} of {bits} bits",
                   "Perceptual hashes are for re-association, not proof. A small difference "
                   "may mean a re-render; a large one means different geometry.")

    # ------------------------------------------------------- the signature
    r.section("The signature")
    sig = binding.get("signature") or {}
    if not sig.get("signed"):
        r.line(WARN, "the binding is NOT signed",
               "It records what produced what and is internally checkable, but nothing "
               "here establishes WHO asserts it.")
    else:
        ok, why = verify_binding(binding, public_key)
        if not ok:
            r.line(BAD, "signature does not verify", why)
        elif public_key:
            r.line(OK, f"signature verifies against the supplied key ({sig.get('keyId')})")
        else:
            r.line(WARN, f"signature verifies against its OWN embedded key ({sig.get('keyId')})",
                   "This shows the binding was not altered since signing. It does NOT show "
                   "who signed it. Re-run with --key <hex> using a key you already trust.")

    return _finish(r)


def _finish(r: Report) -> int:
    print()
    print("=" * 64)
    if r.failures:
        print(f"{r.failures} FAILURE(S), {r.warnings} warning(s) — do not rely on this package")
        return 1
    if r.warnings:
        print(f"No failures, {r.warnings} warning(s) — read them before relying on this package")
        return 0
    print("Verified: coherent, complete and signed.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("Usage:")[0])
    ap.add_argument("outputs", type=Path, help="a job's outputs directory")
    ap.add_argument("--key", default=None,
                    help="hex Ed25519 public key you already trust")
    a = ap.parse_args()
    if not a.outputs.is_dir():
        print(f"{a.outputs} is not a directory")
        return 2
    return verify(a.outputs, a.key)


if __name__ == "__main__":
    raise SystemExit(main())
