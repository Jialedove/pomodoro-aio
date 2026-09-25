const { PluginSettingTab, Setting, Notice } = require("obsidian");
const { positiveNumber, normalizeTag } = require("../core/validation");
const { normalizeRestPresets } = require("../core/modules");
/** @typedef {import("../../types/contracts").Settings} Settings */

class PomodoroSettingTab extends PluginSettingTab {
  /** @param {any} app @param {any} plugin @param {(raw?:Record<string, any>, fallback?:Settings)=>Settings} normalizeSettings */
  constructor(app, plugin, normalizeSettings) {
    super(app, plugin);
    this.plugin = plugin;
    this.normalizeSettings = normalizeSettings;
  }

  display() {
    const c = this.containerEl;
    c.empty();
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

    c.createEl("h3", { text: "循环行为" });
    new Setting(c).setName("模块完成后").setDesc("选择自动开始下一段，或等待你确认后再继续。")
      .addDropdown(dropdown => {
        dropdown.addOptions({ wait: "等待确认", automatic: "自动开始下一段" });
        dropdown.setValue(this.plugin.settings.autoAdvance === true ? "automatic" : "wait");
        dropdown.onChange(value => set({ autoAdvance: value === "automatic" }));
      });
    new Setting(c).setName("序列结束后").setDesc("可以从第一个模块重新循环，也可以结束序列。")
      .addDropdown(dropdown => {
        dropdown.addOptions({ infinite: "从头继续循环", once: "执行一次后停止", count: "执行指定次数" });
        dropdown.setValue(["infinite", "once", "count"].includes(this.plugin.settings.loopMode) ? this.plugin.settings.loopMode : "infinite");
        dropdown.onChange(async value => {
          await set({ loopMode: /** @type {"infinite"|"once"|"count"} */ (value) });
          this.display();
        });
      });
    if (this.plugin.settings.loopMode === "count") {
      new Setting(c).setName("循环次数").setDesc("完整执行序列的次数；第一次完整通过记为 1 次。")
        .addText(text => text.setValue(String(this.plugin.settings.loopCount || 1)).onChange(value => set({ loopCount: Math.max(1, Math.round(positiveNumber(value, 1))) })));
    }

    c.createEl("h3", { text:"休息事项" });
    const presets = c.createDiv({ cls:"pmd-settings-presets" });
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

    c.createEl("h3", { text: "功能" });
    new Setting(c).setName("推进中的项目").setDesc("启用独立项目页面，并允许工作模块关联项目、汇总项目番茄。关闭后不显示项目入口。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.enableProjects === true).onChange(async value => {
        await set({ enableProjects: value });
        this.display();
      }));
    if (this.plugin.settings.enableProjects === true) {
      new Setting(c).setName("项目标签").addText(text => text.setValue(this.plugin.settings.projectTag || "#project")
        .onChange(value => set({ projectTag:normalizeTag(value) || "#project" })));
      new Setting(c).setName("项目状态字段").addText(text => text.setValue(this.plugin.settings.projectStatusKey || "项目状态")
        .onChange(value => set({ projectStatusKey:value || "项目状态" })));
      new Setting(c).setName("允许的项目状态").setDesc("逗号分隔，例如：进行中,筹划中")
        .addText(text => text.setValue(this.plugin.settings.projectStatusWhitelist || "进行中,筹划中")
          .onChange(value => set({ projectStatusWhitelist:value || "进行中,筹划中" })));
      new Setting(c).setName("项目番茄字段").addText(text => text.setValue(this.plugin.settings.projectFmKey || "番茄数")
        .onChange(value => set({ projectFmKey:value || "番茄数" })));
    }

    c.createEl("h3", { text: "当日日记" });
    new Setting(c).setName("一天开始时间（HH:MM）").setDesc("例：04:00；在 04:00 前完成的番茄记在前一天。")
      .addText(text => text.setValue(this.plugin.settings.dayStartHHMM || "00:00").onChange(value => set({ dayStartHHMM: value || "00:00" })));
    new Setting(c).setName("当日路径模板").setDesc("使用 {{date:YYYY-MM-DD}}，例如 Daily/{{date:YYYY-MM-DD}}.md。")
      .addText(text => text.setValue(this.plugin.settings.fallbackPattern || "Daily/{{date:YYYY-MM-DD}}.md").onChange(value => set({ fallbackPattern: value || "Daily/{{date:YYYY-MM-DD}}.md" })));
    new Setting(c).setName("找不到当天文件时自动创建").addToggle(toggle => toggle.setValue(this.plugin.settings.allowCreateDaily === true).onChange(value => set({ allowCreateDaily: value })));
    new Setting(c).setName("番茄汇总 frontmatter 键").addText(text => text.setValue(this.plugin.settings.fmKey || "番茄数").onChange(value => set({ fmKey: value || "番茄数" })));
    new Setting(c).setName("快速记录标题").setDesc("待办与想法写入当日日记的此标题下。")
      .addText(text => text.setValue(this.plugin.settings.captureHeading || "Inbox").onChange(value => set({ captureHeading: value || "Inbox" })));
    new Setting(c).setName("快速记录目标路径模板").setDesc("留空时写入当日日记；可使用 {{date:YYYY-MM-DD}}。")
      .addText(text => text.setValue(this.plugin.settings.capturePathPattern || "").onChange(value => set({ capturePathPattern: value })));
    new Setting(c).setName("找不到同名日记任务时自动创建").addToggle(toggle => toggle.setValue(this.plugin.settings.allowAutoCreateTask === true).onChange(value => set({ allowAutoCreateTask: value })));
    new Setting(c).setName("新任务插入标题").setDesc("留空时使用现有日记写入规则。")
      .addText(text => text.setValue(this.plugin.settings.tasksHeading || "").onChange(value => set({ tasksHeading: value })));

    c.createEl("h3", { text: "提醒" });
    new Setting(c).setName("系统通知").addToggle(toggle => toggle.setValue(this.plugin.settings.enableNotify !== false).onChange(value => set({ enableNotify: value })));
    new Setting(c).setName("提示音").addToggle(toggle => toggle.setValue(this.plugin.settings.enableSound !== false).onChange(value => {
      set({ enableSound: value });
      if (!value) this.plugin.stopPersistentAlertSound();
      else if (this.plugin.runtime.attention) this.plugin.startPersistentAlertSound();
    }));
    new Setting(c).setName("到点后持续提醒").setDesc("直到你开始下一段或处理提醒。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.persistentAlertSound === true).onChange(value => {
        set({ persistentAlertSound: value });
        if (!value) this.plugin.stopPersistentAlertSound();
        else if (this.plugin.runtime.attention) this.plugin.startPersistentAlertSound();
      }));
    new Setting(c).setName("持续提醒升级延迟（秒）")
      .addText(text => text.setValue(String(this.plugin.settings.strongAlertDelaySec || 30)).onChange(value => {
        set({ strongAlertDelaySec: Math.max(1, Math.round(positiveNumber(value, 30))) });
        this._restartStrongAlert();
      }));
    new Setting(c).setName("持续提醒重复间隔（秒）")
      .addText(text => text.setValue(String(this.plugin.settings.strongAlertIntervalSec || 60)).onChange(value => {
        set({ strongAlertIntervalSec: Math.max(1, Math.round(positiveNumber(value, 60))) });
        this._restartStrongAlert();
      }));
    new Setting(c).setName("每日工作段目标").addText(text => text.setValue(String(this.plugin.settings.dailyGoal || 8)).onChange(value => set({ dailyGoal: positiveNumber(value, 8) })));
  }

  _restartStrongAlert() {
    if (!this.plugin.runtime.attention) return;
    this.plugin.stopPersistentAlertSound();
    this.plugin.startPersistentAlertSound();
  }
}

module.exports = { PomodoroSettingTab };
