/** @typedef {import("../../types/contracts").LightProgram} LightProgram */
/** @typedef {import("../../types/contracts").LightingSnapshot} LightingSnapshot */
/** @typedef {Record<string, any>} AnyRecord */

/** @param {string} id @param {string} name @param {boolean} power @param {number} [brightnessPct] @param {number} [colorTempKelvin] @returns {LightProgram} */
function fixedProgram(id, name, power, brightnessPct, colorTempKelvin) {
  return { id, name, revision:1, steps:[{ id:"start", trigger:{ kind:"elapsed", value:0 }, action:"state",
    target:power ? { power, brightnessPct, colorTempKelvin } : { power }, transitionMs:0, repeatCount:1, cueDurationMs:2000 }] };
}
const DEFAULT_LIGHT_PROGRAMS = [
  fixedProgram("work", "工作模式", true, 80, 4600), fixedProgram("rest", "休息关闭", false),
  fixedProgram("reading", "阅读模式", true, 100, 4000), fixedProgram("warm", "温馨夜读", true, 40, 2700)
];

/** @param {unknown} value @returns {LightProgram} */
function normalizeLightProgram(value) {
  const input = /** @type {AnyRecord} */ (value);
  if (!input || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id || "") || !String(input.name || "").trim()
    || String(input.name).trim().length > 80 || !Number.isInteger(input.revision) || input.revision < 1
    || !Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 32) throw new Error("方案名称、版本或步骤数量无效");
  const ids = new Set();
  const steps = input.steps.map((/** @type {AnyRecord} */ item) => {
    if (!item || !String(item.id || "").trim() || ids.has(item.id)) throw new Error("步骤标识无效或重复");
    ids.add(item.id);
    const kind = item.trigger?.kind;
    const value = Number(item.trigger?.value);
    if (!["elapsed", "progress", "remaining"].includes(kind) || !Number.isFinite(value) || value < 0
      || value > (kind === "progress" ? 100 : 86400)) throw new Error("步骤触发时间无效");
    if (!["state", "pulse", "blink", "warning", "finished"].includes(item.action)) throw new Error("灯光动作无效");
    const transitionMs = Number(item.transitionMs ?? 0), repeatCount = Number(item.repeatCount ?? 1), cueDurationMs = Number(item.cueDurationMs ?? 2000);
    if (!Number.isFinite(transitionMs) || transitionMs < 0 || transitionMs > 3600000 || !Number.isInteger(repeatCount)
      || repeatCount < 1 || repeatCount > 4 || !Number.isFinite(cueDurationMs) || cueDurationMs < 2000 || cueDurationMs > 10000) throw new Error("变化时长或提示次数无效（每次提示至少 2 秒）");
    /** @type {import("../../types/contracts").LightStep} */
    const step = { id:String(item.id), trigger:{ kind, value }, action:item.action, transitionMs, repeatCount, cueDurationMs };
    if (item.action === "state") {
      const target = item.target;
      if (!target || typeof target.power !== "boolean") throw new Error("请选择开灯或关灯");
      step.target = { power:target.power };
      if (target.power) {
        if (target.brightnessPct != null) {
          if (!Number.isInteger(target.brightnessPct) || target.brightnessPct < 1 || target.brightnessPct > 100) throw new Error("亮度须为 1–100 的整数");
          step.target.brightnessPct = target.brightnessPct;
        }
        if (target.colorTempKelvin != null) {
          if (!Number.isInteger(target.colorTempKelvin) || target.colorTempKelvin < 1000 || target.colorTempKelvin > 10000) throw new Error("色温无效");
          step.target.colorTempKelvin = target.colorTempKelvin;
        }
        if (target.effect) step.target.effect = String(target.effect);
      }
    }
    return step;
  });
  if (!steps.some(step => step.action === "state" && step.trigger.kind === "elapsed" && step.trigger.value === 0)) throw new Error("请保留任务开始时的基础灯光步骤");
  return { id:input.id, name:String(input.name).trim(), revision:input.revision, steps };
}

/** @param {unknown} value @returns {LightingSnapshot | null} */
function normalizeLightingSnapshot(value) {
  try {
    const source = /** @type {AnyRecord} */ (value);
    if (!source || typeof source.deviceId !== "string") return null;
    return { deviceId:source.deviceId, ...(source.baseUrl ? { baseUrl:normalizeBridgeUrl(source.baseUrl) } : {}), program:normalizeLightProgram(source.program) };
  } catch { return null; }
}

/** @param {AnyRecord} module @param {AnyRecord} settings @returns {LightingSnapshot | null} */
function createLightingSnapshot(module, settings) {
  if (module.lightProgramId === "none") return null;
  const id = module.lightProgramId || (module.type === "rest" ? settings.lightingDefaultRestId || "rest" : settings.lightingDefaultWorkId || "work");
  if (id === "none") return null;
  const programs = Array.isArray(settings.lightingPrograms) ? settings.lightingPrograms : DEFAULT_LIGHT_PROGRAMS;
  const program = programs.find((/** @type {AnyRecord} */ item) => item.id === id);
  return program ? { deviceId:String(settings.lightingDeviceId || ""), baseUrl:normalizeBridgeUrl(settings.lightingBaseUrl), program:normalizeLightProgram(program) } : null;
}

/** @param {unknown} input @returns {string} */
function normalizeBridgeUrl(input) {
  const url = new URL(String(input || "http://127.0.0.1:18473"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("服务地址须为 HTTP 或 HTTPS 地址");
  return url.href.replace(/\/+$/, "");
}

/** @param {AnyRecord} source @param {AnyRecord} base */
function normalizeLightingSettings(source, base) {
  let lightingBaseUrl;
  try { lightingBaseUrl = normalizeBridgeUrl(source.lightingBaseUrl ?? base.lightingBaseUrl); }
  catch { lightingBaseUrl = normalizeBridgeUrl(base.lightingBaseUrl); }
  const programs = source.lightingPrograms ?? base.lightingPrograms ?? DEFAULT_LIGHT_PROGRAMS;
  /** @type {LightProgram[]} */
  const lightingPrograms = [];
  const ids = new Set();
  for (const input of Array.isArray(programs) ? programs.slice(0, 128) : DEFAULT_LIGHT_PROGRAMS) {
    try { const program = normalizeLightProgram(input); if (!ids.has(program.id)) { ids.add(program.id); lightingPrograms.push(program); } } catch { /* Invalid cached assets are never executed. */ }
  }
  return { lightingEnabled:typeof source.lightingEnabled === "boolean" ? source.lightingEnabled : base.lightingEnabled !== false,
    lightingBaseUrl, lightingDeviceId:String(source.lightingDeviceId ?? base.lightingDeviceId ?? ""),
    lightingDefaultWorkId:String(source.lightingDefaultWorkId ?? base.lightingDefaultWorkId ?? "work"),
    lightingDefaultRestId:String(source.lightingDefaultRestId ?? base.lightingDefaultRestId ?? "rest"), lightingPrograms };
}

module.exports = { DEFAULT_LIGHT_PROGRAMS, normalizeLightProgram, normalizeLightingSnapshot, createLightingSnapshot, normalizeBridgeUrl, normalizeLightingSettings };
