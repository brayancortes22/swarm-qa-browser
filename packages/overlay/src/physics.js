/** Pure motion helpers shared by the swarm engine (no DOM access, fully unit-testable). */

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Fitts-like travel time: short hops are snappy, long flights stay under a second. */
export function flightDuration(dist) {
  return clamp(200 + dist * 0.55, 220, 880);
}

/** Deterministic PRNG (mulberry32) so choreography can be seeded in tests. */
export function createRng(seed = Date.now()) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Point on a quadratic curve whose control point is offset sideways by `bend` × distance. */
export function arcPoint(from, to, bend, t) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const cx = (from.x + to.x) / 2 - dy * bend;
  const cy = (from.y + to.y) / 2 + dx * bend;
  const inv = 1 - t;
  return {
    x: inv * inv * from.x + 2 * inv * t * cx + t * t * to.x,
    y: inv * inv * from.y + 2 * inv * t * cy + t * t * to.y
  };
}

/** Picks black or white ink for text placed on top of `hex`, by relative luminance. */
export function inkFor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.66 ? '#0b0c10' : '#ffffff';
}
