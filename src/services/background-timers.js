// Timers that keep firing while the Obsidian window is hidden or covered.
// Chromium throttles window timers in hidden pages (down to about once per minute
// after five minutes), which delays settlement, blackout updates and lighting
// leases. Node's timers run on libuv in the desktop renderer and are not throttled.

/**
 * @typedef {object} BackgroundTimers
 * @property {(callback:() => void, delay:number) => unknown} setTimeout
 * @property {(handle:unknown) => void} clearTimeout
 * @property {(callback:() => void, delay:number) => unknown} setInterval
 * @property {(handle:unknown) => void} clearInterval
 */

/** @returns {BackgroundTimers} */
function windowTimers() {
  return {
    setTimeout:(callback, delay) => window.setTimeout(callback, delay),
    clearTimeout:handle => window.clearTimeout(/** @type {number} */ (handle)),
    setInterval:(callback, delay) => window.setInterval(callback, delay),
    clearInterval:handle => window.clearInterval(/** @type {number} */ (handle))
  };
}

/** @param {() => any} [loadNodeTimers] @returns {BackgroundTimers} */
function createBackgroundTimers(loadNodeTimers=() => require("node:timers")) {
  let timers = null;
  try { timers = loadNodeTimers(); } catch { timers = null; }
  if (!timers || typeof timers.setTimeout !== "function") return windowTimers();
  return {
    setTimeout:(callback, delay) => timers.setTimeout(callback, delay),
    clearTimeout:handle => timers.clearTimeout(handle),
    setInterval:(callback, delay) => timers.setInterval(callback, delay),
    clearInterval:handle => timers.clearInterval(handle)
  };
}

module.exports = { createBackgroundTimers };
