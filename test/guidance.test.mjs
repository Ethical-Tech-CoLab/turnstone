/**
 * Tests for the guidance loop and session model.
 *
 * Covers conformance C-10 (one instruction, stable under jitter) and the OQ-1
 * requirement that both surface-completeness values are retained.
 *
 * Run: node --test test/guidance.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { loadRubric } from '../lib/rubric.js';
import { advise } from '../lib/guidance.js';
import { Session } from '../lib/session.js';
import { orbit, frameAt } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const rubric = loadRubric(JSON.parse(readFileSync(join(HERE, '..', 'rubric', 'heritage-v1.json'), 'utf8')));

const GOOD = {
  'angular-coverage': 0.97,
  'surface-completeness': 0.98,
  'image-overlap': 0.78,
  sharpness: 320,
  exposure: 0.002,
  'ground-sample-distance': 0.20,
  'scale-reference': 1,
  'colour-reference': 1,
  'lighting-consistency': 0.93,
  'device-metadata': 0.99,
};

// ------------------------------------------------------------------ C-10

test('C-10 · guidance returns exactly one instruction', () => {
  const g = advise(rubric, { ...GOOD, sharpness: 25 });
  assert.equal(typeof g.primaryAction, 'string');
  assert.equal(g.primaryDimension, 'sharpness');
  // Not a list. One thing to do.
  assert.ok(!Array.isArray(g.primaryAction));
});

test('C-10b · guidance is stable under jitter around a threshold', () => {
  /*
   * Two dimensions hovering either side of the same threshold would otherwise
   * swap the headline instruction several times a second. That reads as
   * malfunction and cannot be obeyed — the same failure Plumb hit with a
   * flickering pose readout.
   */
  let previous = null;
  const seen = [];
  for (let i = 0; i < 60; i++) {
    const jitter = (i % 2 ? 1 : -1) * 0.002;
    const g = advise(rubric, {
      ...GOOD,
      'image-overlap': 0.55 + jitter,
      'lighting-consistency': 0.60 + jitter * -1,
    }, { previousDimension: previous });
    previous = g.primaryDimension;
    seen.push(previous);
  }
  const switches = seen.filter((v, i) => i > 0 && v !== seen[i - 1]).length;
  assert.ok(switches <= 1, `instruction switched ${switches} times under jitter`);
});

test('C-10c · guidance still moves when the situation genuinely changes', () => {
  // Hysteresis must damp noise without freezing. A stuck instruction is worse
  // than a flickering one: it is confidently wrong.
  const first = advise(rubric, { ...GOOD, sharpness: 25 });
  assert.equal(first.primaryDimension, 'sharpness');

  const second = advise(rubric, { ...GOOD, sharpness: 320, 'colour-reference': 0 },
    { previousDimension: 'sharpness', target: 'reference' });
  assert.equal(second.primaryDimension, 'colour-reference');
});

test('a blocking dimension outranks a merely below-target one', () => {
  // However good the rest is, a blocking dimension makes the session unusable.
  const g = advise(rubric, { ...GOOD, sharpness: 15, 'image-overlap': 0.55 });
  assert.equal(g.primaryDimension, 'sharpness');
  assert.equal(g.signals.find((s) => s.id === 'sharpness').state, 'blocking');
});

test('an unmeasured dimension is actionable, not silently satisfied', () => {
  const { 'scale-reference': _omit, ...partial } = GOOD;
  const g = advise(rubric, partial);
  const sig = g.signals.find((s) => s.id === 'scale-reference');
  assert.equal(sig.state, 'unknown');
  assert.equal(sig.measured, 'not measured');
  assert.equal(g.primaryDimension, 'scale-reference');
});

test('deferred dimensions are declared, never counted as passing', () => {
  const g = advise(rubric, GOOD);
  assert.deepEqual(g.deferred, ['device-metadata']);
  // No live signal for a deferred dimension: it cannot drive guidance.
  assert.equal(g.signals.find((s) => s.id === 'device-metadata'), undefined);
  assert.match(g.summary, /after processing/);
});

test('when everything meets target, there is nothing to say', () => {
  const g = advise(rubric, GOOD, { target: 'study' });
  assert.equal(g.primaryAction, null);
  assert.equal(g.meetsTarget, true);
});

test('guidance never claims target is met while a dimension is unmeasured', () => {
  const { sharpness: _s, ...partial } = GOOD;
  assert.equal(advise(rubric, partial).meetsTarget, false);
});

// --------------------------------------------------------------- session

test('a session tracks frames and finds the sector still missing', () => {
  const s = new Session(rubric, { target: 'study' });
  // Three-quarters of an orbit: bins 18-23 unvisited.
  for (const f of orbit(24, 0).slice(0, 18)) s.addFrame(f);

  const st = s.status();
  assert.equal(st.frames, 18);
  assert.ok(st.coverage.perBand.eye.fraction < 1);
  assert.equal(st.gap.length, 6);
  assert.equal(st.gap.start, 18);
});

test('a single soft frame is marked suspect and does not fill its bin', () => {
  const s = new Session(rubric);
  for (const f of orbit(24, 0)) s.addFrame(f);
  s.addFrame(frameAt(180, 0, { vol: 12 }));       // one badly blurred frame

  const st = s.status();
  assert.equal(st.suspect, 1);
  assert.equal(s.frames.at(-1).suspect, true);
});

test('a wholly soft session is not reported as entirely suspect', () => {
  /*
   * If every frame is soft, the session is soft — the median is not "wrong".
   * Marking all of them suspect would leave nothing to score and would report
   * an empty session rather than a poor one.
   */
  const s = new Session(rubric);
  for (const f of orbit(12, 0, { vol: 8 })) s.addFrame(f);
  assert.equal(s.usableFrames.length, 12);
  assert.ok(s.status().quality.class === 'insufficient');
});

test('suspect status does not depend on the order frames arrived in', () => {
  // The median moves as frames arrive, so a frame judged early against a poor
  // reference point must be able to recover.
  const build = (order) => {
    const s = new Session(rubric);
    for (const f of order) s.addFrame(f);
    return s.frames.filter((x) => x.suspect).length;
  };
  const frames = [...orbit(10, 0), frameAt(200, 0, { vol: 10 })];
  const reversed = [...frames].reverse();
  assert.equal(build(frames), build(reversed));
});

test('overlap is computed from pose, with no distance term', () => {
  const s = new Session(rubric);
  for (const f of orbit(36, 0)) s.addFrame(f);     // 10 degree steps
  const ov = s.meanOverlap();
  // 10 degrees at 45 degree object FOV gives ~79%.
  assert.ok(Math.abs(ov - 0.79) < 0.02, `got ${ov}`);
});

test('overlap wraps the short way round the circle', () => {
  // 350 -> 0 is a 10 degree step, not 350.
  const s = new Session(rubric);
  s.addFrame(frameAt(350, 0));
  s.addFrame(frameAt(0, 0));
  assert.ok(s.meanOverlap() > 0.75);
});

test('a session with one frame reports no overlap rather than guessing', () => {
  const s = new Session(rubric);
  s.addFrame(frameAt(0, 0));
  assert.equal(s.meanOverlap(), null);
  assert.ok(!('image-overlap' in s.measurements()));
});

// ------------------------------------------------------------------ OQ-1

test('OQ-1 · both surface-completeness values are kept, never collapsed', () => {
  /*
   * Deferring a question is only honest if the question stays answerable. The
   * capture-time estimate must survive the arrival of the post-reconstruction
   * truth, and their difference must be recorded, so the eventual decision
   * rests on a distribution rather than on one memorable incident.
   */
  const s = new Session(rubric);
  for (const f of orbit(24, 0)) s.addFrame(f);
  s.status();

  const estimate = s.surfaceCompleteness.captureEstimate;
  assert.ok(estimate != null, 'capture-time estimate should be recorded');

  const rec = s.recordPostReconstructionCompleteness(0.62);
  assert.equal(rec.captureEstimate, estimate, 'estimate must not be overwritten');
  assert.equal(rec.postReconstruction, 0.62);
  assert.ok(Math.abs(rec.difference - (0.62 - estimate)) < 1e-9);
});

test('OQ-1 · the estimate is labelled as an estimate wherever it surfaces', () => {
  const s = new Session(rubric);
  for (const f of orbit(24, 0)) s.addFrame(f);
  assert.ok('captureEstimate' in s.status().surfaceCompleteness);
});

// ------------------------------------------------------------------ passes

test('a flip starts a new pass, and frames record which pass they belong to', () => {
  // The underside needs the object turned over. That is a distinct workflow,
  // not an afterthought.
  const s = new Session(rubric);
  for (const f of orbit(12, 0)) s.addFrame(f);
  s.startPass('inverted');
  for (const f of orbit(12, 0)) s.addFrame(f);

  assert.equal(s.passes.length, 2);
  assert.equal(s.frames[0].pass, 0);
  assert.equal(s.frames.at(-1).pass, 1);
});

test('status is safe on an empty session', () => {
  // The very first render happens before any frame exists.
  const st = new Session(rubric).status();
  assert.equal(st.frames, 0);
  assert.equal(st.quality.class, 'insufficient');
  assert.ok(st.guidance.primaryAction);
});

// ------------------------------------------------- deferred vs provisional

test('a deferred dimension never caps the live class', () => {
  /*
   * Found by the browser probe. Device metadata is deferred — it cannot be
   * known during a session — yet it was being scored live, so a session with
   * flawless pixels reported `insufficient` for a reason the contributor could
   * neither observe nor act on. That is precisely the post-mortem failure the
   * guidance design exists to avoid.
   */
  const s = new Session(rubric);
  for (const f of [...orbit(24, 0), ...orbit(24, 35)]) {
    s.addFrame({ ...f, focalLengthMm: null, sensorWidthMm: null });   // stripped
  }
  s.scaleReference = 1;
  s.colourReference = 1;
  s.gsdMmPerPx = 0.16;

  const st = s.status();
  assert.notEqual(st.quality.class, 'insufficient');
  assert.notEqual(st.quality.limitingDimension, 'device-metadata');
  // But it is not silently forgiven either.
  assert.ok(st.quality.deferred.includes('device-metadata'));
  assert.equal(st.quality.provisional, true);
});

test('a provisional class is flagged so it cannot pass as final', () => {
  const s = new Session(rubric);
  for (const f of orbit(24, 0)) s.addFrame(f);
  assert.equal(s.status().quality.provisional, true);
});

test('the deferred dimension does count once reconstruction supplies it', () => {
  // Deferring is not excusing. It still gates the final record.
  const s = new Session(rubric);
  for (const f of [...orbit(24, 0), ...orbit(24, 35)]) {
    s.addFrame({ ...f, focalLengthMm: null, sensorWidthMm: null });
  }
  s.scaleReference = 1;
  s.colourReference = 1;
  s.gsdMmPerPx = 0.16;

  const live = s.status().quality;
  const final = s.finalQuality();
  assert.ok(live.class !== 'insufficient');
  assert.equal(final.class, 'insufficient', 'stripped metadata must gate the final record');
  assert.equal(final.limitingDimension, 'device-metadata');
  assert.equal(final.provisional, false);
});

test('guidance never advises on a deferred dimension', () => {
  const s = new Session(rubric);
  for (const f of orbit(24, 0)) s.addFrame({ ...f, focalLengthMm: null });
  const g = s.status().guidance;
  assert.notEqual(g.primaryDimension, 'device-metadata');
});
