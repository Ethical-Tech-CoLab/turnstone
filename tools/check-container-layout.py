"""
Simulate the container's file layout and prove the service can start in it.

The container cannot be built here — no Docker engine, no WSL — so the next best
thing is to lay the files out exactly as the Dockerfile does and boot against
them. This catches the class of bug that has already bitten twice: a path
derived from __file__ that resolves correctly in the repository and to nowhere
once installed.
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parents[1]
fails = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))
    if not cond:
        fails.append(label)


def main():
    with tempfile.TemporaryDirectory() as t:
        app = Path(t) / "app"
        # Exactly what the Dockerfile COPYs, at exactly the paths it uses.
        shutil.copytree(REPO / "server" / "turnstone_server", app / "turnstone_server")
        shutil.copytree(REPO / "rubric", app / "rubric")
        shutil.copytree(REPO / "record", app / "record")

        env = dict(os.environ)
        env.update({
            "TURNSTONE_RUBRIC": str(app / "rubric" / "heritage-v1.json"),
            "TURNSTONE_DISCLAIMERS": str(app / "record" / "disclaimers-v1.json"),
            "TURNSTONE_VOCABULARY": str(app / "record" / "vocabulary-v1.json"),
            "TURNSTONE_DATA_DIR": str(Path(t) / "data"),
            "PYTHONPATH": str(app),
        })

        print("\n== the app imports and resolves its data files ==")
        probe = (
            "import json;"
            "from turnstone_server.config import config;"
            "from turnstone_server.interop import load_vocabulary, to_crmdig;"
            "from turnstone_server.binding import load_disclaimers;"
            "d = load_disclaimers(config.disclaimers_path);"
            "v = load_vocabulary();"
            "import turnstone_server.api as a;"
            "print(json.dumps({'rubric': config.rubric_path.exists(),"
            " 'disclaimers': bool(d['doesNotAttest']),"
            " 'vocabClasses': len(v['crm']['classes']) + len(v['crmdig']['classes']),"
            " 'routes': sorted(r.path for r in a.app.routes)}))"
        )
        r = subprocess.run([sys.executable, "-c", probe], env=env, cwd=t,
                           capture_output=True, text=True, encoding="utf-8")
        if r.returncode != 0:
            check("app starts under the container layout", False, r.stderr.strip()[-300:])
        else:
            import json as _json
            got = _json.loads(r.stdout.strip().splitlines()[-1])
            check("rubric resolves", got["rubric"])
            check("disclaimers resolve", got["disclaimers"])
            check("vocabulary resolves", got["vocabClasses"] == 15, str(got["vocabClasses"]))
            # Named explicitly rather than counted: a count passes while the one
            # endpoint you care about is missing.
            for path in ("/_health", "/backends", "/jobs", "/jobs/{job_id}",
                         "/jobs/{job_id}/quality", "/jobs/{job_id}/rerun",
                         "/jobs/{job_id}/export/{fmt}", "/jobs/{job_id}/outputs/{name}"):
                check(f"route {path}", path in got["routes"])

        print("\n== a missing data file refuses startup rather than failing later ==")
        for var in ("TURNSTONE_RUBRIC", "TURNSTONE_DISCLAIMERS", "TURNSTONE_VOCABULARY"):
            broken = dict(env)
            broken[var] = str(Path(t) / "absent.json")
            r = subprocess.run([sys.executable, "-c", "import turnstone_server.api"],
                               env=broken, cwd=t, capture_output=True, text=True,
                               encoding="utf-8")
            check(f"missing {var} stops the service", r.returncode != 0,
                  "started anyway" if r.returncode == 0 else "refused")

    print("\n" + "=" * 60)
    print("ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILED: {', '.join(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
