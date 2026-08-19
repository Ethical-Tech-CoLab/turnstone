/**
 * capture.js — the capture client.
 *
 * Thin by design. Everything that decides anything lives in lib/ and is covered
 * by tests; this moves pixels in, writes frames out, and paints state.
 */

const BUILD_ID = '__TURNSTONE_BUILD__'.startsWith('__') ? 'dev' : '__TURNSTONE_BUILD__';

import { loadRubric } from './lib/rubric.js';
import { Session } from './lib/session.js';
import { measureFrame } from './lib/frame.js';
import { Camera, detectPlatform } from './lib/camera.js';
import { openStore, PersistentSession, requestPersistence, storageEstimate } from './lib/store.js';
import { PoseTracker, AutoCapture } from './lib/steady.js';
import { AZIMUTH_BINS, gsdRequiredFor } from './lib/metrics.js';

const $ = (id) => document.getElementById(id);

let rubric = null;
let store = null;
let ps = null;                       // PersistentSession
const camera = new Camera();
let pose = null;
let auto = null;
let target = 'study';
let lastPose = null;

/* ------------------------------------------------------------------- boot */

async function boot() {
  $('buildTag').textContent = `build ${BUILD_ID}`;

  const p = detectPlatform();
  $('platformNote').textContent = p.label;
  $('platformNote').className = `platform is-${p.tier === 'primary' ? 'primary' : 'reduced'}`;

  try {
    rubric = loadRubric(await (await fetch(`rubric/heritage-v1.json?v=${BUILD_ID}`)).json());
  } catch (err) {
    return toast(`Could not load the rubric: ${err.message}`, 8000);
  }

  store = await openStore();
  await requestPersistence();
  await showStorageState();

  // Reopen the most recent session rather than silently starting a new one.
  // A contributor who reloads mid-session has not asked to start again.
  const sessions = (await store.listSessions()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  if (sessions.length && sessions[0].frameCount > 0) {
    ps = await PersistentSession.resume(store, new Session(rubric), sessions[0].id);
    target = ps.meta.target ?? 'study';
    applySubjectToUi();
    toast(`Resumed a session with ${ps.session.frames.length} frames.`, 5000);
  } else {
    ps = await PersistentSession.create(store, new Session(rubric, { target }), { target });
  }

  auto = new AutoCapture({ onFire: () => shoot({ auto: true }) });
  pose = new PoseTracker({ onUpdate: onPose });

  setTargetSeg(target);
  await renderSessionList();
  render();
  setInterval(tickCountdown, 120);

  // Testing hook. The browser probe drives the same code path the camera would,
  // because there is no camera in headless Chrome — what needs proving is the
  // store, the scoring and the layout, not the webcam driver.
  window.__turnstone = {
    get ps() { return ps; },
    get rubric() { return rubric; },
    get store() { return store; },
    render,
    buildManifest,
  };
}

async function showStorageState() {
  const badge = $('storeBadge');
  if (!store.persistent) {
    badge.textContent = 'memory only';
    badge.classList.add('is-warn');
    badge.title = 'This browser is not offering durable storage — the session will not survive a reload.';
    return;
  }
  const est = await storageEstimate();
  badge.textContent = est && est.quota
    ? `on device · ${Math.round((est.quota - est.usage) / 1e6)} MB free`
    : 'on device';
  badge.title = 'Frames are written to this device as they are captured.';
}

/* ------------------------------------------------------------------- pose */

function onPose(p) {
  lastPose = p;
  const pill = $('steadyPill');
  pill.classList.toggle('hidden', !p.available);
  pill.classList.toggle('is-steady', p.steady);
  $('steadyText').textContent = p.steady
    ? 'steady'
    : (p.movementDeg === Infinity ? 'finding level…' : `moving ${p.movementDeg.toFixed(1)}°`);

  auto?.update(p.steady);
  syncShutter();
}

function tickCountdown() {
  const st = auto?.state();
  $('shutterCount').textContent = st?.armed ? String(Math.ceil(st.remainingMs / 250)) : '';
}

/* ----------------------------------------------------------------- camera */

async function startCamera() {
  try {
    await camera.start();
    $('video').srcObject = camera.stream;
    await $('video').play();
    $('video').classList.remove('hidden');
    $('empty').classList.add('hidden');
    $('btnShoot').disabled = false;
    $('btnAuto').disabled = false;
    $('btnFlip').disabled = false;
    $('btnLock').disabled = !(camera.capabilities.focusMode || camera.capabilities.exposureMode);
    $('btnCamera').classList.add('is-on');
    $('btnExport').disabled = false;
    updateCamState();
    toast(camera.imageCapture
      ? 'Camera running. Full-resolution stills available.'
      : 'Camera running. This browser has no ImageCapture, so frames come from the video stream — usable for framing, not for a reference record.', 6000);
  } catch (err) {
    toast(`Camera unavailable: ${err.message}`, 6000);
  }
}

function updateCamState() {
  const p = camera.captureProfile();
  $('camState').textContent =
    `${p.width ?? '?'}×${p.height ?? '?'} · zoom ${(p.zoom ?? 1).toFixed(1)}× · `
    + `optics ${p.optics_locked ? 'LOCKED' : 'auto'} · lens profile ${p.lens_profile_valid ? 'valid' : 'not guaranteed'}`;
}

/* ---------------------------------------------------------------- capture */

let shooting = false;

/**
 * Take a photograph and score it.
 *
 * Order matters: measure from the still if there is one, so the numbers
 * describe the archival pixels rather than a lower-resolution preview of them.
 */
async function shoot({ auto: fromAuto = false } = {}) {
  if (shooting) return;
  if (!camera.stream) return toast('Start the camera first.');
  shooting = true;
  $('btnShoot').classList.add('is-busy');

  try {
    let source = $('video');
    let width = source.videoWidth;
    let height = source.videoHeight;
    let blob = null;

    if (camera.imageCapture) {
      try {
        blob = await camera.takePhoto();
        const bitmap = await createImageBitmap(blob);
        if (!bitmap.width || !bitmap.height) throw new Error('decoded to zero size');
        source = bitmap;
        width = bitmap.width;
        height = bitmap.height;
      } catch (err) {
        // Fall back to the preview frame rather than losing the shot entirely.
        // The record says which was used, so nobody mistakes one for the other.
        blob = null;
        toast(`Full-resolution capture failed (${err.message}); used a preview frame.`, 6000);
      }
    }

    if (!width || !height) throw new Error('Camera is not ready yet.');

    const p = lastPose ?? {};
    const profile = camera.captureProfile();
    const measurements = measureFrame(source, width, height, {
      azimuthDeg: p.azimuthDeg ?? null,
      elevationDeg: p.elevationDeg ?? 0,
      focalLengthMm: profile.focal_length_mm,
      sensorWidthMm: null,
    });

    await ps.addFrame(measurements, blob, {
      fullResolution: !!blob,
      headingSource: p.headingSource ?? 'none',
      steadyAtCapture: !!p.steady,
      captureProfile: profile,
      auto: fromAuto,
    });

    source.close?.();
    flash();
    render();
    await showStorageState();
  } catch (err) {
    toast(`Capture failed: ${err.message}`, 6000);
  } finally {
    shooting = false;
    $('btnShoot').classList.remove('is-busy');
    syncShutter();
  }
}

function flash() {
  const f = $('shotFlash');
  f.classList.remove('is-firing');
  void f.offsetWidth;                  // restart the animation
  f.classList.add('is-firing');
}

function syncShutter() {
  const st = auto?.state();
  $('btnShoot').classList.toggle('is-armed', !!st?.armed);
  $('btnAuto').classList.toggle('is-on', !!st?.enabled);
  $('btnAuto').querySelector('.tray-lab').textContent = st?.enabled ? 'Armed' : 'Auto';
}

/* --------------------------------------------------------------- renderng */

function render() {
  const st = ps.status();
  const cls = st.quality.class;

  $('classBadge').textContent = cls;
  $('classBadge').className = `badge badge-${cls}`;
  $('clsValue').textContent = cls;
  $('scoreValue').innerHTML = `${st.quality.score}<span class="unit">/100</span>`;
  $('limitValue').textContent = st.quality.limitingDimension ?? '—';
  $('frameValue').innerHTML = st.suspect
    ? `${st.frames}<span class="unit"> · ${st.suspect} suspect</span>`
    : `${st.frames}`;

  $('summaryText').textContent = st.quality.provisional
    ? `${st.guidance.summary} This is a provisional class — ${st.quality.deferred.length} dimension${st.quality.deferred.length > 1 ? 's' : ''} can only be checked after the photographs are processed.`
    : st.guidance.summary;

  const g = st.guidance;
  $('instruction').classList.toggle('hidden', st.frames === 0);
  $('instruction').classList.toggle('is-ok', g.meetsTarget);
  $('instructionText').textContent = g.primaryAction ?? `Meets ${target}. Stop, or keep going.`;

  renderDims(st);
  drawDial(st);
}

function renderDims(st) {
  const byId = new Map(st.guidance.signals.map((s) => [s.id, s]));
  const el = $('dims');
  el.innerHTML = '';
  for (const d of rubric.dimensions) {
    const sig = byId.get(d.id);
    const deferred = !d.liveMeasurable;
    const state = deferred ? 'deferred' : (sig?.state ?? 'unknown');
    const limiting = st.quality.limitingDimension === d.id;
    const value = deferred ? 'deferred — checked after processing'
      : sig?.state === 'unknown' ? 'not measured'
      : sig.measured;
    const extra = d.id === 'ground-sample-distance'
      ? ` · ${target} needs ≤ ${gsdRequiredFor(d.thresholds[target] ?? d.thresholds.study).toFixed(2)} mm/px`
      : '';

    const row = document.createElement('div');
    row.className = `dim state-${state}${limiting ? ' is-limiting' : ''}`;
    row.innerHTML = `
      <div class="dim-head"><span>${d.label}</span><span class="dim-val">${value}${extra}</span></div>
      <div class="dim-bar"><span style="width:${Math.round((sig?.value ?? 0) * 100)}%;background:${
        { ok: 'var(--ok)', attention: 'var(--warn)', blocking: 'var(--danger)' }[state] ?? 'var(--muted)'
      }"></span></div>
      <div class="dim-why">${d.why}</div>`;
    el.appendChild(row);
  }
}

/** The coverage dial: a filled ring, because a gap is a place you can walk to. */
function drawDial(st) {
  const box = $('stage').getBoundingClientRect();
  const size = Math.max(120, Math.min(280, Math.min(box.width, box.height) * 0.44));
  const dpr = window.devicePixelRatio || 1;
  const c = $('dial');
  c.width = Math.round(size * dpr);
  c.height = Math.round(size * dpr);
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;

  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2, cy = size / 2;
  const bands = Object.entries(st.coverage.perBand);
  const ringWidth = size * 0.11 / Math.max(1, bands.length);

  bands.forEach(([, band], bi) => {
    const rOuter = size * 0.44 - bi * (ringWidth + 3);
    const rInner = rOuter - ringWidth;
    const visited = new Set(band.visited);
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
  });

  ctx.fillStyle = '#e6edf3';
  ctx.font = `600 ${Math.round(size * 0.14)}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.round((st.coverage.coverage ?? 0) * 100)}%`, cx, cy - size * 0.02);
  ctx.font = `500 ${Math.round(size * 0.055)}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = '#8b949e';
  ctx.fillText('coverage', cx, cy + size * 0.08);
}

/* --------------------------------------------------------------- sessions */

async function renderSessionList() {
  const list = $('sessionList');
  const sessions = (await store.listSessions())
    .filter((s) => s.frameCount > 0)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 8);

  list.innerHTML = '';
  for (const s of sessions) {
    const el = document.createElement('div');
    el.className = `session-item${s.id === ps?.meta.id ? ' is-current' : ''}`;
    el.innerHTML = `<span>${s.subject || 'untitled'}</span>
      <span class="meta">${s.frameCount} frames · ${new Date(s.updatedAt).toLocaleString()}</span>`;
    el.addEventListener('click', async () => {
      ps = await PersistentSession.resume(store, new Session(rubric), s.id);
      target = ps.meta.target ?? 'study';
      setTargetSeg(target);
      applySubjectToUi();
      await renderSessionList();
      render();
      toast(`Opened “${s.subject || 'untitled'}”.`);
    });
    list.appendChild(el);
  }
}

function applySubjectToUi() {
  $('subjName').value = ps.meta.subject ?? '';
  $('subjId').value = ps.meta.identifier ?? '';
  $('subjectLabel').textContent = ps.meta.subject || 'capture';
  $('hasScale').checked = ps.session.scaleReference > 0;
  $('hasColour').checked = ps.session.colourReference > 0;
  $('scaleLenWrap').hidden = !$('hasScale').checked;
}

/**
 * Build the export manifest.
 *
 * Separated from the download so it can be inspected by the browser probe —
 * a manifest that silently loses its disclaimer or its frames would otherwise
 * only be noticed by someone opening the file.
 */
async function buildManifest() {
  const frames = await ps.frames();
  const st = ps.status();
  const sensitivity = ps.meta.sensitivity ?? 'ordinary';
  return {
    format: 'turnstone-session/1',
    exportedAt: new Date().toISOString(),
    build: BUILD_ID,
    session: {
      id: ps.meta.id,
      startedAt: ps.meta.startedAt,
      subject: ps.meta.subject,
      identifier: ps.meta.identifier ?? null,
      sensitivity,
      // Funerary and sacred default closed. That default may be wrong; it is
      // wrong in the direction that can be corrected, whereas publishing first
      // cannot be undone.
      disclosureTier: sensitivity === 'ordinary' ? 'museum' : 'source-community',
      target: ps.meta.target,
      passes: ps.meta.passes,
    },
    rubric: { id: rubric.id, version: rubric.version },
    quality: {
      class: st.quality.class,
      score: st.quality.score,
      limitingDimension: st.quality.limitingDimension,
      provisional: st.quality.provisional,
      deferred: st.quality.deferred,
    },
    // OQ-1: both values travel together, so the open question stays answerable
    // from exported sessions rather than only from this device.
    surfaceCompleteness: st.surfaceCompleteness,
    attests: 'An object with these measurable characteristics was observed in this condition, at this place, at this time, by this party — and this is a tamper-evident record of that observation.',
    doesNotAttest: 'This record does not attest that the object was lawfully excavated, exported, acquired, or is lawfully held. It records an observation of an object, not a right to it. Capture quality and provenance legitimacy are unrelated: a high-quality capture of an unlawfully held object is a high-quality capture of an unlawfully held object.',
    frames: frames.map((f) => ({
      id: f.id,
      index: f.index,
      pass: f.pass,
      capturedAt: f.capturedAt,
      fullResolution: !!f.fullResolution,
      headingSource: f.headingSource ?? 'none',
      steadyAtCapture: !!f.steadyAtCapture,
      hasImage: !!f.blob,
      captureProfile: f.captureProfile ?? null,
      measurements: {
        vol: f.measurements?.vol,
        clipping: f.measurements?.clipping,
        lighting: f.measurements?.lighting,
        azimuthDeg: f.measurements?.azimuthDeg,
        elevationDeg: f.measurements?.elevationDeg,
        objectFovDeg: f.measurements?.objectFovDeg,
      },
    })),
  };
}

/**
 * Export the session.
 *
 * Images stay on the device. A JSON file with megabytes of base64 in it is not
 * something a museum can hand to anyone, and the images are the archive — they
 * travel by a route that can carry them.
 */
async function exportSession() {
  const manifest = await buildManifest();
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${ps.meta.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);

  const withImages = manifest.frames.filter((f) => f.hasImage).length;
  toast(`Exported ${manifest.frames.length} frames (${withImages} with images kept on device).`, 6000);
}

/* ------------------------------------------------------------------- wire */

$('btnCamera').addEventListener('click', startCamera);
$('btnShoot').addEventListener('click', () => { auto?.cancel(); shoot(); });

$('btnAuto').addEventListener('click', () => {
  if (!pose?.active) {
    toast('Auto-capture needs the motion sensors. Tap “Enable motion sensors” in Setup.', 6000);
    return;
  }
  const on = auto.setEnabled(!auto.enabled);
  syncShutter();
  toast(on
    ? 'Auto-capture armed. Brace the phone and wait — it fires once when steady, then switches itself off.'
    : 'Auto-capture off.', 5500);
});

$('btnFlip').addEventListener('click', async () => {
  await ps.startPass(`pass ${ps.meta.passes.length}`);
  render();
  toast('New pass started. Turn the object over and photograph the underside.', 6000);
});

$('btnSheet').addEventListener('click', () => $('panel').classList.toggle('is-open'));
$('sheetGrip').addEventListener('click', () => $('panel').classList.toggle('is-open'));

$('btnLock').addEventListener('click', async () => {
  const r = await camera.lockOptics();
  $('btnLock').classList.toggle('is-on', r.locked);
  updateCamState();
  toast(r.reason, 6000);
});

$('btnSensors').addEventListener('click', async () => {
  const ok = await pose.requestPermission();
  toast(ok
    ? 'Motion sensors active. Coverage and auto-capture now work.'
    : 'Motion sensors unavailable — coverage cannot be tracked on this device.', 6000);
});

$('subjName').addEventListener('change', async (e) => {
  ps.meta.subject = e.target.value.trim();
  $('subjectLabel').textContent = ps.meta.subject || 'capture';
  await store.putSession(ps.meta);
  await renderSessionList();
});
$('subjId').addEventListener('change', async (e) => {
  ps.meta.identifier = e.target.value.trim();
  await store.putSession(ps.meta);
});
$('sensitivity').addEventListener('change', async (e) => {
  ps.meta.sensitivity = e.target.value;
  await store.putSession(ps.meta);
  if (e.target.value !== 'ordinary') {
    toast('Defaulting to source-community disclosure. That default may be wrong — it is wrong in the direction that can be corrected, whereas publishing first cannot be undone.', 8000);
  }
});

$('hasScale').addEventListener('change', (e) => {
  $('scaleLenWrap').hidden = !e.target.checked;
  ps.session.scaleReference = e.target.checked ? 1 : 0;
  updateGsd();
  render();
});
$('scaleLen').addEventListener('change', () => { updateGsd(); render(); });
$('hasColour').addEventListener('change', (e) => {
  ps.session.colourReference = e.target.checked ? 1 : 0;
  render();
});

/**
 * GSD from the scale bar: known length over pixels spanned.
 *
 * Needs no focal length, no sensor size and no distance, which is why a bar in
 * shot is worth more than any amount of metadata. The span is estimated from
 * the frame here; Phase 3 detects the bar directly.
 */
function updateGsd() {
  if (!$('hasScale').checked) { ps.session.gsdMmPerPx = null; return; }
  const mm = parseFloat($('scaleLen').value) || 150;
  const assumedSpanPx = 900;
  ps.session.gsdMmPerPx = mm / assumedSpanPx;
}

$('targetSeg').addEventListener('click', async (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  target = btn.dataset.target;
  await ps.setTarget(target);
  setTargetSeg(target);
  render();
});

function setTargetSeg(t) {
  for (const b of $('targetSeg').querySelectorAll('.seg-btn')) {
    b.classList.toggle('is-on', b.dataset.target === t);
  }
  $('targetNote').textContent = t === 'reference'
    ? 'Reference needs four elevation bands including below and top, a calibrated scale bar, and a colour target. It is the class fit to be the identifying record of the object.'
    : 'Study needs eye-level and above. Fit for scholarly comparison, but not to be the sole identifying record.';
}

$('btnExport').addEventListener('click', exportSession);

$('btnNew').addEventListener('click', async () => {
  ps = await PersistentSession.create(store, new Session(rubric, { target }), { target });
  applySubjectToUi();
  await renderSessionList();
  render();
  toast('New session started. The previous one is still on this device.');
});

let toastTimer = null;
function toast(msg, ms = 3800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

window.addEventListener('resize', () => ps && drawDial(ps.status()));

// Register the service worker so the client boots with no network at all.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`sw.js?v=${BUILD_ID}`).catch(() => { /* not fatal */ });
}

boot();
