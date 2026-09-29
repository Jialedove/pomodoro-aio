const { TIMER_STAGE } = require("../core/timer");
/** @typedef {import("../../types/contracts").Settings} Settings */
/** @param {Partial<Settings>} settings @param {string} type @param {boolean} [isLong] @param {0 | 1 | null} [cycleSlot] */
function configuredStageDurationMs(settings = {}, type, isLong = false, cycleSlot = null) {
  if (type === TIMER_STAGE.BREAK) {
    const minutes = isLong ? settings.longBreakMin : settings.breakMin;
    return Math.max(1, Math.round((Number(minutes) || (isLong ? 15 : 5)) * 60 * 1000));
  }
  if (Number.isInteger(cycleSlot)) {
    const minutes = cycleSlot === 1 ? settings.cycleMinB : settings.cycleMinA;
    return Math.max(1, Math.round((Number(minutes) || 15) * 60 * 1000));
  }
  return Math.max(1, Math.round((Number(settings.focusMin) || 25) * 60 * 1000));
}

module.exports = { configuredStageDurationMs };
