"""
Prove the verifier catches tampering.

A verifier that has only ever been run on good data is not a verifier. Each case
here damages a real reconstruction package in one specific way and requires the
tool to notice — because every one of these is something an interested party
would actually do.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
VERIFIER = REPO / "tools" / "verify-reconstruction.py"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

fails = []


def build_reference_package(workdir: Path) -> Path:
    """
    Produce a real, signed reconstruction to damage.

    Built here rather than assumed to exist, so this runs on a clean CI checkout
    with no server, no prior job and no field data. It exercises the genuine
    ingest → reconstruct → sign → record path; a hand-written fixture would let
    the verifier pass against something the server never actually emits.
    """
    sys.path.insert(0, str(REPO / "server"))
    from turnstone_server.binding import SigningKey  # noqa: PLC0415
    from turnstone_server.config import Config  # noqa: PLC0415
    from turnstone_server.jobs import JobStore  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    src = workdir / "package.zip"
    with zipfile.ZipFile(src, "w") as zf:
        zf.writestr("manifest.json", json.dumps({
            "format": "turnstone-session/1",
            "session": {"id": "s_verifier", "subject": "verifier fixture",
                        "sensitivity": "ordinary"},
            "frames": [],
        }))
        for i in range(4):
            p = workdir / f"f{i}.jpg"
            Image.new("RGB", (96, 72), (i * 50, 90, 140)).save(p, "JPEG")
            zf.write(p, f"images/f{i}.jpg")

    key_path = workdir / "signing.key"
    key_path.write_bytes(SigningKey.generate().private_seed())

    cfg = Config(data_dir=workdir / "data", signing_key_path=key_path,
                 signing_key_id="verifier-fixture")
    store = JobStore(cfg)
    pkg = store.ingest(src)
    job, _ = store.submit(pkg, "simulated", {})
    done = store.run(job, cfg.rubric_path)
    if done.state != "succeeded":
        raise RuntimeError(f"fixture reconstruction failed: {done.error}")
    return store.job_dir(job.id) / "outputs"


def run(d: Path, *args):
    p = subprocess.run([sys.executable, str(VERIFIER), str(d), *args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))
    if not cond:
        fails.append(label)


def case(source: Path, mutate):
    """Copy a good package, damage it, and see whether the tool notices."""
    with tempfile.TemporaryDirectory() as t:
        d = Path(t) / "outputs"
        shutil.copytree(source, d)
        mutate(d)
        return run(d)


def load(d: Path):
    return json.loads((d / "record.json").read_text(encoding="utf-8"))


def save(d: Path, r):
    (d / "record.json").write_text(json.dumps(r, indent=2), encoding="utf-8")


def main():
    with tempfile.TemporaryDirectory() as t:
        good = build_reference_package(Path(t))
        return _run_cases(good)


def _run_cases(good: Path):
    print("\n== a sound package passes ==")
    code, out = run(good)
    check("exit code 0", code == 0, f"exit {code}")
    check("no failures reported", "FAILURE" not in out)

    print("\n== the mesh is swapped for different bytes ==")
    def swap_mesh(d):
        (d / "model.ply").write_bytes(b"ply\nformat ascii 1.0\nelement vertex 0\nend_header\n")
    code, out = case(good, swap_mesh)
    check("substituted mesh is caught", code == 1, f"exit {code}")
    check("names the binding mismatch", "NOT the one the binding covers" in out)

    print("\n== the legitimacy disclaimer is removed ==")
    def strip_disclaimer(d):
        r = load(d)
        del r["doesNotAttest"]
        save(d, r)
    code, out = case(good, strip_disclaimer)
    check("missing disclaimer is a failure, not a warning", code == 1, f"exit {code}")
    check("says why it matters", "provenance" in out or "cite" in out)

    print("\n== chainComplete is flipped to true ==")
    # The single field an interested party would most want to change.
    def flip_chain(d):
        r = load(d)
        r["binding"]["chainComplete"] = True
        save(d, r)
    code, out = case(good, flip_chain)
    check("flipped chainComplete is caught", code == 1, f"exit {code}")
    check("caught by internal consistency", "contradicts itself" in out)
    check("and by the signature", "does not verify" in out)

    print("\n== the seal counts are forged to close the chain ==")
    def forge_seals(d):
        r = load(d)
        r["binding"]["sealedImageCount"] = r["binding"]["totalImageCount"]
        r["binding"]["unsealedImageCount"] = 0
        r["binding"]["chainComplete"] = True
        save(d, r)
    code, out = case(good, forge_seals)
    check("forged seal counts are caught by the signature", code == 1, f"exit {code}")

    print("\n== an ortho view is replaced ==")
    def repaint(d):
        from PIL import Image
        Image.new("RGB", (512, 512), (255, 0, 0)).save(d / "ortho-front.png", "PNG")
    code, out = case(good, repaint)
    check("replaced view is caught", code == 1, f"exit {code}")
    check("hash mismatch is named", "does NOT match its recorded hash" in out)

    print("\n== the binding is removed entirely ==")
    def drop_binding(d):
        r = load(d)
        r["binding"] = None
        save(d, r)
    code, out = case(good, drop_binding)
    check("a record with no binding is a failure", code == 1, f"exit {code}")
    check("says nothing connects mesh to photographs", "Nothing connects" in out)

    print("\n== verified against a key that did not sign it ==")
    code, out = run(good, "--key", "00" * 32)
    check("a substituted key is refused", code == 1, f"exit {code}")

    print("\n" + "=" * 60)
    print("ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILED: {', '.join(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())

