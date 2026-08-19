/**
 * session.js — one object, one contributor, one sitting.
 *
 * Holds the frames, keeps the running measurements the guidance loop reads, and
 * owns the two things that cannot be decided per frame:
 *
 *   - the session median sharpness, which the relative rule needs (R-6.1);
 *   - the lighting signatures, whose spread is the metric (§6.7).
 *
 * ---------------------------------------------------------------------------
 * OQ-1 IS ENFORCED HERE.
 *
 * The specification defers whether surface completeness is live-measurable
 * (DPA's position) or only live-estimable (ours), to be settled against a real
 * artefact with a cavity. Deferring a question is only honest if the question
 * stays answerable, so this class records BOTH the capture-time estimate and the
 * post-reconstruction truth, never overwriting one with the other, and records
 * their difference. Evidence then accumulates on its own and the eventual
 * decision rests on a distribution rather than on whichever incident happened to
 * be memorable.
 * ---------------------------------------------------------------------------
 */

import {
  judgeSharpness, median, angularCoverage, surfaceCompletenessEstimate,
  lightingConsistency, deviceMetadataCompleteness, largestGap,
} from './metrics.js';
import { overlapForStep } from './overlap.js';
import { assess } from './rubric.js';
import { advise } from './guidance.js';

export class Session {
  constructor(rubric, { target = 'study', subject = null } = {}) {
    this.rubric = rubric;
    this.target = target;
    this.subject = subject;
    this.startedAt = new Date().toISOString();
    this.frames = [];
    this.passes = [{ id: 0, label: 'upright', startedAt: this.startedAt }];
    this.previousDimension = null;

    // OQ-1: both values, kept side by side. Never collapse these.
    this.surfaceCompleteness = {
      captureEstimate: null,
      postReconstruction: null,
      difference: null,
    };

    // Scale and colour are session-level facts, not per-frame ones.
    this.scaleReference = 0;      // 1 calibrated · 0.5 AR-derived · 0 absent
    this.colourReference = 0;
    this.gsdMmPerPx = null;
  }

  /** Start a new pass — a flip, or a change of object orientation. */
  startPass(label) {
    this.passes.push({ id: this.passes.length, label, startedAt: new Date().toISOString() });
    return this.passes.at(-1);
  }

  /**
   * Add a frame. `frame` carries the per-frame measurements already extracted:
   *   { vol, clipping, lighting, azimuthDeg, elevationDeg, observedSectors, ... }
   *
   * Sharpness is judged against the session median, which is why suspect status
   * is assigned here rather than at extraction time — a frame cannot know
   * whether it is out of step with a session it has not joined yet.
   */
  addFrame(frame) {
    const f = { ...frame, pass: this.passes.at(-1).id, index: this.frames.length };
    this.frames.push(f);
    this._rejudgeSharpness();
    return f;
  }

  /**
   * Re-judge every frame against the current median.
   *
   * The median moves as frames arrive, so a frame marked suspect early — when
   * two frames made a poor reference point — must be able to recover. The
   * median is computed over NON-SUSPECT frames only, so a run of blurred frames
   * cannot drag the reference point down until they look normal; it is iterated
   * to a fixed point so the result does not depend on arrival order.
   */
  _rejudgeSharpness() {
    if (!this.frames.length) return;
    for (const f of this.frames) f.suspect = false;

    for (let pass = 0; pass < 4; pass++) {
      const pool = this.frames.filter((f) => !f.suspect).map((f) => f.vol);
      const m = median(pool.length ? pool : this.frames.map((f) => f.vol));
      let changed = false;
      for (const f of this.frames) {
        const j = judgeSharpness(f.vol, m);
        if (j.suspect !== f.suspect) changed = true;
        f.suspect = j.suspect;
        f.sharpnessRelative = j.relative;
      }
      this.sessionMedianVol = m;
      // Everything suspect means the whole session is soft, not that the median
      // is wrong. Back off rather than reporting an empty session.
      if (this.frames.every((f) => f.suspect)) {
        for (const f of this.frames) f.suspect = false;
        this.sessionMedianVol = median(this.frames.map((f) => f.vol));
        break;
      }
      if (!changed) break;
    }
  }

  /** Frames that count toward coverage and quality. */
  get usableFrames() {
    return this.frames.filter((f) => !f.suspect);
  }

  /**
   * Mean overlap between consecutive frames, from pose.
   *
   * Distance cancels in the geometry, so this needs only the angular step and
   * how much of the frame the object fills — no depth sensor.
   */
  meanOverlap() {
    const f = this.usableFrames.filter((x) => x.azimuthDeg != null && x.objectFovDeg > 0);
    if (f.length < 2) return null;
    const vals = [];
    for (let i = 1; i < f.length; i++) {
      let step = Math.abs(f[i].azimuthDeg - f[i - 1].azimuthDeg);
      if (step > 180) step = 360 - step;                     // wrap the short way
      if (step === 0) continue;
      vals.push(overlapForStep(step, (f[i].objectFovDeg + f[i - 1].objectFovDeg) / 2));
    }
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  /** Current raw measurements, in the shape the rubric expects. */
  measurements() {
    const usable = this.usableFrames;
    const cov = angularCoverage(this.frames, this.target);
    const sc = surfaceCompletenessEstimate(this.frames);
    this.surfaceCompleteness.captureEstimate = sc.estimate;

    const light = lightingConsistency(usable.map((f) => f.lighting).filter(Boolean));
    const m = {
      'angular-coverage': cov.coverage,
      'surface-completeness': sc.estimate,
      'scale-reference': this.scaleReference,
      'colour-reference': this.colourReference,
      'device-metadata': deviceMetadataCompleteness(this.frames),
    };

    if (usable.length) {
      m.sharpness = median(usable.map((f) => f.vol));
      m.exposure = median(usable.map((f) => f.clipping?.worst ?? 0));
    }
    const ov = this.meanOverlap();
    if (ov != null) m['image-overlap'] = ov;
    if (light.consistency != null) m['lighting-consistency'] = light.consistency;
    if (this.gsdMmPerPx != null) m['ground-sample-distance'] = this.gsdMmPerPx;

    return m;
  }

  /** Score, plus the single instruction to act on next. */
  status() {
    const measurements = this.measurements();
    // Live-only: a deferred dimension cannot be known during a session, so
    // scoring it now would cap the class for a reason the contributor can
    // neither see nor fix. It is still listed as deferred.
    const quality = assess(this.rubric, measurements, { liveOnly: true });
    const guidance = advise(this.rubric, measurements, {
      target: this.target,
      previousDimension: this.previousDimension,
    });
    this.previousDimension = guidance.primaryDimension;

    const cov = angularCoverage(this.frames, this.target);
    return {
      quality,
      guidance,
      coverage: cov,
      // Where to point, rather than "keep orbiting".
      gap: largestGap(cov.perBand.eye?.visited ?? []),
      frames: this.frames.length,
      usable: this.usableFrames.length,
      suspect: this.frames.length - this.usableFrames.length,
      surfaceCompleteness: { ...this.surfaceCompleteness },
    };
  }

  /**
   * The final class, once reconstruction has supplied the deferred dimensions.
   *
   * Kept separate from `status()` on purpose: a capture-time class is
   * provisional, and presenting it as final would let a session pass an
   * acceptance check nobody has run yet.
   */
  finalQuality(deferredMeasurements = {}) {
    return assess(this.rubric, { ...this.measurements(), ...deferredMeasurements });
  }

  /**
   * Record the authoritative surface completeness once reconstruction has run
   * (R-6.9). The capture-time estimate is kept, not replaced — see OQ-1.
   */
  recordPostReconstructionCompleteness(value) {
    this.surfaceCompleteness.postReconstruction = value;
    if (this.surfaceCompleteness.captureEstimate != null) {
      this.surfaceCompleteness.difference = value - this.surfaceCompleteness.captureEstimate;
    }
    return { ...this.surfaceCompleteness };
  }
}
