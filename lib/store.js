/**
 * store.js — sessions and frames that survive.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL.
 *
 * The design constraint behind this whole tool is that a second visit may be
 * impossible: the contributor may be a volunteer in a museum for one afternoon,
 * or in a country they cannot return to. A session that evaporates on a page
 * refresh, a phone call, a low-battery kill or an accidental back-swipe is
 * therefore not a minor annoyance — it destroys work that cannot be redone.
 *
 * So frames are written to IndexedDB as they are captured, not accumulated in
 * memory and saved at the end. "Save at the end" means the failure mode is
 * losing everything rather than losing the last frame.
 *
 * Blobs are stored directly. IndexedDB handles them natively, and base64 would
 * inflate archival images by a third for no benefit.
 * ---------------------------------------------------------------------------
 */

const DB_NAME = 'turnstone';
const DB_VERSION = 1;

/** In-memory fallback, used when IndexedDB is unavailable or blocked. */
class MemoryBackend {
  constructor() {
    this.sessions = new Map();
    this.frames = new Map();
    this.persistent = false;
  }

  async putSession(s) { this.sessions.set(s.id, structuredClone(s)); return s.id; }
  async getSession(id) { return this.sessions.get(id) ? structuredClone(this.sessions.get(id)) : null; }
  async listSessions() { return [...this.sessions.values()].map((s) => structuredClone(s)); }
  async deleteSession(id) {
    this.sessions.delete(id);
    for (const [k, f] of this.frames) if (f.sessionId === id) this.frames.delete(k);
  }
  async putFrame(f) { this.frames.set(f.id, { ...f }); return f.id; }
  async framesFor(id) {
    return [...this.frames.values()].filter((f) => f.sessionId === id)
      .sort((a, b) => a.index - b.index).map((f) => ({ ...f }));
  }
  async countFrames(id) { return (await this.framesFor(id)).length; }
}

class IdbBackend {
  constructor(db) { this.db = db; this.persistent = true; }

  static open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('frames')) {
          const s = db.createObjectStore('frames', { keyPath: 'id' });
          s.createIndex('sessionId', 'sessionId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(new IdbBackend(req.result));
      req.onerror = () => reject(req.error);
      // Private browsing can leave the request pending forever rather than
      // failing, so the caller must not wait indefinitely.
      req.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });
  }

  _tx(store, mode) {
    return this.db.transaction(store, mode).objectStore(store);
  }

  _wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async putSession(s) { return this._wrap(this._tx('sessions', 'readwrite').put(s)); }
  async getSession(id) { return (await this._wrap(this._tx('sessions').get(id))) ?? null; }
  async listSessions() { return (await this._wrap(this._tx('sessions').getAll())) ?? []; }

  async deleteSession(id) {
    await this._wrap(this._tx('sessions', 'readwrite').delete(id));
    const frames = await this.framesFor(id);
    const store = this._tx('frames', 'readwrite');
    await Promise.all(frames.map((f) => this._wrap(store.delete(f.id))));
  }

  async putFrame(f) { return this._wrap(this._tx('frames', 'readwrite').put(f)); }

  async framesFor(id) {
    const all = await this._wrap(this._tx('frames').index('sessionId').getAll(id));
    return (all ?? []).sort((a, b) => a.index - b.index);
  }

  async countFrames(id) {
    return this._wrap(this._tx('frames').index('sessionId').count(id));
  }
}

/**
 * Open the store.
 *
 * Falls back to memory rather than throwing. A contributor in a museum with
 * private browsing on should still be able to capture — they should simply be
 * TOLD that the session will not survive a reload, which `persistent` reports.
 */
export async function openStore({ timeoutMs = 3000 } = {}) {
  if (typeof indexedDB === 'undefined') return new MemoryBackend();
  try {
    const backend = await Promise.race([
      IdbBackend.open(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB timed out')), timeoutMs)),
    ]);
    return backend;
  } catch {
    return new MemoryBackend();
  }
}

/**
 * Ask the browser not to evict this data under storage pressure.
 *
 * Best-effort by definition — no browser guarantees it. Worth requesting
 * because the alternative is a session silently discarded to reclaim space.
 */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) {
      const already = await navigator.storage.persisted();
      return already || await navigator.storage.persist();
    }
  } catch { /* not supported */ }
  return false;
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

export function newSessionId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A session that writes through to the store on every change.
 *
 * Wraps the in-memory Session rather than replacing it: the scoring logic is
 * tested and has no business knowing about storage.
 */
export class PersistentSession {
  constructor(store, session, meta) {
    this.store = store;
    this.session = session;
    this.meta = meta;
  }

  static async create(store, session, { subject = null, target = 'study', rubricId = null } = {}) {
    const meta = {
      id: newSessionId(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subject,
      target,
      rubricId,
      frameCount: 0,
      passes: [{ id: 0, label: 'upright' }],
    };
    await store.putSession(meta);
    return new PersistentSession(store, session, meta);
  }

  /**
   * Reopen a stored session and replay its frames back into the scorer.
   *
   * Replaying the measurements rather than the stored score is deliberate: the
   * score is derived, and a rubric or an extractor may have improved since the
   * session was captured. Recomputing means a reopened session is scored by the
   * current code, not by whatever ran last week.
   */
  static async resume(store, session, id) {
    const meta = await store.getSession(id);
    if (!meta) return null;
    const frames = await store.framesFor(id);
    session.target = meta.target ?? 'study';
    for (const f of frames) session.addFrame(f.measurements);
    return new PersistentSession(store, session, meta);
  }

  /**
   * Add a frame: measurements first, image second.
   *
   * The measurements are what the session is *for*. Writing them first means a
   * failure while storing a multi-megabyte blob costs the picture but not the
   * record of what was measured, which is the more valuable of the two when a
   * device is running out of space.
   */
  async addFrame(measurements, blob = null, extra = {}) {
    const index = this.session.frames.length;
    const applied = this.session.addFrame(measurements);
    const record = {
      id: `${this.meta.id}_f${String(index).padStart(4, '0')}`,
      sessionId: this.meta.id,
      index,
      capturedAt: new Date().toISOString(),
      measurements,
      pass: applied.pass,
      ...extra,
    };
    await this.store.putFrame(record);

    if (blob) {
      try {
        await this.store.putFrame({ ...record, blob, blobSize: blob.size });
      } catch (err) {
        // Out of quota is the common cause. The measurement survives, which is
        // the part that cannot be recreated from the object later.
        record.blobError = err.message;
        await this.store.putFrame(record);
      }
    }

    this.meta.frameCount = index + 1;
    this.meta.updatedAt = new Date().toISOString();
    await this.store.putSession(this.meta);
    return record;
  }

  async startPass(label) {
    const pass = this.session.startPass(label);
    this.meta.passes.push({ id: pass.id, label });
    await this.store.putSession(this.meta);
    return pass;
  }

  async setTarget(target) {
    this.session.target = target;
    this.meta.target = target;
    await this.store.putSession(this.meta);
  }

  async frames() {
    return this.store.framesFor(this.meta.id);
  }

  status() {
    return this.session.status();
  }
}
