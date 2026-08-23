/**
 * check-targets.mjs — render the printable mats and measure the scale bar.
 *
 * ---------------------------------------------------------------------------
 * A target whose printed length differs from its stated length is worse than no
 * target: every measurement taken from the resulting model is wrong by that
 * factor, and nothing downstream can detect it. The number on the page is a
 * claim, and it has to be checked like one.
 *
 * Two real defects were caught this way and neither was visible by reading the
 * file:
 *
 *   - end ticks drawn with a 1.2 mm stroke centred on the end coordinates put
 *     0.6 mm of ink past each end, so a 180 mm bar measured 181.2 mm;
 *   - the Letter variant, produced by search-and-replacing coordinates in the
 *     A4 file, moved the ticks without moving the blocks and measured 183.72 mm.
 *
 * Usage: node tools/check-targets.mjs
 * ---------------------------------------------------------------------------
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Expected geometry. These are the claims the SVGs make on their face. */
const TARGETS = [
  { file: 'target-a4.svg', pageW: 210, barMm: 180, barY: 56 },
  { file: 'target-letter.svg', pageW: 215.9, barMm: 180, barY: 56 },
];

/* Sub-millimetre: a printer cannot do better, and a tighter bound would be
 * measuring the rasteriser rather than the artwork. */
const TOLERANCE_MM = 0.35;
const SCALE = 8;                        // canvas px per mm

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/probe') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!DOCTYPE html><html><body style="margin:0;background:#fff">`
      + `<img id="t" src="/docs/assets/${url.searchParams.get('f')}" `
      + `style="display:block;width:${Number(url.searchParams.get('w')) * SCALE}px"></body></html>`);
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const f = join(ROOT, rel);
  if (!existsSync(f) || !f.startsWith(ROOT)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': extname(f) === '.svg' ? 'image/svg+xml' : 'text/plain' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), 'turnstone-targets-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9373', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage', 'about:blank',
], { stdio: 'ignore' });

let failures = 0;
const expect = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

try {
  let wsUrl;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9373/json/list')).json();
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1900, height: 2600, deviceScaleFactor: 1, mobile: false });

  console.log('');
  for (const t of TARGETS) {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/probe?f=${t.file}&w=${t.pageW}` });
    await sleep(1600);

    const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(async () => {
      const img = document.getElementById('t');
      if (!img) return { err: 'image element missing' };
      await img.decode();
      const W = img.clientWidth;
      const H = Math.round(img.naturalHeight / img.naturalWidth * W);
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
      c.drawImage(img, 0, 0, W, H);
      const d = c.getImageData(0, 0, W, H).data;
      const pxPerMm = W / ${t.pageW};
      const y = Math.round(${t.barY} * pxPerMm);
      let first = -1, last = -1;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (d[i] < 100 && d[i+1] < 100 && d[i+2] < 100) { if (first < 0) first = x; last = x; }
      }
      return { W, H, pxPerMm, spanMm: (last - first + 1) / pxPerMm,
               aspect: (img.naturalHeight / img.naturalWidth) };
    })()`});

    const v = r.result?.value;
    if (!v || v.err) { expect(`${t.file} renders`, false, v?.err ?? 'no result'); continue; }

    const err = Math.abs(v.spanMm - t.barMm);
    expect(`${t.file}: scale bar measures ${v.spanMm.toFixed(2)} mm (nominal ${t.barMm})`,
      err <= TOLERANCE_MM, `off by ${err.toFixed(2)} mm`);
  }
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
}

console.log(failures === 0
  ? '\n  Printable targets are dimensionally correct.\n'
  : `\n  ${failures} target check(s) FAILED. Do not print these.\n`);
process.exit(failures === 0 ? 0 : 1);
