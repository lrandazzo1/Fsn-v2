/**
 * draftTimer.js
 * -----------------------------------------------------------------------------
 * The pick clock.
 *
 * Deliberately dumb and injectable: the scheduler is a constructor option so the
 * terminal test-suite can drive expiry synchronously (`timer.tick()`) without
 * waiting on real wall-clock seconds.
 */

export class PickTimer {
  /**
   * @param {Object} options
   * @param {number}   [options.seconds=60]  Length of a pick clock.
   * @param {Function} [options.onTick]      (secondsRemaining) => void
   * @param {Function} [options.onExpire]    () => void, fired once at zero.
   * @param {number}   [options.interval=1000]
   * @param {{setInterval: Function, clearInterval: Function}} [options.scheduler]
   */
  constructor({ seconds = 60, onTick, onExpire, interval = 1000, scheduler } = {}) {
    this.duration = seconds;
    this.remaining = seconds;
    this.onTick = onTick || (() => {});
    this.onExpire = onExpire || (() => {});
    this.interval = interval;
    this.scheduler = scheduler || {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle)
    };
    this.handle = null;
    this.running = false;
    this.expired = false;
  }

  /** Restarts the clock from `seconds` (defaults to the configured duration). */
  start(seconds = this.duration) {
    this.stop();
    this.duration = seconds;
    this.remaining = seconds;
    this.expired = false;
    this.running = true;
    this.onTick(this.remaining);
    this.handle = this.scheduler.setInterval(() => this.tick(), this.interval);
    return this;
  }

  /** Advances one second. Exposed so tests can run the clock instantly. */
  tick() {
    if (!this.running) return this.remaining;
    this.remaining = Math.max(0, this.remaining - 1);
    this.onTick(this.remaining);

    if (this.remaining === 0 && !this.expired) {
      this.expired = true;
      this.running = false;
      this.clearHandle();
      this.onExpire();
    }
    return this.remaining;
  }

  /** Runs the clock straight to zero — used by "force expiry" controls/tests. */
  expireNow() {
    if (!this.running) return;
    this.remaining = 1;
    this.tick();
  }

  pause() {
    this.running = false;
    this.clearHandle();
    return this;
  }

  resume() {
    if (this.running || this.remaining === 0) return this;
    this.running = true;
    this.handle = this.scheduler.setInterval(() => this.tick(), this.interval);
    return this;
  }

  stop() {
    this.running = false;
    this.expired = false;
    this.clearHandle();
    return this;
  }

  clearHandle() {
    if (this.handle !== null) {
      this.scheduler.clearInterval(this.handle);
      this.handle = null;
    }
  }

  /** 0..1 — how much of the clock is left (for the progress ring). */
  get fraction() {
    return this.duration === 0 ? 0 : this.remaining / this.duration;
  }

  /** "0:47" */
  get display() {
    const mins = Math.floor(this.remaining / 60);
    const secs = this.remaining % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
}
