const { normalizeModuleDefinition, normalizeRestPresets } = require("./modules");

/** @param {{modules:Record<string, any>[],restPresets:string[]}} settings */
function moduleDraftSignature(settings) {
  return JSON.stringify({ modules:settings.modules || [], restPresets:normalizeRestPresets(settings.restPresets) });
}

/** @param {{modules:Record<string, any>[],restPresets:string[]}} settings */
function createModuleDraft(settings) {
  return {
    baseSignature:moduleDraftSignature(settings),
    modules:(settings.modules || []).map(module => ({ ...module })),
    restPresetsText:normalizeRestPresets(settings.restPresets).join("\n")
  };
}

/** @param {{baseSignature:string,modules:Record<string, any>[],restPresetsText:string}} draft @param {{modules:Record<string, any>[],restPresets:string[]}} settings */
function prepareModuleDraft(draft, settings) {
  if (draft.baseSignature !== moduleDraftSignature(settings)) {
    throw new Error("模块设置已在其他地方变化；请取消后重新进入设置");
  }
  if (!Array.isArray(draft.modules)) throw new Error("模块列表无效");
  const ids = new Set();
  const modules = draft.modules.map((module, index) => {
    if (!module || !["work", "rest"].includes(module.type) || !String(module.id || "").trim() || ids.has(module.id)) {
      throw new Error(`第 ${index + 1} 个模块无效`);
    }
    ids.add(module.id);
    if (module.invalidWorkspace === true) throw new Error(`第 ${index + 1} 个模块的工作区须从候选中选择`);
    const duration = Number(module.durationMin);
    if (!Number.isFinite(duration) || duration < 1) throw new Error(`第 ${index + 1} 个模块的时长须大于零`);
    return normalizeModuleDefinition(module);
  });
  const restPresets = normalizeRestPresets(String(draft.restPresetsText || "").split(/\r?\n/));
  return { modules, restPresets };
}

module.exports = { moduleDraftSignature, createModuleDraft, prepareModuleDraft };
