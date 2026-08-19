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
  await sleep(1800);

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
  await sleep(2200);

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

  // A second elevation band should raise coverage, not merely add frames.
  const before2 = await cdp.eval(`window.__turnstone.ps.status().coverage.coverage`);
  await cdp.eval(FEED(24, 35));
  const after2 = await cdp.eval(`window.__turnstone.ps.status().coverage.coverage`);
  expect('a second elevation band raises coverage', after2 > before2, `${before2} -> ${after2}`);

  // --- the scale bar is the highest-value thing in the frame ---------------
  const noScale = await cdp.eval(`document.getElementById('clsValue').textContent`);
  await cdp.eval(`(() => {
    const c = document.getElementById('hasScale');
    c.checked = true; c.dispatchEvent(new Event('change'));
    const k = document.getElementById('hasColour');
    k.checked = true; k.dispatchEvent(new Event('change'));
  })()`);
  await sleep(300);
  const withScale = await cdp.eval(`document.getElementById('clsValue').textContent`);
  expect('adding a scale bar lifts the class', withScale !== noScale, `${noScale} -> ${withScale}`);

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
  await sleep(2600);

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
