/**
 * Tests for the capture layer — camera, store, steadiness, auto-capture.
 *
 * Run: node --test test/capture.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { Camera, detectPlatform } from '../lib/camera.js';
import { openStore, PersistentSession, newSessionId } from '../lib/store.js';
import { Smoothed, Steadiness, AutoCapture, PoseTracker } from '../lib/steady.js';
import { loadRubric } from '../lib/rubric.js';
import { Session } from '../lib/session.js';
import { orbit, frameAt } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const rubric = loadRubric(JSON.parse(readFileSync(join(HERE, '..', 'rubric', 'heritage-v1.json'), 'utf8')));

/* ------------------------------------------------------------------ camera */

/** ImageCapture stand-in with scriptable failure modes. */
function fakeImageCapture({ failConstrained = false, emptyConstrained = false, delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async takePhoto(settings) {
      calls.push(settings);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const constrained = settings && ('imageWidth' in settings || 'imageHeight' in settings);
      if (constrained && failConstrained) throw new Error('NotSupportedError');
      if (constrained && emptyConstrained) return { size: 0 };
      return { size: 2_000_000 };
    },
    async getPhotoCapabilities() { return {}; },
  };
}

function cameraWith(ic, photoCaps = { imageWidth: { max: 4080 }, imageHeight: { max: 3072 }, fillLightMode: ['off', 'auto'] }) {
  const c = new Camera();
  c.imageCapture = ic;
  c.photoCapabilities = photoCaps;
  return c;
}

test('takePhoto asks for full resolution first', async () => {
  const ic = fakeImageCapture();
  const blob = await cameraWith(ic).takePhoto();
  assert.equal(blob.size, 2_000_000);
  assert.equal(ic.calls[0].imageWidth, 4080);
  assert.equal(ic.calls[0].fillLightMode, 'off');
});

test('a device that rejects the constrained call still gets a photo', async () => {
  // Several Android devices reject explicit sizing outright.
  const ic = fakeImageCapture({ failConstrained: true });
  const blob = await cameraWith(ic).takePhoto();
  assert.equal(blob.size, 2_000_000);
  assert.ok(ic.calls.length > 1, 'should have fallen back');
});

test('an empty blob is rejected rather than reaching a canvas', async () => {
  /*
   * This is the blank-screen bug. A device that returns a zero-byte blob for
   * the constrained call produced a 0x0 canvas with the live preview hidden
   * behind it, and no error surfaced anywhere.
   */
  const ic = fakeImageCapture({ emptyConstrained: true });
  const blob = await cameraWith(ic).takePhoto();
  assert.ok(blob.size > 1024, 'must not return the empty blob');
});

test('every attempt failing throws rather than returning nothing', async () => {
  const ic = { async takePhoto() { throw new Error('hardware busy'); } };
  await assert.rejects(() => cameraWith(ic).takePhoto(), /hardware busy/);
});

test('a re-entrant capture is refused', async () => {
  // A second takePhoto() while one is in flight throws InvalidStateError on
  // Android, and auto-capture makes that easy to hit.
  const cam = cameraWith(fakeImageCapture({ delayMs: 40 }));
  const first = cam.takePhoto();
  await assert.rejects(() => cam.takePhoto(), /already in progress/);
  await first;
  // And the guard clears, so the next shot works.
  assert.equal(cam.isCapturing, false);
  await cam.takePhoto();
});

test('the capture guard clears even when the shot fails', async () => {
  const cam = cameraWith({ async takePhoto() { throw new Error('boom'); } });
  await assert.rejects(() => cam.takePhoto());
  assert.equal(cam.isCapturing, false, 'a failed shot must not wedge the camera');
});

test('no ImageCapture is an explicit error, not a silent no-op', async () => {
  const c = new Camera();
  await assert.rejects(() => c.takePhoto(), /not available/);
});

test('the capture profile says whether the lens profile can be trusted', () => {
  const c = new Camera();
  c.settings = { width: 4080, height: 3072, zoom: 1 };
  assert.equal(c.captureProfile().lens_profile_valid, false);
  c.opticsLocked = true;
  assert.equal(c.captureProfile().lens_profile_valid, true);
});

test('platform detection does not throw outside a browser', () => {
  const p = detectPlatform();
  assert.ok(p.id);
  assert.ok(p.tier);
});

/* ------------------------------------------------------------------- store */

test('the store falls back to memory rather than throwing', async () => {
  // Node has no IndexedDB. A contributor in private browsing hits the same path.
  const store = await openStore();
  assert.ok(store);
  assert.equal(store.persistent, false);
});

test('a session round-trips through the store', async () => {
  const store = await openStore();
  const ps = await PersistentSession.create(store, new Session(rubric), { subject: 'Bura askos' });
  for (const f of orbit(6, 0)) await ps.addFrame(f);

  const meta = await store.getSession(ps.meta.id);
  assert.equal(meta.frameCount, 6);
  assert.equal(meta.subject, 'Bura askos');
  assert.equal((await store.framesFor(ps.meta.id)).length, 6);
});

test('a resumed session is rescored by current code, not replayed from a stored score', async () => {
  /*
   * The score is derived. A rubric threshold or an extractor may have improved
   * since the session was captured, so replaying the MEASUREMENTS and
   * recomputing means a reopened session is judged by today's code. Storing a
   * score and trusting it would freeze a session at whatever ran that week.
   */
  const store = await openStore();
  const ps = await PersistentSession.create(store, new Session(rubric));
  for (const f of orbit(12, 0)) await ps.addFrame(f);
  const before = ps.status();

  const resumed = await PersistentSession.resume(store, new Session(rubric), ps.meta.id);
  assert.ok(resumed);
  assert.equal(resumed.session.frames.length, 12);
  assert.equal(resumed.status().quality.class, before.quality.class);
  assert.equal(resumed.status().coverage.coverage, before.coverage.coverage);
});

test('resuming an unknown session returns null rather than an empty one', async () => {
  const store = await openStore();
  assert.equal(await PersistentSession.resume(store, new Session(rubric), 'nope'), null);
});

test('frames are written as they are captured, not saved at the end', async () => {
  /*
   * "Save at the end" makes the failure mode losing everything rather than
   * losing the last frame, and this runs on a phone that may be killed at any
   * moment.
   */
  const store = await openStore();
  const ps = await PersistentSession.create(store, new Session(rubric));
  await ps.addFrame(frameAt(0, 0));
  assert.equal(await store.countFrames(ps.meta.id), 1, 'first frame must already be durable');
  await ps.addFrame(frameAt(15, 0));
  assert.equal(await store.countFrames(ps.meta.id), 2);
});

test('measurements survive even when storing the image fails', async () => {
  // Out of quota is the common cause. The measurement is the part that cannot
  // be recreated from the object afterwards.
  const store = await openStore();
  let calls = 0;
  const original = store.putFrame.bind(store);
  store.putFrame = async (f) => {
    calls++;
    if (f.blob) throw new Error('QuotaExceededError');
    return original(f);
  };

  const ps = await PersistentSession.create(store, new Session(rubric));
  await ps.addFrame(frameAt(0, 0), { size: 5_000_000 });

  store.putFrame = original;
  const frames = await store.framesFor(ps.meta.id);
  assert.equal(frames.length, 1);
  assert.ok(frames[0].measurements, 'the measurement must survive');
  assert.ok(calls >= 2, 'it should have attempted the blob write');
});

test('deleting a session takes its frames with it', async () => {
  const store = await openStore();
  const ps = await PersistentSession.create(store, new Session(rubric));
  for (const f of orbit(4, 0)) await ps.addFrame(f);
  await store.deleteSession(ps.meta.id);
  assert.equal(await store.getSession(ps.meta.id), null);
  assert.equal((await store.framesFor(ps.meta.id)).length, 0);
});

test('a flip is recorded in the stored session, not just in memory', async () => {
  const store = await openStore();
  const ps = await PersistentSession.create(store, new Session(rubric));
  for (const f of orbit(6, 0)) await ps.addFrame(f);
  await ps.startPass('inverted');
  for (const f of orbit(6, 0)) await ps.addFrame(f);

  const meta = await store.getSession(ps.meta.id);
  assert.equal(meta.passes.length, 2);
  assert.equal(meta.passes[1].label, 'inverted');
  const frames = await store.framesFor(ps.meta.id);
  assert.equal(frames.at(-1).pass, 1);
});

test('session ids do not collide', () => {
  const ids = new Set(Array.from({ length: 500 }, newSessionId));
  assert.equal(ids.size, 500);
});

/* -------------------------------------------------------------- steadiness */

test('smoothing ignores jitter below the deadband', () => {
  const s = new Smoothed({ alpha: 0.5, deadband: 0.4 });
  s.push(10);
  s.push(10.2);        // noise
  assert.equal(s.value, 10, 'small jitter must not move the value');
  s.push(14);          // real movement
  assert.ok(s.value > 10);
});

test('smoothing lags real movement rather than snapping to it', () => {
  const s = new Smoothed({ alpha: 0.25, deadband: 0.4 });
  s.push(0);
  s.push(20);
  assert.ok(s.value > 0 && s.value < 20, `expected a lagged value, got ${s.value}`);
});

test('steadiness needs enough samples before claiming anything', () => {
  const st = new Steadiness();
  st.push(0, 0).push(0, 0);
  assert.equal(st.movement(), Infinity);
  assert.equal(st.isSteady(), false, 'must not claim steady before it knows');
});

test('a held phone reads steady, a moving one does not', () => {
  const held = new Steadiness();
  for (let i = 0; i < 12; i++) held.push(10 + (i % 2) * 0.2, 3);
  assert.equal(held.isSteady(), true);

  const moving = new Steadiness();
  for (let i = 0; i < 12; i++) moving.push(10 + i * 2, 3);
  assert.equal(moving.isSteady(), false);
});

test('a single jolt breaks steadiness even in a calm window', () => {
  // Peak-to-peak, not variance: one sharp jolt is exactly what ruins a frame,
  // and variance would average it away.
  const st = new Steadiness();
  for (let i = 0; i < 11; i++) st.push(10, 3);
  st.push(18, 3);
  assert.equal(st.isSteady(), false);
});

/* ------------------------------------------------------------ auto-capture */

test('auto-capture fires once and then disarms', async () => {
  /*
   * A continuous version fires repeatedly while the phone happens to be steady,
   * filling a session with near-identical frames from one position — which
   * looks like progress on a frame counter while adding no coverage at all.
   */
  let fired = 0;
  const ac = new AutoCapture({ onFire: () => { fired++; }, delayMs: 20 });
  ac.setEnabled(true);
  ac.update(true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired, 1);
  assert.equal(ac.enabled, false, 'must disarm itself after firing');

  ac.update(true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fired, 1, 'must not fire again while disabled');
});

test('movement cancels a pending shot', async () => {
  // Firing anyway would capture exactly the blur the countdown existed to avoid.
  let fired = 0;
  const ac = new AutoCapture({ onFire: () => { fired++; }, delayMs: 40 });
  ac.setEnabled(true);
  ac.update(true);
  assert.equal(ac.state().armed, true);
  ac.update(false);
  assert.equal(ac.state().armed, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, 0);
});

test('auto-capture does nothing while disabled', async () => {
  let fired = 0;
  const ac = new AutoCapture({ onFire: () => { fired++; }, delayMs: 10 });
  ac.update(true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired, 0);
});

test('a slow capture cannot overlap the next arm cycle', async () => {
  // Overlapping shots are the re-entrancy that throws InvalidStateError.
  let inFlight = 0;
  let overlapped = false;
  const ac = new AutoCapture({
    delayMs: 10,
    onFire: async () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
    },
  });
  ac.setEnabled(true);
  ac.update(true);
  for (let i = 0; i < 10; i++) { ac.update(true); await new Promise((r) => setTimeout(r, 8)); }
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(overlapped, false);
});

test('the countdown reports time remaining, so it can be shown', async () => {
  const ac = new AutoCapture({ onFire: () => {}, delayMs: 200 });
  ac.setEnabled(true);
  ac.update(true);
  const left = ac.state().remainingMs;
  assert.ok(left > 0 && left <= 200, `got ${left}`);
  ac.cancel();
  assert.equal(ac.state().remainingMs, 0);
});

/* -------------------------------------------------------------------- pose */

test('pose tracking reports honestly when nothing is available', () => {
  const p = new PoseTracker();
  const pose = p.pose();
  assert.equal(pose.available, false);
  assert.equal(pose.headingSource, 'none');
  // Crucially it does not claim steady before it has any samples.
  assert.equal(pose.steady, false);
});

test('heading source distinguishes a compass from a relative reading', () => {
  const p = new PoseTracker();
  p.heading = 90;
  p.headingSource = 'relative';
  assert.equal(p.pose().headingSource, 'relative');
  // A consumer must be able to tell a measured orbit from an unreferenced one.
});
