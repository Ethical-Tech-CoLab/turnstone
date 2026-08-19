/**
 * steady.js — is the phone still enough to shoot?
 *
 * ---------------------------------------------------------------------------
 * WHY AUTO-CAPTURE MATTERS MORE HERE THAN IT LOOKS.
 *
 * Holding a phone still AND pressing a button at the same time is the hardest
 * part of handheld capture, and the tap is what introduces the blur. Motion
 * blur is the single most common reason a capture fails and it is invisible on
 * a small screen at capture time — the contributor finds out weeks later, if at
 * all. Letting the phone fire itself the moment it settles removes the tap from
 * the critical moment entirely.
 *
 * ONE-SHOT, NOT CONTINUOUS. Auto-capture arms, fires once, and disarms. A
 * continuous version fires repeatedly while the phone happens to be steady,
 * filling a session with near-identical frames from one position — which looks
 * like progress on a frame counter while adding no coverage at all.
 *
 * SMOOTHING IS NOT COSMETIC. Raw orientation readings jitter by a degree or
 * more at rest. Feeding them straight to a threshold produces a readiness
 * signal that flickers several times a second, which reads as malfunction and
 * cannot be acted on. Plumb hit exactly this and the fix — EMA plus a deadband
 * plus hysteresis on the decision — is carried over rather than rediscovered.
 * ---------------------------------------------------------------------------
 */

/** Exponential moving average with a deadband, so small jitter does not move it. */
export class Smoothed {
  constructor({ alpha = 0.25, deadband = 0.4 } = {}) {
    this.alpha = alpha;
    this.deadband = deadband;
    this.value = null;
  }

  push(raw) {
    if (raw == null || Number.isNaN(raw)) return this.value;
    if (this.value == null) { this.value = raw; return this.value; }
    // Below the deadband the reading is noise, not movement.
    if (Math.abs(raw - this.value) < this.deadband) return this.value;
    this.value = this.value + this.alpha * (raw - this.value);
    return this.value;
  }

  reset() { this.value = null; }
}

/**
 * Peak-to-peak movement over a short window.
 *
 * Peak-to-peak rather than variance, because a single sharp jolt is exactly
 * what ruins a frame, and variance would average it away against a otherwise
 * calm window.
 */
export class Steadiness {
  constructor({ window = 12, thresholdDeg = 1.5 } = {}) {
    this.window = window;
    this.thresholdDeg = thresholdDeg;
    this.samples = [];
  }

  push(a, b) {
    this.samples.push({ a, b });
    if (this.samples.length > this.window) this.samples.shift();
    return this;
  }

  /** Degrees of peak-to-peak movement. Infinity until there is enough data. */
  movement() {
    if (this.samples.length < 4) return Infinity;
    const as = this.samples.map((s) => s.a);
    const bs = this.samples.map((s) => s.b);
    return Math.max(Math.max(...as) - Math.min(...as), Math.max(...bs) - Math.min(...bs));
  }

  isSteady() { return this.movement() <= this.thresholdDeg; }
  reset() { this.samples = []; }
}

export const AUTO_CAPTURE_DELAY_MS = 700;

/**
 * Arms once the phone is steady, fires once, disarms.
 *
 * `onFire` is awaited, so a slow full-resolution capture cannot overlap with
 * the next arm cycle — the re-entrancy that throws InvalidStateError on Android.
 */
export class AutoCapture {
  constructor({ onFire, onCountdown = null, delayMs = AUTO_CAPTURE_DELAY_MS } = {}) {
    this.onFire = onFire;
    this.onCountdown = onCountdown;
    this.delayMs = delayMs;
    this.enabled = false;
    this.armed = false;
    this.firing = false;
    this.deadline = 0;
    this._timer = null;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.cancel();
    return this.enabled;
  }

  /** Feed the current steadiness. Arms, holds or cancels accordingly. */
  update(isSteady) {
    if (!this.enabled || this.firing) return this.state();
    if (isSteady) {
      if (!this.armed) this._arm();
    } else if (this.armed) {
      // Movement cancels a pending shot. Firing anyway would capture the blur
      // the countdown existed to avoid.
      this.cancel();
    }
    return this.state();
  }

  _arm() {
    this.armed = true;
    this.deadline = Date.now() + this.delayMs;
    this._timer = setTimeout(async () => {
      this.armed = false;
      this.firing = true;
      try {
        await this.onFire?.();
      } finally {
        this.firing = false;
        // One-shot: disarm so it does not immediately re-fire from the same
        // position, filling the session with duplicates of one viewpoint.
        this.enabled = false;
        this.deadline = 0;
      }
    }, this.delayMs);
  }

  cancel() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.armed = false;
    this.deadline = 0;
  }

  /** Seconds remaining, for a countdown the operator can see coming. */
  remaining() {
    return this.deadline ? Math.max(0, this.deadline - Date.now()) : 0;
  }

  state() {
    return {
      enabled: this.enabled,
      armed: this.armed,
      firing: this.firing,
      remainingMs: this.remaining(),
    };
  }
}

/**
 * Track device orientation and turn it into pose plus steadiness.
 *
 * Azimuth comes from the compass where available. It is not survey-grade — it
 * is good enough to bin a viewpoint into one of 24 sectors, which is all the
 * coverage metric asks of it, and `headingSource` records which it was so a
 * consumer never mistakes a simulated orbit for a measured one.
 */
export class PoseTracker {
  constructor({ onUpdate = null } = {}) {
    this.onUpdate = onUpdate;
    this.pitch = new Smoothed();
    this.roll = new Smoothed();
    this.heading = null;
    this.headingSource = 'none';
    this.steadiness = new Steadiness();
    this.active = false;
    this._handler = null;
  }

  async requestPermission() {
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch {
      return false;
    }
    this.start();
    return true;
  }

  start() {
    if (this.active) return;
    this._handler = (e) => {
      // beta is front-back tilt; 90 means the phone is upright, so subtracting
      // it puts "pointing at a wall" at zero.
      const pitch = e.beta != null ? this.pitch.push(e.beta - 90) : null;
      const roll = e.gamma != null ? this.roll.push(e.gamma) : null;

      if (e.webkitCompassHeading != null) {
        this.heading = e.webkitCompassHeading;
        this.headingSource = 'compass';
      } else if (e.alpha != null) {
        this.heading = e.alpha;
        this.headingSource = e.absolute ? 'compass' : 'relative';
      }

      if (pitch != null && roll != null) this.steadiness.push(pitch, roll);
      this.onUpdate?.(this.pose());
    };
    window.addEventListener('deviceorientation', this._handler);
    this.active = true;
  }

  stop() {
    if (this._handler) window.removeEventListener('deviceorientation', this._handler);
    this._handler = null;
    this.active = false;
  }

  pose() {
    return {
      pitchDeg: this.pitch.value,
      rollDeg: this.roll.value,
      azimuthDeg: this.heading,
      elevationDeg: this.pitch.value,
      headingSource: this.headingSource,
      steady: this.steadiness.isSteady(),
      movementDeg: this.steadiness.movement(),
      available: this.pitch.value != null || this.heading != null,
    };
  }
}
