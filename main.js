// GENERATED FILE — edit src/main.js, then run npm run build.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/main.js
var {
  Plugin,
  Notice,
  TFile,
  ItemView,
  PluginSettingTab,
  Setting
} = require("obsidian");
var DEFAULT_SETTINGS = {
  // 计时
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longEvery: 4,
  autoNext: true,
  // 当日逻辑日期
  dayStartHHMM: "00:00",
  // 当日日记路径模板（不依赖 Daily Notes）
  fallbackPattern: "Daily/{{date:YYYY-MM-DD}}.md",
  allowCreateDaily: true,
  // 任务写入
  fmKey: "\u756A\u8304\u6570",
  allowAutoCreateTask: true,
  tasksHeading: "",
  defaultTaskName: "",
  // 项目同步
  projectEnable: true,
  projectTag: "#project",
  projectStatusKey: "\u9879\u76EE\u72B6\u6001",
  projectStatusWhitelist: "\u8FDB\u884C\u4E2D,\u7B79\u5212\u4E2D",
  projectFmKey: "\u756A\u8304\u6570",
  currentProjectPath: "",
  showProjectSelector: true,
  // 可视化与提醒
  dailyGoal: 8,
  enableSound: true,
  enableNotify: true,
  soundWaveform: "sine",
  focusStartSound: "focus-start",
  breakStartSound: "break-start",
  focusEndSound: "focus-end",
  breakEndSound: "break-end",
  focusAlertSound: "focus-alert",
  breakAlertSound: "break-alert",
  strongAlertDelaySec: 30,
  strongAlertIntervalSec: 60,
  longFocusDefaultMin: 50,
  persistentAlertSound: true,
  ribbonClickAutoNext: true,
  focusStartCommandId: "",
  breakStartCommandId: "",
  // 循环工作：两项任务交替，无休息阶段
  workMode: "standard",
  cycleTaskA: "",
  cycleMinA: 15,
  cycleWorkspaceCommandA: "",
  cycleTaskB: "",
  cycleMinB: 15,
  cycleWorkspaceCommandB: "",
  // 兼容性
  respectModalInputFocus: true
};
function parseHHMMToMinutes(hhmm) {
  const m = String(hhmm || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const h = Math.min(23, Math.max(0, +m[1]));
  const mi = Math.min(59, Math.max(0, +m[2]));
  return h * 60 + mi;
}
function getLogicalDayKey(now, startHHMM) {
  const startMin = parseHHMMToMinutes(startHHMM);
  const curMin = now.getHours() * 60 + now.getMinutes();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = curMin >= startMin ? base : new Date(base.getTime() - 864e5);
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function renderPattern(pattern, dayKey) {
  return String(pattern || "").replace("{{date:YYYY-MM-DD}}", dayKey);
}
function getTomatoSum(text) {
  const re = /^\s*-\s*\[[^\]]\]\s+.*?(\d+(?:\.\d+)?)\s*🍅\s*$/;
  let sum = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(re);
    if (m) sum += parseFloat(m[1]) || 0;
  }
  return Math.round(sum * 10) / 10;
}
function stripBaseName(line) {
  return String(line || "").replace(/^\s*-\s*\[[^\]]\]\s*/, "").replace(/\s*\d+(?:\.\d+)?🍅\s*$/, "").trim();
}
function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizeTag(tag) {
  const value = String(tag || "").trim();
  if (!value) return "";
  return value.startsWith("#") ? value : `#${value}`;
}
function workspaceLayoutLabel(command) {
  return String(command?.name || "").replace(/^.*?Load:\s*/, "");
}
function insertUnderHeading(text, headingRaw, newLine) {
  const heading = String(headingRaw || "").trim();
  if (!heading) return text.replace(/\s*$/, (m2) => m2.endsWith("\n") ? "" : "\n") + newLine + "\n";
  const label = heading.replace(/^#+\s*/, "");
  const re = new RegExp(`^\\s*#+\\s*${escapeReg(label)}\\s*$`, "m");
  const m = text.match(re);
  if (!m) {
    const block = `
${heading.startsWith("#") ? heading : "## " + label}
${newLine}
`;
    return text.replace(/\s*$/, (x) => x.endsWith("\n") ? "" : "\n") + block;
  }
  const idx = m.index + m[0].length;
  return text.slice(0, idx) + "\n" + newLine + "\n" + text.slice(idx);
}
function formatTomatoNumber(val) {
  const num = Number(val) || 0;
  const rounded = Math.round(num * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
function positiveNumber(value, fallback, min = 0.1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(min, number) : fallback;
}
function playBeep(kind, enabled = true, waveform = "sine", strong = false) {
  if (!enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const tones = {
      "focus-start": [740, 988],
      "break-start": [660, 523],
      "focus-end": [784, 784, 1047],
      "break-end": [1047, 784, 1047],
      "focus-alert": [784, 1047, 784, 1047],
      "break-alert": [1047, 1047, 784]
    }[kind] || [520];
    tones.forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = ctx.currentTime + index * 0.16;
      osc.type = waveform === "square" || waveform === "triangle" ? waveform : "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(1e-4, at);
      gain.gain.exponentialRampToValueAtTime(strong ? 0.32 : 0.25, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(1e-4, at + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.16);
      if (index === tones.length - 1) osc.onended = () => ctx.close?.();
    });
  } catch {
  }
}
function sysNotify(title, body, enabled = true) {
  if (!enabled) return;
  try {
    if (!("Notification" in window)) throw new Error("no Notification");
    if (Notification.permission === "granted") {
      new Notification(title, { body });
      return;
    }
    if (Notification.permission === "default") {
      Notification.requestPermission().then((p) => {
        if (p === "granted") new Notification(title, { body });
        else new Notice(`${title}\uFF5C${body}`);
      });
      return;
    }
    new Notice(`${title}\uFF5C${body}`);
  } catch {
    new Notice(`${title}\uFF5C${body}`);
  }
}
function mmss(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}
var PomodoroAIO = class extends Plugin {
  async onload() {
    await this.loadSettings();
    this.runtime = Object.assign({
      phase: "idle",
      // idle | focus | break
      startedAt: 0,
      durationSec: 0,
      paused: false,
      pausedLeftSec: 0,
      sessionCount: 0,
      currentTaskName: this.settings.defaultTaskName || "",
      tomatoCredit: Math.max(0.1, (this.settings.focusMin || 25) / 25),
      strongAlert: false,
      longFocusMinutes: Math.max(0.1, this.settings.longFocusDefaultMin || this.settings.focusMin || 25),
      pendingPhase: "",
      pendingIsLong: false,
      pendingAutoStarted: false,
      pendingCycleSlot: null,
      cycleActive: false,
      cycleSlot: 0,
      viewWasOpen: false
    }, await this.loadState() || {});
    if (!this.runtime.longFocusMinutes) {
      this.runtime.longFocusMinutes = Math.max(0.1, this.settings.longFocusDefaultMin || this.settings.focusMin || 25);
    }
    this._alertInterval = null;
    this._completionInFlight = false;
    this.ribbonBadge = null;
    if (!this.runtime.dayKey) this.runtime.dayKey = this.logicalTodayKey();
    this.registerView(PomodoroView.VIEW_TYPE, (leaf) => new PomodoroView(leaf, this));
    this.addCommand({ id: "open-view", name: "\u6253\u5F00\u756A\u8304\u89C6\u56FE", callback: (evt) => this.runUserCommand(() => this.activateView(), evt) });
    this.ribbon = this.addRibbonIcon("clock", "\u6253\u5F00\u756A\u8304\u89C6\u56FE", () => this.activateView());
    if (this.ribbon) {
      this.ribbon.addClass("pomodoro-ribbon");
      this.ribbonBadge = this.ribbon.createDiv({ cls: "pomodoro-ribbon-badge" });
      const originalClick = this.ribbon.onclick?.bind(this.ribbon);
      this.ribbon.onclick = (evt) => {
        this.onRibbonClick(evt);
        if (originalClick) originalClick(evt);
      };
    }
    this.addCommand({ id: "start-focus", name: "\u5F00\u59CB\u4E13\u6CE8", callback: (evt) => this.runUserCommand(() => this.startFocus(), evt) });
    this.addCommand({ id: "start-break", name: "\u5F00\u59CB\u77ED\u4F11", callback: (evt) => this.runUserCommand(() => this.startBreak(false), evt) });
    this.addCommand({ id: "start-long-break", name: "\u5F00\u59CB\u957F\u4F11", callback: (evt) => this.runUserCommand(() => this.startBreak(true), evt) });
    this.addCommand({ id: "pause-resume", name: "\u6682\u505C/\u7EE7\u7EED", callback: (evt) => this.runUserCommand(() => this.togglePause(), evt) });
    this.addCommand({ id: "reset", name: "\u91CD\u7F6E", callback: (evt) => this.runUserCommand(() => this.reset(), evt) });
    this.addCommand({ id: "complete-now", name: "\u7ACB\u523B\u7ED3\u7B97\u5F53\u524D\u4E13\u6CE8\uFF08\u6309\u5B9E\u9645\u65F6\u957F\uFF09", callback: (evt) => this.runUserCommand(() => this.forceCompleteFocusOnce(), evt) });
    this.addCommand({ id: "open-today", name: "\u6253\u5F00\u5F53\u65E5\u65E5\u8BB0", callback: (evt) => this.runUserCommand(() => this.openToday(), evt) });
    this.addSettingTab(new PomodoroSettingTab(this.app, this));
    this.registerStyles();
    this.app.workspace.onLayoutReady(() => {
      if (!this.runtime.viewWasOpen) return;
      const leaves = this.app.workspace.getLeavesOfType(PomodoroView.VIEW_TYPE);
      if (!leaves.length) this.runAutoAction(() => this.activateView({ source: "auto" }));
    });
    this._tickTimeout = null;
    this._unloading = false;
    this._scheduleTick = () => {
      if (this._unloading) return;
      const now = Date.now();
      const base = this.runtime.startedAt || now;
      const delay = Math.max(50, 1e3 - (now - base) % 1e3);
      this._tickTimeout = window.setTimeout(() => {
        if (this._unloading) return;
        this.tick();
        this._scheduleTick();
      }, delay);
    };
    this._scheduleTick();
    this.applyStrongAlertStateFromRuntime();
    this.updateRibbonVisuals();
  }
  onunload() {
    this._unloading = true;
    this.stopPersistentAlertSound();
    if (this._tickTimeout) window.clearTimeout(this._tickTimeout);
  }
  async loadState() {
    return await this.app.loadLocalStorage("pomodoro-aio-runtime") || null;
  }
  async saveState() {
    await this.app.saveLocalStorage("pomodoro-aio-runtime", this.runtime);
  }
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    return this.settings;
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /* ====== 环境守护 ====== */
  respectGuardsEnabled() {
    return this.settings?.respectModalInputFocus !== false;
  }
  isElementVisible(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle?.(el);
      if (style) {
        if (style.display === "none") return false;
        if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      if (el.offsetParent === null && style?.position !== "fixed") return false;
      return true;
    } catch {
      return true;
    }
  }
  isTextInputTarget(target) {
    const el = target instanceof HTMLElement ? target : null;
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.closest?.("input, textarea, select")) return true;
    if (el.isContentEditable || el.getAttribute?.("contenteditable") === "true") return true;
    if (el.closest?.("[contenteditable='true']")) return true;
    if (el.closest?.(".cm-editor")) return true;
    if (el.closest?.(".markdown-source-view") || el.closest?.(".markdown-preview-view")) return true;
    return false;
  }
  hasBlockingOverlay() {
    if (!this.respectGuardsEnabled()) return false;
    try {
      const root = document?.body || document;
      const selectors = [
        ".modal",
        ".modal-container",
        ".modal-bg",
        ".prompt",
        ".suggestion-container",
        ".popover",
        ".quick-switcher",
        ".command-palette",
        ".mod-command-palette"
      ];
      const nodes = root?.querySelectorAll?.(selectors.join(", ")) || [];
      for (const el of nodes) {
        if (this.isElementVisible(el)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  shouldBlockHotkeys(evt, opts = {}) {
    if (!this.respectGuardsEnabled()) return false;
    if (evt?.defaultPrevented) return true;
    if (this.hasBlockingOverlay()) return true;
    const allowInPluginInput = !!opts.allowInPluginInput;
    const allowInText = !!opts.allowInText;
    let target = evt?.target;
    if (!target) {
      try {
        target = document?.activeElement;
      } catch {
      }
    }
    if (!allowInPluginInput && !allowInText && target && this.isTextInputTarget(target)) return true;
    return false;
  }
  shouldBlockFocusLayoutSideEffects(opts = {}) {
    if (!this.respectGuardsEnabled()) return false;
    const source = opts.source || "auto";
    if (this.hasBlockingOverlay()) return true;
    if (source === "auto") {
      let active = null;
      try {
        active = document.activeElement;
      } catch {
      }
      if (active && this.isTextInputTarget(active)) return true;
    }
    return false;
  }
  runUserCommand(fn, evt) {
    if (this.shouldBlockHotkeys(evt, { allowInText: true })) return false;
    if (this.shouldBlockFocusLayoutSideEffects({ source: "user" })) return false;
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
    return true;
  }
  runAutoAction(fn) {
    if (this.shouldBlockFocusLayoutSideEffects({ source: "auto" })) return false;
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
    return true;
  }
  /* ====== 视图与广播 ====== */
  async activateView(opts = {}) {
    const source = opts.source || "user";
    if (this.shouldBlockFocusLayoutSideEffects({ source })) return;
    const leaves = this.app.workspace.getLeavesOfType(PomodoroView.VIEW_TYPE);
    if (leaves.length) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: PomodoroView.VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  broadcast() {
    const snap = this.snapshot();
    this.updateRibbonVisuals(snap.runtime);
    this.app.workspace.trigger("pomodoro:aio-state", snap);
  }
  snapshot() {
    const left = this.getLeftSec();
    return {
      settings: this.settings,
      runtime: Object.assign({}, this.runtime, { leftSec: left })
    };
  }
  updateRibbonVisuals(runtime) {
    if (!this.ribbon) return;
    const r = runtime || Object.assign({}, this.runtime, { leftSec: this.getLeftSec() });
    this.updateRibbonBadge(r);
    this.updateRibbonAlertUI(!!r.strongAlert);
  }
  updateRibbonBadge(runtime) {
    if (!this.ribbonBadge) return;
    const phase = runtime?.phase || this.runtime.phase;
    const sec = runtime ? runtime.paused ? runtime.pausedLeftSec || 0 : runtime.leftSec ?? this.getLeftSec() : this.getLeftSec();
    const show = phase !== "idle" && sec > 0;
    if (show) {
      const minutes = Math.max(0, Math.ceil(sec / 60));
      this.ribbonBadge.setText(String(minutes));
      this.ribbon.addClass("pomodoro-ribbon-has-badge");
    } else {
      this.ribbonBadge.setText("");
      this.ribbon.removeClass("pomodoro-ribbon-has-badge");
    }
  }
  updateRibbonAlertUI(active) {
    if (!this.ribbon) return;
    if (active) this.ribbon.addClass("pomodoro-ribbon-alert");
    else this.ribbon.removeClass("pomodoro-ribbon-alert");
  }
  startPersistentAlertSound() {
    if (!this.settings.enableSound || !this.settings.persistentAlertSound) return;
    if (this._alertInterval || this._alertEscalationTimeout) return;
    const alertKind = () => this.runtime.pendingPhase === "focus" ? this.settings.breakAlertSound : this.settings.focusAlertSound;
    const delay = Math.max(1, Number(this.settings.strongAlertDelaySec) || 30) * 1e3;
    const interval = Math.max(1, Number(this.settings.strongAlertIntervalSec) || 60) * 1e3;
    this._alertEscalationTimeout = window.setTimeout(() => {
      this._alertEscalationTimeout = null;
      playBeep(alertKind(), true, this.settings.soundWaveform, true);
      this._alertInterval = window.setInterval(() => playBeep(alertKind(), true, this.settings.soundWaveform, true), interval);
    }, delay);
  }
  stopPersistentAlertSound() {
    if (this._alertEscalationTimeout) {
      window.clearTimeout(this._alertEscalationTimeout);
      this._alertEscalationTimeout = null;
    }
    if (this._alertInterval) {
      window.clearInterval(this._alertInterval);
      this._alertInterval = null;
    }
  }
  applyStrongAlertStateFromRuntime() {
    if (!this.runtime.strongAlert) {
      this.updateRibbonAlertUI(false);
      this.stopPersistentAlertSound();
      return;
    }
    this.updateRibbonAlertUI(true);
    this.startPersistentAlertSound();
  }
  onRibbonClick(evt) {
    if (!this.runtime.strongAlert) return;
    if (!this.settings.ribbonClickAutoNext || this.runtime.pendingAutoStarted) {
      this.stopStrongAlert();
      return;
    }
    this.startPendingStage();
  }
  startPendingStage() {
    const next = {
      type: this.runtime.pendingPhase || "",
      isLong: !!this.runtime.pendingIsLong,
      cycleSlot: this.runtime.pendingCycleSlot
    };
    this.stopStrongAlert();
    if (next.type === "break") {
      if (this.runtime.phase === "break" && this.runtime.paused) {
        this.togglePause(true);
      } else {
        this.startBreak(next.isLong, { forceRun: true, cause: "manual" });
      }
    } else if (next.type === "focus") {
      if (Number.isInteger(next.cycleSlot)) {
        this.startCycle(next.cycleSlot, { cause: "manual" });
        return;
      }
      if (this.runtime.phase === "focus" && this.runtime.paused) {
        this.togglePause(true);
      } else {
        this.startFocus({ cause: "manual" });
      }
    }
  }
  beginStrongAlert(nextPhase) {
    this.runtime.strongAlert = true;
    this.runtime.pendingPhase = nextPhase?.type || "";
    this.runtime.pendingIsLong = !!nextPhase?.isLong;
    this.runtime.pendingAutoStarted = !!nextPhase?.autoStarted;
    this.runtime.pendingCycleSlot = Number.isInteger(nextPhase?.cycleSlot) ? nextPhase.cycleSlot : null;
    this.saveState();
    this.updateRibbonAlertUI(true);
    this.startPersistentAlertSound();
    this.broadcast();
  }
  stopStrongAlert() {
    if (!this.runtime.strongAlert) {
      this.stopPersistentAlertSound();
      this.updateRibbonAlertUI(false);
      return;
    }
    this.runtime.strongAlert = false;
    this.runtime.pendingPhase = "";
    this.runtime.pendingIsLong = false;
    this.runtime.pendingAutoStarted = false;
    this.runtime.pendingCycleSlot = null;
    this.saveState();
    this.stopPersistentAlertSound();
    this.updateRibbonAlertUI(false);
    this.updateRibbonBadge();
    this.broadcast();
  }
  currentTomatoAmount() {
    if (this.runtime.phase !== "focus") return this.runtime.tomatoCredit || 0;
    const credit = this.runtime.tomatoCredit;
    if (typeof credit === "number" && isFinite(credit) && credit > 0) return Math.round(credit * 10) / 10;
    if (this.runtime.durationSec) return Math.round(this.runtime.durationSec / 1500 * 10) / 10;
    return Math.round((this.settings.focusMin || 25) / 25 * 10) / 10;
  }
  focusCompletionBody(tomatoAmount, next) {
    const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
    return `${task ? `\u5B8C\u6210\uFF1A${task} \xB7 ` : ""}+${formatTomatoNumber(tomatoAmount)}\u{1F345}
\u4E0B\u4E00\u6B65\uFF1A${next}`;
  }
  executeStageCommand(commandId) {
    const id = String(commandId || "").trim();
    if (!id) return false;
    if (this.isWorkspaceLayoutActive(id)) return true;
    try {
      const executed = this.app?.commands?.executeCommandById?.(id);
      if (executed === false) new Notice("\u9644\u5E26\u547D\u4EE4\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9");
      return executed !== false;
    } catch (err) {
      console.error(err);
      new Notice("\u9644\u5E26\u547D\u4EE4\u6267\u884C\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9");
      return false;
    }
  }
  getWorkspaceLayoutCommands() {
    return (this.app?.commands?.listCommands?.() || []).filter((command) => command?.id?.startsWith("workspaces-plus:") && /(?:^|:\s)Load:\s/.test(String(command.name || ""))).sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
  }
  isWorkspaceLayoutActive(commandId) {
    const id = String(commandId || "");
    if (!this.getWorkspaceLayoutCommands().some((command) => command.id === id)) return false;
    const activeWorkspace = this.app?.internalPlugins?.getPluginById?.("workspaces")?.instance?.activeWorkspace;
    return activeWorkspace === id.slice("workspaces-plus:".length);
  }
  /* ====== 计时控制 ====== */
  getLeftMs() {
    const r = this.runtime;
    if (r.phase === "idle") {
      const slot = this.settings.workMode === "cycle" && Number.isInteger(r.pendingCycleSlot) ? r.pendingCycleSlot : r.cycleSlot;
      const minutes = this.settings.workMode === "cycle" ? slot === 1 ? this.settings.cycleMinB : this.settings.cycleMinA : this.settings.focusMin;
      return (Number(minutes) || 25) * 60 * 1e3;
    }
    if (r.paused) return Math.max(0, (r.pausedLeftSec || 0) * 1e3);
    if (!r.startedAt || !r.durationSec) return 0;
    const ms = r.durationSec * 1e3 - (Date.now() - r.startedAt);
    return Math.max(0, ms);
  }
  getLeftSec() {
    return Math.ceil(this.getLeftMs() / 1e3);
  }
  ensureDayFreshness() {
    const cur = this.logicalTodayKey();
    if (this.runtime.dayKey !== cur) {
      this.runtime.dayKey = cur;
      this.runtime.sessionCount = 0;
      this.saveState();
      this.broadcast();
    }
  }
  startFocus(options) {
    this.ensureDayFreshness();
    let opts = { suppressNotify: false, cause: "manual", minutes: null, cycle: false };
    if (typeof options === "boolean") opts.suppressNotify = options;
    else if (options && typeof options === "object") opts = Object.assign(opts, options);
    const minutesRaw = typeof opts.minutes === "number" && isFinite(opts.minutes) && opts.minutes > 0 ? opts.minutes : this.settings.focusMin || 25;
    const minutes = Math.max(0.1, minutesRaw);
    if (opts.minutes != null) this.setLongFocusMinutes(minutes, false);
    const durationSec = Math.max(1, Math.round(minutes * 60));
    if (opts.cause !== "auto") this.stopStrongAlert();
    if (!opts.cycle) {
      this.runtime.cycleActive = false;
      this.runtime.cycleSlot = 0;
    }
    this.runtime.phase = "focus";
    this.runtime.durationSec = durationSec;
    this.runtime.startedAt = Date.now();
    this.runtime.paused = false;
    this.runtime.pausedLeftSec = 0;
    this.runtime.tomatoCredit = Math.max(0.1, Math.round(minutes / 25 * 10) / 10);
    this.saveState();
    this.broadcast();
    playBeep(this.settings.focusStartSound, this.settings.enableSound, this.settings.soundWaveform);
    if (!opts.suppressNotify) {
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("\u5F00\u59CB\u4E13\u6CE8", `${formatTomatoNumber(minutes)} \u5206\u949F${task ? ` \xB7 \u4EFB\u52A1\uFF1A${task}` : ""}`, this.settings.enableNotify);
    }
    const commandId = opts.cycle ? this.runtime.cycleSlot === 1 ? this.settings.cycleWorkspaceCommandB : this.settings.cycleWorkspaceCommandA : this.settings.focusStartCommandId;
    if (opts.cause !== "auto" && commandId) this.executeStageCommand(commandId);
    this._resyncTick();
  }
  startCycle(slot = this.runtime.cycleSlot, options = {}) {
    const cycleSlot = slot === 1 ? 1 : 0;
    const task = String(cycleSlot ? this.settings.cycleTaskB : this.settings.cycleTaskA).trim();
    const minutes = Number(cycleSlot ? this.settings.cycleMinB : this.settings.cycleMinA);
    if (!task) {
      new Notice(`\u8BF7\u5148\u586B\u5199\u4EFB\u52A1 ${cycleSlot ? "B" : "A"}`);
      return;
    }
    if (!isFinite(minutes) || minutes <= 0) {
      new Notice(`\u8BF7\u8BBE\u7F6E\u4EFB\u52A1 ${cycleSlot ? "B" : "A"} \u7684\u65F6\u957F`);
      return;
    }
    this.runtime.cycleActive = true;
    this.runtime.cycleSlot = cycleSlot;
    this.runtime.currentTaskName = task;
    this.startFocus(Object.assign({ cause: "manual", minutes, cycle: true }, options));
  }
  startBreak(isLong = false, options) {
    this.ensureDayFreshness();
    let opts = { forceRun: true, suppressNotify: false, cause: "manual" };
    if (typeof options === "boolean") opts.forceRun = options;
    else if (options && typeof options === "object") opts = Object.assign(opts, options);
    if (opts.cause !== "auto") this.stopStrongAlert();
    this.runtime.cycleActive = false;
    this.runtime.cycleSlot = 0;
    const minutes = isLong ? this.settings.longBreakMin || 15 : this.settings.breakMin || 5;
    const dur = Math.max(1, Math.round(minutes * 60));
    this.runtime.phase = "break";
    this.runtime.durationSec = dur;
    this.runtime.startedAt = Date.now();
    const forceRun = opts.forceRun ?? true;
    const paused = !forceRun && !this.settings.autoNext;
    this.runtime.paused = paused;
    this.runtime.pausedLeftSec = paused ? dur : 0;
    this.runtime.tomatoCredit = 0;
    this.saveState();
    this.broadcast();
    playBeep(this.settings.breakStartSound, this.settings.enableSound, this.settings.soundWaveform);
    if (!opts.suppressNotify) {
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("\u5F00\u59CB\u4F11\u606F", `${formatTomatoNumber(minutes)} \u5206\u949F${task ? ` \xB7 \u521A\u5B8C\u6210\uFF1A${task}` : ""}`, this.settings.enableNotify);
    }
    if (opts.cause !== "auto" && this.settings.breakStartCommandId) this.executeStageCommand(this.settings.breakStartCommandId);
    this._resyncTick();
  }
  togglePause(triggerCommand = false) {
    this.ensureDayFreshness();
    if (this.runtime.phase === "idle") return;
    const wasPaused = this.runtime.paused;
    this.stopStrongAlert();
    if (!this.runtime.paused) {
      this.runtime.pausedLeftSec = this.getLeftSec();
      this.runtime.paused = true;
    } else {
      this.runtime.startedAt = Date.now() - (this.runtime.durationSec - this.runtime.pausedLeftSec) * 1e3;
      this.runtime.paused = false;
    }
    this.saveState();
    this.broadcast();
    this._resyncTick();
    if (triggerCommand && wasPaused && !this.runtime.paused) {
      const focusCommandId = this.runtime.cycleActive ? this.runtime.cycleSlot === 1 ? this.settings.cycleWorkspaceCommandB : this.settings.cycleWorkspaceCommandA : this.settings.focusStartCommandId;
      if (this.runtime.phase === "focus" && focusCommandId) this.executeStageCommand(focusCommandId);
      else if (this.runtime.phase === "break" && this.settings.breakStartCommandId) this.executeStageCommand(this.settings.breakStartCommandId);
    }
  }
  reset(showNotice = true) {
    this.ensureDayFreshness();
    this.stopStrongAlert();
    this.runtime = Object.assign(this.runtime, {
      phase: "idle",
      startedAt: 0,
      durationSec: 0,
      paused: false,
      pausedLeftSec: 0,
      cycleActive: false,
      cycleSlot: 0
    });
    this.saveState();
    this.broadcast();
    this._resyncTick();
    if (showNotice) new Notice("\u5DF2\u91CD\u7F6E");
  }
  /* ====== 到点/补记 ====== */
  async tick() {
    this.ensureDayFreshness();
    this.broadcast();
    if (this._completionInFlight) return;
    const r = this.runtime;
    if (r.phase === "idle" || r.paused || !r.startedAt || !r.durationSec) return;
    const leftMs = this.getLeftMs();
    if (leftMs > 0) return;
    if (r.phase === "focus") {
      this._completionInFlight = true;
      try {
        const tomatoAmount = this.currentTomatoAmount() || 1;
        await this.applyTomatoAndSum(tomatoAmount);
        await this.safeBumpProjectTomato(tomatoAmount);
        r.sessionCount = (r.sessionCount || 0) + 1;
        playBeep(this.settings.focusEndSound, this.settings.enableSound, this.settings.soundWaveform);
        if (r.cycleActive) {
          const nextSlot = r.cycleSlot === 1 ? 0 : 1;
          const nextTask = String(nextSlot ? this.settings.cycleTaskB : this.settings.cycleTaskA).trim();
          sysNotify("\u4E13\u6CE8\u5B8C\u6210", this.focusCompletionBody(tomatoAmount, `${nextTask || "\u4E0B\u4E00\u6BB5\u4E13\u6CE8"}\uFF08\u70B9\u51FB\u756A\u8304\u56FE\u6807\u5F00\u59CB\uFF09`), this.settings.enableNotify);
          r.phase = "idle";
          r.startedAt = 0;
          r.durationSec = 0;
          r.paused = false;
          r.pausedLeftSec = 0;
          this.saveState();
          this.broadcast();
          this.beginStrongAlert({ type: "focus", cycleSlot: nextSlot, autoStarted: false });
        } else {
          const isLong = this.settings.longEvery > 0 && r.sessionCount % this.settings.longEvery === 0;
          const autoNext = !!this.settings.autoNext;
          const breakMinutes = isLong ? this.settings.longBreakMin : this.settings.breakMin;
          sysNotify("\u4E13\u6CE8\u5B8C\u6210", this.focusCompletionBody(tomatoAmount, `${isLong ? "\u957F\u4F11" : "\u77ED\u4F11"} ${formatTomatoNumber(breakMinutes)} \u5206\u949F${autoNext ? "\uFF08\u5DF2\u5F00\u59CB\uFF09" : "\uFF08\u70B9\u51FB\u756A\u8304\u56FE\u6807\u5F00\u59CB\uFF09"}`), this.settings.enableNotify);
          this.startBreak(isLong, { forceRun: autoNext, cause: "auto" });
          this.beginStrongAlert({ type: "break", isLong, autoStarted: autoNext });
        }
      } catch (e) {
        console.error(e);
        new Notice("\u5199\u5165\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u7F6E/\u4EFB\u52A1/\u9879\u76EE");
        this.reset();
      } finally {
        this._completionInFlight = false;
      }
    } else if (r.phase === "break") {
      playBeep(this.settings.breakEndSound, this.settings.enableSound, this.settings.soundWaveform);
      const autoNext = !!this.settings.autoNext;
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("\u4F11\u606F\u7ED3\u675F", `\u4E0B\u4E00\u6B65\uFF1A${autoNext ? "\u5DF2\u5F00\u59CB" : "\u70B9\u51FB\u756A\u8304\u56FE\u6807\u5F00\u59CB"}\u4E13\u6CE8${task ? ` \xB7 \u4EFB\u52A1\uFF1A${task}` : ""}`, this.settings.enableNotify);
      if (autoNext) this.startFocus({ suppressNotify: true, cause: "auto" });
      else this.reset(false);
      this.beginStrongAlert({ type: "focus", autoStarted: autoNext });
    }
  }
  async forceCompleteFocusOnce() {
    this.ensureDayFreshness();
    if (this.runtime.phase !== "focus") {
      new Notice("\u5F53\u524D\u4E0D\u5728\u4E13\u6CE8\u9636\u6BB5");
      return;
    }
    if (this._completionInFlight) {
      new Notice("\u6B63\u5728\u7ED3\u7B97\u5F53\u524D\u4E13\u6CE8");
      return;
    }
    this._completionInFlight = true;
    try {
      const tomatoAmount = this.currentTomatoAmount() || 1;
      await this.applyTomatoAndSum(tomatoAmount);
      await this.safeBumpProjectTomato(tomatoAmount);
      this.runtime.sessionCount = (this.runtime.sessionCount || 0) + 1;
      if (this.runtime.cycleActive) {
        const nextSlot = this.runtime.cycleSlot === 1 ? 0 : 1;
        const nextTask = String(nextSlot ? this.settings.cycleTaskB : this.settings.cycleTaskA).trim();
        sysNotify("\u4E13\u6CE8\u5B8C\u6210\uFF08\u624B\u52A8\uFF09", this.focusCompletionBody(tomatoAmount, `${nextTask || "\u4E0B\u4E00\u6BB5\u4E13\u6CE8"}\uFF08\u70B9\u51FB\u756A\u8304\u56FE\u6807\u5F00\u59CB\uFF09`), this.settings.enableNotify);
        this.runtime.phase = "idle";
        this.runtime.startedAt = 0;
        this.runtime.durationSec = 0;
        this.runtime.paused = false;
        this.runtime.pausedLeftSec = 0;
        this.saveState();
        this.broadcast();
        this.beginStrongAlert({ type: "focus", cycleSlot: nextSlot, autoStarted: false });
      } else {
        const isLong = this.settings.longEvery > 0 && this.runtime.sessionCount % this.settings.longEvery === 0;
        const autoNext = !!this.settings.autoNext;
        const breakMinutes = isLong ? this.settings.longBreakMin : this.settings.breakMin;
        sysNotify("\u4E13\u6CE8\u5B8C\u6210\uFF08\u624B\u52A8\uFF09", this.focusCompletionBody(tomatoAmount, `${isLong ? "\u957F\u4F11" : "\u77ED\u4F11"} ${formatTomatoNumber(breakMinutes)} \u5206\u949F${autoNext ? "\uFF08\u5DF2\u5F00\u59CB\uFF09" : "\uFF08\u70B9\u51FB\u756A\u8304\u56FE\u6807\u5F00\u59CB\uFF09"}`), this.settings.enableNotify);
        this.startBreak(isLong, { forceRun: false, cause: "manual" });
        this.beginStrongAlert({ type: "break", isLong, autoStarted: false });
      }
      this._resyncTick();
      playBeep(this.settings.focusEndSound, this.settings.enableSound, this.settings.soundWaveform);
    } catch (e) {
      console.error(e);
      new Notice("\u5199\u5165\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u7F6E/\u4EFB\u52A1/\u9879\u76EE");
    } finally {
      this._completionInFlight = false;
    }
  }
  _resyncTick() {
    if (this._tickTimeout) window.clearTimeout(this._tickTimeout);
    this._scheduleTick && this._scheduleTick();
  }
  /* ====== 文件相关 ====== */
  logicalTodayKey() {
    return getLogicalDayKey(/* @__PURE__ */ new Date(), this.settings.dayStartHHMM || "00:00");
  }
  todayFilePath() {
    return renderPattern(this.settings.fallbackPattern || "Daily/{{date:YYYY-MM-DD}}.md", this.logicalTodayKey());
  }
  async ensureTodayFile() {
    const p = this.todayFilePath();
    let f = this.app.vault.getAbstractFileByPath(p);
    if (!f) {
      if (!this.settings.allowCreateDaily) throw new Error("\u627E\u4E0D\u5230\u5F53\u5929\u6587\u4EF6\uFF0C\u4E14\u672A\u5F00\u542F\u81EA\u52A8\u521B\u5EFA");
      const parts = p.split("/");
      if (parts.length > 1) {
        let acc = "";
        for (let i = 0; i < parts.length - 1; i++) {
          acc = acc ? `${acc}/${parts[i]}` : parts[i];
          try {
            await this.app.vault.createFolder(acc);
          } catch {
          }
        }
      }
      f = await this.app.vault.create(p, "");
    }
    if (!(f instanceof TFile)) throw new Error("\u76EE\u6807\u4E0D\u662F\u6587\u4EF6");
    return f;
  }
  async readToday() {
    const f = await this.ensureTodayFile();
    return { file: f, text: await this.app.vault.read(f) };
  }
  async listUncheckedTasksFromText(text) {
    const lines = text.split(/\r?\n/);
    const names = /* @__PURE__ */ new Set();
    for (const l of lines) {
      if (!/^\s*-\s*\[\s\]\s+/.test(l)) continue;
      const base = stripBaseName(l);
      if (base) names.add(base);
    }
    return Array.from(names);
  }
  // 当日任务行尾追加对应 🍅 数量，并写入 frontmatter[fmKey]；返回今日累计
  async applyTomatoAndSum(amount = 1) {
    const taskName = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
    if (!taskName) throw new Error("\u4EFB\u52A1\u540D\u4E3A\u7A7A");
    const add = Math.max(0, Number(amount) || 0);
    if (!add) return getTomatoSum((await this.readToday()).text);
    const f = await this.ensureTodayFile();
    let text = await this.app.vault.read(f);
    const lines = text.split(/\r?\n/);
    const want = taskName.toLowerCase().trim();
    let iUnchecked = -1, iAny = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!/^\s*-\s*\[[^\]]\]\s+/.test(l)) continue;
      const base = stripBaseName(l).toLowerCase();
      if (base === want) {
        if (/^\s*-\s*\[\s\]/.test(l) && iUnchecked === -1) iUnchecked = i;
        if (iAny === -1) iAny = i;
      }
    }
    const hit = iUnchecked !== -1 ? iUnchecked : iAny;
    if (hit !== -1) {
      const oldLine = lines[hit];
      const m = oldLine.match(/(\d+(?:\.\d+)?)\s*🍅\s*$/);
      const old = m ? parseFloat(m[1]) || 0 : 0;
      const prefix = oldLine.match(/^\s*-\s*\[[^\]]\]\s*/)?.[0] || "- [ ] ";
      const base = stripBaseName(oldLine);
      lines[hit] = `${prefix}${base} ${formatTomatoNumber(old + add)}\u{1F345}`;
      text = lines.join("\n");
    } else {
      if (!this.settings.allowAutoCreateTask) throw new Error("\u672A\u627E\u5230\u540C\u540D\u4EFB\u52A1\uFF0C\u4E14\u672A\u5F00\u542F\u81EA\u52A8\u521B\u5EFA");
      const newLine = `- [ ] ${taskName} ${formatTomatoNumber(add)}\u{1F345}`;
      text = insertUnderHeading(text, this.settings.tasksHeading, newLine);
    }
    const sum = getTomatoSum(text);
    await this.app.vault.modify(f, text);
    try {
      await this.app.fileManager.processFrontMatter(f, (fm) => {
        fm[this.settings.fmKey || "\u756A\u8304\u6570"] = sum;
      });
    } catch (err) {
      console.error(err);
      new Notice("\u5F53\u65E5\u65E5\u8BB0 frontmatter \u6C47\u603B\u5199\u5165\u5931\u8D25\uFF0C\u4EFB\u52A1\u884C\u8BB0\u5F55\u5DF2\u4FDD\u7559");
    }
    this.broadcast();
    return sum;
  }
  // 为所选项目文件 frontmatter[projectFmKey] +1
  async bumpProjectTomato(amount = 1) {
    if (!this.settings.projectEnable) return;
    const add = Math.max(0, Number(amount) || 0);
    if (!add) return;
    const p = (this.settings.currentProjectPath || "").trim();
    if (!p) return;
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!f || !(f instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(f, (fm) => {
      const k = this.settings.projectFmKey || "\u756A\u8304\u6570";
      const prev = parseFloat(fm[k]) || 0;
      fm[k] = Math.round((prev + add) * 10) / 10;
    });
  }
  async safeBumpProjectTomato(amount = 1) {
    try {
      await this.bumpProjectTomato(amount);
    } catch (err) {
      console.error(err);
      new Notice("\u9879\u76EE\u756A\u8304\u540C\u6B65\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u5F53\u65E5\u65E5\u8BB0\u8BB0\u5F55");
    }
  }
  /* ====== 提供给视图的查询/动作 ====== */
  async refreshTodaySnapshot() {
    const { file, text } = await this.readToday();
    const sum = getTomatoSum(text);
    const unchecked = await this.listUncheckedTasksFromText(text);
    return { file, sum, unchecked };
  }
  projectCandidates() {
    const tagWant = normalizeTag(this.settings.projectTag || "#project");
    const white = new Set(String(this.settings.projectStatusWhitelist || "\u8FDB\u884C\u4E2D,\u7B79\u5212\u4E2D").split(",").map((s) => s.trim()).filter(Boolean));
    const files = this.app.vault.getMarkdownFiles();
    const out = [];
    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f) || {};
      let hasTag = false;
      const fm = cache.frontmatter || {};
      const tags = /* @__PURE__ */ new Set();
      const fmTags = fm.tags;
      if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(normalizeTag(t)));
      else if (typeof fmTags === "string") fmTags.split(/[,\s]+/).forEach((t) => t && tags.add(normalizeTag(t)));
      (cache.tags || []).forEach((obj) => obj?.tag && tags.add(obj.tag));
      hasTag = tags.has(tagWant);
      if (!hasTag) continue;
      const status = String(fm[this.settings.projectStatusKey || "\u9879\u76EE\u72B6\u6001"] || "").trim();
      if (!white.has(status)) continue;
      out.push({ label: `${f.basename} \u2014 ${status} (${f.path})`, path: f.path });
    }
    return out;
  }
  setCurrentTaskName(name) {
    this.runtime.currentTaskName = String(name || "").trim();
    this.saveState();
    this.broadcast();
  }
  setCurrentProjectPath(path) {
    this.settings.currentProjectPath = String(path || "").trim();
    this.saveSettings();
    this.broadcast();
  }
  setWorkMode(mode) {
    if (this.runtime.phase !== "idle" || this.runtime.cycleActive) {
      new Notice("\u8BF7\u5148\u91CD\u7F6E\u5F53\u524D\u8BA1\u65F6\uFF0C\u518D\u5207\u6362\u5DE5\u4F5C\u6A21\u5F0F");
      return false;
    }
    this.settings.workMode = mode === "cycle" ? "cycle" : "standard";
    this.saveSettings();
    this.broadcast();
    return true;
  }
  setCycleConfig(patch) {
    Object.assign(this.settings, patch);
    this.saveSettings();
    this.broadcast();
  }
  selectCycleSlot(slot) {
    if (this.settings.workMode !== "cycle" || this.runtime.phase !== "idle" || this.runtime.strongAlert) return false;
    this.runtime.cycleSlot = slot === 1 ? 1 : 0;
    this.saveState();
    this.broadcast();
    return true;
  }
  setLongFocusMinutes(minutes, broadcast = true) {
    const num = Number(minutes);
    if (!isFinite(num)) return;
    const normalized = Math.max(0.1, Math.round(num * 10) / 10);
    this.runtime.longFocusMinutes = normalized;
    this.saveState();
    if (broadcast) this.broadcast();
  }
  // 打开当日日记
  async openToday() {
    if (this.shouldBlockFocusLayoutSideEffects({ source: "user" })) return;
    const f = await this.ensureTodayFile();
    await this.app.workspace.getLeaf(true).openFile(f);
  }
  // 打开当前选择的项目文件
  async openCurrentProject() {
    if (this.shouldBlockFocusLayoutSideEffects({ source: "user" })) return;
    const p = (this.settings.currentProjectPath || "").trim();
    if (!p) {
      new Notice("\u672A\u9009\u62E9\u9879\u76EE");
      return;
    }
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!f || !(f instanceof TFile)) {
      new Notice("\u9879\u76EE\u6587\u4EF6\u4E0D\u5B58\u5728");
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(f);
  }
};
var _PomodoroView = class _PomodoroView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.disposers = [];
  }
  getViewType() {
    return _PomodoroView.VIEW_TYPE;
  }
  getDisplayText() {
    return "\u756A\u8304\u949F";
  }
  getIcon() {
    return "clock";
  }
  async onOpen() {
    try {
      this.plugin.runtime.viewWasOpen = true;
      this.plugin.saveState();
    } catch {
    }
    try {
      const container = this.containerEl;
      container.empty();
      container.addClass("pmd-root");
      const head = container.createDiv({ cls: "pmd-head" });
      const ring = head.createDiv({ cls: "pmd-ring" });
      ring.innerHTML = `<svg class="pmd-ring-svg" width="72" height="72" viewBox="0 0 72 72">
        <g transform="rotate(-90 36 36)">
          <circle cx="36" cy="36" r="30" class="pmd-ring-track"></circle>
          <circle cx="36" cy="36" r="30" class="pmd-ring-prog" stroke-dasharray="${2 * Math.PI * 30}" stroke-dashoffset="${2 * Math.PI * 30}"></circle>
        </g>
      </svg>
      <div class="pmd-ring-text">0/8</div>`;
      const ringText = ring.querySelector(".pmd-ring-text");
      const ringProgress = ring.querySelector(".pmd-ring-prog");
      ring.setAttribute("role", "progressbar");
      ring.setAttribute("aria-label", "\u4ECA\u65E5\u756A\u8304\u8FDB\u5EA6");
      ring.setAttribute("aria-valuemin", "0");
      const timeEl = head.createDiv({ cls: "pmd-time", text: mmss(this.plugin.getLeftSec()), attr: { role: "timer", "aria-label": "\u5269\u4F59\u65F6\u95F4" } });
      const stateEl = head.createDiv({ cls: "pmd-state", text: "\u5F85\u673A" });
      const modeButton = head.createEl("button", {
        text: "\u666E\u901A\u4E13\u6CE8",
        cls: "pmd-btn pmd-mode-toggle",
        attr: { type: "button", "aria-label": "\u5207\u6362\u5DE5\u4F5C\u6A21\u5F0F", "aria-pressed": "false" }
      });
      const openTodayBtn = head.createEl("button", { text: "\u6253\u5F00\u5F53\u65E5\u65E5\u8BB0", cls: "pmd-btn pmd-btn-secondary", attr: { type: "button" } });
      const projectDetails = container.createEl("details", { cls: "pmd-project" });
      const projectSummary = projectDetails.createEl("summary", { text: "\u5171\u540C\u9879\u76EE\uFF08\u53EF\u9009\uFF09" });
      const projWrap = projectDetails.createDiv({ cls: "pmd-row-inline pmd-project-row" });
      const projBox = projWrap.createDiv({ cls: "pmd-input-wrap" });
      const projectTagLabel = normalizeTag(this.plugin.settings.projectTag || "#project") || "#project";
      const projInput = projBox.createEl("input", { type: "text", attr: { list: "pmdProjList", placeholder: `\u5173\u8054\u9879\u76EE\uFF08\u53EF\u9009\uFF1B${projectTagLabel} \u4E14\u72B6\u6001\u5728\u767D\u540D\u5355\uFF09`, "aria-label": "\u5173\u8054\u9879\u76EE\uFF08\u53EF\u9009\uFF09" }, cls: "pmd-input" });
      const projList = projBox.createEl("datalist", { attr: { id: "pmdProjList" } });
      const _openDatalist = (input) => {
        const prev = input.value;
        const inputWrap = !prev && input.closest(".pmd-input-wrap");
        inputWrap?.classList.add("pmd-datalist-opening");
        input.value = prev + "\u200B";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(() => {
          input.value = prev;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          inputWrap?.classList.remove("pmd-datalist-opening");
        }, 0);
      };
      projInput.addEventListener("focus", () => _openDatalist(projInput));
      projInput.addEventListener("click", () => _openDatalist(projInput));
      const clearProjBtn = projBox.createEl("button", { text: "\xD7", cls: "pmd-clear", attr: { title: "\u6E05\u7A7A\u9879\u76EE\u9009\u62E9", "aria-label": "\u6E05\u7A7A\u9879\u76EE\u9009\u62E9", type: "button" } });
      projInput.onkeydown = (e) => {
        if (this.plugin.shouldBlockHotkeys(e, { allowInPluginInput: true })) return;
        if (e.key === "Escape") {
          e.preventDefault();
          projInput.value = "";
          this.plugin.setCurrentProjectPath("");
        }
      };
      const openProjBtn = projWrap.createEl("button", { text: "\u6253\u5F00\u9879\u76EE", cls: "pmd-btn pmd-btn-secondary", attr: { type: "button" } });
      openProjBtn.onclick = () => this.plugin.openCurrentProject();
      const taskWrap = container.createDiv({ cls: "pmd-row pmd-row-inline" });
      const taskBox = taskWrap.createDiv({ cls: "pmd-input-wrap" });
      const taskInput = taskBox.createEl("input", { type: "text", attr: { list: "pmdTaskList", placeholder: "\u8F93\u5165/\u9009\u62E9\u4EFB\u52A1\u540D\uFF08\u4EC5\u663E\u793A\u672A\u52FE\u9009\uFF09", "aria-label": "\u5F53\u524D\u4EFB\u52A1" }, cls: "pmd-input" });
      taskInput.addEventListener("focus", () => _openDatalist(taskInput));
      taskInput.addEventListener("click", () => _openDatalist(taskInput));
      const taskList = taskBox.createEl("datalist", { attr: { id: "pmdTaskList" } });
      let _suppressTaskSyncUntil = 0;
      const clearTaskBtn = taskBox.createEl("button", { text: "\xD7", cls: "pmd-clear", attr: { title: "\u6E05\u7A7A\u4EFB\u52A1\u540D", "aria-label": "\u6E05\u7A7A\u4EFB\u52A1\u540D", type: "button" } });
      taskInput.onkeydown = (e) => {
        if (this.plugin.shouldBlockHotkeys(e, { allowInPluginInput: true })) return;
        if (e.key === "Escape") {
          e.preventDefault();
          _suppressTaskSyncUntil = Date.now() + 1200;
          taskInput.value = "";
          this.plugin.setCurrentTaskName("");
        }
      };
      const longWrap = container.createDiv({ cls: "pmd-row pmd-row-inline pmd-long-row" });
      const longLabel = longWrap.createSpan({ cls: "pmd-long-label", text: "\u957F\u4E13\u6CE8\uFF08\u5206\u949F\uFF09" });
      const longInput = longWrap.createEl("input", {
        type: "number",
        cls: "pmd-long-input",
        attr: { min: "1", step: "5", placeholder: "50", "aria-label": "\u957F\u4E13\u6CE8\u65F6\u957F\uFF08\u5206\u949F\uFF09" }
      });
      const ensureLongValue = () => {
        const fallback = this.plugin.runtime.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25;
        const val = Number(longInput.value);
        const normalized = isFinite(val) && val > 0 ? Math.round(val * 10) / 10 : Math.round(fallback * 10) / 10;
        longInput.value = String(normalized);
        this.plugin.setLongFocusMinutes(normalized);
        return normalized;
      };
      longInput.value = String(this.plugin.runtime.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25);
      longInput.onchange = () => ensureLongValue();
      longInput.onblur = () => ensureLongValue();
      const longBtn = longWrap.createEl("button", { text: "\u5F00\u59CB\u957F\u4E13\u6CE8", cls: "pmd-btn", attr: { type: "button" } });
      const cycleWrap = container.createDiv({ cls: "pmd-cycle" });
      const cycleRowA = cycleWrap.createDiv({ cls: "pmd-cycle-row" });
      const cycleRoleA = cycleRowA.createSpan({ cls: "pmd-cycle-role", text: "\u5F53\u524D" });
      const cycleFieldsA = cycleRowA.createDiv({ cls: "pmd-cycle-fields" });
      const cycleTaskWrapA = cycleFieldsA.createDiv({ cls: "pmd-input-wrap" });
      const cycleTaskA = cycleTaskWrapA.createEl("input", {
        type: "text",
        cls: "pmd-input",
        attr: { list: "pmdCycleTaskListA", placeholder: "\u4EFB\u52A1 A", "aria-label": "\u5FAA\u73AF\u4EFB\u52A1 A" }
      });
      const cycleTaskListA = cycleTaskWrapA.createEl("datalist", { attr: { id: "pmdCycleTaskListA" } });
      const clearCycleTaskA = cycleTaskWrapA.createEl("button", { text: "\xD7", cls: "pmd-clear", attr: { title: "\u6E05\u7A7A\u4EFB\u52A1\u540D", "aria-label": "\u6E05\u7A7A\u4EFB\u52A1\u540D", type: "button" } });
      const cycleWorkspaceA = cycleFieldsA.createEl("input", {
        type: "text",
        cls: "pmd-cycle-workspace",
        attr: { list: "pmdCycleWorkspaceListA", placeholder: "\u7B5B\u9009/\u9009\u62E9\u5E03\u5C40", "aria-label": "\u4EFB\u52A1 A \u5DE5\u4F5C\u533A\u5E03\u5C40", title: "\u5F00\u59CB\u4EFB\u52A1 A \u65F6\u52A0\u8F7D\u7684 Workspaces Plus \u5E03\u5C40" }
      });
      const cycleWorkspaceListA = cycleFieldsA.createEl("datalist", { attr: { id: "pmdCycleWorkspaceListA" } });
      const cycleDurationA = cycleRowA.createDiv({ cls: "pmd-cycle-duration" });
      const cycleMinA = cycleDurationA.createEl("input", {
        type: "number",
        cls: "pmd-cycle-min",
        attr: { min: "1", step: "1", placeholder: "\u65F6\u957F", "aria-label": "\u4EFB\u52A1 A \u65F6\u957F\uFF08\u5206\u949F\uFF09" }
      });
      cycleDurationA.createSpan({ cls: "pmd-cycle-unit", text: "\u5206\u949F" });
      const cycleRowB = cycleWrap.createDiv({ cls: "pmd-cycle-row" });
      const cycleRoleB = cycleRowB.createSpan({ cls: "pmd-cycle-role", text: "\u4E0B\u4E00\u6BB5" });
      const cycleFieldsB = cycleRowB.createDiv({ cls: "pmd-cycle-fields" });
      const cycleTaskWrapB = cycleFieldsB.createDiv({ cls: "pmd-input-wrap" });
      const cycleTaskB = cycleTaskWrapB.createEl("input", {
        type: "text",
        cls: "pmd-input",
        attr: { list: "pmdCycleTaskListB", placeholder: "\u4EFB\u52A1 B", "aria-label": "\u5FAA\u73AF\u4EFB\u52A1 B" }
      });
      const cycleTaskListB = cycleTaskWrapB.createEl("datalist", { attr: { id: "pmdCycleTaskListB" } });
      const clearCycleTaskB = cycleTaskWrapB.createEl("button", { text: "\xD7", cls: "pmd-clear", attr: { title: "\u6E05\u7A7A\u4EFB\u52A1\u540D", "aria-label": "\u6E05\u7A7A\u4EFB\u52A1\u540D", type: "button" } });
      const cycleWorkspaceB = cycleFieldsB.createEl("input", {
        type: "text",
        cls: "pmd-cycle-workspace",
        attr: { list: "pmdCycleWorkspaceListB", placeholder: "\u7B5B\u9009/\u9009\u62E9\u5E03\u5C40", "aria-label": "\u4EFB\u52A1 B \u5DE5\u4F5C\u533A\u5E03\u5C40", title: "\u5F00\u59CB\u4EFB\u52A1 B \u65F6\u52A0\u8F7D\u7684 Workspaces Plus \u5E03\u5C40" }
      });
      const cycleWorkspaceListB = cycleFieldsB.createEl("datalist", { attr: { id: "pmdCycleWorkspaceListB" } });
      const cycleDurationB = cycleRowB.createDiv({ cls: "pmd-cycle-duration" });
      const cycleMinB = cycleDurationB.createEl("input", {
        type: "number",
        cls: "pmd-cycle-min",
        attr: { min: "1", step: "1", placeholder: "\u65F6\u957F", "aria-label": "\u4EFB\u52A1 B \u65F6\u957F\uFF08\u5206\u949F\uFF09" }
      });
      cycleDurationB.createSpan({ cls: "pmd-cycle-unit", text: "\u5206\u949F" });
      cycleTaskA.value = this.plugin.settings.cycleTaskA || "";
      cycleTaskB.value = this.plugin.settings.cycleTaskB || "";
      cycleMinA.value = String(this.plugin.settings.cycleMinA || 15);
      cycleMinB.value = String(this.plugin.settings.cycleMinB || 15);
      const fillWorkspaceList = (input, list, selected = "") => {
        const commands = this.plugin.getWorkspaceLayoutCommands();
        list.empty();
        commands.forEach((command) => list.createEl("option", { attr: { value: workspaceLayoutLabel(command) } }));
        const selectedCommand = commands.find((command) => command.id === selected);
        input.dataset.commandId = selectedCommand?.id || "";
        input.value = selectedCommand ? workspaceLayoutLabel(selectedCommand) : selected ? "\u5E03\u5C40\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u9009" : "";
      };
      const selectWorkspace = (input) => {
        const command = this.plugin.getWorkspaceLayoutCommands().find((item) => workspaceLayoutLabel(item) === input.value.trim());
        if (!command && input.value.trim()) {
          const current = this.plugin.getWorkspaceLayoutCommands().find((item) => item.id === input.dataset.commandId);
          input.value = current ? workspaceLayoutLabel(current) : "";
          return;
        }
        input.dataset.commandId = command?.id || "";
        saveCycleConfig();
      };
      fillWorkspaceList(cycleWorkspaceA, cycleWorkspaceListA, this.plugin.settings.cycleWorkspaceCommandA || "");
      fillWorkspaceList(cycleWorkspaceB, cycleWorkspaceListB, this.plugin.settings.cycleWorkspaceCommandB || "");
      cycleWorkspaceA.onfocus = () => fillWorkspaceList(cycleWorkspaceA, cycleWorkspaceListA, cycleWorkspaceA.dataset.commandId || "");
      cycleWorkspaceB.onfocus = () => fillWorkspaceList(cycleWorkspaceB, cycleWorkspaceListB, cycleWorkspaceB.dataset.commandId || "");
      const actions = container.createDiv({ cls: "pmd-actions" });
      const startBtn = actions.createEl("button", { text: "\u5F00\u59CB\u4E13\u6CE8", cls: "pmd-btn pmd-btn-primary", attr: { type: "button" } });
      const pauseBtn = actions.createEl("button", { text: "\u6682\u505C", cls: "pmd-btn", attr: { type: "button" } });
      const resetBtn = actions.createEl("button", { text: "\u91CD\u7F6E", cls: "pmd-btn", attr: { type: "button" } });
      const doneBtn = actions.createEl("button", { text: "\u5B8C\u6210\u672C\u6BB5", cls: "pmd-btn", attr: { type: "button" } });
      const refreshBtn = actions.createEl("button", { text: "\u5237\u65B0", cls: "pmd-btn pmd-btn-secondary", attr: { type: "button" } });
      const meta = container.createDiv({ cls: "pmd-meta" });
      const sumEl = meta.createSpan({ text: "\u4ECA\u65E5\u7D2F\u8BA1\uFF1A0\u{1F345}" });
      const sessionEl = meta.createSpan({ text: "  \u672C\u6B21\u5DF2\u5B8C\u6210\uFF1A0 \u6BB5" });
      let taskSaveTimer = null;
      const saveTask = () => {
        if (taskSaveTimer) window.clearTimeout(taskSaveTimer);
        taskSaveTimer = null;
        if (this.plugin.runtime.currentTaskName === taskInput.value.trim()) return;
        this.plugin.setCurrentTaskName(taskInput.value);
      };
      taskInput.oninput = () => {
        _suppressTaskSyncUntil = Date.now() + 1200;
        if (taskSaveTimer) window.clearTimeout(taskSaveTimer);
        taskSaveTimer = window.setTimeout(saveTask, 180);
      };
      taskInput.onchange = saveTask;
      modeButton.onclick = () => {
        const next = this.plugin.settings.workMode === "cycle" ? "standard" : "cycle";
        this.plugin.setWorkMode(next);
      };
      let cycleSaveTimer = null;
      const saveCycleConfig = () => {
        if (cycleSaveTimer) window.clearTimeout(cycleSaveTimer);
        cycleSaveTimer = null;
        const patch = {
          cycleTaskA: cycleTaskA.value.trim(),
          cycleMinA: Math.max(1, Number(cycleMinA.value) || 15),
          cycleWorkspaceCommandA: cycleWorkspaceA.dataset.commandId || "",
          cycleTaskB: cycleTaskB.value.trim(),
          cycleMinB: Math.max(1, Number(cycleMinB.value) || 15),
          cycleWorkspaceCommandB: cycleWorkspaceB.dataset.commandId || ""
        };
        if (Object.entries(patch).every(([key, value]) => this.plugin.settings[key] === value)) return;
        this.plugin.setCycleConfig(patch);
      };
      const queueCycleSave = () => {
        if (cycleSaveTimer) window.clearTimeout(cycleSaveTimer);
        cycleSaveTimer = window.setTimeout(saveCycleConfig, 180);
      };
      [cycleTaskA, cycleMinA, cycleTaskB, cycleMinB].forEach((input) => {
        input.oninput = queueCycleSave;
        input.onchange = saveCycleConfig;
      });
      [cycleWorkspaceA, cycleWorkspaceB].forEach((input) => {
        input.oninput = () => {
          if (this.plugin.getWorkspaceLayoutCommands().some((command) => workspaceLayoutLabel(command) === input.value.trim())) selectWorkspace(input);
        };
        input.onchange = () => selectWorkspace(input);
      });
      [cycleTaskA, cycleTaskB].forEach((input) => {
        input.addEventListener("focus", () => _openDatalist(input));
        input.addEventListener("click", () => _openDatalist(input));
      });
      cycleRowA.ondblclick = (event) => {
        if (!event.target.closest("input, button, select")) this.plugin.selectCycleSlot(0);
      };
      cycleRowB.ondblclick = (event) => {
        if (!event.target.closest("input, button, select")) this.plugin.selectCycleSlot(1);
      };
      const clearCurrentTask = (event) => {
        event?.preventDefault();
        if (taskSaveTimer) window.clearTimeout(taskSaveTimer);
        taskSaveTimer = null;
        _suppressTaskSyncUntil = Date.now() + 1500;
        taskInput.value = "";
        this.plugin.setCurrentTaskName("");
        taskInput.focus();
      };
      const clearCycleTask = (input, event) => {
        event?.preventDefault();
        input.value = "";
        saveCycleConfig();
        input.focus();
      };
      clearTaskBtn.onpointerdown = clearCurrentTask;
      clearTaskBtn.onclick = (event) => {
        if (event.detail === 0) clearCurrentTask(event);
      };
      clearCycleTaskA.onpointerdown = (event) => clearCycleTask(cycleTaskA, event);
      clearCycleTaskA.onclick = (event) => {
        if (event.detail === 0) clearCycleTask(cycleTaskA, event);
      };
      clearCycleTaskB.onpointerdown = (event) => clearCycleTask(cycleTaskB, event);
      clearCycleTaskB.onclick = (event) => {
        if (event.detail === 0) clearCycleTask(cycleTaskB, event);
      };
      projInput.onchange = () => {
        const label = projInput.value;
        const hit = (this._projOpts || []).find((x) => x.label === label);
        this.plugin.setCurrentProjectPath(hit ? hit.path : "");
      };
      const clearProject = (event) => {
        event?.preventDefault();
        projInput.value = "";
        this.plugin.setCurrentProjectPath("");
        projInput.focus();
      };
      clearProjBtn.onpointerdown = clearProject;
      clearProjBtn.onclick = (event) => {
        if (event.detail === 0) clearProject(event);
      };
      openTodayBtn.onclick = () => this.plugin.openToday();
      longBtn.onclick = () => {
        const minutes = ensureLongValue();
        this.plugin.startFocus({ cause: "manual", minutes });
      };
      startBtn.onclick = () => {
        const snap = this.plugin.snapshot();
        if (snap.runtime.paused) {
          this.plugin.togglePause(true);
          return;
        }
        if (snap.runtime.strongAlert && snap.runtime.pendingPhase) {
          this.plugin.startPendingStage();
          return;
        }
        if (this.plugin.settings.workMode === "cycle") {
          saveCycleConfig();
          this.plugin.startCycle();
        } else {
          saveTask();
          this.plugin.startFocus({ cause: "manual" });
        }
      };
      pauseBtn.onclick = () => this.plugin.togglePause();
      resetBtn.onclick = () => this.plugin.reset();
      doneBtn.onclick = () => this.plugin.forceCompleteFocusOnce();
      const refreshTodayUI = async () => {
        const snap = await this._safeRefreshTodaySnapshot();
        this._todaySumCache = snap.sum;
        this._fillTaskOptions(taskList, snap.unchecked);
        this._fillTaskOptions(cycleTaskListA, snap.unchecked);
        this._fillTaskOptions(cycleTaskListB, snap.unchecked);
        sumEl.setText(`\u4ECA\u65E5\u7D2F\u8BA1\uFF1A${formatTomatoNumber(snap.sum)}\u{1F345}`);
        this.plugin.broadcast();
      };
      refreshBtn.onclick = refreshTodayUI;
      let lastRenderKey = "";
      let lastProjectMode = null;
      const show = (el, visible) => el.classList.toggle("pmd-hidden", !visible);
      const onState = (snap) => {
        const { settings: s, runtime: r } = snap;
        const cycleMode = s.workMode === "cycle";
        timeEl.setText(mmss(r.leftSec || 0));
        const renderKey = [
          cycleMode,
          s.showProjectSelector,
          s.currentProjectPath,
          s.dailyGoal,
          s.cycleTaskA,
          s.cycleMinA,
          s.cycleWorkspaceCommandA,
          s.cycleTaskB,
          s.cycleMinB,
          s.cycleWorkspaceCommandB,
          r.phase,
          r.paused,
          r.strongAlert,
          r.pendingPhase,
          r.pendingCycleSlot,
          r.cycleActive,
          r.cycleSlot,
          r.sessionCount,
          r.currentTaskName,
          r.longFocusMinutes,
          this._todaySumCache
        ].join("|");
        if (renderKey === lastRenderKey) return;
        lastRenderKey = renderKey;
        projectDetails.classList.toggle("pmd-hidden", s.showProjectSelector === false);
        projectDetails.classList.toggle("is-cycle", cycleMode);
        if (lastProjectMode !== cycleMode) {
          projectDetails.open = !cycleMode;
          lastProjectMode = cycleMode;
        }
        const projectName = String(s.currentProjectPath || "").split("/").pop()?.replace(/\.md$/i, "");
        projectSummary.setText(projectName ? `\u5171\u540C\u9879\u76EE \xB7 ${projectName}` : "\u5171\u540C\u9879\u76EE\uFF08\u53EF\u9009\uFF09");
        projInput.setAttribute("placeholder", cycleMode ? "\u9009\u62E9\u5171\u540C\u9879\u76EE\uFF08\u53EF\u9009\uFF09" : `\u5173\u8054\u9879\u76EE\uFF08\u53EF\u9009\uFF1B${projectTagLabel} \u4E14\u72B6\u6001\u5728\u767D\u540D\u5355\uFF09`);
        projInput.setAttribute("aria-label", cycleMode ? "\u5171\u540C\u9879\u76EE\uFF08\u53EF\u9009\uFF09" : "\u5173\u8054\u9879\u76EE\uFF08\u53EF\u9009\uFF09");
        taskWrap.classList.toggle("pmd-hidden", cycleMode);
        longWrap.classList.toggle("pmd-hidden", cycleMode);
        cycleWrap.classList.toggle("pmd-hidden", !cycleMode);
        const modeLocked = r.phase !== "idle" || r.cycleActive;
        modeButton.disabled = modeLocked;
        modeButton.setText(cycleMode ? "\u5FAA\u73AF\u5DE5\u4F5C" : "\u666E\u901A\u4E13\u6CE8");
        modeButton.setAttribute("aria-pressed", String(cycleMode));
        modeButton.setAttribute("aria-label", cycleMode ? "\u5F53\u524D\u4E3A\u5FAA\u73AF\u5DE5\u4F5C\uFF0C\u70B9\u51FB\u5207\u6362\u5230\u666E\u901A\u4E13\u6CE8" : "\u5F53\u524D\u4E3A\u666E\u901A\u4E13\u6CE8\uFF0C\u70B9\u51FB\u5207\u6362\u5230\u5FAA\u73AF\u5DE5\u4F5C");
        modeButton.setAttribute("title", cycleMode ? "\u5207\u6362\u5230\u666E\u901A\u4E13\u6CE8" : "\u5207\u6362\u5230\u5FAA\u73AF\u5DE5\u4F5C");
        const lockCycleA = r.cycleActive && r.cycleSlot === 0;
        const lockCycleB = r.cycleActive && r.cycleSlot === 1;
        [cycleTaskA, cycleMinA, clearCycleTaskA, cycleWorkspaceA].forEach((input) => input.disabled = lockCycleA);
        [cycleTaskB, cycleMinB, clearCycleTaskB, cycleWorkspaceB].forEach((input) => input.disabled = lockCycleB);
        if (document.activeElement !== cycleWorkspaceA && cycleWorkspaceA.dataset.commandId !== (s.cycleWorkspaceCommandA || "")) {
          fillWorkspaceList(cycleWorkspaceA, cycleWorkspaceListA, s.cycleWorkspaceCommandA || "");
        }
        if (document.activeElement !== cycleWorkspaceB && cycleWorkspaceB.dataset.commandId !== (s.cycleWorkspaceCommandB || "")) {
          fillWorkspaceList(cycleWorkspaceB, cycleWorkspaceListB, s.cycleWorkspaceCommandB || "");
        }
        if (cycleMode) {
          const currentSlot = Number.isInteger(r.pendingCycleSlot) ? r.pendingCycleSlot : r.cycleSlot === 1 ? 1 : 0;
          const canSelectSlot = r.phase === "idle" && !r.strongAlert;
          cycleRowA.classList.toggle("is-current", currentSlot === 0);
          cycleRowB.classList.toggle("is-current", currentSlot === 1);
          cycleRowA.classList.toggle("is-selectable", canSelectSlot);
          cycleRowB.classList.toggle("is-selectable", canSelectSlot);
          cycleRowA.setAttribute("title", canSelectSlot ? "\u53CC\u51FB\u8BBE\u4E3A\u5F53\u524D\u4EFB\u52A1" : "");
          cycleRowB.setAttribute("title", canSelectSlot ? "\u53CC\u51FB\u8BBE\u4E3A\u5F53\u524D\u4EFB\u52A1" : "");
          cycleRoleA.setText(currentSlot === 0 ? r.strongAlert ? "\u5F85\u5F00\u59CB" : "\u5F53\u524D" : "\u4E0B\u4E00\u6BB5");
          cycleRoleB.setText(currentSlot === 1 ? r.strongAlert ? "\u5F85\u5F00\u59CB" : "\u5F53\u524D" : "\u4E0B\u4E00\u6BB5");
          cycleRowA.setAttribute("aria-label", `${cycleRoleA.textContent}\uFF1A\u4EFB\u52A1 A`);
          cycleRowB.setAttribute("aria-label", `${cycleRoleB.textContent}\uFF1A\u4EFB\u52A1 B`);
        }
        const max = s.dailyGoal || 8;
        const done = this._todaySumCache ?? 0;
        ringText.textContent = `${formatTomatoNumber(done)}/${max}`;
        ring.setAttribute("aria-valuemax", String(max));
        ring.setAttribute("aria-valuenow", String(done));
        const C = 2 * Math.PI * 30;
        const offset = C * (1 - Math.min(done / max, 1));
        ringProgress.setAttribute("stroke-dashoffset", String(offset));
        stateEl.setText(r.strongAlert && r.phase === "idle" ? "\u5F85\u786E\u8BA4" : r.phase === "focus" ? "\u4E13\u6CE8" : r.phase === "break" ? "\u4F11\u606F" : "\u5F85\u673A");
        const idle = r.phase === "idle";
        show(startBtn, idle || r.paused);
        show(pauseBtn, !idle && !r.paused);
        show(resetBtn, !idle || r.strongAlert);
        show(doneBtn, r.phase === "focus");
        if (r.paused) startBtn.setText("\u7EE7\u7EED");
        else if (r.strongAlert && r.pendingPhase === "break") startBtn.setText("\u5F00\u59CB\u4F11\u606F");
        else if (r.strongAlert && r.pendingPhase === "focus") startBtn.setText(cycleMode ? "\u5F00\u59CB\u4E0B\u4E00\u6BB5" : "\u5F00\u59CB\u4E13\u6CE8");
        else startBtn.setText(cycleMode ? "\u5F00\u59CB\u5FAA\u73AF\u5DE5\u4F5C" : "\u5F00\u59CB\u4E13\u6CE8");
        if (Date.now() >= _suppressTaskSyncUntil && document.activeElement !== taskInput && taskInput.value !== (r.currentTaskName || "")) taskInput.value = r.currentTaskName || "";
        sessionEl.setText(`\u672C\u6B21\u5DF2\u5B8C\u6210\uFF1A${r.sessionCount || 0} \u6BB5`);
        if (document.activeElement !== longInput) {
          const target = r.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25;
          longInput.value = String(Math.round(target * 10) / 10);
        }
      };
      this.app.workspace.on("pomodoro:aio-state", onState);
      this.disposers.push(() => this.app.workspace.off("pomodoro:aio-state", onState));
      taskInput.value = this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName || "";
      longInput.value = String(Math.round((this.plugin.runtime.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25) * 10) / 10);
      onState(this.plugin.snapshot());
      await refreshTodayUI();
      const projects = this._safeProjectCandidates();
      this._projOpts = projects;
      this._fillProjectOptions(projList, projects);
      if (this.plugin.settings.currentProjectPath) {
        const hit = projects.find((p) => p.path === this.plugin.settings.currentProjectPath);
        if (hit) projInput.value = hit.label;
      }
      let vaultRefreshTimer = null;
      const onVaultModify = (file) => {
        if (file?.path !== this.plugin.todayFilePath()) return;
        if (vaultRefreshTimer) window.clearTimeout(vaultRefreshTimer);
        vaultRefreshTimer = window.setTimeout(refreshTodayUI, 180);
      };
      const vaultModifyRef = this.app.vault.on("modify", onVaultModify);
      this.disposers.push(() => {
        if (vaultRefreshTimer) window.clearTimeout(vaultRefreshTimer);
        this.app.vault.offref(vaultModifyRef);
      });
      this.disposers.push(() => {
        if (taskSaveTimer) saveTask();
        if (cycleSaveTimer) saveCycleConfig();
      });
    } catch (err) {
      console.error(err);
      new Notice("\u756A\u8304\u89C6\u56FE\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u65E5\u5FD7");
    }
  }
  _fillTaskOptions(datalist, arr) {
    datalist.empty();
    arr.forEach((n) => datalist.createEl("option", { attr: { value: n } }));
  }
  _fillProjectOptions(datalist, arr) {
    datalist.empty();
    arr.forEach((o) => datalist.createEl("option", { attr: { value: o.label } }));
  }
  async _safeRefreshTodaySnapshot() {
    try {
      return await this.plugin.refreshTodaySnapshot();
    } catch (err) {
      console.error(err);
      return { file: null, sum: 0, unchecked: [] };
    }
  }
  _safeProjectCandidates() {
    try {
      return this.plugin.projectCandidates();
    } catch (err) {
      console.error(err);
      return [];
    }
  }
  async onClose() {
    if (this._projTimer) window.clearInterval(this._projTimer);
    this.disposers.forEach((off) => {
      try {
        if (typeof off === "function") off();
        else if (off?.off) off.off();
      } catch (err) {
        console.error(err);
      }
    });
    this.disposers.length = 0;
    try {
      this.plugin.runtime.viewWasOpen = false;
      this.plugin.saveState();
    } catch {
    }
  }
};
__publicField(_PomodoroView, "VIEW_TYPE", "pomodoro-aio-view");
var PomodoroView = _PomodoroView;
var PomodoroSettingTab = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const s = this.plugin.settings;
    const set = async (patch) => {
      Object.assign(this.plugin.settings, patch);
      await this.plugin.saveSettings();
      this.plugin.broadcast();
    };
    const c = this.containerEl;
    c.empty();
    c.createEl("h2", { text: "Pomodoro AIO \u8BBE\u7F6E" });
    c.createEl("h3", { text: "\u8BA1\u65F6\u53C2\u6570" });
    new Setting(c).setName("\u4E13\u6CE8\u65F6\u957F\uFF08\u5206\u949F\uFF09").addText((t) => t.setValue(String(s.focusMin)).onChange((v) => set({ focusMin: positiveNumber(v, 25) })));
    new Setting(c).setName("\u9ED8\u8BA4\u957F\u4E13\u6CE8\u65F6\u957F\uFF08\u5206\u949F\uFF09").setDesc("\u7528\u4E8E\u89C6\u56FE\u4E2D\u7684\u957F\u4E13\u6CE8\u6309\u94AE").addText((t) => t.setValue(String(s.longFocusDefaultMin || 50)).onChange((v) => {
      const num = positiveNumber(v, positiveNumber(s.focusMin, 25));
      set({ longFocusDefaultMin: num });
      this.plugin.setLongFocusMinutes(num);
    }));
    new Setting(c).setName("\u77ED\u4F11\u65F6\u957F\uFF08\u5206\u949F\uFF09").addText((t) => t.setValue(String(s.breakMin)).onChange((v) => set({ breakMin: positiveNumber(v, 5) })));
    new Setting(c).setName("\u957F\u4F11\u65F6\u957F\uFF08\u5206\u949F\uFF09").addText((t) => t.setValue(String(s.longBreakMin)).onChange((v) => set({ longBreakMin: positiveNumber(v, 15) })));
    new Setting(c).setName("\u6BCF N \u6B21\u957F\u4F11\u4E00\u6B21").addText((t) => t.setValue(String(s.longEvery)).onChange((v) => set({ longEvery: Math.max(1, Math.round(positiveNumber(v, 4, 1))) })));
    new Setting(c).setName("\u5B8C\u6210\u540E\u81EA\u52A8\u8FDB\u5165\u4E0B\u4E00\u6BB5").setDesc("\u4EC5\u666E\u901A\u6A21\u5F0F\uFF1B\u5FAA\u73AF\u5DE5\u4F5C\u6BCF\u6BB5\u7ED3\u675F\u540E\u9700\u70B9\u51FB Ribbon \u786E\u8BA4\u4E0B\u4E00\u6BB5").addToggle((t) => t.setValue(s.autoNext).onChange((v) => set({ autoNext: v })));
    c.createEl("h3", { text: "\u5FAA\u73AF\u5DE5\u4F5C\uFF08\u65E0\u4F11\u606F\uFF09" });
    new Setting(c).setName("\u4EFB\u52A1 A \u9ED8\u8BA4\u65F6\u957F\uFF08\u5206\u949F\uFF09").addText((t) => t.setValue(String(s.cycleMinA || 15)).onChange((v) => this.plugin.setCycleConfig({ cycleMinA: Math.max(1, Number(v) || 15) })));
    new Setting(c).setName("\u4EFB\u52A1 B \u9ED8\u8BA4\u65F6\u957F\uFF08\u5206\u949F\uFF09").addText((t) => t.setValue(String(s.cycleMinB || 15)).onChange((v) => this.plugin.setCycleConfig({ cycleMinB: Math.max(1, Number(v) || 15) })));
    c.createEl("h3", { text: "\u4E00\u5929\u8D77\u6B62 & \u5F53\u65E5\u65E5\u8BB0" });
    new Setting(c).setName("\u4E00\u5929\u5F00\u59CB\u65F6\u95F4\uFF08HH:MM\uFF09").setDesc("\u4F8B\uFF1A04:00\uFF1B\u5728 04:00 \u524D\u5B8C\u6210\u7684\u756A\u8304\u8BB0\u5728\u524D\u4E00\u5929").addText((t) => t.setValue(s.dayStartHHMM).onChange((v) => set({ dayStartHHMM: v || "00:00" })));
    new Setting(c).setName("\u5F53\u65E5\u8DEF\u5F84\u6A21\u677F").setDesc("\u4E0D\u4F9D\u8D56 Daily Notes\uFF1B\u4F7F\u7528 {{date:YYYY-MM-DD}}").addText((t) => t.setValue(s.fallbackPattern).onChange((v) => set({ fallbackPattern: v || "Daily/{{date:YYYY-MM-DD}}.md" })));
    new Setting(c).setName("\u627E\u4E0D\u5230\u5F53\u5929\u6587\u4EF6\u65F6\u81EA\u52A8\u521B\u5EFA").addToggle((t) => t.setValue(s.allowCreateDaily).onChange((v) => set({ allowCreateDaily: v })));
    c.createEl("h3", { text: "\u4EFB\u52A1\u4E0E\u5199\u5165" });
    new Setting(c).setName("\u9ED8\u8BA4\u4EFB\u52A1\u540D\uFF08\u53EF\u7A7A\uFF09").addText((t) => t.setValue(s.defaultTaskName).onChange((v) => set({ defaultTaskName: v })));
    new Setting(c).setName("\u672A\u627E\u5230\u540C\u540D\u4EFB\u52A1\u65F6\u81EA\u52A8\u521B\u5EFA").addToggle((t) => t.setValue(s.allowAutoCreateTask).onChange((v) => set({ allowAutoCreateTask: v })));
    new Setting(c).setName("\u65B0\u4EFB\u52A1\u63D2\u5165\u5230\u54EA\u4E2A\u6807\u9898\u4E0B\uFF08\u53EF\u7A7A\uFF09").addText((t) => t.setValue(s.tasksHeading).onChange((v) => set({ tasksHeading: v })));
    new Setting(c).setName("frontmatter \u952E\u540D\uFF08\u5F53\u5929\u6C47\u603B\uFF09").addText((t) => t.setValue(s.fmKey).onChange((v) => set({ fmKey: v || "\u756A\u8304\u6570" })));
    c.createEl("h3", { text: "\u9879\u76EE\u540C\u6B65" });
    new Setting(c).setName("\u542F\u7528\u9879\u76EE\u756A\u8304\u540C\u6B65").addToggle((t) => t.setValue(s.projectEnable).onChange((v) => set({ projectEnable: v })));
    new Setting(c).setName("\u9879\u76EE\u6807\u7B7E").addText((t) => t.setValue(s.projectTag).onChange((v) => set({ projectTag: normalizeTag(v) || "#project" })));
    new Setting(c).setName("\u9879\u76EE\u72B6\u6001\u5B57\u6BB5\u540D").addText((t) => t.setValue(s.projectStatusKey).onChange((v) => set({ projectStatusKey: v || "\u9879\u76EE\u72B6\u6001" })));
    new Setting(c).setName("\u5141\u8BB8\u7684\u9879\u76EE\u72B6\u6001\uFF08\u9017\u53F7\u5206\u9694\uFF09").addText((t) => t.setValue(s.projectStatusWhitelist).onChange((v) => set({ projectStatusWhitelist: v || "\u8FDB\u884C\u4E2D,\u7B79\u5212\u4E2D" })));
    new Setting(c).setName("\u9879\u76EE frontmatter \u952E\u540D").addText((t) => t.setValue(s.projectFmKey).onChange((v) => set({ projectFmKey: v || "\u756A\u8304\u6570" })));
    new Setting(c).setName("\u663E\u793A\u9879\u76EE\u9009\u62E9").setDesc("\u5173\u95ED\u540E\u4FA7\u680F\u4E0D\u663E\u793A\u201C\u9009\u62E9\u9879\u76EE\u201D\u8F93\u5165\u6846\uFF1B\u5DF2\u9009\u9879\u76EE\u4ECD\u4F1A\u7EE7\u7EED\u540C\u6B65\u756A\u8304").addToggle((t) => t.setValue(s.showProjectSelector !== false).onChange((v) => set({ showProjectSelector: v })));
    c.createEl("h3", { text: "\u517C\u5BB9\u6027\u4E0E\u9632\u5E72\u6270" });
    new Setting(c).setName("\u5728\u5F39\u7A97\u4E0E\u8F93\u5165\u65F6\u7981\u7528\u5FEB\u6377\u952E\u4E0E\u805A\u7126\u64CD\u4F5C").setDesc("\u907F\u514D\u5E72\u6270 Workspaces / Workspaces Plus \u7684\u5F39\u7A97\u4E0E\u8F93\u5165\uFF0C\u63A8\u8350\u4FDD\u6301\u5F00\u542F").addToggle((t) => t.setValue(s.respectModalInputFocus !== false).onChange((v) => set({ respectModalInputFocus: v })));
    c.createEl("h3", { text: "\u63D0\u9192\u4E0E\u53EF\u89C6\u5316" });
    new Setting(c).setName("\u542F\u7528\u7CFB\u7EDF\u901A\u77E5").addToggle((t) => t.setValue(s.enableNotify).onChange((v) => set({ enableNotify: v })));
    new Setting(c).setName("\u542F\u7528\u8702\u9E23\u97F3").addToggle((t) => t.setValue(s.enableSound).onChange((v) => {
      set({ enableSound: v });
      if (!v) this.plugin.stopPersistentAlertSound();
      else if (this.plugin.runtime.strongAlert) this.plugin.startPersistentAlertSound();
    }));
    new Setting(c).setName("\u63D0\u793A\u97F3\u6CE2\u5F62").setDesc("sine/square/triangle\uFF1B\u82E5\u9700\u9759\u97F3\u53EF\u5728\u4E0A\u65B9\u5173\u95ED\u2018\u542F\u7528\u8702\u9E23\u97F3\u2019").addDropdown((d) => {
      d.addOptions({ sine: "sine", square: "square", triangle: "triangle" });
      d.setValue(this.plugin.settings.soundWaveform || "sine");
      d.onChange((v) => {
        const value = v === "square" || v === "triangle" ? v : "sine";
        set({ soundWaveform: value });
        if (this.plugin.runtime.strongAlert) {
          this.plugin.stopPersistentAlertSound();
          this.plugin.startPersistentAlertSound();
        }
      });
    });
    const soundOptions = {
      "focus-start": "\u4E0A\u626C\u53CC\u97F3",
      "break-start": "\u4E0B\u884C\u53CC\u97F3",
      "focus-end": "\u4E09\u8FDE\u5B8C\u6210\u97F3",
      "break-end": "\u56DE\u5F52\u4E13\u6CE8\u97F3",
      "focus-alert": "\u56DB\u8FDE\u5F3A\u63D0\u9192",
      "break-alert": "\u4E09\u8FDE\u5F3A\u63D0\u9192"
    };
    [
      ["\u5F00\u59CB\u4E13\u6CE8\u63D0\u793A\u97F3", "focusStartSound"],
      ["\u5F00\u59CB\u4F11\u606F\u63D0\u793A\u97F3", "breakStartSound"],
      ["\u4E13\u6CE8\u7ED3\u675F\u63D0\u793A\u97F3", "focusEndSound"],
      ["\u4F11\u606F\u7ED3\u675F\u63D0\u793A\u97F3", "breakEndSound"],
      ["\u4E13\u6CE8\u7ED3\u675F\u5F3A\u63D0\u9192\u97F3", "focusAlertSound"],
      ["\u4F11\u606F\u7ED3\u675F\u5F3A\u63D0\u9192\u97F3", "breakAlertSound"]
    ].forEach(([name, key]) => new Setting(c).setName(name).addDropdown((d) => {
      d.addOptions(soundOptions);
      d.setValue(s[key] || DEFAULT_SETTINGS[key]);
      d.onChange((v) => set({ [key]: soundOptions[v] ? v : DEFAULT_SETTINGS[key] }));
    }));
    new Setting(c).setName("\u6BCF\u65E5\u76EE\u6807\uFF08\u6BB5\uFF09").addText((t) => t.setValue(String(s.dailyGoal)).onChange((v) => set({ dailyGoal: positiveNumber(v, 8) })));
    c.createEl("h3", { text: "\u5F3A\u63D0\u9192\u4E0E\u81EA\u52A8\u5316" });
    new Setting(c).setName("\u6301\u7EED\u63D0\u793A\u97F3\uFF08\u5F3A\u63D0\u9192\uFF09").setDesc("\u6309\u4E0B\u65B9\u95F4\u9694\u518D\u6B21\u63D0\u9192\uFF0C\u76F4\u5230\u70B9\u51FB\u5DE6\u4FA7\u756A\u8304\u56FE\u6807").addToggle((t) => t.setValue(s.persistentAlertSound).onChange((v) => {
      set({ persistentAlertSound: v });
      if (!v) this.plugin.stopPersistentAlertSound();
      else if (this.plugin.runtime.strongAlert) this.plugin.startPersistentAlertSound();
    }));
    const restartStrongAlert = () => {
      if (!this.plugin.runtime.strongAlert) return;
      this.plugin.stopPersistentAlertSound();
      this.plugin.startPersistentAlertSound();
    };
    new Setting(c).setName("\u5F3A\u63D0\u9192\u9996\u6B21\u5347\u7EA7\u5EF6\u8FDF\uFF08\u79D2\uFF09").setDesc("\u5230\u70B9\u540E\u7684\u7B2C\u4E00\u6B21\u5347\u7EA7\u63D0\u9192\uFF1B\u9ED8\u8BA4 30 \u79D2").addText((t) => t.setValue(String(s.strongAlertDelaySec || 30)).onChange((v) => {
      set({ strongAlertDelaySec: Math.max(1, Math.round(Number(v) || 30)) });
      restartStrongAlert();
    }));
    new Setting(c).setName("\u5F3A\u63D0\u9192\u91CD\u590D\u95F4\u9694\uFF08\u79D2\uFF09").setDesc("\u9996\u6B21\u5347\u7EA7\u540E\u6BCF\u9694\u591A\u4E45\u91CD\u590D\uFF1B\u9ED8\u8BA4 60 \u79D2").addText((t) => t.setValue(String(s.strongAlertIntervalSec || 60)).onChange((v) => {
      set({ strongAlertIntervalSec: Math.max(1, Math.round(Number(v) || 60)) });
      restartStrongAlert();
    }));
    new Setting(c).setName("\u70B9\u51FB\u83DC\u5355\u56FE\u6807\u81EA\u52A8\u8FDB\u5165\u4E0B\u4E00\u9636\u6BB5").setDesc("\u5F3A\u63D0\u9192\u89E6\u53D1\u65F6\uFF0C\u70B9\u51FB\u56FE\u6807\u540E\u7ACB\u5373\u63A8\u8FDB\u4E0B\u4E00\u6BB5\u4E13\u6CE8/\u4F11\u606F").addToggle((t) => t.setValue(s.ribbonClickAutoNext).onChange((v) => set({ ribbonClickAutoNext: v })));
    const commandOptions = { "": "\uFF08\u4E0D\u6267\u884C\u547D\u4EE4\uFF09" };
    const allCommands = this.app.commands?.listCommands?.() || [];
    allCommands.forEach((cmd) => {
      if (cmd?.id) commandOptions[cmd.id] = `${cmd.name} (${cmd.id})`;
    });
    new Setting(c).setName("\u5F00\u59CB\u4E13\u6CE8\u65F6\u9644\u5E26\u547D\u4EE4").setDesc("\u5F53\u624B\u52A8\u6216\u5F3A\u63D0\u9192\u5F00\u59CB\u4E13\u6CE8\u65F6\uFF0C\u540C\u65F6\u6267\u884C\u6240\u9009\u547D\u4EE4").addDropdown((d) => {
      d.addOptions(commandOptions);
      d.setValue(s.focusStartCommandId || "");
      d.onChange((v) => set({ focusStartCommandId: v }));
    });
    new Setting(c).setName("\u5F00\u59CB\u4F11\u606F\u65F6\u9644\u5E26\u547D\u4EE4").setDesc("\u5F53\u624B\u52A8\u6216\u5F3A\u63D0\u9192\u786E\u8BA4\u5F00\u59CB\u77ED\u4F11/\u957F\u4F11\u65F6\uFF0C\u989D\u5916\u6267\u884C\u6240\u9009\u547D\u4EE4").addDropdown((d) => {
      d.addOptions(commandOptions);
      d.setValue(s.breakStartCommandId || "");
      d.onChange((v) => set({ breakStartCommandId: v }));
    });
  }
};
PomodoroAIO.prototype.registerStyles = function() {
};
module.exports = PomodoroAIO;
