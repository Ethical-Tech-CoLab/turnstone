/**
 * demo.js — Turnstone capture quality, running on real pixels.
 *
 * Deliberately thin. Everything that decides anything lives in lib/ and is
 * covered by the test suite; this file only moves pixels in and paints results
 * out. If a number shown here is wrong, the bug is in a tested module, not in
 * the page.
 *
 * The build id is stamped at deploy time. Plumb learned this the hard way: an
 * unversioned asset behind a ten-minute cache makes a deploy that reached the
 * device indistinguishable from one that changed nothing, which costs a whole
 * round trip of field testing to diagnose.
 */

const BUILD_ID = '__TURNSTONE_BUILD__'.startsWith('__') ? 'dev' : '__TURNSTONE_BUILD__';

import { loadRubric } from './lib/rubric.js';
import { Session } from './lib/session.js';
import { measureFrame } from './lib/frame.js';
import { noisy, blur, clipPixels, flat } from './lib/synthetic.js';
import { AZIMUTH_BINS, azimuthBin, gsdRequiredFor } from './lib/metrics.js';

const $ = (id) => document.getElementById(id);

const els = {
  video: $('video'), still: $('still'), dial: $('dial'),
  stage: $('stage'), empty: $('empty'),
  instruction: $('instruction'), instructionText: $('instructionText'),
  classBadge: $('classBadge'), cls: $('clsValue'), score: $('scoreValue'),
  limit: $('limitValue'), frames: $('frameValue'), summary: $('summaryText'),
  dims: $('dims'), toast: $('toast'), panel: document.querySelector('.panel'),
};

let rubric = null;
let session = null;
let stream = null;
let target = 'study';
let demoTimer = null;
let simulatedAzimuth = 0;

/* ------------------------------------------------------------------ boot */

async function boot() {
  $('buildTag').textContent = `build ${BUILD_ID}`;
  try {
    rubric = loadRubric(await (await fetch(`rubric/heritage-v1.json?v=${BUILD_ID}`)).json());
  } catch (err) {
    toast(`Could not load the rubric: ${err.message}`);
    return;
  }
  reset();
  render();
}

function reset() {
  session = new Session(rubric, { target });
  simulatedAzimuth = 0;
  $('btnScale').classList.remove('is-on');
  stopDemo();
  render();
}

/* -------------------------------------------------------------- rendering */

function render() {
  const st = session.status();

  const cls = st.quality.class;
  els.classBadge.textContent = cls;
  els.classBadge.className = `badge badge-${cls}`;
  els.cls.textContent = cls;
  els.score.innerHTML = `${st.quality.score}<span class="unit">/100</span>`;
  els.limit.textContent = st.quality.limitingDimension ?? '—';
  els.frames.innerHTML = st.suspect
    ? `${st.frames}<span class="unit"> · ${st.suspect} suspect</span>`
    : `${st.frames}`;
  // Say plainly that this is a capture-time class with checks still outstanding.
  els.summary.textContent = st.quality.provisional
    ? `${st.guidance.summary} This is a provisional class — ${st.quality.deferred.length} dimension${st.quality.deferred.length > 1 ? 's' : ''} can only be checked after the photographs are processed.`
    : st.guidance.summary;

  // One instruction. Not a list.
  const g = st.guidance;
  els.instruction.classList.toggle('hidden', st.frames === 0);
  els.instruction.classList.toggle('is-ok', g.meetsTarget);
  els.instruction.classList.toggle('is-blocking',
    g.signals.some((s) => s.id === g.primaryDimension && s.state === 'blocking'));
  els.instructionText.textContent = g.primaryAction ?? `Meets ${target}. Stop, or keep going.`;

  renderDims(st);
  drawDial(st);
}

function renderDims(st) {
  const byId = new Map(st.guidance.signals.map((s) => [s.id, s]));
  els.dims.innerHTML = '';

  for (const d of rubric.dimensions) {
    const sig = byId.get(d.id);
    const deferred = !d.liveMeasurable;
    const state = deferred ? 'deferred' : (sig?.state ?? 'unknown');
    const limiting = st.quality.limitingDimension === d.id;

    const el = document.createElement('div');
    el.className = `dim state-${state}${limiting ? ' is-limiting' : ''}`;

    const value = deferred ? 'deferred — checked after processing'
      : sig?.state === 'unknown' ? 'not measured'
      : sig.measured;

    // Ground sample distance is stated in the rubric as a normalised number,
    // which is not an instruction anyone can act on. Show what it actually
    // demands, in the units an operator works in.
    const extra = d.id === 'ground-sample-distance'
      ? ` · ${target} needs ≤ ${gsdRequiredFor(d.thresholds[target] ?? d.thresholds.study).toFixed(2)} mm/px`
      : '';

    el.innerHTML = `
      <div class="dim-head">
        <span>${d.label}</span>
        <span class="dim-val">${value}${extra}</span>
      </div>
      <div class="dim-bar"><span style="width:${Math.round((sig?.value ?? 0) * 100)}%;background:${barColour(state)}"></span></div>
      <div class="dim-why">${d.why}</div>`;
    els.dims.appendChild(el);
  }
}

function barColour(state) {
  return { ok: 'var(--ok)', attention: 'var(--warn)', blocking: 'var(--danger)' }[state] ?? 'var(--muted)';
}

/**
 * The coverage dial (R-6.7): a filled ring, not a percentage.
 *
 * Apple and DPA converged on this independently, and the reason is that a gap
 * in a ring is a place you can walk to, whereas "62%" is a number you have to
 * translate into one.
 */
function drawDial(st) {
  const box = els.stage.getBoundingClientRect();
  const size = Math.max(120, Math.min(260, Math.min(box.width, box.height) * 0.42));
  const dpr = window.devicePixelRatio || 1;
  els.dial.width = Math.round(size * dpr);
  els.dial.height = Math.round(size * dpr);
  els.dial.style.width = `${size}px`;
  els.dial.style.height = `${size}px`;

  const ctx = els.dial.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.42;
  const rInner = size * 0.31;
  const visited = new Set(st.coverage.perBand.eye?.visited ?? []);

  for (let i = 0; i < AZIMUTH_BINS; i++) {
    const a0 = (i / AZIMUTH_BINS) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 0.86) / AZIMUTH_BINS) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, a0, a1);
    ctx.arc(cx, cy, rInner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = visited.has(i) ? 'rgba(0,229,255,.85)' : 'rgba(255,255,255,.13)';
    ctx.fill();
  }

  const pct = Math.round((st.coverage.coverage ?? 0) * 100);
  ctx.fillStyle = '#e6edf3';
  ctx.font = `600 ${Math.round(size * 0.13)}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${pct}%`, cx, cy - size * 0.02);
  ctx.font = `500 ${Math.round(size * 0.058)}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = '#8b949e';
  ctx.fillText('coverage', cx, cy + size * 0.09);
}

/* ------------------------------------------------------------- the camera */

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false,
    });
    els.video.srcObject = stream;
    await els.video.play();
    els.video.classList.remove('hidden');
    els.still.classList.add('hidden');
    els.empty.classList.add('hidden');
    $('btnShoot').disabled = false;
    $('btnCamera').classList.add('is-on');
    stopDemo();
    requestOrientation();
    toast('Point at an object and capture a few frames as you move around it.');
  } catch (err) {
    toast(`Camera unavailable: ${err.message}. The demo runs without it.`);
  }
}

/**
 * Pose, honestly labelled.
 *
 * Real device orientation where the browser offers it; a simulated orbit
 * otherwise. Coverage on a laptop is therefore illustrative, and the page says
 * so rather than implying the dial means something it does not.
 */
let heading = null;
let pitch = null;

function requestOrientation() {
  const attach = () => window.addEventListener('deviceorientation', (e) => {
    if (e.alpha != null) heading = e.alpha;
    if (e.beta != null) pitch = e.beta - 90;
  });
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') attach(); }).catch(() => {});
  } else {
    attach();
  }
}

function currentPose() {
  if (heading != null) {
    return { azimuthDeg: heading, elevationDeg: pitch ?? 0, real: true };
  }
  const a = simulatedAzimuth;
  simulatedAzimuth = (simulatedAzimuth + 360 / AZIMUTH_BINS) % 360;
  return { azimuthDeg: a, elevationDeg: 0, real: false };
}

function captureFromVideo() {
  if (!els.video.videoWidth) return toast('Camera is not ready yet.');
  const pose = currentPose();
  const f = measureFrame(els.video, els.video.videoWidth, els.video.videoHeight, pose);
  session.addFrame(f);
  render();
  if (!pose.real) toast('Pose simulated — this device reports no orientation.', 2200);
}

/* --------------------------------------------------------------- the demo */

/**
 * A scripted session that gets things wrong before it gets them right.
 *
 * A demo where everything is perfect teaches nothing. This one starts blurred
 * and over-exposed so the guidance visibly changes its mind as each problem is
 * fixed — which is the behaviour worth showing.
 */
const SCRIPT = [
  { n: 6,  label: 'blurred, over-exposed',  blurRadius: 3, clip: 0.14 },
  { n: 6,  label: 'exposure fixed',          blurRadius: 3, clip: 0.002 },
  { n: 12, label: 'focus fixed',             blurRadius: 0, clip: 0.002 },
  { n: 12, label: 'completing the orbit',    blurRadius: 0, clip: 0.002 },
];

function runDemo() {
  reset();
  els.empty.classList.add('hidden');
  els.video.classList.add('hidden');
  els.still.classList.remove('hidden');
  $('btnDemo').classList.add('is-on');

  const steps = [];
  for (const s of SCRIPT) for (let i = 0; i < s.n; i++) steps.push(s);

  let i = 0;
  demoTimer = setInterval(() => {
    if (i >= steps.length) {
      stopDemo();
      toast('Session complete. Now tap “Scale bar” — every pixel-level dimension is good, and the class is still capped because the object has no size.', 8000);
      return;
    }
    const step = steps[i];
    const W = 320, H = 320;

    let px = noisy(W, H, { seed: 100 + i, amplitude: 78 });
    if (step.blurRadius) px = blur(px, W, H, step.blurRadius);
    if (step.clip > 0.01) px = clipPixels(px, W, H, { fraction: step.clip, value: 255 });

    // Paint it so the page shows the frame being measured, not an abstraction.
    els.still.width = W;
    els.still.height = H;
    els.still.getContext('2d').putImageData(new ImageData(px, W, H), 0, 0);

    const pose = { azimuthDeg: (360 / AZIMUTH_BINS) * i, elevationDeg: 0 };
    session.addFrame(measureFrame(els.still, W, H, pose));
    render();
    i++;
  }, 240);
}

function stopDemo() {
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = null;
  $('btnDemo').classList.remove('is-on');
}

/* ------------------------------------------------------------------- wire */

$('btnDemo').addEventListener('click', () => (demoTimer ? stopDemo() : runDemo()));
$('btnCamera').addEventListener('click', startCamera);
$('btnShoot').addEventListener('click', captureFromVideo);
$('btnReset').addEventListener('click', () => {
  els.empty.classList.remove('hidden');
  els.still.classList.add('hidden');
  reset();
  toast('Session reset.');
});

/**
 * Put a scale bar in the scene, or take it away.
 *
 * A calibrated bar of known length in shot satisfies TWO dimensions at once,
 * which is why it is the single highest-value thing an operator can do:
 *
 *   - `scale-reference`, directly;
 *   - `ground-sample-distance`, because GSD = known length / pixels spanned,
 *     needing no focal length, no sensor size and no distance.
 *
 * Toggling it is the clearest demonstration of the rubric's central rule. Every
 * pixel-level dimension can be flawless and the class still stops at
 * `insufficient`, because an object with no size cannot be measured, compared
 * against a written description, or matched to an excavation record.
 */
$('btnScale').addEventListener('click', () => {
  const on = session.scaleReference === 0;
  session.scaleReference = on ? 1 : 0;
  session.colourReference = on ? 1 : 0;
  // 150 mm bar spanning ~900 px of a 1024 px working frame.
  session.gsdMmPerPx = on ? 150 / 900 : null;
  $('btnScale').classList.toggle('is-on', on);
  render();
  toast(on
    ? 'Scale bar and colour target in shot. The record can now state a size — watch the class move.'
    : 'Scale bar removed. The object now has shape but no size.', 5200);
});

// On a phone the panel is a sheet; tapping its grip area opens it.
els.panel.addEventListener('click', (e) => {
  if (window.matchMedia('(max-width: 900px), (max-height: 560px)').matches
      && e.offsetY < 24 && e.target === els.panel) {
    els.panel.classList.toggle('is-open');
  }
});

let toastTimer = null;
function toast(msg, ms = 3600) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

window.addEventListener('resize', () => session && drawDial(session.status()));

boot();
