const { normalizeMarkdownPath, isValidHHMM, positiveNumber } = require("./validation");
const { normalizeCaptureHeading } = require("./quick-capture");
const { normalizeModuleDefinition, normalizeRestPresets, normalizeOrchestration } = require("./modules");
const { TIMER_SCHEMA_VERSION } = require("./timer");
const { DEFAULT_LIGHT_PROGRAMS, normalizeLightingSettings } = require("./lighting");
/** @typedef {import("../../types/contracts").Settings} Settings */

/** @type {Settings} */
const DEFAULT_SETTINGS = {
  schemaVersion:TIMER_SCHEMA_VERSION,
  modules:[], restPresets:normalizeRestPresets(), projectAssignments:{},
  loopMode:"infinite", loopCount:1, autoAdvance:false, enableProjects:false,
  dayStartHHMM:"00:00", fallbackPattern:"Daily/{{date:YYYY-MM-DD}}.md",
  allowCreateDaily:true, fmKey:"番茄数", allowAutoCreateTask:true,
  tasksHeading:"", captureHeading:"Inbox", capturePathPattern:"",
  projectTag:"#project", projectStatusKey:"项目状态", projectStatusWhitelist:"进行中,筹划中",
  projectFmKey:"番茄数", dailyGoal:8,
  enableSound:true, enableNotify:true, soundWaveform:"sine",
  focusStartSound:"focus-start", breakStartSound:"break-start",
  focusEndSound:"focus-end", breakEndSound:"break-end",
  focusAlertSound:"focus-alert", breakAlertSound:"break-alert",
  strongAlertDelaySec:30, strongAlertIntervalSec:60,
  persistentAlertSound:true, ribbonClickAutoNext:true, respectModalInputFocus:true,
  lightingEnabled:true, lightingBaseUrl:"http://127.0.0.1:18473", lightingDeviceId:"",
  lightingDefaultWorkId:"work", lightingDefaultRestId:"rest", lightingPrograms:DEFAULT_LIGHT_PROGRAMS
};

/** @param {unknown} raw @param {Settings} fallback @param {(path:string)=>string} normalizePath @returns {Settings} */
function normalizeCurrentSettings(raw, fallback = DEFAULT_SETTINGS, normalizePath = path => path) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const base = { ...DEFAULT_SETTINGS, ...fallback };
  /** @type {Settings} */
  const result = { ...DEFAULT_SETTINGS };
  const path = (/** @type {unknown} */ value) => {
    try { return normalizeMarkdownPath(value, normalizePath); }
    catch (_) { return ""; }
  };
  const modules = Array.isArray(source.modules) ? source.modules : base.modules;
  const seen = new Set();
  result.modules = modules.map((/** @type {unknown} */ value, /** @type {number} */ index) => {
    const module = normalizeModuleDefinition(value, { fallbackName:`模块 ${index + 1}` });
    while (seen.has(module.id)) module.id = `${module.id}-${index + 1}`;
    seen.add(module.id);
    return module;
  });
  result.restPresets = normalizeRestPresets(source.restPresets ?? base.restPresets);
  Object.assign(result, normalizeOrchestration({ ...base, ...source }));
  const assignments = source.projectAssignments ?? base.projectAssignments;
  result.projectAssignments = Object.fromEntries(result.modules
    .filter(module => module.type === "work")
    .map(module => [module.id, path(assignments?.[module.id])])
    .filter(([, value]) => !!value));
  for (const key of ["allowCreateDaily", "allowAutoCreateTask", "enableSound", "enableNotify",
    "persistentAlertSound", "ribbonClickAutoNext", "respectModalInputFocus"]) {
    result[key] = typeof source[key] === "boolean" ? source[key] : base[key];
  }
  for (const key of ["fmKey", "tasksHeading", "projectTag", "projectStatusKey",
    "projectStatusWhitelist", "projectFmKey", "focusStartSound", "breakStartSound",
    "focusEndSound", "breakEndSound", "focusAlertSound", "breakAlertSound"]) {
    result[key] = String(source[key] ?? base[key]);
  }
  result.dayStartHHMM = isValidHHMM(source.dayStartHHMM) ? source.dayStartHHMM : base.dayStartHHMM;
  result.fallbackPattern = path(source.fallbackPattern ?? base.fallbackPattern) || base.fallbackPattern;
  result.capturePathPattern = source.capturePathPattern ? path(source.capturePathPattern) : "";
  result.captureHeading = normalizeCaptureHeading(source.captureHeading ?? base.captureHeading);
  result.dailyGoal = positiveNumber(source.dailyGoal, base.dailyGoal);
  result.strongAlertDelaySec = Math.max(1, Math.round(positiveNumber(source.strongAlertDelaySec, base.strongAlertDelaySec)));
  result.strongAlertIntervalSec = Math.max(1, Math.round(positiveNumber(source.strongAlertIntervalSec, base.strongAlertIntervalSec)));
  result.soundWaveform = ["sine", "square", "triangle"].includes(source.soundWaveform) ? source.soundWaveform : base.soundWaveform;
  result.schemaVersion = TIMER_SCHEMA_VERSION;
  Object.assign(result, normalizeLightingSettings(source, base));
  return result;
}

module.exports = { DEFAULT_SETTINGS, normalizeCurrentSettings };
