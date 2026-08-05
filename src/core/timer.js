const TIMER_SCHEMA_VERSION = 3;
const TIMER_STATUS = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  AWAITING: "awaiting",
  SETTLING: "settling",
  FAILED: "settlement-failed"
});
const TIMER_STAGE = Object.freeze({ FOCUS: "focus", BREAK: "break" });
const TOMATO_MS = 25 * 60 * 1000;

function roundTomatoAmount(value, minimum = 0) {
  const rounded = Math.round((Number(value) || 0) * 10) / 10;
  return rounded > 0 ? Math.max(minimum, rounded) : 0;
}

function plannedTomatoAmount(durationMs) {
  return roundTomatoAmount(Number(durationMs) / TOMATO_MS, 0.1);
}

function actualTomatoAmount(elapsedMs) {
  const milliseconds = Math.max(0, Number(elapsedMs) || 0);
  return milliseconds ? roundTomatoAmount(milliseconds / TOMATO_MS, 0.1) : 0;
}

function createSessionId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch (error) {
    console.debug("Pomodoro AIO crypto.randomUUID 不可用，使用备用 sessionId", error);
  }
  return `pmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

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

function getElapsedMs(runtime, at = Date.now()) {
  const duration = Math.max(0, Number(runtime?.durationMs) || 0);
  const carried = Math.min(duration, Math.max(0, Number(runtime?.elapsedMs) || 0));
  if (runtime?.status !== TIMER_STATUS.RUNNING || !runtime?.startedAtMs) return carried;
  return Math.min(duration, carried + Math.max(0, at - runtime.startedAtMs));
}

function getRemainingMs(runtime, settings, at = Date.now()) {
  if (runtime?.status === TIMER_STATUS.IDLE) {
    const slot = settings?.workMode === "cycle" ? runtime.cycleSlot : null;
    return configuredStageDurationMs(settings || {}, TIMER_STAGE.FOCUS, false, slot);
  }
  if (runtime?.status === TIMER_STATUS.AWAITING) {
    return Math.max(0, Number(runtime.attention?.durationMs) || Number(runtime.remainingMs) || 0);
  }
  if (runtime?.status === TIMER_STATUS.PAUSED) return Math.max(0, Number(runtime.remainingMs) || 0);
  if (runtime?.status !== TIMER_STATUS.RUNNING || !runtime?.startedAtMs || !runtime?.durationMs) return 0;
  return Math.max(0, runtime.durationMs - getElapsedMs(runtime, at));
}

module.exports = {
  TIMER_SCHEMA_VERSION,
  TIMER_STATUS,
  TIMER_STAGE,
  configuredStageDurationMs,
  plannedTomatoAmount,
  actualTomatoAmount,
  createSessionId,
  getElapsedMs,
  getRemainingMs
};
