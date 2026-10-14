const { PluginSettingTab, Setting, Notice } = require("obsidian");
const { positiveNumber, normalizeTag } = require("../core/validation");
const { normalizeRestPresets } = require("../core/modules");
const { renderLightingSettings } = require("./lighting-settings");
/** @typedef {import("../../types/contracts").Settings} Settings */

class PomodoroSettingTab extends PluginSettingTab {
  /** @param {any} app @param {any} plugin @param {(raw?:Record<string, any>, fallback?:Settings)=>Settings} normalizeSettings */
  constructor(app, plugin, normalizeSettings) {
    super(app, plugin);
    this.plugin = plugin;
    this.normalizeSettings = normalizeSettings;
    /** @type {(() => void) | null} */
    this._stopLightingPreview = null;
  }

  display() {
    this._stopLightingPreview?.();
    const c = this.containerEl;
    c.empty();
    c.addClass("pmd-settings-page");
    c.createEl("h2", { text: "Pomodoro AIO 设置" });

    /** @param {Partial<Settings>} patch */
    const set = async patch => {
      const previous = { ...this.plugin.settings };
      const next = this.normalizeSettings({ ...this.plugin.settings, ...patch }, this.plugin.settings);
      if (patch.dayStartHHMM !== undefined && next.dayStartHHMM !== patch.dayStartHHMM) new Notice("一天开始时间格式无效，已保留原值");
      if (patch.fallbackPattern !== undefined && next.fallbackPattern !== String(patch.fallbackPattern || "").trim()) new Notice("当日路径必须是规范的 Markdown 路径，已保留原值");
      if (patch.capturePathPattern !== undefined && String(patch.capturePathPattern || "").trim() && !next.capturePathPattern) new Notice("快速记录目标路径必须是规范的 Markdown 路径，已清空为当日日记");
      Object.assign(this.plugin.settings, next);
      try {
        await this.plugin.saveSettings();
        this.plugin.broadcast();
        if (patch.enableProjects === true && previous.enableProjects !== true) {
          await this.plugin.drainProjectQueue();
        }
        return true;
      } catch (error) {
        Object.assign(this.plugin.settings, previous);
        new Notice("设置保存失败，请稍后重试");
        console.error("Pomodoro AIO 设置保存失败", error);
        return false;
      }
    };

    /** @param {string} title @param {string} [description] */
    const section = (title, description = "") => {
      const panel = c.createDiv({ cls:"pmd-settings-card" });
      panel.createEl("h3", { text:title });
      if (description) panel.createEl("p", { cls:"pmd-settings-intro", text:description });
      return panel;
    };
    const cycle = section("循环与休息事项", "配置模块之间如何衔接，以及休息事项候选。");
    new Setting(cycle).setName("模块完成后").setDesc("选择自动开始下一段，或等待你确认后再继续。")
      .addDropdown(dropdown => {
        dropdown.addOptions({ wait: "等待确认", automatic: "自动开始下一段" });
        dropdown.setValue(this.plugin.settings.autoAdvance === true ? "automatic" : "wait");
        dropdown.onChange(value => set({ autoAdvance: value === "automatic" }));
      });
    new Setting(cycle).setName("序列结束后").setDesc("可以从第一个模块重新循环，也可以结束序列。")
      .addDropdown(dropdown => {
        dropdown.addOptions({ infinite: "从头继续循环", once: "执行一次后停止", count: "执行指定次数" });
        dropdown.setValue(["infinite", "once", "count"].includes(this.plugin.settings.loopMode) ? this.plugin.settings.loopMode : "infinite");
        dropdown.onChange(async value => {
          await set({ loopMode: /** @type {"infinite"|"once"|"count"} */ (value) });
          dropdown.setValue(this.plugin.settings.loopMode);
          renderLoopCount();
        });
      });
    const loopDetails = cycle.createDiv();
    const renderLoopCount = () => {
      loopDetails.empty();
      if (this.plugin.settings.loopMode !== "count") return;
      new Setting(loopDetails).setName("循环次数").setDesc("完整执行序列的次数；第一次完整通过记为 1 次。")
        .addText(text => text.setValue(String(this.plugin.settings.loopCount || 1)).onChange(value => set({ loopCount: Math.max(1, Math.round(positiveNumber(value, 1))) })));
    };
    renderLoopCount();

    cycle.createEl("h4", { text:"休息事项候选" });
    const presets = cycle.createDiv({ cls:"pmd-settings-presets" });
    presets.createEl("label", { text:"预设休息事项（每行一项）", attr:{ for:"pmd-settings-rest-presets" } });
    const presetInput = presets.createEl("textarea", { attr:{ id:"pmd-settings-rest-presets", rows:"5" } });
    presetInput.value = (this.plugin.settings.restPresets || []).join("\n");
    const savePresets = presets.createEl("button", { cls:"mod-cta", text:"保存休息事项", attr:{ type:"button" } });
    const presetStatus = presets.createDiv({ attr:{ role:"status", "aria-live":"polite" } });
    savePresets.onclick = async () => {
      savePresets.disabled = true;
      const ok = await set({ restPresets:normalizeRestPresets(presetInput.value.split(/\r?\n/)) });
      presetStatus.setText(ok ? "休息事项已保存" : "保存失败，改动仍在输入框中");
      savePresets.disabled = false;
    };

    this._stopLightingPreview = renderLightingSettings(c, this.plugin, set);
    const projects = section("项目统计", "项目关联与计时模块独立，按需开启。");
    new Setting(projects).setName("推进中的项目").setDesc("启用独立项目页面，并允许工作模块关联项目、汇总项目番茄。关闭后不显示项目入口。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.enableProjects === true).onChange(async value => {
        await set({ enableProjects: value });
        toggle.setValue(this.plugin.settings.enableProjects === true);
        renderProjectDetails();
      }));
    const projectDetails = projects.createDiv();
    const renderProjectDetails = () => {
      projectDetails.empty();
      if (this.plugin.settings.enableProjects !== true) return;
      new Setting(projectDetails).setName("项目标签").addText(text => text.setValue(this.plugin.settings.projectTag || "#project")
        .onChange(value => set({ projectTag:normalizeTag(value) || "#project" })));
      new Setting(projectDetails).setName("项目状态字段").addText(text => text.setValue(this.plugin.settings.projectStatusKey || "项目状态")
        .onChange(value => set({ projectStatusKey:value || "项目状态" })));
      new Setting(projectDetails).setName("允许的项目状态").setDesc("逗号分隔，例如：进行中,筹划中")
        .addText(text => text.setValue(this.plugin.settings.projectStatusWhitelist || "进行中,筹划中")
          .onChange(value => set({ projectStatusWhitelist:value || "进行中,筹划中" })));
      new Setting(projectDetails).setName("项目番茄字段").addText(text => text.setValue(this.plugin.settings.projectFmKey || "番茄数")
        .onChange(value => set({ projectFmKey:value || "番茄数" })));
    };
    renderProjectDetails();

    const daily = section("日记与快速记录", "设置计时记录的日期、文件路径和写入位置。");
    new Setting(daily).setName("一天开始时间（HH:MM）").setDesc("例：04:00；在 04:00 前完成的番茄记在前一天。")
      .addText(text => text.setValue(this.plugin.settings.dayStartHHMM || "00:00").onChange(value => set({ dayStartHHMM: value || "00:00" })));
    new Setting(daily).setName("当日路径模板").setDesc("使用 {{date:YYYY-MM-DD}}，例如 Daily/{{date:YYYY-MM-DD}}.md。")
      .addText(text => text.setValue(this.plugin.settings.fallbackPattern || "Daily/{{date:YYYY-MM-DD}}.md").onChange(value => set({ fallbackPattern: value || "Daily/{{date:YYYY-MM-DD}}.md" })));
    new Setting(daily).setName("找不到当天文件时自动创建").addToggle(toggle => toggle.setValue(this.plugin.settings.allowCreateDaily === true).onChange(value => set({ allowCreateDaily: value })));
    new Setting(daily).setName("番茄汇总 frontmatter 键").addText(text => text.setValue(this.plugin.settings.fmKey || "番茄数").onChange(value => set({ fmKey: value || "番茄数" })));
    new Setting(daily).setName("快速记录标题").setDesc("待办与想法写入当日日记的此标题下。")
      .addText(text => text.setValue(this.plugin.settings.captureHeading || "Inbox").onChange(value => set({ captureHeading: value || "Inbox" })));
    new Setting(daily).setName("快速记录目标路径模板").setDesc("留空时写入当日日记；可使用 {{date:YYYY-MM-DD}}。")
      .addText(text => text.setValue(this.plugin.settings.capturePathPattern || "").onChange(value => set({ capturePathPattern: value })));
    new Setting(daily).setName("找不到同名日记任务时自动创建").addToggle(toggle => toggle.setValue(this.plugin.settings.allowAutoCreateTask === true).onChange(value => set({ allowAutoCreateTask: value })));
    new Setting(daily).setName("新任务插入标题").setDesc("留空时使用现有日记写入规则。")
      .addText(text => text.setValue(this.plugin.settings.tasksHeading || "").onChange(value => set({ tasksHeading: value })));

    const alerts = section("提醒与目标");
    new Setting(alerts).setName("系统通知").addToggle(toggle => toggle.setValue(this.plugin.settings.enableNotify !== false).onChange(value => set({ enableNotify: value })));
    new Setting(alerts).setName("提示音").addToggle(toggle => toggle.setValue(this.plugin.settings.enableSound !== false).onChange(value => {
      set({ enableSound: value });
      if (!value) this.plugin.stopPersistentAlertSound();
      else if (this.plugin.runtime.attention) this.plugin.startPersistentAlertSound();
    }));
    new Setting(alerts).setName("到点后持续提醒").setDesc("直到你开始下一段或处理提醒。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.persistentAlertSound === true).onChange(value => {
        set({ persistentAlertSound: value });
        if (!value) this.plugin.stopPersistentAlertSound();
        else if (this.plugin.runtime.attention) this.plugin.startPersistentAlertSound();
      }));
    new Setting(alerts).setName("持续提醒升级延迟（秒）")
      .addText(text => text.setValue(String(this.plugin.settings.strongAlertDelaySec || 30)).onChange(value => {
        set({ strongAlertDelaySec: Math.max(1, Math.round(positiveNumber(value, 30))) });
        this._restartStrongAlert();
      }));
    new Setting(alerts).setName("持续提醒重复间隔（秒）")
      .addText(text => text.setValue(String(this.plugin.settings.strongAlertIntervalSec || 60)).onChange(value => {
        set({ strongAlertIntervalSec: Math.max(1, Math.round(positiveNumber(value, 60))) });
        this._restartStrongAlert();
      }));
    new Setting(alerts).setName("每日工作段目标").addText(text => text.setValue(String(this.plugin.settings.dailyGoal || 8)).onChange(value => set({ dailyGoal: positiveNumber(value, 8) })));

    const accounting = section("时间归属", "人在电脑前的每一分钟都应属于工作、休息或声明不计时。没有归属时逐级提醒；声明和未归属时段写入当日日记。macOS 检测所有 App 的键鼠输入，其他平台只检测 Obsidian 窗口内的输入。");
    new Setting(accounting).setName("启用时间归属")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.accountingEnabled === true).onChange(value => set({ accountingEnabled: value })));
    /** @param {string} name @param {string} desc @param {"accountingNotifyAfterMin"|"accountingPromptAfterMin"|"accountingPromptRepeatMin"|"accountingSnoozeMin"|"accountingSnoozeLimit"|"accountingLeisureBudgetMin"|"accountingAwaySec"} key */
    const accountingNumber = (name, desc, key) => new Setting(accounting).setName(name).setDesc(desc)
      .addText(text => text.setValue(String(this.plugin.settings[key])).onChange(value => set({ [key]: Number(value) })));
    accountingNumber("每日消遣额度（分钟）", "声明“消遣”时占用；超出会在日记中标记。", "accountingLeisureBudgetMin");
    accountingNumber("通知（分钟）", "未归属这么久后发系统通知。", "accountingNotifyAfterMin");
    accountingNumber("弹窗（分钟）", "未归属这么久后，等你停手再把 Obsidian 切到前台并弹出选择窗口。", "accountingPromptAfterMin");
    accountingNumber("弹窗重复间隔（分钟）", "关掉弹窗后仍未归属时，隔多久再次弹出。", "accountingPromptRepeatMin");
    accountingNumber("稍后提醒时长（分钟）", "选择“稍后再提醒”后静音多久；静音期间仍计入未归属。", "accountingSnoozeMin");
    accountingNumber("每日稍后提醒次数", "用完后弹窗里不再提供“稍后再提醒”。", "accountingSnoozeLimit");
    accountingNumber("离开判定（秒）", "这么久没有键盘鼠标输入就视为离开，不计入未归属。", "accountingAwaySec");
    new Setting(accounting).setName("日记标题").setDesc("声明、未归属时段和稍后提醒记录写在当日日记的这个标题下。")
      .addText(text => text.setValue(this.plugin.settings.accountingHeading || "时间归属").onChange(value => set({ accountingHeading: value || "时间归属" })));
  }

  _restartStrongAlert() {
    if (!this.plugin.runtime.attention) return;
    this.plugin.stopPersistentAlertSound();
    this.plugin.startPersistentAlertSound();
  }
  hide() { this._stopLightingPreview?.(); this._stopLightingPreview = null; }
}

module.exports = { PomodoroSettingTab };
