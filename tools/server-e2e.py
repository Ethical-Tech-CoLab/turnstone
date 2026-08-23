"""End-to-end exercise of the reconstruction service against a real package."""
import json
import sys
import time
import urllib.request
import uuid
from pathlib import Path

BASE = "http://127.0.0.1:8080"
ZIP = Path(r"c:\Dev\turnstone-testrun\turnstone-field-test-2026-08-23.zip")


def post_multipart(url, fields, files):
    boundary = uuid.uuid4().hex
    body = b""
    for k, v in fields.items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").encode()
    for k, (name, data) in files.items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; "
                 f"filename=\"{name}\"\r\nContent-Type: application/zip\r\n\r\n").encode()
        body += data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def get(path):
    with urllib.request.urlopen(BASE + path) as r:
        return r.status, json.loads(r.read())


fails = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))
    if not cond:
        fails.append(label)


print("\n== backends ==")
_, b = get("/backends")
names = [x["id"] for x in b["backends"]]
print("  available:", names)
check("simulated backend is offered", "simulated" in names)
openmvs = next(x for x in b["backends"] if x["id"] == "openmvs")
check("openmvs is gated behind AGPL acknowledgement", openmvs["permitted"] is False,
      openmvs["licence"])

print("\n== first upload ==")
data = ZIP.read_bytes()
t0 = time.time()
status, r1 = post_multipart(BASE + "/jobs", {"backend": "simulated"},
                            {"package": (ZIP.name, data)})
print(f"  HTTP {status} in {time.time()-t0:.1f}s")
print("  ", json.dumps({k: v for k, v in r1.items() if k != "job"}, indent=2))
# 202 on a fresh server, 200 if this package was already ingested by an earlier
# run. Both are correct; pinning it to 202 would make this script runnable only
# once, and a test people can only run once is a test they stop running.
check("upload accepted", status in (200, 202), f"HTTP {status}")
check("all 9 photographs ingested", r1.get("sourceImages") == 9, str(r1.get("sourceImages")))
job_id = r1["job"]["id"]
content_hash = r1["contentHash"]

print("\n== idempotency (C-13): same bytes again ==")
status2, r2 = post_multipart(BASE + "/jobs", {"backend": "simulated"},
                             {"package": (ZIP.name, data)})
check("duplicate upload creates no second job", r2.get("created") is False, f"created={r2.get('created')}")
check("duplicate resolves to the same job id", r2["job"]["id"] == job_id,
      f"{r2['job']['id']} vs {job_id}")
check("duplicate returns 200 not 202", status2 == 200, f"HTTP {status2}")

print("\n== waiting for reconstruction ==")
for _ in range(60):
    _, job = get(f"/jobs/{job_id}")
    if job["state"] in ("succeeded", "failed"):
        break
    time.sleep(1)
print(f"  state: {job['state']}")
if job["state"] == "failed":
    print("  error:", job["error"])
    print("  ", (job.get("result") or {}).get("traceback", "")[-2000:])
check("job succeeded", job["state"] == "succeeded", job.get("error") or "")

if job["state"] == "succeeded":
    res = job["result"]
    print("\n== outputs ==")
    for k, v in sorted(res["outputs"].items()):
        if isinstance(v, dict) and "file" in v:
            print(f"   {k:16s} {v['file']:20s} {v['bytes']:>8d} bytes  {v['sha256'][:12]}")
    check("a mesh or point cloud was produced", "point_cloud" in res["outputs"] or "mesh" in res["outputs"])
    check("a glTF delivery mesh was derived", "delivery_mesh" in res["outputs"])
    check("six ortho views were rendered",
          sum(1 for k in res["outputs"] if k.startswith("ortho_")) == 6)
    check("a sidecar record was written", "sidecar" in res["outputs"])

    print("\n== artefacts are downloadable ==")
    import urllib.request as _u
    for key in ("delivery_mesh", "sidecar", "ortho_front"):
        if key in res["outputs"]:
            fn = res["outputs"][key]["file"]
            with _u.urlopen(f"{BASE}/jobs/{job_id}/outputs/{fn}") as r:
                body = r.read()
            expect = res["outputs"][key]["bytes"]
            check(f"{key} downloads intact", len(body) == expect, f"{len(body)}/{expect} bytes")
            if key == "delivery_mesh":
                check("the delivery mesh is a real GLB", body[:4] == b"glTF", body[:4].hex())

    print("\n== quality ==")
    _, q = get(f"/jobs/{job_id}/quality")
    print(f"   capture class : {q['captureClass']}")
    print(f"   final class   : {q['finalClass']}  ({q['direction']})")
    print(f"   limiting      : {q['limitingDimension']}")
    print(f"   provisional   : {q['provisional']}")
    check("final assessment is no longer provisional", q["provisional"] is False)
    print("   deferred values:")
    for k, v in q["deferredValues"].items():
        print(f"     {k}: {json.dumps(v)}")
    check("device-metadata was measured from EXIF", "device-metadata" in q["deferredValues"])
    dims = {d["id"]: d for d in q["dimensions"]}
    check("all 10 rubric dimensions are scored", len(dims) == 10, str(len(dims)))

    print("\n== source images byte-identical (C-12, R-8.8) ==")
    import hashlib, zipfile
    stored = Path(r"c:\Dev\turnstone\server\.testdata\packages") / content_hash
    zf = zipfile.ZipFile(ZIP)
    same, checked = True, 0
    for n in zf.namelist():
        if n.startswith("images/") and not n.endswith("/"):
            orig = hashlib.sha256(zf.read(n)).hexdigest()
            now = hashlib.sha256((stored / n).read_bytes()).hexdigest()
            checked += 1
            if orig != now:
                same = False
                print("   DIFFERS:", n)
    check(f"all {checked} stored photographs match the uploaded bytes exactly", same and checked == 9)

    work = Path(r"c:\Dev\turnstone\server\.testdata\jobs") / job_id / "work" / "images"
    same2 = all(
        hashlib.sha256(zf.read(f"images/{p.name}")).hexdigest()
        == hashlib.sha256(p.read_bytes()).hexdigest()
        for p in work.glob("*.jpg")
    )
    check("photographs staged for the backend are unmodified", same2)

print("\n== re-run with different settings (R-8.7) ==")
# A quality value unique to this run, so the re-run is genuinely new every time
# rather than colliding with a previous execution of this script.
unique_quality = f"e2e-{int(time.time())}"
status, rr = post_multipart(BASE + f"/jobs/{job_id}/rerun",
                            {"backend": "simulated", "quality": unique_quality}, {})
check("re-run creates a distinct job", rr.get("created") is True and rr["job"]["id"] != job_id,
      f"{rr['job']['id']} vs {job_id}")
check("re-run reuses the stored photographs", rr["job"]["content_hash"] == content_hash)

print("\n== licence gate ==")
status, lr = post_multipart(BASE + "/jobs", {"backend": "openmvs"}, {"package": (ZIP.name, data)})
check("AGPL backend refused with 403", status == 403, f"HTTP {status}")
print("   ", lr.get("detail", "")[:160])

print("\n== unknown backend ==")
status, ub = post_multipart(BASE + "/jobs", {"backend": "nonesuch"}, {"package": (ZIP.name, data)})
check("unknown backend rejected with 400", status == 400, f"HTTP {status}")
print("   ", ub.get("detail", "")[:120])

print("\n== bad input ==")
status, br = post_multipart(BASE + "/jobs", {}, {"package": ("junk.zip", b"not a zip at all")})
check("unreadable archive rejected with 400", status == 400, f"HTTP {status}")
print("   ", br.get("detail", "")[:120])

print("\n== path traversal on outputs ==")
try:
    urllib.request.urlopen(BASE + f"/jobs/{job_id}/outputs/..%2f..%2fjob.json")
    check("traversal blocked", False, "request succeeded")
except urllib.error.HTTPError as e:
    check("traversal blocked", e.code == 404, f"HTTP {e.code}")

print("\n" + "=" * 60)
print(f"{'ALL CHECKS PASSED' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
