const { Setting } = require("obsidian");
const { normalizeBridgeUrl, normalizeLightProgram, DEFAULT_LIGHT_PROGRAMS } = require("../core/lighting");
const { LIGHT_PROGRAM_TEMPLATES, describeLightStep, lightSwatchColor } = require("../core/lighting-presets");
const { makeUniqueId } = require("../core/modules");
/** @typedef {import("../../types/contracts").LightProgram} LightProgram */
/** @typedef {import("../../types/contracts").LightStep} LightStep */

/** @template T @param {T} value @returns {T} */
const clone = value => JSON.parse(JSON.stringify(value));

/** @param {ObsidianElement} container @param {any} plugin @param {(patch:Record<string,any>)=>Promise<boolean>} save */
function renderLightingSettings(container, plugin, save) {
  const card = container.createDiv({ cls:"pmd-settings-card pmd-lighting-settings" });
  card.createEl("h3", { text:"灯光联动" });
  card.createEl("p", { cls:"pmd-settings-intro", text:"计时时按方案自动调节台灯。每个工作或休息任务可在黑屏旁单独选择方案；暂停会停止变化，手动调灯会接管当前任务。" });

  /** @param {string} title @param {string} description */
  const section = (title, description) => {
    const body = card.createDiv({ cls:"pmd-lighting-section" });
    const head = body.createDiv({ cls:"pmd-lighting-section-head" });
    head.createEl("h4", { text:title });
    head.createEl("p", { cls:"pmd-settings-intro", text:description });
    const status = body.createDiv({ cls:"pmd-settings-status", attr:{ role:"status", "aria-live":"polite" } });
    return { body, status };
  };
  /** @param {ObsidianElement} status @param {()=>Promise<void>|void} action */
  const run = async (status, action) => {
    status.setText("");
    try { await action(); } catch (error) { status.setText(error instanceof Error ? error.message : String(error)); }
  };
  /** @param {ObsidianElement} parent @param {string} text @param {ObsidianElement} status @param {()=>void|Promise<void>} action */
  const button = (parent, text, status, action) => {
    const element = parent.createEl("button", { text, attr:{ type:"button" } });
    element.onclick = () => run(status, async () => { element.disabled = true; try { await action(); } finally { element.disabled = false; } });
    return element;
  };

  /** @returns {LightProgram[]} */
  const programs = () => plugin.settings.lightingPrograms || DEFAULT_LIGHT_PROGRAMS;
  /** @returns {any[]} */
  const devices = () => plugin._getDeviceBridge().devices || [];
  const activeDevice = () => devices().find(item => item.id === plugin.settings.lightingDeviceId) || devices()[0];

  /* ---- 连接与灯具 ---- */
  const connection = section("连接与灯具", "需要本机运行 DeviceBridge 菜单栏应用。修改只影响下一个任务，当前任务保留开始时的设置。");
  new Setting(connection.body).setName("启用灯光联动").setDesc("关闭后不再自动调灯，计时照常进行。")
    .addToggle(toggle => toggle.setValue(plugin.settings.lightingEnabled !== false).onChange(async value => {
      if (!await save({ lightingEnabled:value })) toggle.setValue(plugin.settings.lightingEnabled !== false);
    }));
  const connectionRow = connection.body.createDiv({ cls:"pmd-lighting-connection" });
  connectionRow.createEl("label", { text:"服务地址", cls:"pmd-field-label", attr:{ for:"pmd-lighting-address" } });
  const address = connectionRow.createEl("input", { attr:{ id:"pmd-lighting-address", type:"url", placeholder:"http://127.0.0.1:18473" } });
  address.value = plugin.settings.lightingBaseUrl || "http://127.0.0.1:18473";
  button(connectionRow, "保存并测试连接", connection.status, async () => {
    if (!await save({ lightingBaseUrl:normalizeBridgeUrl(address.value) })) throw new Error("服务地址保存失败，输入内容已保留");
    connected = await plugin.refreshLightingLibrary();
    renderAll();
  });
  const connectionState = connection.body.createDiv({ cls:"pmd-lighting-connection-state" });
  const deviceContainer = connection.body.createDiv();
  /** @type {{programs:LightProgram[], devices:any[]} | null} */
  let connected = null;
  const renderConnectionState = () => {
    connectionState.empty();
    const list = devices();
    const online = list.filter(device => device.observedState?.isOnline).length;
    const state = !connected && !list.length ? ["is-unknown", "尚未连接", "点击“保存并测试连接”读取灯具和方案库。"]
      : online ? ["is-ok", connected ? "已连接" : "已读取灯具", `${list.length} 盏灯，${online} 盏在线 · ${programs().length} 个方案`]
        : ["is-warning", "灯具离线", `已连接服务，但 ${list.length} 盏灯都不在线；请检查 Home Assistant 中的灯具。`];
    connectionState.className = `pmd-lighting-connection-state ${state[0]}`;
    connectionState.createSpan({ cls:"pmd-lighting-dot", attr:{ "aria-hidden":"true" } });
    connectionState.createSpan({ cls:"pmd-lighting-state-label", text:state[1] });
    connectionState.createSpan({ cls:"pmd-lighting-state-detail", text:state[2] });
  };
  const renderDevices = () => {
    deviceContainer.empty();
    /** @type {Record<string, string>} */
    const options = { "":"默认第一盏灯" };
    devices().forEach(device => { options[device.id] = device.name + (device.observedState?.isOnline ? "" : "（离线）"); });
    if (plugin.settings.lightingDeviceId && !options[plugin.settings.lightingDeviceId]) options[plugin.settings.lightingDeviceId] = "已选灯具（尚未连接）";
    new Setting(deviceContainer).setName("控制哪盏灯")
      .addDropdown(dropdown => dropdown.addOptions(options).setValue(plugin.settings.lightingDeviceId || "").onChange(async value => {
        if (!await save({ lightingDeviceId:value })) dropdown.setValue(plugin.settings.lightingDeviceId || "");
      }));
  };

  /* ---- 默认方案 ---- */
  const defaults = section("默认方案", "任务没有单独选择灯光方案时使用；选“不联动”则该类任务不调灯。");
  const defaultsContainer = defaults.body.createDiv();
  const renderDefaults = () => {
    defaultsContainer.empty();
    const options = Object.fromEntries([["none", "不联动"], ...programs().map(program => [program.id, program.name])]);
    for (const [name, key, fallback] of [["工作任务", "lightingDefaultWorkId", "work"], ["休息任务", "lightingDefaultRestId", "rest"]]) {
      const selected = plugin.settings[key] || fallback;
      const choices = options[selected] ? options : { ...options, [selected]:"方案已移除，请重新选择" };
      new Setting(defaultsContainer).setName(name).addDropdown(dropdown => dropdown.addOptions(choices).setValue(selected).onChange(async value => {
        if (!await save({ [key]:value })) dropdown.setValue(plugin.settings[key] || fallback);
      }));
    }
  };

  /** Coloured dots for each base light state, in order. @param {ObsidianElement} parent @param {LightProgram} program */
  const swatches = (parent, program) => {
    const row = parent.createDiv({ cls:"pmd-light-swatches", attr:{ "aria-hidden":"true" } });
    program.steps.filter(step => step.action === "state").slice(0, 4).forEach(step => {
      const color = lightSwatchColor(step.target);
      const dot = row.createSpan({ cls:`pmd-light-swatch${color ? "" : " is-off"}` });
      if (color) dot.style.background = color;
    });
  };
  /** @param {ObsidianElement} parent @param {LightProgram} program */
  const summary = (parent, program) => {
    const list = parent.createEl("ol", { cls:"pmd-light-summary" });
    program.steps.forEach(step => list.createEl("li", { text:describeLightStep(step) }));
  };
  /** @param {ObsidianElement} parent @param {string} id */
  const usageBadges = (parent, id) => {
    const badges = [];
    if ((plugin.settings.lightingDefaultWorkId || "work") === id) badges.push("默认工作");
    if ((plugin.settings.lightingDefaultRestId || "rest") === id) badges.push("默认休息");
    const tasks = (plugin.settings.modules || []).filter((/** @type {any} */ module) => module.lightProgramId === id).length;
    if (tasks) badges.push(`${tasks} 个任务使用`);
    badges.forEach(text => parent.createSpan({ cls:"pmd-light-badge", text }));
  };

  /* ---- 我的方案 ---- */
  const mine = section("我的方案", "方案保存在 DeviceBridge，可被多个任务复用。编辑后需点击保存；正在运行的任务继续使用开始时的版本。");
  const library = mine.body.createDiv({ cls:"pmd-lighting-library" });
  /** @type {LightProgram | null} */
  let draft = null;
  let dirty = false;
  let selectedId = "";
  const ensureClean = () => { if (dirty) throw new Error("请先保存或取消当前方案的修改"); };
  /** @param {LightProgram} program @param {string} [name] */
  const startCopy = (program, name=`${program.name} 副本`) => {
    ensureClean();
    const copy = clone(program);
    copy.id = makeUniqueId("light"); copy.name = name.slice(0, 80); copy.revision = 1;
    draft = copy; selectedId = ""; dirty = true; renderLibrary();
  };
  const renderLibrary = () => {
    library.empty();
    const toolbar = library.createDiv({ cls:"pmd-lighting-library-toolbar" });
    button(toolbar, "新建方案", mine.status, () => startCopy(DEFAULT_LIGHT_PROGRAMS[0], "新灯光方案"));
    button(toolbar, "从服务刷新", mine.status, async () => {
      ensureClean();
      connected = await plugin.refreshLightingLibrary(); renderAll(); mine.status.setText("方案库已刷新");
    });
    if (draft && !selectedId) {
      const item = library.createDiv({ cls:"pmd-light-program is-editing" });
      item.createDiv({ cls:"pmd-light-program-name", text:"新方案（尚未保存）" });
      renderEditor(item, draft);
    }
    const list = library.createDiv({ cls:"pmd-light-program-list", attr:{ role:"list" } });
    for (const program of programs()) {
      const editing = program.id === selectedId && draft;
      const item = list.createDiv({ cls:`pmd-light-program${editing ? " is-editing" : ""}`, attr:{ role:"listitem" } });
      const head = item.createDiv({ cls:"pmd-light-program-head" });
      swatches(head, program);
      const title = head.createDiv({ cls:"pmd-light-program-title" });
      title.createSpan({ cls:"pmd-light-program-name", text:program.name });
      usageBadges(title, program.id);
      const tools = head.createDiv({ cls:"pmd-light-program-tools" });
      if (!editing) {
        button(tools, "编辑", mine.status, () => {
          ensureClean();
          selectedId = program.id; draft = clone(program); dirty = false; renderLibrary();
        }).setAttribute("aria-label", `编辑方案「${program.name}」`);
        button(tools, "复制", mine.status, () => startCopy(program)).setAttribute("aria-label", `复制方案「${program.name}」`);
        summary(item, program);
      } else if (draft) renderEditor(item, draft);
    }
  };

  /** @param {ObsidianElement} parent @param {LightProgram} current */
  const renderEditor = (parent, current) => {
    const editor = parent.createDiv({ cls:"pmd-light-program-editor" });
    const nameField = editor.createEl("label", { cls:"pmd-light-field pmd-light-name-field" });
    nameField.createSpan({ text:"方案名称（任务选择框中显示）" });
    const name = nameField.createEl("input", { attr:{ type:"text", maxlength:"80" } });
    name.value = current.name;
    name.oninput = () => { current.name = name.value; dirty = true; };
    editor.createEl("p", { cls:"pmd-settings-intro", text:"按时间顺序执行。“开始时”的灯光必须保留；设置灯光可在指定秒数内渐变，提示类动作结束后回到当前应有的灯光。" });

    const device = activeDevice();
    const brightnessRange = device?.capabilities?.brightnessRange || [1, 100];
    const kelvinRange = device?.capabilities?.colorTempKelvinRange || [2700, 6500];
    const effects = device?.capabilities?.supportedEffects || [];
    const baseCount = current.steps.filter(step => step.action === "state" && step.trigger.kind === "elapsed" && step.trigger.value === 0).length;
    const steps = editor.createEl("ol", { cls:"pmd-light-steps" });
    current.steps.forEach((step, index) => {
      const row = steps.createEl("li", { cls:"pmd-light-step" });
      const heading = row.createDiv({ cls:"pmd-light-step-heading" });
      heading.createSpan({ cls:"pmd-light-step-index", text:String(index + 1) });
      const caption = heading.createSpan({ cls:"pmd-light-step-caption", text:describeLightStep(step) });
      const refreshCaption = () => { caption.setText(describeLightStep(step)); };
      const tools = heading.createDiv({ cls:"pmd-light-step-tools" });
      const move = (/** @type {number} */ offset) => {
        const [moving] = current.steps.splice(index, 1); current.steps.splice(index + offset, 0, moving); dirty = true; renderLibrary();
      };
      const up = button(tools, "↑", mine.status, () => move(-1));
      up.disabled = index === 0; up.setAttribute("aria-label", `上移步骤 ${index + 1}`);
      const down = button(tools, "↓", mine.status, () => move(1));
      down.disabled = index === current.steps.length - 1; down.setAttribute("aria-label", `下移步骤 ${index + 1}`);
      const isBase = step.action === "state" && step.trigger.kind === "elapsed" && step.trigger.value === 0;
      const remove = button(tools, "删除", mine.status, () => { current.steps.splice(index, 1); dirty = true; renderLibrary(); });
      remove.disabled = isBase && baseCount <= 1 || current.steps.length <= 1;
      remove.setAttribute("aria-label", `删除步骤 ${index + 1}`);
      if (remove.disabled) remove.setAttribute("title", "开始时的基础灯光不能删除");

      /** @param {ObsidianElement} group @param {string} label @param {number} value @param {(value:number)=>void} change @param {number} min @param {number} max @param {string} unit */
      const numberField = (group, label, value, change, min, max, unit) => {
        const wrap = group.createEl("label", { cls:"pmd-light-field" });
        wrap.createSpan({ text:label });
        const box = wrap.createDiv({ cls:"pmd-light-input-unit" });
        const input = box.createEl("input", { attr:{ type:"number", min:String(min), max:String(max), step:"1", inputmode:"numeric" } });
        box.createSpan({ text:unit });
        input.value = String(value);
        input.oninput = () => { change(input.value === "" ? NaN : Number(input.value)); dirty = true; refreshCaption(); };
        return input;
      };
      /** @param {ObsidianElement} group @param {string} label @param {[string, string][]} options @param {string} value @param {(value:string)=>void} change */
      const selectField = (group, label, options, value, change) => {
        const wrap = group.createEl("label", { cls:"pmd-light-field" });
        wrap.createSpan({ text:label });
        const select = wrap.createEl("select");
        options.forEach(([optionValue, text]) => select.createEl("option", { text, attr:{ value:optionValue } }));
        select.value = value;
        select.onchange = () => { change(select.value); dirty = true; renderLibrary(); };
        return select;
      };

      const when = row.createDiv({ cls:"pmd-light-step-group" });
      when.createDiv({ cls:"pmd-light-group-label", text:"何时" });
      const whenFields = when.createDiv({ cls:"pmd-light-step-fields" });
      selectField(whenFields, "触发方式", [["elapsed", "开始后经过"], ["progress", "任务进度达到"], ["remaining", "剩余时间为"]], step.trigger.kind, value => {
        step.trigger.kind = /** @type {LightStep["trigger"]["kind"]} */ (value); step.trigger.value = 0;
      });
      const isProgress = step.trigger.kind === "progress";
      numberField(whenFields, isProgress ? "进度" : "时间", step.trigger.value, value => { step.trigger.value = value; }, 0, isProgress ? 100 : 86400, isProgress ? "%" : "秒");

      const what = row.createDiv({ cls:"pmd-light-step-group" });
      what.createDiv({ cls:"pmd-light-group-label", text:"做什么" });
      const whatFields = what.createDiv({ cls:"pmd-light-step-fields" });
      selectField(whatFields, "动作", [["state", "设置灯光"], ["pulse", "轻微明暗提示"], ["blink", "开关闪烁提示"], ["warning", "暖光提醒"], ["finished", "完成提示"]], step.action, value => {
        step.action = /** @type {LightStep["action"]} */ (value);
        if (!step.target) step.target = { power:true, brightnessPct:80, colorTempKelvin:4600 };
      });
      if (step.action === "state") {
        if (!step.target) step.target = { power:true, brightnessPct:80, colorTempKelvin:4600 };
        const target = step.target;
        selectField(whatFields, "开关", [["on", "开灯"], ["off", "关灯"]], target.power ? "on" : "off", value => { target.power = value === "on"; });
        if (target.power) {
          if (effects.length || target.effect) {
            selectField(whatFields, "设备效果", [["", "自定义亮度与色温"], ...[...new Set([...effects, ...(target.effect ? [target.effect] : [])])].map(item => /** @type {[string, string]} */ ([String(item), String(item)]))],
              target.effect || "", value => { target.effect = value || undefined; if (target.effect) step.transitionMs = 0; });
          }
          if (!target.effect) {
            numberField(whatFields, "亮度", target.brightnessPct ?? 80, value => { target.brightnessPct = value; }, brightnessRange[0], brightnessRange[1], "%");
            numberField(whatFields, "色温", target.colorTempKelvin ?? 4600, value => { target.colorTempKelvin = value; }, kelvinRange[0], kelvinRange[1], "K");
            numberField(whatFields, "渐变用时", step.transitionMs / 1000, value => { step.transitionMs = value * 1000; }, 0, 3600, "秒");
            const preview = row.createDiv({ cls:"pmd-light-step-preview", attr:{ "aria-hidden":"true" } });
            preview.style.background = lightSwatchColor(target);
          }
        }
      } else {
        numberField(whatFields, "提示次数", step.repeatCount, value => { step.repeatCount = value; }, 1, 4, "次");
        numberField(whatFields, "每次时长", step.cueDurationMs / 1000, value => { step.cueDurationMs = value * 1000; }, 2, 10, "秒");
      }
    });
    const structure = editor.createDiv({ cls:"pmd-light-program-structure" });
    button(structure, "＋ 添加步骤", mine.status, () => {
      if (current.steps.length >= 32) throw new Error("一个方案最多 32 个步骤");
      current.steps.push({ id:makeUniqueId("step"), trigger:{ kind:"progress", value:70 }, action:"state", target:{ power:true, brightnessPct:50, colorTempKelvin:3500 }, transitionMs:0, repeatCount:1, cueDurationMs:2000 });
      dirty = true; renderLibrary();
    });

    const actions = editor.createDiv({ cls:"pmd-light-program-actions" });
    button(actions, "保存方案", mine.status, async () => {
      const saved = await plugin.saveLightProgram(normalizeLightProgram(current));
      selectedId = ""; draft = null; dirty = false; renderAll(); mine.status.setText(`「${saved.name}」已保存，下一个任务开始使用新版本`);
    }).addClass("mod-cta");
    button(actions, "取消", mine.status, () => { draft = null; selectedId = ""; dirty = false; renderLibrary(); });
    const spacer = actions.createDiv({ cls:"pmd-light-actions-spacer" });
    spacer.setAttribute("aria-hidden", "true");
    button(actions, "预览 60 秒", mine.status, async () => {
      await plugin.previewLightProgram(normalizeLightProgram(current));
      mine.status.setText("正在预览：把方案压缩到 60 秒执行，结束后保持当前灯光");
    });
    button(actions, "停止预览", mine.status, async () => { await plugin._getDeviceBridge().stopPreview(); mine.status.setText("预览已停止"); });
    if (selectedId) button(actions, "删除方案", mine.status, async () => {
      await plugin.deleteLightProgram(current); draft = null; selectedId = ""; dirty = false; renderAll(); mine.status.setText("方案已删除");
    }).addClass("mod-warning");
  };

  /* ---- 常用方案 ---- */
  const presets = section("常用方案", "添加到“我的方案”后，可在任务或默认方案中选择，也可以继续编辑。需先连接 DeviceBridge。");
  const templateList = presets.body.createDiv({ cls:"pmd-light-templates" });
  /** @param {LightProgram} program */
  const addTemplate = async program => {
    await plugin.saveLightProgram(normalizeLightProgram(clone(program)));
  };
  const renderTemplates = () => {
    templateList.empty();
    const existing = new Set(programs().map(program => program.id));
    const missing = LIGHT_PROGRAM_TEMPLATES.filter(template => !existing.has(template.program.id));
    for (const template of LIGHT_PROGRAM_TEMPLATES) {
      const item = templateList.createDiv({ cls:"pmd-light-template" });
      const head = item.createDiv({ cls:"pmd-light-program-head" });
      swatches(head, template.program);
      const title = head.createDiv({ cls:"pmd-light-program-title" });
      title.createSpan({ cls:"pmd-light-program-name", text:template.program.name });
      title.createSpan({ cls:`pmd-light-badge is-${template.use}`, text:template.use === "rest" ? "适合休息" : "适合工作" });
      item.createEl("p", { cls:"pmd-light-template-desc", text:template.description });
      summary(item, template.program);
      if (existing.has(template.program.id)) item.createDiv({ cls:"pmd-light-template-added", text:"✓ 已在我的方案" });
      else button(item, "添加到我的方案", presets.status, async () => {
        await addTemplate(template.program);
        renderAll(); presets.status.setText(`已添加「${template.program.name}」`);
      }).setAttribute("aria-label", `添加常用方案「${template.program.name}」`);
    }
    presets.body.querySelector(".pmd-light-templates-all")?.remove();
    if (missing.length > 1) {
      button(presets.body, `全部添加（${missing.length} 个）`, presets.status, async () => {
        try { for (const template of missing) await addTemplate(template.program); }
        finally { renderAll(); }
        presets.status.setText(`已添加 ${missing.length} 个常用方案`);
      }).addClass("pmd-light-templates-all");
    }
  };

  const renderAll = () => { renderConnectionState(); renderDevices(); renderDefaults(); renderLibrary(); renderTemplates(); };
  renderAll();
  return () => { void plugin._getDeviceBridge().stopPreview?.().catch(() => {}); };
}
module.exports = { renderLightingSettings };
