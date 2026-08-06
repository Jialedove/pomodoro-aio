const { PluginSettingTab, Setting, Notice } = require("obsidian");
const { positiveNumber, normalizeTag } = require("../core/validation");
/** @typedef {import("../../types/contracts").Settings} Settings */
/** @typedef {"focusStartSound" | "breakStartSound" | "focusEndSound" | "breakEndSound" | "focusAlertSound" | "breakAlertSound"} SoundSettingKey */

const SOUND_DEFAULTS = {
  focusStartSound: "focus-start",
  breakStartSound: "break-start",
  focusEndSound: "focus-end",
  breakEndSound: "break-end",
  focusAlertSound: "focus-alert",
  breakAlertSound: "break-alert"
};

/* ========== 设置面板 ========== */
class PomodoroSettingTab extends PluginSettingTab {
  /** @param {any} app @param {any} plugin @param {(raw?:Record<string, any>, fallback?:Settings)=>Settings} normalizeSettings */
  constructor(app, plugin, normalizeSettings){ super(app, plugin); this.plugin=plugin; this.normalizeSettings=normalizeSettings; }
  display(){
    const s = this.plugin.settings;
    /** @param {Partial<Settings>} patch */
    const set = async(patch)=>{
      const next = this.normalizeSettings({ ...this.plugin.settings, ...patch }, this.plugin.settings);
      if (patch.dayStartHHMM !== undefined && next.dayStartHHMM !== patch.dayStartHHMM) new Notice("一天开始时间格式无效，已保留原值");
      if (patch.fallbackPattern !== undefined && next.fallbackPattern !== String(patch.fallbackPattern || "").trim()) new Notice("当日路径必须是规范的 Markdown 路径，已保留原值");
      Object.assign(this.plugin.settings, next);
      await this.plugin.saveSettings();
      this.plugin.broadcast();
    };
    const c = this.containerEl; c.empty();
    c.createEl("h2", { text:"Pomodoro AIO 设置" });

    c.createEl("h3", { text:"计时参数" });
    new Setting(c).setName("专注时长（分钟）").addText(t=>t.setValue(String(s.focusMin)).onChange(v=>set({focusMin: positiveNumber(v, 25)})));
    new Setting(c).setName("默认长专注时长（分钟）").setDesc("用于视图中的长专注按钮")
      .addText(t=>t.setValue(String(s.longFocusDefaultMin || 50)).onChange(v=>{
        const num = positiveNumber(v, positiveNumber(s.focusMin, 25));
        set({ longFocusDefaultMin: num });
        this.plugin.setLongFocusMinutes(num);
      }));
    new Setting(c).setName("短休时长（分钟）").addText(t=>t.setValue(String(s.breakMin)).onChange(v=>set({breakMin: positiveNumber(v, 5)})));
    new Setting(c).setName("长休时长（分钟）").addText(t=>t.setValue(String(s.longBreakMin)).onChange(v=>set({longBreakMin: positiveNumber(v, 15)})));
    new Setting(c).setName("每 N 次长休一次").addText(t=>t.setValue(String(s.longEvery)).onChange(v=>set({longEvery: Math.max(1, Math.round(positiveNumber(v, 4, 1)))})));
    new Setting(c).setName("完成后自动进入下一段").setDesc("仅普通模式；循环工作每段结束后需点击 Ribbon 确认下一段")
      .addToggle(t=>t.setValue(s.autoNext).onChange(v=>set({autoNext:v})));

    c.createEl("h3", { text:"循环工作（无休息）" });
    new Setting(c).setName("任务 A 默认时长（分钟）").addText(t=>t.setValue(String(s.cycleMinA || 15)).onChange(v=>this.plugin.setCycleConfig({cycleMinA:Math.max(1, Number(v)||15)})));
    new Setting(c).setName("任务 B 默认时长（分钟）").addText(t=>t.setValue(String(s.cycleMinB || 15)).onChange(v=>this.plugin.setCycleConfig({cycleMinB:Math.max(1, Number(v)||15)})));

    c.createEl("h3", { text:"一天起止 & 当日日记" });
    new Setting(c).setName("一天开始时间（HH:MM）").setDesc("例：04:00；在 04:00 前完成的番茄记在前一天")
      .addText(t=>t.setValue(s.dayStartHHMM).onChange(v=>set({dayStartHHMM: v || "00:00"})));
    new Setting(c).setName("当日路径模板").setDesc("不依赖 Daily Notes；使用 {{date:YYYY-MM-DD}}")
      .addText(t=>t.setValue(s.fallbackPattern).onChange(v=>set({fallbackPattern: v||"Daily/{{date:YYYY-MM-DD}}.md"})));
    new Setting(c).setName("找不到当天文件时自动创建").addToggle(t=>t.setValue(s.allowCreateDaily).onChange(v=>set({allowCreateDaily:v})));

    c.createEl("h3", { text:"任务与写入" });
    new Setting(c).setName("默认任务名（可空）").addText(t=>t.setValue(s.defaultTaskName).onChange(v=>set({defaultTaskName:v})));
    new Setting(c).setName("未找到同名任务时自动创建").addToggle(t=>t.setValue(s.allowAutoCreateTask).onChange(v=>set({allowAutoCreateTask:v})));
    new Setting(c).setName("新任务插入到哪个标题下（可空）").addText(t=>t.setValue(s.tasksHeading).onChange(v=>set({tasksHeading:v})));
    new Setting(c).setName("frontmatter 键名（当天汇总）").addText(t=>t.setValue(s.fmKey).onChange(v=>set({fmKey: v||"番茄数"})));

    c.createEl("h3", { text:"项目同步" });
    new Setting(c).setName("启用项目番茄同步").addToggle(t=>t.setValue(s.projectEnable).onChange(v=>set({projectEnable:v})));
    new Setting(c).setName("项目标签").addText(t=>t.setValue(s.projectTag).onChange(v=>set({projectTag: normalizeTag(v)||"#project"})));
    new Setting(c).setName("项目状态字段名").addText(t=>t.setValue(s.projectStatusKey).onChange(v=>set({projectStatusKey:v||"项目状态"})));
    new Setting(c).setName("允许的项目状态（逗号分隔）").addText(t=>t.setValue(s.projectStatusWhitelist).onChange(v=>set({projectStatusWhitelist:v||"进行中,筹划中"})));
    new Setting(c).setName("项目 frontmatter 键名").addText(t=>t.setValue(s.projectFmKey).onChange(v=>set({projectFmKey: v||"番茄数"})));
    new Setting(c).setName("显示项目选择").setDesc("关闭后侧栏不显示“选择项目”输入框；已选项目仍会继续同步番茄")
      .addToggle(t=>t.setValue(s.showProjectSelector !== false).onChange(v=>set({showProjectSelector:v})));

    c.createEl("h3", { text:"兼容性与防干扰" });
    new Setting(c).setName("在弹窗与输入时禁用快捷键与聚焦操作").setDesc("避免干扰 Workspaces / Workspaces Plus 的弹窗与输入，推荐保持开启")
      .addToggle(t=>t.setValue(s.respectModalInputFocus !== false).onChange(v=>set({ respectModalInputFocus: v })));

    c.createEl("h3", { text:"提醒与可视化" });
    new Setting(c).setName("启用系统通知").addToggle(t=>t.setValue(s.enableNotify).onChange(v=>set({enableNotify:v})));
    new Setting(c).setName("启用蜂鸣音").addToggle(t=>t.setValue(s.enableSound).onChange(v=>{
      set({enableSound:v});
      if (!v) this.plugin.stopPersistentAlertSound();
      else if (this.plugin.runtime.attention) this.plugin.startPersistentAlertSound();
    }));
    new Setting(c).setName("提示音波形").setDesc("sine/square/triangle；若需静音可在上方关闭‘启用蜂鸣音’")
      .addDropdown(d=>{
        d.addOptions({ sine:"sine", square:"square", triangle:"triangle" });
        d.setValue(this.plugin.settings.soundWaveform || "sine");
        d.onChange(v=>{
          const value = (v==="square"||v==="triangle")? v : "sine";
          set({ soundWaveform: value });
          if (this.plugin.runtime.attention) {
            this.plugin.stopPersistentAlertSound();
            this.plugin.startPersistentAlertSound();
          }
        });
      });
    /** @type {Record<string, string>} */
    const soundOptions = {
      "focus-start": "上扬双音",
      "break-start": "下行双音",
      "focus-end": "三连完成音",
      "break-end": "回归专注音",
      "focus-alert": "四连强提醒",
      "break-alert": "三连强提醒"
    };
    /** @type {Array<[string, SoundSettingKey]>} */
    const soundSettings = [
      ["开始专注提示音", "focusStartSound"],
      ["开始休息提示音", "breakStartSound"],
      ["专注结束提示音", "focusEndSound"],
      ["休息结束提示音", "breakEndSound"],
      ["专注结束强提醒音", "focusAlertSound"],
      ["休息结束强提醒音", "breakAlertSound"]
    ];
    soundSettings.forEach(([name, key]) => new Setting(c).setName(name).addDropdown(d=>{
      d.addOptions(soundOptions);
      d.setValue(s[key] || SOUND_DEFAULTS[key]);
      d.onChange(v=>set({ [key]: soundOptions[v] ? v : SOUND_DEFAULTS[key] }));
    }));
    new Setting(c).setName("每日目标（段）").addText(t=>t.setValue(String(s.dailyGoal)).onChange(v=>set({dailyGoal: positiveNumber(v, 8)})));

    c.createEl("h3", { text:"强提醒与自动化" });
    new Setting(c).setName("持续提示音（强提醒）").setDesc("按下方间隔再次提醒，直到点击左侧番茄图标")
      .addToggle(t=>t.setValue(s.persistentAlertSound).onChange(v=>{
        set({ persistentAlertSound: v });
        if (!v) this.plugin.stopPersistentAlertSound();
        else if (this.plugin.runtime.attention) this.plugin.startPersistentAlertSound();
      }));
    const restartStrongAlert = ()=> {
      if (!this.plugin.runtime.attention) return;
      this.plugin.stopPersistentAlertSound();
      this.plugin.startPersistentAlertSound();
    };
    new Setting(c).setName("强提醒首次升级延迟（秒）").setDesc("到点后的第一次升级提醒；默认 30 秒")
      .addText(t=>t.setValue(String(s.strongAlertDelaySec || 30)).onChange(v=>{
        set({ strongAlertDelaySec: Math.max(1, Math.round(Number(v) || 30)) });
        restartStrongAlert();
      }));
    new Setting(c).setName("强提醒重复间隔（秒）").setDesc("首次升级后每隔多久重复；默认 60 秒")
      .addText(t=>t.setValue(String(s.strongAlertIntervalSec || 60)).onChange(v=>{
        set({ strongAlertIntervalSec: Math.max(1, Math.round(Number(v) || 60)) });
        restartStrongAlert();
      }));
    new Setting(c).setName("点击菜单图标自动进入下一阶段").setDesc("强提醒触发时，点击图标后立即推进下一段专注/休息")
      .addToggle(t=>t.setValue(s.ribbonClickAutoNext).onChange(v=>set({ ribbonClickAutoNext: v })));
    /** @type {Record<string, string>} */
    const commandOptions = { "": "（不执行命令）" };
    const allCommands = this.app.commands?.listCommands?.() || [];
    allCommands.forEach((/** @type {Record<string, any>} */ cmd) => { if (cmd?.id) commandOptions[cmd.id] = `${cmd.name} (${cmd.id})`; });
    new Setting(c).setName("开始专注时附带命令").setDesc("当手动或强提醒开始专注时，同时执行所选命令")
      .addDropdown(d=>{
        d.addOptions(commandOptions);
        d.setValue(s.focusStartCommandId || "");
        d.onChange(v=> set({ focusStartCommandId: v }));
      });
    new Setting(c).setName("开始休息时附带命令").setDesc("当手动或强提醒确认开始短休/长休时，额外执行所选命令")
      .addDropdown(d=>{
        d.addOptions(commandOptions);
        d.setValue(s.breakStartCommandId || "");
        d.onChange(v=> set({ breakStartCommandId: v }));
      });
  }
}

module.exports = { PomodoroSettingTab };
