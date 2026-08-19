"""
Tavily research harness for the photogrammetry tool concept.

Uses the Tavily REST API directly. The Tavily MCP server in this environment
carries a stale key and returns "Invalid API key"; the key in TAVILY_API_KEY
works over REST, verified before this script was written. No substitute
provider is used.

Usage: python tools/tavily_research.py <batch-name>
Writes: research-photogrammetry/raw/<batch>.json  and  <batch>.md
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.tavily.com/search"
KEY = os.environ.get("TAVILY_API_KEY")
if not KEY:
    sys.exit("TAVILY_API_KEY is not set. Refusing to substitute another provider.")

OUT = Path(__file__).resolve().parent.parent / "research-photogrammetry"
(OUT / "raw").mkdir(parents=True, exist_ok=True)

BATCHES = {
    "oss": [
        "Meshroom AliceVision open source photogrammetry pipeline features",
        "COLMAP structure from motion multi-view stereo photogrammetry",
        "OpenMVG OpenMVS open source photogrammetry reconstruction pipeline",
        "MicMac IGN open source photogrammetry cultural heritage",
        "open source photogrammetry software comparison 2025 2026",
        "Meshroom vs COLMAP vs RealityCapture quality comparison",
        "nerfstudio NeRF 3D reconstruction from photos open source",
        "3D Gaussian splatting photogrammetry cultural heritage artifacts",
        "OpenSplat gsplat open source gaussian splatting training",
        "Open Drone Map ODM photogrammetry open source",
        "Regard3D open source photogrammetry",
        "photogrammetry web browser WASM in-browser reconstruction",
        "COLMAP GPU requirements dense reconstruction hardware",
        "AliceVision Meshroom command line batch processing docker",
        "open source mesh processing MeshLab CloudCompare Blender photogrammetry cleanup",
        "Instant NGP NeRF vs photogrammetry mesh accuracy comparison",
        "open source photogrammetry turntable masking background removal",
        "photogrammetry open source license commercial use AGPL MPL",
    ],
    "proprietary": [
        "RealityScan RealityCapture Epic Games photogrammetry features 2025",
        "Agisoft Metashape features cultural heritage workflow",
        "Polycam 3D scanning app features photogrammetry LiDAR",
        "KIRI Engine 3D scanner app features photogrammetry gaussian splatting",
        "Scaniverse Niantic 3D scanning app features",
        "Luma AI capture app 3D NeRF features",
        "Apple Object Capture ObjectCaptureSession API guidance",
        "Apple RealityKit Object Capture automatic capture dial coverage feedback",
        "Matterport Artec Revopoint 3D scanner comparison artifacts",
        "Qlone 3D scanning app turntable mat",
        "Polycam vs KIRI Engine vs Scaniverse comparison 2025",
        "photogrammetry app onboarding guidance user experience features",
        "3D scanning app automatic capture shutter guidance overlap",
        "RealityScan 2.0 features mobile app",
        "Agisoft Metashape scale bar markers coded targets workflow",
        "photogrammetry software subscription pricing 2025 Metashape RealityCapture",
    ],
    "heritage": [
        "Smithsonian Digitization Program Office 3D capture guidelines",
        "cultural heritage 3D digitization standards CIPA CHNT",
        "London Charter Seville Principles 3D cultural heritage",
        "Cultural Heritage Imaging photogrammetry best practice guide",
        "Historic England photogrammetry metric survey specification",
        "3D digitisation cultural heritage EU study VIGIE 2020 654",
        "museum 3D scanning artifacts metadata standard CIDOC CRM",
        "IIIF 3D API model viewer cultural heritage",
        "archival 3D file format preservation glTF PLY E57 OBJ long term",
        "digital repatriation 3D scanning indigenous cultural heritage ethics",
        "CARE principles indigenous data governance 3D scans",
        "Traditional Knowledge Labels Local Contexts digital heritage",
        "3D scan repatriation debate museum replica ethics",
        "Rekrei Project Mosul crowdsourced photogrammetry heritage",
        "Backup Ukraine Polycam UNESCO crowdsourced 3D scanning",
        "colour calibration colour chart photogrammetry museum object",
        "photogrammetry scale bar calibrated cultural heritage accuracy",
        "digital benin looted artifacts 3D documentation",
        "3D model provenance metadata paradata heritage documentation",
        "museum object photography turntable lighting cross polarization",
    ],
    "process": [
        "photogrammetry capture technique overlap percentage rule of thumb",
        "photogrammetry number of photos required small object 360 degrees",
        "photogrammetry turntable vs moving camera which is better",
        "photogrammetry shiny reflective object capture technique",
        "photogrammetry dark black object scanning technique",
        "photogrammetry transparent glass object scanning",
        "cross polarization photogrammetry specular removal setup",
        "focus stacking photogrammetry small objects macro",
        "photogrammetry masking background subtraction turntable",
        "photogrammetry coded targets markers automatic detection",
        "photogrammetry camera settings aperture ISO shutter raw",
        "photogrammetry lighting setup diffuse even museum object",
        "ground sample distance photogrammetry resolution calculation",
        "photogrammetry accuracy validation ground truth caliper measurement",
        "photogrammetry scanning bottom of object flipping alignment",
        "smartphone photogrammetry quality vs DSLR comparison",
        "photogrammetry blur detection variance of laplacian sharpness",
        "structure from motion feature matching failure textureless surface",
        "photogrammetry chunk alignment merging multiple scans",
        "photogrammetry mesh decimation retopology texture baking workflow",
    ],
    "decisions": [
        "COLMAP license BSD permissive commercial use",
        "OpenMVS license AGPL-3.0 commercial implications",
        "AliceVision MPL2 license Meshroom commercial use permitted",
        "glomap global structure from motion faster than COLMAP",
        "VGGT visual geometry grounded transformer feed-forward 3D reconstruction",
        "MASt3R DUSt3R dense unconstrained stereo 3D reconstruction",
        "WebGPU browser gaussian splatting training feasibility",
        "getUserMedia ImageCapture high resolution photo Android Chrome",
        "C2PA 3D model glTF support roadmap manifest",
        "glTF GLB metadata extension custom properties provenance",
        "OpenSfM Mapillary open source structure from motion python",
        "photogrammetry docker container GPU CUDA deployment pipeline",
        "Meshroom AliceVision license change fork 2025",
        "3D mesh perceptual hash duplicate detection similarity",
        "photogrammetry scale bar accuracy small object versus ground control points",
        "CIDOC CRMdig 3D provenance documentation model",
        "Europeana 3D content publication format requirements",
        "photogrammetry photo capture app Android camera2 API full resolution burst",
    ],
}


def search(query, depth="advanced", max_results=6):
    body = json.dumps(
        {
            "api_key": KEY,
            "query": query,
            "search_depth": depth,
            "max_results": max_results,
            "include_answer": True,
        }
    ).encode()
    req = urllib.request.Request(
        API, data=body, headers={"Content-Type": "application/json"}
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503, 504) and attempt < 3:
                time.sleep(4 * (attempt + 1))
                continue
            return {"error": f"HTTP {e.code}: {e.read()[:300].decode(errors='replace')}"}
        except Exception as e:  # noqa: BLE001 - report and continue
            if attempt < 3:
                time.sleep(3)
                continue
            return {"error": str(e)}
    return {"error": "exhausted retries"}


def main():
    batch = sys.argv[1]
    queries = BATCHES[batch]
    out = []
    for i, q in enumerate(queries, 1):
        r = search(q)
        out.append({"query": q, "result": r})
        n = len(r.get("results", [])) if "error" not in r else 0
        print(f"[{batch} {i}/{len(queries)}] {n:>2} results  {q}", flush=True)
        time.sleep(0.7)

    (OUT / "raw" / f"{batch}.json").write_text(
        json.dumps(out, indent=1), encoding="utf-8"
    )

    lines = [f"# Tavily research — {batch}", ""]
    for item in out:
        lines.append(f"## {item['query']}")
        r = item["result"]
        if "error" in r:
            lines.append(f"ERROR: {r['error']}")
            lines.append("")
            continue
        if r.get("answer"):
            lines.append(f"**Answer:** {r['answer']}")
            lines.append("")
        for res in r.get("results", []):
            lines.append(f"- [{res.get('title','')}]({res.get('url','')})")
            body = (res.get("content") or "").replace("\n", " ").strip()
            if body:
                lines.append(f"  - {body[:600]}")
        lines.append("")
    (OUT / f"{batch}.md").write_text("\n".join(lines), encoding="utf-8")
    errs = sum(1 for i in out if "error" in i["result"])
    print(f"DONE {batch}: {len(out)} queries, {errs} errors", flush=True)


if __name__ == "__main__":
    main()
