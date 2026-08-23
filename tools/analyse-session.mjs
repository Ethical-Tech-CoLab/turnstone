/**
 * analyse-session.mjs — run the real extractors over real photographs.
 *
 * ---------------------------------------------------------------------------
 * The metrics are exercised in tests against synthetic frames whose answers are
 * known by construction, which is the right way to prove they are correct. This
 * is the other half: pointing them at actual photographs from an actual capture
 * and seeing what they say.
 *
 * It also answers the question a contributor actually has — "can anything be
 * built from what I shot?" — before a reconstruction pipeline exists, and
 * without pretending a pipeline exists.
 *
 * Runs in headless Chrome because that is where the extractors run in
 * production: same decode path, same canvas, same code.
 *
 * Usage: node tools/analyse-session.mjs <directory-of-images>
 * ---------------------------------------------------------------------------
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, normalize, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const CHROME = process.env.CHROME_PATH ?? CANDIDATES.find((p) => existsSync(p));
if (!CHROME) throw new Error('No Chrome, Chromium or Edge binary found. Set CHROME_PATH.');

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error('Usage: node tools/analyse-session.mjs <directory-of-images> [manifest.json]');
  process.exit(2);
}

/**
 * Recorded pose, if a manifest is supplied.
 *
 * This is authoritative over anything inferred from pixels: it says where the
 * camera actually was, which is the only thing that determines whether a
 * reconstruction is possible.
 */
let pose = null;
const manifestPath = process.argv[3];
if (manifestPath && existsSync(manifestPath)) {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const az = (m.frames ?? []).map((f) => f.measurements?.azimuthDeg).filter((a) => a != null);
    if (az.length) {
      const bins = new Set(az.map((a) => Math.floor((((a % 360) + 360) % 360) / 15)));
      pose = {
        count: az.length,
        spreadDeg: Math.max(...az) - Math.min(...az),
        binsVisited: bins.size,
        recordedSize: m.frames[0]?.captureProfile
          ? `${m.frames[0].captureProfile.width}x${m.frames[0].captureProfile.height}` : null,
      };
    }
  } catch { /* a manifest we cannot read is simply absent */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const images = readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
if (!images.length) { console.error('No images found.'); process.exit(2); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!DOCTYPE html><html><body></body></html>');
  }
  // Normalise to forward slashes before matching: on Windows `normalize` turns
  // /img/x.jpg into \img\x.jpg, which then fails a `startsWith('img/')` test
  // and silently 404s — the image never loads and decode() reports the
  // misleading "source image cannot be decoded".
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '').replace(/\\/g, '/');
  const f = rel.startsWith('img/') ? join(dir, rel.slice(4)) : join(ROOT, rel);
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), 'turnstone-analyse-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9375', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage', 'about:blank',
], { stdio: 'ignore' });

try {
  let wsUrl;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9375/json/list')).json();
      const p = list.find((t) => t.type === 'page');
      if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
    } catch { /* not up */ }
    await sleep(250);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const x = JSON.parse(m.data);
    if (x.id && pending.has(x.id)) { pending.get(x.id)(x.result); pending.delete(x.id); }
  };
  const send = (method, params = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((r) => pending.set(i, r));
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(900);

  console.log(`\nAnalysing ${images.length} photographs from ${basename(dir)}\n${'='.repeat(64)}`);

  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(async () => {
    const { toLuma, varianceOfLaplacian, clippingFraction, frameLightingSignature, median }
      = await import('/lib/metrics.js');
    const names = ${JSON.stringify(images)};
    const out = [];
    let prevSmall = null;
    const SMALL = 96;                       // for frame-to-frame comparison

    for (const name of names) {
      // fetch + createImageBitmap rather than assigning img.src: it reports a
      // real HTTP status when something is wrong, instead of surfacing every
      // failure as the misleading "source image cannot be decoded".
      let img;
      try {
        const res = await fetch('/img/' + name);
        if (!res.ok) { out.push({ name, error: 'HTTP ' + res.status }); continue; }
        img = await createImageBitmap(await res.blob());
      } catch (err) {
        out.push({ name, error: err.message });
        continue;
      }

      // Working image, exactly as the client builds it.
      const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
      const W = Math.round(img.width * scale), H = Math.round(img.height * scale);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.drawImage(img, 0, 0, W, H);
      const data = c.getImageData(0, 0, W, H).data;
      const luma = toLuma(data, W, H);

      // A tiny greyscale copy, to measure how much actually changed between
      // consecutive frames. Photogrammetry needs the camera to MOVE; frames
      // that differ only by sensor noise carry no parallax and no new geometry.
      const sc = document.createElement('canvas'); sc.width = SMALL; sc.height = SMALL;
      sc.getContext('2d').drawImage(img, 0, 0, SMALL, SMALL);
      const sd = sc.getContext('2d').getImageData(0, 0, SMALL, SMALL).data;
      const small = new Float32Array(SMALL * SMALL);
      for (let i = 0, p = 0; i < small.length; i++, p += 4) {
        small[i] = 0.2126 * sd[p] + 0.7152 * sd[p+1] + 0.0722 * sd[p+2];
      }
      let meanAbsDiff = null;
      if (prevSmall) {
        let s = 0;
        for (let i = 0; i < small.length; i++) s += Math.abs(small[i] - prevSmall[i]);
        meanAbsDiff = s / small.length;
      }
      prevSmall = small;

      out.push({
        name,
        width: img.width, height: img.height,
        vol: varianceOfLaplacian(luma, W, H),
        clip: clippingFraction(data, W, H).worst,
        light: frameLightingSignature(data, W, H),
        meanAbsDiff,
      });
    }
    return out;
  })()`});

  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'analysis failed');
  const frames = r.result.value;

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const vols = frames.map((f) => f.vol);
  const medVol = med(vols);

  console.log('\n  frame              size        sharpness   clipped   luma   change from prev');
  console.log('  ' + '-'.repeat(76));
  for (const f of frames) {
    const rel = f.vol / medVol;
    const flag = rel < 0.4 ? ' SUSPECT' : '';
    const diff = f.meanAbsDiff == null ? '     —' : `${f.meanAbsDiff.toFixed(1).padStart(6)}`;
    console.log(`  ${f.name.padEnd(18)} ${String(f.width) + 'x' + f.height}   `
      + `${f.vol.toFixed(0).padStart(7)}${flag.padEnd(8)} `
      + `${(f.clip * 100).toFixed(2).padStart(6)}%  ${f.light.luma.toFixed(0).padStart(5)}  ${diff}`);
  }

  const diffs = frames.map((f) => f.meanAbsDiff).filter((d) => d != null);
  const medDiff = med(diffs);

  console.log('\n' + '  ' + '='.repeat(62));
  console.log(`  Median sharpness (VoL)       ${medVol.toFixed(0)}`);
  console.log(`  Suspect frames               ${frames.filter((f) => f.vol / medVol < 0.4).length} of ${frames.length}`);
  console.log(`  Median clipping              ${(med(frames.map((f) => f.clip)) * 100).toFixed(2)}%`);
  console.log(`  Median frame-to-frame change ${medDiff.toFixed(1)} grey levels`);

  // A recorded size that disagrees with the file is a metadata bug worth
  // surfacing: a pipeline reads the metadata, not the pixels.
  if (pose?.recordedSize) {
    const actual = `${frames[0].width}x${frames[0].height}`;
    if (pose.recordedSize !== actual) {
      console.log('');
      console.log(`  WARNING: the manifest records ${pose.recordedSize} but the images are ${actual}.`);
      console.log('  The measurements were computed from the real pixels and are correct;');
      console.log('  the recorded dimensions were the preview stream, not the still.');
    }
  }

  /*
   * Can anything be reconstructed from this?
   *
   * Photogrammetry recovers geometry from PARALLAX — the same surface point
   * seen from genuinely different camera positions. Frames that differ only by
   * sensor noise contain no parallax however many there are, and no pipeline
   * can recover depth from them.
   *
   * Frame-to-frame pixel change alone CANNOT distinguish a camera that moved
   * from a subject that moved, and the two have opposite consequences: camera
   * motion is what makes reconstruction possible, while subject motion breaks
   * the rigid-scene assumption every pipeline depends on. So where recorded
   * pose is available it is authoritative, and the pixel measure is used only
   * as a fallback with that limitation stated.
   */
  console.log('\n  RECONSTRUCTION FEASIBILITY');
  console.log('  ' + '-'.repeat(62));

  if (pose) {
    const spread = pose.spreadDeg;
    const bins = pose.binsVisited;
    console.log(`  Recorded camera heading spans ${spread.toFixed(2)}°, visiting ${bins} of 24 sectors.`);
    console.log('');
    if (spread < 5) {
      console.log('  NO. The camera did not move. Photogrammetry recovers shape from');
      console.log('  parallax, and a fixed camera produces none however many frames it');
      console.log('  takes — every frame sees exactly the same geometry.');
      console.log('');
      if (medDiff > 8) {
        console.log(`  The ${medDiff.toFixed(0)} grey levels of frame-to-frame change is the SUBJECT`);
        console.log('  moving, not the camera. For photogrammetry that is worse than no');
        console.log('  change at all: every pipeline assumes a rigid scene, and a subject');
        console.log('  that shifts between frames produces inconsistent geometry.');
        console.log('');
      }
      console.log('  As a test of the capture plumbing this is a complete success — the');
      console.log('  camera, the metrics, the store and the export all worked.');
    } else if (bins < 12) {
      console.log(`  NO. The camera moved a little but covered only ${bins} of 24 sectors.`);
      console.log('  Surfaces never pointed at cannot be reconstructed at all.');
    } else if (frames.length < 20) {
      console.log(`  MARGINAL. The camera moved around the object, but ${frames.length} frames is`);
      console.log('  below the 24–36 needed for adequate overlap on one orbit.');
    } else {
      console.log('  PLAUSIBLE. The camera moved around the object with enough frames to');
      console.log('  attempt a reconstruction.');
    }
  } else {
    console.log('  UNKNOWN — no recorded camera pose, so this is inferred from pixels alone.');
    console.log(`  Median frame-to-frame change is ${medDiff.toFixed(1)} grey levels, which cannot`);
    console.log('  distinguish a camera that moved from a subject that moved. Only the');
    console.log('  first helps; the second breaks the rigid-scene assumption.');
    if (medDiff < 8) {
      console.log('\n  Near-identical frames, so most likely a fixed camera and not');
      console.log('  reconstructable.');
    }
  }

  console.log('\n  What a reconstructable session needs:');
  console.log('    • the camera moving AROUND the object, not the object filling a fixed frame');
  console.log('    • 10–15° between shots — about 24–36 frames per orbit');
  console.log('    • at least two elevations, plus a flip pass for the underside');
  console.log('    • a scale bar in shot, or the model has shape but no size');
  console.log('');
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
}
