/** Tiny WebAudio blips. Disabled by default; the AudioContext is created lazily on first use. */
export function createSound(win) {
  let enabled = false;
  let ctx = null;

  function blip(frequency, duration, gain = 0.035, type = 'sine') {
    if (!enabled) return;
    try {
      const AudioCtx = win?.AudioContext || win?.webkitAudioContext;
      if (!AudioCtx) return;
      ctx ||= new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume?.();
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type;
      osc.frequency.value = frequency;
      amp.gain.setValueAtTime(gain, ctx.currentTime);
      amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      osc.connect(amp).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch {
      /* Audio is a nicety; never let it break the overlay. */
    }
  }

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(next) {
      enabled = Boolean(next);
    },
    tick: () => blip(880 + Math.random() * 440, 0.05, 0.02, 'triangle'),
    click: () => blip(520, 0.09, 0.04),
    done: () => {
      blip(660, 0.14, 0.04);
      setTimeout(() => blip(990, 0.2, 0.04), 110);
    },
    destroy() {
      enabled = false;
      ctx?.close?.().catch?.(() => {});
      ctx = null;
    }
  };
}
