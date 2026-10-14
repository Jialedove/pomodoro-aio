// 活动提醒：检测到在用电脑、但番茄钟没有在计时时，先轻提醒，再周期性强提醒。
// 纯函数，不读取系统时间或 Obsidian 状态，便于测试。
const { TIMER_STATUS } = require("./timer");
const { positiveNumber } = require("./validation");
/** @typedef {import("../../types/contracts").Runtime} Runtime */
/** @typedef {{activeSinceMs:number|null,lastGentleAtMs:number|null,lastStrongAtMs:number|null,snoozeUntilMs:number}} NudgeState */
/** @typedef {"idle"|"paused"} NudgeReason */
/** @typedef {{action:"none"|"gentle"|"strong",state:NudgeState,activeMs:number}} NudgeDecision */

const ACTIVITY_NUDGE_DEFAULTS = Object.freeze({
  activityNudgeEnabled:true,
  activityAwaySec:120,
  activityGentleAfterMin:1,
  activityStrongAfterMin:5,
  activityStrongRepeatMin:5,
  activitySnoozeMin:15
});

/** @param {Record<string, any>} source @param {Record<string, any>} [base] */
function normalizeActivityNudgeSettings(source, base = ACTIVITY_NUDGE_DEFAULTS) {
  /** @type {Record<string, any>} */
  const fallback = { ...ACTIVITY_NUDGE_DEFAULTS, ...base };
  /** @param {string} key @param {number} min */
  const num = (key, min) => Math.round(positiveNumber(source?.[key], fallback[key], min) * 10) / 10;
  return {
    activityNudgeEnabled:typeof source?.activityNudgeEnabled === "boolean" ? source.activityNudgeEnabled : fallback.activityNudgeEnabled === true,
    activityAwaySec:Math.round(num("activityAwaySec", 10)),
    activityGentleAfterMin:num("activityGentleAfterMin", 0.1),
    activityStrongAfterMin:num("activityStrongAfterMin", 0.5),
    activityStrongRepeatMin:num("activityStrongRepeatMin", 0.5),
    activitySnoozeMin:num("activitySnoozeMin", 1)
  };
}

/** @returns {NudgeState} */
function createNudgeState() {
  return { activeSinceMs:null, lastGentleAtMs:null, lastStrongAtMs:null, snoozeUntilMs:0 };
}

/**
 * 只有“空闲且没有待确认的下一段”或“已暂停”才算没在计时；等待确认已有自己的持续提醒，
 * 结算中、结算失败和待恢复的转换不打扰。
 * @param {Runtime} runtime @returns {NudgeReason | null}
 */
function untrackedReason(runtime) {
  if (!runtime || runtime.attention || runtime.pendingSettlement || runtime.pendingBreakTransition) return null;
  if (runtime.status === TIMER_STATUS.IDLE) return "idle";
  if (runtime.status === TIMER_STATUS.PAUSED) return "paused";
  return null;
}

/**
 * @param {NudgeState} state
 * @param {{nowMs:number, idleSec:number|null, untracked:boolean, settings:Record<string, any>}} input
 * @returns {NudgeDecision}
 */
function evaluateNudge(state, { nowMs, idleSec, untracked, settings }) {
  const config = normalizeActivityNudgeSettings(settings);
  /** @param {NudgeState} next @returns {NudgeDecision} */
  const none = next => ({ action:"none", state:next, activeMs:0 });
  const reset = { ...state, activeSinceMs:null, lastGentleAtMs:null, lastStrongAtMs:null };
  if (!config.activityNudgeEnabled || !untracked || idleSec === null || !Number.isFinite(idleSec)) return none(reset);
  if (idleSec >= config.activityAwaySec) return none(reset);
  if (nowMs < state.snoozeUntilMs) return none(reset);

  const activeSinceMs = state.activeSinceMs ?? nowMs;
  const activeMs = Math.max(0, nowMs - activeSinceMs);
  const next = { ...state, activeSinceMs };
  const strongDue = activeMs >= config.activityStrongAfterMin * 60_000
    && (state.lastStrongAtMs === null || nowMs - state.lastStrongAtMs >= config.activityStrongRepeatMin * 60_000);
  if (strongDue) return { action:"strong", state:{ ...next, lastStrongAtMs:nowMs }, activeMs };
  if (state.lastGentleAtMs === null && activeMs >= config.activityGentleAfterMin * 60_000) {
    return { action:"gentle", state:{ ...next, lastGentleAtMs:nowMs }, activeMs };
  }
  return { action:"none", state:next, activeMs };
}

/** @param {NudgeState} state @param {number} nowMs @param {number} minutes @returns {NudgeState} */
function snoozeNudge(state, nowMs, minutes) {
  return { ...state, activeSinceMs:null, lastGentleAtMs:null, lastStrongAtMs:null,
    snoozeUntilMs:nowMs + Math.max(1, Number(minutes) || 0) * 60_000 };
}

/** ioreg 输出中的 HIDIdleTime 单位是纳秒。 @param {unknown} output @returns {number | null} */
function parseHidIdleSeconds(output) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(output || ""));
  return match ? Number(match[1]) / 1e9 : null;
}

module.exports = {
  ACTIVITY_NUDGE_DEFAULTS,
  normalizeActivityNudgeSettings,
  createNudgeState,
  untrackedReason,
  evaluateNudge,
  snoozeNudge,
  parseHidIdleSeconds
};
