const { TIMER_STATUS, TIMER_STAGE } = require("../core/timer");
/** @param {Record<string, any> | null | undefined} runtime @param {Record<string, any> | null | undefined} settings */
function shouldShowLegacyBlackout(runtime, settings) {
  const active = [TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED].includes(runtime?.status);
  if (!active) return false;
  if (runtime?.stage === TIMER_STAGE.BREAK) return settings?.breakBlackoutEnabled === true;
  if (runtime?.stage !== TIMER_STAGE.FOCUS) return false;
  if (runtime?.mode === "cycle") return runtime?.cycleSlot === 1
    ? settings?.cycleTaskBlackoutB === true
    : settings?.cycleTaskBlackoutA === true;
  return settings?.taskBlackoutEnabled === true;
}
/** @param {Record<string, any>} runtime @param {Record<string, any> | null | undefined} settings */
function legacyBlackoutPrompt(runtime, settings) {
  if (runtime.stage === TIMER_STAGE.BREAK) return { label:"现在应该做什么", title:"休息一下" };
  const configuredTask = runtime.mode === "cycle"
    ? (runtime.cycleSlot === 1 ? settings?.cycleTaskB : settings?.cycleTaskA)
    : settings?.defaultTaskName;
  const task = String(runtime.currentTaskName || configuredTask || "").trim();
  return { label:"现在应该做什么", title:task || "专注当前任务" };
}
/** @param {Record<string, any>} runtime */
function legacyBlackoutKey(runtime) {
  if (!runtime.stage) return "";
  if (runtime.stage === TIMER_STAGE.BREAK) return "break:active";
  return `${runtime.stage}:${runtime.sessionId || runtime.startedAtMs || "pending"}`;
}
module.exports = { shouldShowLegacyBlackout, legacyBlackoutPrompt, legacyBlackoutKey };
