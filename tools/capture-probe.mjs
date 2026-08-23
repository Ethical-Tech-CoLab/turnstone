/**
 * capture-probe.mjs — exercise the capture client in headless Chrome.
 *
 * The claims worth proving here cannot be proved by a unit test:
 *
 *   - a session SURVIVES A RELOAD, which is the whole reason the store exists;
 *   - the control tray stays reachable at every sheet position;
 *   - the client BOOTS WITH THE NETWORK OFF, which is the point of the service
 *     worker and the condition it will actually be used in.
 *
 * Usage: node tools/capture-probe.mjs [url]   (serves the site if no url given)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const CHROME = process.env.CHROME_PATH ?? CANDIDATES.find((p) => existsSync(p));
if (!CHROME) throw new Error('No Chrome, Chromium or Edge binary found. Set CHROME_PATH.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
  const name = rel === '' ? 'capture.html' : rel;
  const file = (name.startsWith('lib') || name.startsWith('rubric'))
    ? join(ROOT, name)
    : join(ROOT, 'web', name);
  if (!existsSync(file) || file.includes('..')) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = process.argv[2] ?? `http://127.0.0.1:${server.address().port}/`;
const URL_ = BASE.endsWith('.html') ? BASE : `${BASE.replace(/\/?$/, '/')}capture.html`;

const PORT = 9342;
const profile = mkdtempSync(join(tmpdir(), 'turnstone-cap-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage',
  '--unsafely-treat-insecure-origin-as-secure=' + new URL(URL_).origin,
  'about:blank',
], { stdio: 'ignore' });

async function debuggerUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.console = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        c.console.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        c.console.push(msg.params.exceptionDetails.exception?.description ?? 'exception');
      }
      if (!msg.id || !c.pending.has(msg.id)) return;
      const { res, rej } = c.pending.get(msg.id);
      c.pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  }
}

let failures = 0;
const expect = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

/**
 * Wait for the client to finish booting, rather than sleeping a fixed time.
 *
 * A fixed wait tuned on localhost fails against the deployed site, where the
 * rubric arrives over the network — and it fails as "nothing rendered", which
 * looks exactly like a broken build. Polling for the readiness the app itself
 * exposes removes the guess.
 */
async function waitForReady(cdp, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await cdp.eval(
      `!!(window.__turnstone && document.querySelectorAll('.dim').length === 10)`,
    ).catch(() => false);
    if (ready) return true;
    await sleep(250);
  }
  throw new Error(`client did not finish booting within ${timeoutMs} ms`);
}

/**
 * Feed synthetic frames straight into the live session.
 *
 * There is no camera in headless Chrome, so this drives the same code path the
 * camera would: measure a real canvas, hand the measurements to the persistent
 * session. What is being tested is the store and the UI, not the camera.
 */
const FEED = (n, elevation = 0) => `(async () => {
  const { measureFrame } = await import('./lib/frame.js');
  const { noisy } = await import('./lib/synthetic.js');
  const W = 256, H = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const ps = window.__turnstone.ps;
  for (let i = 0; i < ${n}; i++) {
    ctx.putImageData(new ImageData(noisy(W, H, { seed: 900 + i, amplitude: 80 }), W, H), 0, 0);
    const m = measureFrame(cv, W, H, { azimuthDeg: (360 / ${n}) * i, elevationDeg: ${elevation} });
    await ps.addFrame(m, null, { headingSource: 'probe' });
  }
  window.__turnstone.render();
  return ps.session.frames.length;
})()`;

try {
  const cdp = await Cdp.connect(await debuggerUrl());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.navigate', { url: URL_ });
  await waitForReady(cdp);

  const booted = await cdp.eval(`(() => ({
    dims: document.querySelectorAll('.dim').length,
    cls: document.getElementById('clsValue').textContent,
    store: document.getElementById('storeBadge').textContent,
    exposed: !!window.__turnstone,
  }))()`);
  expect('client boots and renders all ten dimensions', booted.dims === 10, `saw ${booted.dims}`);
  expect('starts at insufficient', booted.cls === 'insufficient', booted.cls);
  expect('reports where the session is stored', booted.store.length > 2, booted.store);
  expect('exposes its session for testing', booted.exposed === true);

  // --- the claim that matters most: frames survive a reload -----------------
  const fed = await cdp.eval(FEED(24, 0));
  expect('frames are measured and stored', fed === 24, `${fed} frames`);

  const beforeId = await cdp.eval(`window.__turnstone.ps.meta.id`);
  const beforeClass = await cdp.eval(`document.getElementById('clsValue').textContent`);

  await cdp.send('Page.reload');
  await waitForReady(cdp);

  const after = await cdp.eval(`(() => ({
    id: window.__turnstone.ps.meta.id,
    frames: window.__turnstone.ps.session.frames.length,
    cls: document.getElementById('clsValue').textContent,
  }))()`);
  expect('the same session is reopened after a reload', after.id === beforeId, `${beforeId} -> ${after.id}`);
  expect('every frame survived the reload', after.frames === 24, `${after.frames} frames`);
  expect('and it rescores to the same class', after.cls === beforeClass, `${beforeClass} -> ${after.cls}`);

  // --- coverage and guidance behave on the real client ----------------------
  const cov = await cdp.eval(`(() => {
    const c = document.getElementById('dial');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
    return { lit, instruction: document.getElementById('instructionText').textContent };
  })()`);
  expect('the coverage dial is painted', cov.lit > 2000, `${cov.lit} lit pixels`);
  expect('one instruction is shown', cov.instruction.length > 10, cov.instruction);

  /*
   * Two layout faults found by looking at a screenshot of the phone build:
   * the empty-state copy stayed up behind the dial once frames existed, so
   * body text and the primary instrument overlapped and neither was readable;
   * and the instruction pill sat under the sheet, half visible, which reads as
   * a bug rather than as guidance.
   */
  const layout = await cdp.eval(`(() => {
    const empty = document.getElementById('empty');
    const el = document.getElementById('instruction');
    const inst = el.getBoundingClientRect();
    const panel = document.getElementById('panel').getBoundingClientRect();
    const dial = document.getElementById('dial').getBoundingClientRect();
    const cx = dial.left + dial.width / 2, cy = dial.top + dial.height / 2;
    const atDial = document.elementFromPoint(cx, cy);
    const span = el.querySelector('span');
    return {
      emptyHidden: empty.classList.contains('hidden') || getComputedStyle(empty).display === 'none',
      instructionClear: inst.bottom <= panel.top + 1,
      instructionVisible: inst.height > 0 && inst.top >= 0,
      dialUnobstructed: !!atDial && !atDial.closest('#empty'),
      // Text must not paint outside the pill's rounded border. A clamp that
      // hides overflow without capping the box lets a fourth line escape.
      textInsidePill: span.getBoundingClientRect().bottom <= inst.bottom + 1,
      instHeight: Math.round(inst.height),
    };
  })()`);
  expect('the empty state is dismissed once frames exist', layout.emptyHidden === true);
  expect('nothing overlaps the coverage dial', layout.dialUnobstructed === true);
  expect('the instruction clears the sheet', layout.instructionClear === true);
  expect('the instruction is fully on screen', layout.instructionVisible === true);
  expect('instruction text stays inside its pill', layout.textInsidePill === true, `pill ${layout.instHeight}px`);

  // A second elevation band should raise coverage, not merely add frames.
  const before2 = await cdp.eval(`window.__turnstone.ps.status().coverage.coverage`);
  await cdp.eval(FEED(24, 35));
  const after2 = await cdp.eval(`window.__turnstone.ps.status().coverage.coverage`);
  expect('a second elevation band raises coverage', after2 > before2, `${before2} -> ${after2}`);

  // --- the scale bar is the highest-value thing in the frame ---------------
  const noScale = await cdp.eval(`document.getElementById('clsValue').textContent`);
  await cdp.eval(`(() => {
    const k = document.getElementById('targetKind');
    k.value = 'plumb-card'; k.dispatchEvent(new Event('change'));
    const l = document.getElementById('scaleLen');
    // The real measured value from a real card, not the nominal 150.
    l.value = '137.5'; l.dispatchEvent(new Event('input'));
    const c = document.getElementById('hasColour');
    c.checked = true; c.dispatchEvent(new Event('change'));
  })()`);
  await sleep(400);
  const withScale = await cdp.eval(`(() => ({
    cls: document.getElementById('clsValue').textContent,
    limiting: document.getElementById('limitValue').textContent,
    gsd: window.__turnstone.ps.session.gsdMmPerPx,
    scaleRef: window.__turnstone.ps.session.scaleReference,
    warned: !document.getElementById('printWarn').classList.contains('hidden'),
    warnText: document.getElementById('printWarn').textContent,
  }))()`);
  expect('the measured length is accepted', withScale.scaleRef === 1);
  expect('GSD is derived from it', withScale.gsd > 0, `${withScale.gsd?.toFixed(3)} mm/px`);
  /*
   * The class is NOT asserted to jump here.
   *
   * These probe frames are 256 px wide, so a 137.5 mm bar across 35% of the
   * frame genuinely works out at ~1.5 mm/px — which is correctly rated
   * insufficient. Demanding a class change would be demanding the scorer lie
   * about a real limitation of synthetic input. What must be true is that the
   * scale reference is satisfied and no longer the thing holding the capture
   * back.
   */
  expect('scale reference is no longer the limiting dimension',
    withScale.limiting !== 'scale-reference', withScale.limiting);

  /*
   * A card printed at 137.5 mm against a 150 mm design has been scaled by the
   * printer. The measured value must still be used — it is the correct one —
   * but the operator needs telling, or the next print will be wrong too.
   */
  expect('a scaled print is flagged', withScale.warned === true);
  expect('and the warning explains how to fix it',
    /Actual size|100%/i.test(withScale.warnText), withScale.warnText.slice(0, 70));

  // --- export ---------------------------------------------------------------
  const manifest = await cdp.eval(`(async () => {
    const m = await window.__turnstone.buildManifest();
    return { format: m.format, frames: m.frames.length, hasAttests: !!m.attests,
             hasDoesNot: !!m.doesNotAttest, tier: m.session.disclosureTier,
             provisional: m.quality.provisional };
  })()`);
  expect('export carries every frame', manifest.frames === 48, `${manifest.frames}`);
  expect('export states what it attests', manifest.hasAttests === true);
  expect('export states what it does NOT attest', manifest.hasDoesNot === true);
  expect('export marks the class provisional', manifest.provisional === true);

  /*
   * The photographs must actually leave the device.
   *
   * The first version of the export wrote only the manifest, with hasImage:true
   * per frame — a record of images that were not in it. A real field test found
   * nine full-resolution JPEGs stranded in browser storage with no way to get
   * them out. Browser storage is not an archive: it is evicted under pressure
   * and wiped by "clear browsing data".
   *
   * So this builds a package from frames that carry real image blobs, and
   * checks the archive contains the bytes rather than a promise of them.
   */
  const pkg = await cdp.eval(`(async () => {
    const { makeZip } = await import('./lib/zip.js');
    const ps = window.__turnstone.ps;

    // Give three frames real image data, as a camera capture would.
    const frames = await ps.frames();
    const store = window.__turnstone.store;
    for (let i = 0; i < 3; i++) {
      const bytes = new Uint8Array(50000);
      bytes[0] = 0xFF; bytes[1] = 0xD8; bytes[2] = 0xFF; bytes[3] = 0xE0;
      for (let j = 4; j < bytes.length; j++) bytes[j] = (i * 17 + j) & 0xFF;
      await store.putFrame({ ...frames[i], blob: new Blob([bytes], { type: 'image/jpeg' }) });
    }

    const withImages = (await ps.frames()).filter(f => f.blob);
    const zip = await makeZip([
      { name: 'manifest.json', text: '{"format":"turnstone-session/1"}' },
      ...withImages.map((f, i) => ({
        name: 'images/frame-' + String(i).padStart(4, '0') + '.jpg', blob: f.blob,
      })),
    ]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    return {
      imagesStored: withImages.length,
      zipBytes: zip.size,
      isZip: buf[0] === 0x50 && buf[1] === 0x4B,
      // The payload has to be in there, not merely referenced.
      carriesPayload: zip.size > withImages.length * 40000,
    };
  })()`);
  expect('images are retrievable from storage', pkg.imagesStored === 3, `${pkg.imagesStored}`);
  expect('the package is a real ZIP', pkg.isZip === true);
  expect('the package carries the image bytes, not just a reference',
    pkg.carriesPayload === true, `${(pkg.zipBytes / 1e3).toFixed(0)} KB`);

  /*
   * THE RECOVERY PATH.
   *
   * A field test captured nine full-resolution photographs that could not be
   * exported, because the export wrote only the manifest. Fixing the export is
   * not enough — those photographs are still in browser storage and must come
   * out without re-shooting the object, which for a museum piece may not be
   * possible at all.
   *
   * So: reload (which resumes the stored session), and export from the resumed
   * session with no camera involved.
   */
  await cdp.send('Page.reload');
  await waitForReady(cdp);
  const recovered = await cdp.eval(`(async () => {
    const ps = window.__turnstone.ps;
    const frames = await ps.frames();
    const withImages = frames.filter(f => f.blob);
    const m = await window.__turnstone.buildManifest(frames);
    return {
      resumedFrames: frames.length,
      imagesRecovered: withImages.length,
      manifestNamesFiles: m.frames.filter(f => f.file).length,
      exportEnabled: !document.getElementById('btnExport').disabled,
      firstBytes: withImages.length ? withImages[0].blob.size : 0,
    };
  })()`);
  expect('a reopened session still holds its photographs',
    recovered.imagesRecovered === 3, `${recovered.imagesRecovered} of 3`);
  expect('recovered photographs are exportable without re-shooting',
    recovered.exportEnabled === true);
  expect('the manifest names each image file',
    recovered.manifestNamesFiles === recovered.imagesRecovered,
    `${recovered.manifestNamesFiles} named`);
  expect('recovered image data is intact', recovered.firstBytes === 50000, `${recovered.firstBytes} bytes`);

  /*
   * A session with work must survive opens that capture nothing.
   *
   * The first version asked whether the MOST RECENT session had frames, which
   * is a different question. Every unused open creates an empty session with a
   * fresh timestamp, so after one idle visit the empty session was the most
   * recent, the check failed, and another empty session was created — while the
   * session holding the photographs was never resumed. A contributor whose work
   * was still on the device would be shown a blank screen.
   */
  const beforeIdle = await cdp.eval(`window.__turnstone.ps.meta.id`);
  await cdp.send('Page.reload');
  await waitForReady(cdp);
  await cdp.send('Page.reload');
  await waitForReady(cdp);
  const afterIdle = await cdp.eval(`(() => ({
    id: window.__turnstone.ps.meta.id,
    frames: window.__turnstone.ps.session.frames.length,
    exportEnabled: !document.getElementById('btnExport').disabled,
    sessionCount: 0,
  }))()`);
  expect('work is still resumed after further idle opens',
    afterIdle.id === beforeIdle, `${beforeIdle} -> ${afterIdle.id}`);
  expect('and its frames are still there', afterIdle.frames === 48, `${afterIdle.frames}`);
  expect('and it is still exportable', afterIdle.exportEnabled === true);

  const empties = await cdp.eval(`(async () => {
    const all = await window.__turnstone.store.listSessions();
    return { total: all.length, empty: all.filter(s => (s.frameCount ?? 0) === 0).length };
  })()`);
  expect('empty sessions do not accumulate', empties.empty === 0,
    `${empties.empty} empty of ${empties.total}`);

  // Funerary material must default closed.
  const tier = await cdp.eval(`(async () => {
    const s = document.getElementById('sensitivity');
    s.value = 'funerary'; s.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    return (await window.__turnstone.buildManifest()).session.disclosureTier;
  })()`);
  expect('funerary material defaults to source-community', tier === 'source-community', tier);

  // --- the tray must stay reachable ----------------------------------------
  const tray = await cdp.eval(`(() => {
    const hit = (id) => { const b = document.getElementById(id).getBoundingClientRect();
      const t = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2);
      return !!(t && t.closest('.tray')); };
    const panel = document.getElementById('panel');
    const out = {};
    for (const open of [false, true]) {
      panel.classList.toggle('is-open', open);
      panel.getBoundingClientRect();
      out[open ? 'open' : 'peek'] =
        ['btnShoot','btnCamera','btnAuto','btnFlip','btnSheet'].every(hit);
    }
    panel.classList.remove('is-open');
    return { ...out, sideScroll: document.documentElement.scrollWidth - innerWidth };
  })()`);
  expect('tray usable with the sheet closed', tray.peek === true);
  expect('tray usable with the sheet open', tray.open === true);
  expect('no sideways scroll', tray.sideScroll <= 0, `${tray.sideScroll}px`);

  // --- offline ---------------------------------------------------------------
  // The condition this will actually be used in: a store room with no signal.
  await cdp.send('Network.enable');
  await cdp.eval(`navigator.serviceWorker.ready.then(() => true)`).catch(() => null);
  await sleep(1200);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await cdp.send('Page.reload');
  await waitForReady(cdp).catch(() => {});

  const offline = await cdp.eval(`(() => ({
    booted: !!window.__turnstone,
    dims: document.querySelectorAll('.dim').length,
    frames: window.__turnstone ? window.__turnstone.ps.session.frames.length : -1,
  }))()`).catch(() => ({ booted: false, dims: 0, frames: -1 }));
  expect('the client boots with the network off', offline.booted === true);
  expect('the rubric is available offline', offline.dims === 10, `${offline.dims} dimensions`);
  expect('the session is still there offline', offline.frames === 48, `${offline.frames} frames`);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });

  const errs = cdp.console.filter((e) => !/favicon|Failed to load resource/i.test(e));
  expect('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log(failures === 0 ? '\nAll capture checks passed.' : `\n${failures} capture check(s) FAILED.`);
} finally {
  chrome.kill();
  server.close();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
}

process.exit(failures === 0 ? 0 : 1);
