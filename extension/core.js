/* Shared pure functions: no DOM, network, or extension API dependencies. */
(() => {
  'use strict';
  const DEFAULTS = Object.freeze({ enabled: true, minDelay: 1, maxDelay: 15, probability: 100, cooldown: 0, oncePerVideo: true, autoResume: false });
  const numeric = (n, fallback, min, max) => Number.isFinite(Number(n)) ? Math.min(max, Math.max(min, Number(n))) : fallback;
  function normalize(input = {}) {
    if (!input || typeof input !== 'object') input = {};
    const minDelay = numeric(input.minDelay ?? DEFAULTS.minDelay, DEFAULTS.minDelay, 1, 3600);
    return {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULTS.enabled,
      minDelay,
      maxDelay: numeric(input.maxDelay ?? DEFAULTS.maxDelay, DEFAULTS.maxDelay, minDelay, 3600),
      probability: numeric(input.probability ?? DEFAULTS.probability, DEFAULTS.probability, 0, 100),
      cooldown: numeric(input.cooldown ?? DEFAULTS.cooldown, DEFAULTS.cooldown, 0, 3600),
      oncePerVideo: typeof input.oncePerVideo === 'boolean' ? input.oncePerVideo : DEFAULTS.oncePerVideo,
      autoResume: typeof input.autoResume === 'boolean' ? input.autoResume : DEFAULTS.autoResume
    };
  }
  function delay(settings, random = Math.random) { return (settings.minDelay + random() * (settings.maxDelay - settings.minDelay)) * 1000; }
  function chance(percent, random = Math.random) { return percent > 0 && random() * 100 < percent; }
  function visibleArea(rect, width, height) {
    return Math.max(0, Math.min(rect.right, width) - Math.max(0, rect.left)) * Math.max(0, Math.min(rect.bottom, height) - Math.max(0, rect.top));
  }
  const api = { DEFAULTS, normalize, delay, chance, visibleArea };
  globalThis.VideoPrankCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
