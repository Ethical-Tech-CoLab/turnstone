/**
 * camera.js — Android-first camera control.
 *
 * Implements PHOTOGRAMMETRY-SPEC.md §7 capture requirements.
 *
 * ---------------------------------------------------------------------------
 * WHY OPTICS LOCKING IS A METROLOGY FEATURE, NOT A CONVENIENCE.
 *
 * Autofocus silently changes the effective focal length. A lens profile
 * measured at one focus distance is invalid at another, so a session shot with
 * autofocus active has a different camera model in every frame — and the
 * reconstruction has no way to know. Locking focus, exposure and white balance
 * for the duration of a session is what keeps one intrinsic profile valid
 * across it.
 *
 * The same applies to zoom: a digital zoom crops, an optical zoom changes the
 * focal length, and the browser does not always say which it did. So the zoom
 * factor is recorded with every frame rather than assumed constant.
 *
 * ANDROID IS THE REFERENCE PLATFORM. `ImageCapture.takePhoto()` returns a full
 * sensor-resolution still in-page on Android Chrome, which is the only way to
 * get archival pixels out of a browser. Safari does not implement it, so iOS
 * falls back to a video frame — usable for framing, not for a reference record,
 * and the difference is recorded rather than hidden.
 * ---------------------------------------------------------------------------
 */

export function detectPlatform() {
  if (typeof navigator === 'undefined') {
    return { id: 'unknown', label: 'not a browser', tier: 'unknown' };
  }
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const hasImageCapture = typeof window !== 'undefined' && 'ImageCapture' in window;

  if (isAndroid && hasImageCapture) {
    return { id: 'android', label: 'Android — full resolution available', tier: 'primary' };
  }
  if (isIOS) {
    return {
      id: 'ios',
      label: 'iOS — no ImageCapture; frames come from the video stream',
      tier: 'reduced',
    };
  }
  return {
    id: hasImageCapture ? 'desktop' : 'limited',
    label: hasImageCapture ? 'Desktop browser' : 'No ImageCapture in this browser',
    tier: hasImageCapture ? 'primary' : 'reduced',
  };
}

export class Camera {
  constructor() {
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.capabilities = {};
    this.settings = {};
    this.photoCapabilities = null;
    this.opticsLocked = false;
    this.platform = detectPlatform();
    this._capturing = false;
  }

  async start({ facingMode = 'environment' } = {}) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 4096 },
        height: { ideal: 3072 },
      },
      audio: false,
    });
    this.track = this.stream.getVideoTracks()[0];
    this.capabilities = this.track.getCapabilities?.() ?? {};
    this.settings = this.track.getSettings?.() ?? {};

    if ('ImageCapture' in window) {
      try {
        this.imageCapture = new ImageCapture(this.track);
        this.photoCapabilities = await this.imageCapture.getPhotoCapabilities();
      } catch {
        // Some devices construct ImageCapture and then fail on the first call.
        // Better to find out now than mid-session.
        this.imageCapture = null;
      }
    }
    this.opticsLocked = false;
    return this.stream;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.photoCapabilities = null;
    this.opticsLocked = false;
    this._capturing = false;
  }

  supports(name) {
    return Object.prototype.hasOwnProperty.call(this.capabilities, name);
  }

  /**
   * Full-resolution still, with a fallback chain.
   *
   * Asking for the maximum advertised photo size is the right thing to want,
   * and a number of Android devices either reject the constrained call or hand
   * back an empty frame for it. So: try constrained, then flash-off alone, then
   * the device default — and VALIDATE what comes back rather than trusting it.
   * An unvalidated empty blob previously reached a canvas and produced a blank
   * screen with no error surfaced anywhere.
   *
   * Re-entrant calls are refused: a second takePhoto() while one is in flight
   * throws InvalidStateError on Android, which auto-capture makes easy to hit.
   */
  async takePhoto() {
    if (!this.imageCapture) throw new Error('ImageCapture is not available on this browser.');
    if (this._capturing) throw new Error('A capture is already in progress.');

    this._capturing = true;
    try {
      const caps = this.photoCapabilities;
      const attempts = [];

      const constrained = {};
      if (caps?.imageWidth?.max) constrained.imageWidth = caps.imageWidth.max;
      if (caps?.imageHeight?.max) constrained.imageHeight = caps.imageHeight.max;
      if (caps?.fillLightMode?.includes('off')) constrained.fillLightMode = 'off';
      if (Object.keys(constrained).length) attempts.push(constrained);

      // Flash off alone is widely supported even where explicit sizing is not.
      if (caps?.fillLightMode?.includes('off')) attempts.push({ fillLightMode: 'off' });
      attempts.push(undefined);

      let lastError = null;
      for (const settings of attempts) {
        try {
          const blob = settings
            ? await this.imageCapture.takePhoto(settings)
            : await this.imageCapture.takePhoto();
          if (blob && blob.size > 1024) return blob;
          lastError = new Error(`Camera returned an empty image (${blob?.size ?? 0} bytes).`);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError ?? new Error('takePhoto failed for an unknown reason.');
    } finally {
      this._capturing = false;
    }
  }

  get isCapturing() {
    return !!this._capturing;
  }

  /**
   * Lock focus, exposure and white balance for the session.
   *
   * Reports what it actually managed to apply rather than claiming success:
   * a session that believes its optics are locked when they are not carries an
   * invalid lens profile and has no way to discover that later.
   */
  async lockOptics() {
    if (!this.track) throw new Error('Camera is not running.');
    const caps = this.capabilities;
    const applied = {};
    const wanted = [];

    if (caps.focusMode?.includes('manual')) wanted.push({ focusMode: 'manual' });
    else if (caps.focusMode?.includes('single-shot')) wanted.push({ focusMode: 'single-shot' });
    if (caps.exposureMode?.includes('manual')) wanted.push({ exposureMode: 'manual' });
    else if (caps.exposureMode?.includes('single-shot')) wanted.push({ exposureMode: 'single-shot' });
    if (caps.whiteBalanceMode?.includes('manual')) wanted.push({ whiteBalanceMode: 'manual' });

    for (const constraint of wanted) {
      try {
        await this.track.applyConstraints({ advanced: [constraint] });
        Object.assign(applied, constraint);
      } catch {
        // Applying one constraint can fail while others succeed. Record what
        // stuck rather than abandoning the whole attempt.
      }
    }

    this.settings = this.track.getSettings?.() ?? this.settings;
    this.opticsLocked = Object.keys(applied).length > 0;
    return {
      locked: this.opticsLocked,
      applied,
      reason: this.opticsLocked
        ? 'Optics locked — the lens profile stays valid for this session.'
        : 'No lockable optics exposed by this browser or device. The lens profile may drift between frames.',
    };
  }

  async setZoom(value) {
    if (!this.track || !this.capabilities.zoom) return null;
    const { min, max } = this.capabilities.zoom;
    const z = Math.max(min, Math.min(max, value));
    await this.track.applyConstraints({ advanced: [{ zoom: z }] });
    this.settings = this.track.getSettings?.() ?? this.settings;
    return z;
  }

  async setTorch(on) {
    if (!this.track || !this.capabilities.torch) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return !!on;
    } catch {
      return false;
    }
  }

  /**
   * What the camera was doing, for the record.
   *
   * `lens_profile_valid` is the load-bearing field: it is false whenever the
   * optics were not locked, because a profile that might have changed between
   * frames cannot be relied upon by a reconstruction.
   */
  captureProfile() {
    const s = this.settings ?? {};
    return {
      platform: this.platform.id,
      full_resolution_available: !!this.imageCapture,
      width: s.width ?? null,
      height: s.height ?? null,
      zoom: s.zoom ?? 1,
      focus_mode: s.focusMode ?? null,
      exposure_mode: s.exposureMode ?? null,
      white_balance_mode: s.whiteBalanceMode ?? null,
      optics_locked: this.opticsLocked,
      lens_profile_valid: this.opticsLocked,
      focal_length_mm: s.focalLength ?? null,
      device_id: s.deviceId ?? null,
    };
  }
}
