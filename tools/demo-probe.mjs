/**
 * demo-probe.mjs — run the demo page in headless Chrome and assert it works.
 *
 * A syntax check proves a file parses, not that the page functions. This drives
 * a real browser engine: it loads the page, runs the built-in demo session, and
 * checks that the numbers on screen actually moved and that the class ended up
 * where the rubric says it should.
 *
 * Written this way because the editor's browser tooling drops its connection
 * mid-session and its screenshot tool has captured unrelated windows. No
 * dependencies: Node 22+ ships a global WebSocket.
 *
 * Usage: node tools/demo-probe.mjs [url]     (serves web/ + lib/ + rubric/ if no url)
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

/*
 * Serve the site the way the workflow assembles it: web/ at the root, with lib/
 * and rubric/ alongside. Probing a layout the deploy does not produce would
 * test nothing.
 */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
};
const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
  const name = rel === '' ? 'index.html' : rel;
  const candidates = name.startsWith('lib') || name.startsWith('rubric')
    ? [join(ROOT, name)]
    : [join(ROOT, 'web', name)];
  const file = candidates.find((f) => existsSync(f) && !f.includes('..'));
  if (!file) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = process.argv[2] ?? `http://127.0.0.1:${server.address().port}/index.html`;

const PORT = 9334;
const profile = mkdtempSync(join(tmpdir(), 'turnstone-probe-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--no-sandbox', '--disable-dev-shm-usage',
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

try {
  const cdp = await Cdp.connect(await debuggerUrl());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(1400);

  // The rubric loads over fetch, so a broken path shows up as a page that
  // renders but can never score anything.
  const booted = await cdp.eval(`(() => ({
    dims: document.querySelectorAll('.dim').length,
    cls: document.getElementById('clsValue').textContent,
    build: document.getElementById('buildTag').textContent,
  }))()`);
  expect('rubric loaded and all ten dimensions rendered', booted.dims === 10, `saw ${booted.dims}`);
  expect('starts at insufficient, not at a flattering default', booted.cls === 'insufficient', booted.cls);

  // Run the scripted session and watch it improve.
  await cdp.eval(`document.getElementById('btnDemo').click()`);
  await sleep(1200);
  const early = await cdp.eval(`(() => ({
    cls: document.getElementById('clsValue').textContent,
    limiting: document.getElementById('limitValue').textContent,
    instruction: document.getElementById('instructionText').textContent,
    frames: document.getElementById('frameValue').textContent,
  }))()`);
  expect('frames are being measured', /[1-9]/.test(early.frames), early.frames);
  expect('an instruction is shown', early.instruction.length > 10, early.instruction);

  await sleep(9000);
  const late = await cdp.eval(`(() => ({
    cls: document.getElementById('clsValue').textContent,
    score: parseInt(document.getElementById('scoreValue').textContent, 10),
    limiting: document.getElementById('limitValue').textContent,
    frames: document.getElementById('frameValue').textContent,
    coverage: document.querySelector('#dims .dim .dim-val').textContent,
    dialPainted: (() => {
      const c = document.getElementById('dial');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
      return lit;
    })(),
  }))()`);

  expect('the coverage dial is actually painted', late.dialPainted > 2000, `${late.dialPainted} lit pixels`);
  expect('score rose above zero as the session improved', late.score > 0, `score ${late.score}`);
  expect('captured a full session', /3[0-9]/.test(late.frames), late.frames);

  /*
   * With no scale bar there is no scale reference AND no ground sample
   * distance — a scale bar is what supplies both. So however good the pixels
   * get, the class must stay at `insufficient`. That is the rubric working:
   * an object with no size cannot be measured or matched to a record, and
   * rating it higher would misrepresent what is known.
   */
  expect('class stays capped while the object has no size', late.cls === 'insufficient', late.cls);

  // Now put a scale bar in shot. It satisfies two dimensions at once, and the
  // class should move — the clearest demonstration of the worst-dimension rule.
  await cdp.eval(`document.getElementById('btnScale').click()`);
  await sleep(500);
  const scaled = await cdp.eval(`(() => ({
    cls: document.getElementById('clsValue').textContent,
    score: parseInt(document.getElementById('scoreValue').textContent, 10),
    limiting: document.getElementById('limitValue').textContent,
  }))()`);
  expect('adding a scale bar lifts the class', scaled.cls !== late.cls, `${late.cls} -> ${scaled.cls}`);
  expect('and the limiting dimension moves on', scaled.limiting !== 'scale-reference', scaled.limiting);
  expect('score also rises', scaled.score > late.score, `${late.score} -> ${scaled.score}`);

  // A capture-time class must never be presentable as final.
  const provisional = await cdp.eval(`document.getElementById('summaryText').textContent`);
  expect('the class is declared provisional', /provisional/i.test(provisional), provisional.slice(0, 90));
  const deferredShown = await cdp.eval(
    `[...document.querySelectorAll('.dim.state-deferred .dim-val')].map(e => e.textContent).join('|')`);
  expect('deferred dimensions say so on the face of it', /after processing/.test(deferredShown), deferredShown);

  // Mobile layout: the tray must stay reachable, the lesson Plumb paid for.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(1200);
  const mobile = await cdp.eval(`(() => {
    const tray = document.querySelector('.tray').getBoundingClientRect();
    const hit = (id) => { const b = document.getElementById(id).getBoundingClientRect();
      const t = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2);
      return !!(t && t.closest('.tray')); };
    return {
      trayFixed: getComputedStyle(document.querySelector('.tray')).position === 'fixed',
      trayOnScreen: tray.bottom <= innerHeight + 1 && tray.top >= 0,
      shutterHittable: hit('btnShoot'),
      demoHittable: hit('btnDemo'),
      scaleHittable: hit('btnScale'),
      sideScroll: document.documentElement.scrollWidth - innerWidth,
    };
  })()`);
  expect('tray is fixed on a phone', mobile.trayFixed);
  expect('tray is fully on screen', mobile.trayOnScreen);
  expect('shutter is hittable', mobile.shutterHittable);
  expect('demo button is hittable', mobile.demoHittable);
  expect('scale bar button is hittable', mobile.scaleHittable);
  expect('no sideways scroll', mobile.sideScroll <= 0, `${mobile.sideScroll}px`);

  const errs = cdp.console.filter((e) => !/favicon/i.test(e));
  expect('no console errors', errs.length === 0, errs.join(' | '));

  console.log(failures === 0 ? '\nAll demo checks passed.' : `\n${failures} demo check(s) FAILED.`);
} finally {
  chrome.kill();
  server.close();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
}

process.exit(failures === 0 ? 0 : 1);
