/**
 * Virtual clock driven by requestAnimationFrame. Every animation and choreography timer in the
 * overlay reads this clock, so a single `scale` knob speeds the whole swarm up (1×, 2×, 4×).
 */
export function createClock({ win } = {}) {
  const raf = win?.requestAnimationFrame?.bind(win) ?? ((fn) => setTimeout(() => fn(Date.now()), 16));
  const caf = win?.cancelAnimationFrame?.bind(win) ?? clearTimeout;
  const tickers = new Set();
  const timers = new Set();
  let time = 0;
  let scale = 1;
  let last = null;
  let handle = null;
  let running = false;

  function frame(realNow) {
    if (!running) return;
    const realDt = last == null ? 16 : Math.min(64, Math.max(0, realNow - last));
    last = realNow;
    const dt = realDt * scale;
    time += dt;
    for (const timer of [...timers]) {
      if (timer.due <= time) {
        timers.delete(timer);
        timer.resolve(true);
      }
    }
    for (const fn of [...tickers]) fn(time, dt, realDt);
    handle = raf(frame);
  }

  return {
    get time() {
      return time;
    },
    get scale() {
      return scale;
    },
    setScale(next) {
      scale = Math.min(8, Math.max(0.25, Number(next) || 1));
    },
    /** Registers a per-frame callback `(time, dt, realDt)`; returns an unsubscribe function. */
    onTick(fn) {
      tickers.add(fn);
      return () => tickers.delete(fn);
    },
    /** Resolves `true` after `ms` of virtual time, or `false` if the clock was flushed/stopped. */
    wait(ms) {
      return new Promise((resolve) => timers.add({ due: time + Math.max(0, ms), resolve }));
    },
    /** Runs `fn(progress 0..1)` every frame for `ms` of virtual time. */
    tween(ms, fn) {
      const start = time;
      const duration = Math.max(1, ms);
      return new Promise((resolve) => {
        const off = this.onTick((now) => {
          const p = Math.min(1, (now - start) / duration);
          fn(p);
          if (p >= 1) {
            off();
            resolve(true);
          }
        });
      });
    },
    /** Resolves every pending `wait` immediately with `false` (used when cancelling choreography). */
    flush() {
      for (const timer of [...timers]) {
        timers.delete(timer);
        timer.resolve(false);
      }
    },
    start() {
      if (running) return;
      running = true;
      last = null;
      handle = raf(frame);
    },
    stop() {
      running = false;
      if (handle != null) caf(handle);
      handle = null;
      this.flush();
      tickers.clear();
    }
  };
}
