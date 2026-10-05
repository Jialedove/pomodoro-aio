const { Setting } = require("obsidian");
const { normalizeBridgeUrl, normalizeLightProgram, DEFAULT_LIGHT_PROGRAMS } = require("../core/lighting");
const { makeUniqueId } = require("../core/modules");
/** @typedef {import("../../types/contracts").LightProgram} LightProgram */
/** @typedef {import("../../types/contracts").LightStep} LightStep */

/** @param {ObsidianElement} container @param {any} plugin @param {(patch:Record<string,any>)=>Promise<boolean>} save */
function renderLightingSettings(container, plugin, save) {
  const card = container.createDiv({ cls:"pmd-settings-card pmd-lighting-settings" });
  card.createEl("h3", { text:"灯光联动" });
  card.createEl("p", { cls:"pmd-settings-intro", text:"每个工作或休息任务都可以在黑屏按钮旁选择灯光方案。暂停会停止变化，手动调灯会接管当前任务。" });
  const status = card.createDiv({ cls:"pmd-settings-status", attr:{ role:"status", "aria-live":"polite" } });
  /** @param {()=>Promise<void>} action */
  const run = async action => {
    status.setText("");
    try { await action(); } catch (error) { status.setText(error instanceof Error ? error.message : String(error)); }
  };
  new Setting(card).setName("启用灯光联动").setDesc("关闭后停止自动灯光编排，番茄计时继续运行。")
    .addToggle(toggle => toggle.setValue(plugin.settings.lightingEnabled !== false).onChange(async value => {
      if (!await save({ lightingEnabled:value })) toggle.setValue(plugin.settings.lightingEnabled !== false);
    }));
  const connection = card.createDiv({ cls:"pmd-lighting-connection" });
  const addressLabel = connection.createEl("label", { text:"服务地址", attr:{ for:"pmd-lighting-address" } });
  addressLabel.addClass("pmd-field-label");
  const address = connection.createEl("input", { attr:{ id:"pmd-lighting-address", type:"url", placeholder:"http://127.0.0.1:18473" } });
  address.value = plugin.settings.lightingBaseUrl || "http://127.0.0.1:18473";
  const connect = connection.createEl("button", { text:"保存并测试连接", attr:{ type:"button" } });
  connect.onclick = () => run(async () => {
    connect.disabled = true;
    try {
      if (!await save({ lightingBaseUrl:normalizeBridgeUrl(address.value) })) throw new Error("服务地址保存失败，输入内容已保留");
      const result = await plugin.refreshLightingLibrary();
      status.setText(`服务已连接 · ${result.programs.length} 个方案 · ${result.devices.length} 盏灯${result.devices.some((/** @type {any} */ device) => device.observedState?.isOnline) ? "" : " · 灯具当前离线"}`);
      renderDevices(); renderDefaults(); renderLibrary();
    } finally { connect.disabled = false; }
  });
  const deviceContainer = card.createDiv();
  const defaultsContainer = card.createDiv({ cls:"pmd-lighting-defaults" });
  const library = card.createDiv({ cls:"pmd-lighting-library" });
  /** @type {LightProgram | null} */
  let draft = null;
  let dirty = false;
  let selectedId = "";
  /** @returns {LightProgram[]} */
  const programs = () => plugin.settings.lightingPrograms || DEFAULT_LIGHT_PROGRAMS;
  const renderDevices = () => {
    deviceContainer.empty();
    /** @type {Record<string, string>} */
    const options = { "":"默认第一盏灯" };
    const devices = plugin._getDeviceBridge().devices || [];
    devices.forEach((/** @type {any} */ device) => { options[device.id] = device.name + (device.observedState?.isOnline ? "" : "（离线）"); });
    if (plugin.settings.lightingDeviceId && !options[plugin.settings.lightingDeviceId]) options[plugin.settings.lightingDeviceId] = "已选灯具（尚未连接）";
    new Setting(deviceContainer).setName("控制灯具").setDesc("变更用于下次任务；当前任务保留开始时的灯具。")
      .addDropdown(dropdown => dropdown.addOptions(options).setValue(plugin.settings.lightingDeviceId || "").onChange(async value => {
        if (!await save({ lightingDeviceId:value })) dropdown.setValue(plugin.settings.lightingDeviceId || "");
      }));
  };
  const renderDefaults = () => {
    defaultsContainer.empty();
    const options = Object.fromEntries([["none", "不联动"], ...programs().map(program => [program.id, program.name])]);
    for (const [name, key, fallback] of [["默认工作方案", "lightingDefaultWorkId", "work"], ["默认休息方案", "lightingDefaultRestId", "rest"]]) {
      const selected = plugin.settings[key] || fallback;
      if (!options[selected]) options[selected] = "方案已移除，请重新选择";
      new Setting(defaultsContainer).setName(name).addDropdown(dropdown => dropdown.addOptions(options).setValue(selected).onChange(async value => {
        if (!await save({ [key]:value })) dropdown.setValue(plugin.settings[key] || fallback);
      }));
    }
  };
  /** @param {ObsidianElement} parent @param {string} text @param {()=>void|Promise<void>} action */
  const button = (parent, text, action) => {
    const element = parent.createEl("button", { text, attr:{ type:"button" } });
    element.onclick = () => run(async () => { element.disabled = true; try { await action(); } finally { element.disabled = false; } });
    return element;
  };
  const renderLibrary = () => {
    library.empty();
    library.createEl("h4", { text:"灯光方案库" });
    const toolbar = library.createDiv({ cls:"pmd-lighting-library-toolbar" });
    const selector = toolbar.createEl("select", { attr:{ "aria-label":"编辑灯光方案" } });
    selector.createEl("option", { text:"选择要编辑的方案", attr:{ value:"" } });
    programs().forEach(program => selector.createEl("option", { text:program.name, attr:{ value:program.id } }));
    selector.value = selectedId;
    selector.onchange = () => {
      if (dirty) { selector.value = selectedId; status.setText("请先保存或取消当前方案修改"); return; }
      selectedId = selector.value;
      draft = selectedId ? JSON.parse(JSON.stringify(programs().find(program => program.id === selectedId))) : null;
      renderLibrary();
    };
    button(toolbar, "新建", () => {
      if (dirty) throw new Error("请先保存或取消当前方案修改");
      const created = /** @type {LightProgram} */ (JSON.parse(JSON.stringify(DEFAULT_LIGHT_PROGRAMS[0])));
      created.id = makeUniqueId("light"); created.name = "新灯光方案"; created.revision = 1; draft = created;
      selectedId = ""; dirty = true; renderLibrary();
    });
    button(toolbar, "刷新", async () => {
      if (dirty) throw new Error("请先保存或取消当前方案修改");
      await plugin.refreshLightingLibrary(); renderDevices(); renderDefaults(); renderLibrary(); status.setText("方案库已刷新");
    });
    if (!draft) { library.createEl("p", { cls:"pmd-settings-intro", text:"方案可由多个任务复用。编辑后点击保存，当前运行的任务继续使用开始时版本。" }); return; }
    const current = draft;
    const editor = library.createDiv({ cls:"pmd-light-program-editor" });
    const nameLabel = editor.createEl("label", { text:"方案名称", cls:"pmd-field-label", attr:{ for:"pmd-light-program-name" } });
    nameLabel.setAttribute("title", "任务选择框中显示的名称");
    const name = editor.createEl("input", { attr:{ id:"pmd-light-program-name", type:"text", maxlength:"80" } });
    name.value = current.name;
    name.oninput = () => { current.name = name.value; dirty = true; };
    editor.createEl("p", { cls:"pmd-settings-intro", text:"步骤按任务的有效进度触发。分段渐变每秒调整一次；短暂提示结束后回到当前应有灯光。" });
    const steps = editor.createDiv({ cls:"pmd-light-steps" });
    /** @param {ObsidianElement} parent @param {string} label @param {number} value @param {(value:number)=>void} change @param {number} [min] @param {number} [max] */
    const numberField = (parent, label, value, change, min = 0, max = 86400) => {
      const wrap = parent.createEl("label", { cls:"pmd-light-field" }); wrap.createSpan({ text:label });
      const input = wrap.createEl("input", { attr:{ type:"number", min:String(min), max:String(max), step:"1" } });
      input.value = String(value);
      input.oninput = () => { change(input.value === "" ? NaN : Number(input.value)); dirty = true; };
      return input;
    };
    current.steps.forEach((step, index) => {
      const row = steps.createDiv({ cls:"pmd-light-step" });
      const heading = row.createDiv({ cls:"pmd-light-step-heading" }); heading.createSpan({ text:`步骤 ${index + 1}` });
      const tools = heading.createDiv({ cls:"pmd-light-step-tools" });
      const move = (/** @type {number} */ offset) => {
        const target = index + offset;
        if (target < 0 || target >= current.steps.length) return;
        const [moving] = current.steps.splice(index, 1); current.steps.splice(target, 0, moving); dirty = true; renderLibrary();
      };
      button(tools, "上移", () => move(-1)).disabled = index === 0;
      button(tools, "下移", () => move(1)).disabled = index === current.steps.length - 1;
      button(tools, "删除", () => { current.steps.splice(index, 1); dirty = true; renderLibrary(); });
      const fields = row.createDiv({ cls:"pmd-light-step-fields" });
      const triggerWrap = fields.createEl("label", { cls:"pmd-light-field" }); triggerWrap.createSpan({ text:"触发时机" });
      const trigger = triggerWrap.createEl("select");
      for (const [value, text] of [["elapsed", "开始后（秒）"], ["progress", "任务进度（%）"], ["remaining", "剩余时间（秒）"]]) trigger.createEl("option", { text, attr:{ value } });
      trigger.value = step.trigger.kind;
      trigger.onchange = () => { step.trigger.kind = /** @type {LightStep["trigger"]["kind"]} */ (trigger.value); step.trigger.value = 0; dirty = true; renderLibrary(); };
      numberField(fields, step.trigger.kind === "progress" ? "进度（%）" : "时间（秒）", step.trigger.value, value => { step.trigger.value = value; }, 0, step.trigger.kind === "progress" ? 100 : 86400);
      const actionWrap = fields.createEl("label", { cls:"pmd-light-field" }); actionWrap.createSpan({ text:"动作" });
      const action = actionWrap.createEl("select");
      for (const [value, text] of [["state", "设置灯光"], ["pulse", "轻微明暗提示"], ["blink", "开关提示"], ["warning", "暖光提醒"], ["finished", "完成提示"]]) action.createEl("option", { text, attr:{ value } });
      action.value = step.action;
      action.onchange = () => { step.action = /** @type {LightStep["action"]} */ (action.value); if (!step.target) step.target = { power:true, brightnessPct:80, colorTempKelvin:4600 }; dirty = true; renderLibrary(); };
      if (step.action === "state") {
        if (!step.target) step.target = { power:true, brightnessPct:80, colorTempKelvin:4600 };
        const target = step.target;
        const powerWrap = fields.createEl("label", { cls:"pmd-light-field" }); powerWrap.createSpan({ text:"开关" });
        const power = powerWrap.createEl("select"); power.createEl("option", { text:"开灯", attr:{ value:"on" } }); power.createEl("option", { text:"关灯", attr:{ value:"off" } }); power.value = target.power ? "on" : "off";
        power.onchange = () => { target.power = power.value === "on"; dirty = true; renderLibrary(); };
        if (target.power) {
          const device = (plugin._getDeviceBridge().devices || []).find((/** @type {any} */ item) => item.id === plugin.settings.lightingDeviceId) || plugin._getDeviceBridge().devices?.[0];
          const brightness = numberField(fields, "亮度（%）", target.brightnessPct ?? 80, value => { target.brightnessPct = value; }, device?.capabilities?.brightnessRange?.[0] || 1, device?.capabilities?.brightnessRange?.[1] || 100);
          const temperature = numberField(fields, "色温（K）", target.colorTempKelvin ?? 4600, value => { target.colorTempKelvin = value; }, device?.capabilities?.colorTempKelvinRange?.[0] || 2700, device?.capabilities?.colorTempKelvinRange?.[1] || 6500);
          const transition = numberField(fields, "分段渐变（秒）", step.transitionMs / 1000, value => { step.transitionMs = value * 1000; }, 0, 3600);
          const effects = device?.capabilities?.supportedEffects || [];
          if (effects.length || target.effect) {
            const wrap = fields.createEl("label", { cls:"pmd-light-field" }); wrap.createSpan({ text:"设备效果" });
            const effect = wrap.createEl("select"); effect.createEl("option", { text:"自定义亮度与色温", attr:{ value:"" } });
            for (const name of new Set([...effects, ...(target.effect ? [target.effect] : [])])) effect.createEl("option", { text:String(name), attr:{ value:String(name) } });
            effect.value = target.effect || "";
            effect.onchange = () => { target.effect = effect.value || undefined; if (target.effect) step.transitionMs = 0; dirty = true; renderLibrary(); };
          }
          brightness.disabled = !!target.effect; temperature.disabled = !!target.effect; transition.disabled = !!target.effect;
        }
      } else {
        numberField(fields, "提示次数", step.repeatCount, value => { step.repeatCount = value; }, 1, 4);
        numberField(fields, "每次时长（秒）", step.cueDurationMs / 1000, value => { step.cueDurationMs = value * 1000; }, 2, 10);
      }
    });
    const structure = editor.createDiv({ cls:"pmd-light-program-structure" });
    button(structure, "添加步骤", () => {
      if (current.steps.length >= 32) throw new Error("一个方案最多 32 个步骤");
      current.steps.push({ id:makeUniqueId("step"), trigger:{ kind:"progress", value:70 }, action:"state", target:{ power:true, brightnessPct:50, colorTempKelvin:3500 }, transitionMs:0, repeatCount:1, cueDurationMs:2000 }); dirty = true; renderLibrary();
    });
    button(structure, "复制方案", () => { current.id = makeUniqueId("light"); current.name += " 副本"; current.revision = 1; selectedId = ""; dirty = true; renderLibrary(); });
    const actions = editor.createDiv({ cls:"pmd-light-program-actions" });
    button(actions, "保存方案", async () => {
      const saved = await plugin.saveLightProgram(normalizeLightProgram(current));
      selectedId = saved.id; draft = JSON.parse(JSON.stringify(saved)); dirty = false; renderDefaults(); renderLibrary(); status.setText("灯光方案已保存，下次任务使用新版本");
    }).addClass("mod-cta");
    button(actions, "取消修改", () => { draft = null; selectedId = ""; dirty = false; renderLibrary(); status.setText("已取消修改"); });
    const preview = editor.createDiv({ cls:"pmd-light-preview" });
    button(preview, "预览 60 秒", async () => { await plugin.previewLightProgram(normalizeLightProgram(current)); status.setText("正在预览；进度按 60 秒任务计算，停止后保持当前灯光"); });
    button(preview, "停止预览", async () => { await plugin._getDeviceBridge().stopPreview(); status.setText("预览已停止"); });
    if (selectedId) button(preview, "删除方案", async () => { await plugin.deleteLightProgram(current); draft = null; selectedId = ""; dirty = false; renderDefaults(); renderLibrary(); status.setText("方案已删除"); });
  };
  renderDevices(); renderDefaults(); renderLibrary();
  return () => { void plugin._getDeviceBridge().stopPreview?.().catch(() => {}); };
}
module.exports = { renderLightingSettings };
