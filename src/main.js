// Pomodoro AIO 源码。项目根目录的 main.js 由 esbuild 生成，请勿直接编辑。
// 变更点：项目下拉在任务上方；项目下拉后有“打开项目”；右上角新增“打开当日日记”按钮；左侧 Ribbon 加图标。

const {
  Plugin, Notice, TFile, ItemView, PluginSettingTab, Setting
} = require('obsidian');

/* ========== 默认设置 ========== */
const DEFAULT_SETTINGS = {
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
  fmKey: "番茄数",
  allowAutoCreateTask: true,
  tasksHeading: "",
  defaultTaskName: "",

  // 项目同步
  projectEnable: true,
  projectTag: "#project",
  projectStatusKey: "项目状态",
  projectStatusWhitelist: "进行中,筹划中",
  projectFmKey: "番茄数",
  currentProjectPath: "",
  showProjectSelector: true,

  // 可视化与提醒
  dailyGoal: 8,
  enableSound: true,
  enableNotify: true
  , soundWaveform: "sine",
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

/* ========== 工具函数 ========== */
function parseHHMMToMinutes(hhmm) {
  const m = String(hhmm||"").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const h = Math.min(23, Math.max(0, +m[1]));
  const mi = Math.min(59, Math.max(0, +m[2]));
  return h*60 + mi;
}
function getLogicalDayKey(now, startHHMM) {
  const startMin = parseHHMMToMinutes(startHHMM);
  const curMin = now.getHours()*60 + now.getMinutes();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = curMin >= startMin ? base : new Date(base.getTime()-86400000);
  const pad2 = (n)=> String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function renderPattern(pattern, dayKey) {
  return String(pattern||"").replace("{{date:YYYY-MM-DD}}", dayKey);
}
function getTomatoSum(text) {
  const re = /^\s*-\s*\[[^\]]\]\s+.*?(\d+(?:\.\d+)?)\s*🍅\s*$/;
  let sum = 0;
  for (const line of String(text||"").split(/\r?\n/)) {
    const m = line.match(re);
    if (m) sum += parseFloat(m[1]) || 0;
  }
  return Math.round(sum * 10) / 10;
}
function stripBaseName(line) {
  return String(line||"")
    .replace(/^\s*-\s*\[[^\]]\]\s*/, "")
    .replace(/\s*\d+(?:\.\d+)?🍅\s*$/, "")
    .trim();
}
function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function normalizeTag(tag) {
  const value = String(tag||"").trim();
  if (!value) return "";
  return value.startsWith("#") ? value : `#${value}`;
}
function workspaceLayoutLabel(command) {
  return String(command?.name||"").replace(/^.*?Load:\s*/, "");
}
function insertUnderHeading(text, headingRaw, newLine) {
  const heading = String(headingRaw||"").trim();
  if (!heading) return text.replace(/\s*$/, (m)=> m.endsWith("\n")?"": "\n") + newLine + "\n";
  const label = heading.replace(/^#+\s*/, "");
  const re = new RegExp(`^\\s*#+\\s*${escapeReg(label)}\\s*$`, "m");
  const m = text.match(re);
  if (!m) {
    const block = `\n${heading.startsWith("#") ? heading : "## "+label}\n${newLine}\n`;
    return text.replace(/\s*$/, (x)=> x.endsWith("\n")?"": "\n") + block;
  }
  const idx = m.index + m[0].length;
  return text.slice(0, idx) + "\n" + newLine + "\n" + text.slice(idx);
}
function formatTomatoNumber(val) {
  const num = Number(val) || 0;
  const rounded = Math.round(num * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
function positiveNumber(value, fallback, min=0.1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(min, number) : fallback;
}
function playBeep(kind, enabled=true, waveform='sine', strong=false) {
  if (!enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const tones = {
      'focus-start': [740, 988],
      'break-start': [660, 523],
      'focus-end': [784, 784, 1047],
      'break-end': [1047, 784, 1047],
      'focus-alert': [784, 1047, 784, 1047],
      'break-alert': [1047, 1047, 784]
    }[kind] || [520];
    // 波形来源于设置：sine/square/triangle
    tones.forEach((frequency, index) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      const at = ctx.currentTime + index * 0.16;
      osc.type = (waveform === 'square' || waveform === 'triangle') ? waveform : 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(strong ? 0.32 : 0.25, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      osc.connect(gain).connect(ctx.destination); osc.start(at); osc.stop(at + 0.16);
      if (index === tones.length - 1) osc.onended = ()=> ctx.close?.();
    });
  } catch {}
}
function sysNotify(title, body, enabled=true) {
  if (!enabled) return;
  try {
    if (!("Notification" in window)) throw new Error("no Notification");
    if (Notification.permission === "granted") { new Notification(title,{body}); return; }
    if (Notification.permission === "default") {
      Notification.requestPermission().then(p=>{ if (p==="granted") new Notification(title,{body}); else new Notice(`${title}｜${body}`); });
      return;
    }
    new Notice(`${title}｜${body}`);
  } catch { new Notice(`${title}｜${body}`); }
}
function mmss(sec){ return `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`; }

/* ========== 后台守护 ========== */
class PomodoroAIO extends Plugin {
  async onload() {
    await this.loadSettings();
    this.runtime  = Object.assign({
      phase: "idle",                 // idle | focus | break
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

    // 视图
    this.registerView(PomodoroView.VIEW_TYPE, (leaf)=> new PomodoroView(leaf, this));
    this.addCommand({ id: 'open-view', name: '打开番茄视图', callback: (evt)=> this.runUserCommand(()=> this.activateView(), evt) });

    // Ribbon 图标（左侧菜单栏按钮）
    this.ribbon = this.addRibbonIcon('clock', '打开番茄视图', () => this.activateView());
    if (this.ribbon) {
      this.ribbon.addClass("pomodoro-ribbon");
      this.ribbonBadge = this.ribbon.createDiv({ cls:"pomodoro-ribbon-badge" });
      const originalClick = this.ribbon.onclick?.bind(this.ribbon);
      this.ribbon.onclick = (evt) => {
        this.onRibbonClick(evt);
        if (originalClick) originalClick(evt);
      };
    }

    // 命令
    this.addCommand({ id: 'start-focus', name: '开始专注', callback: (evt)=> this.runUserCommand(()=> this.startFocus(), evt) });
    this.addCommand({ id: 'start-break', name: '开始短休', callback: (evt)=> this.runUserCommand(()=> this.startBreak(false), evt) });
    this.addCommand({ id: 'start-long-break', name: '开始长休', callback: (evt)=> this.runUserCommand(()=> this.startBreak(true), evt) });
    this.addCommand({ id: 'pause-resume', name: '暂停/继续', callback: (evt)=> this.runUserCommand(()=> this.togglePause(), evt) });
    this.addCommand({ id: 'reset', name: '重置', callback: (evt)=> this.runUserCommand(()=> this.reset(), evt) });
    this.addCommand({ id: 'complete-now', name: '立刻结算当前专注（按实际时长）', callback: (evt)=> this.runUserCommand(()=> this.forceCompleteFocusOnce(), evt) });
    this.addCommand({ id: 'open-today', name: '打开当日日记', callback: (evt)=> this.runUserCommand(()=> this.openToday(), evt) });

    // 设置页
    this.addSettingTab(new PomodoroSettingTab(this.app, this));

    // 样式
    this.registerStyles();

    // 延迟到 layout-ready 再恢复视图，避免干扰工作区恢复
    this.app.workspace.onLayoutReady(() => {
      if (!this.runtime.viewWasOpen) return;
      const leaves = this.app.workspace.getLeavesOfType(PomodoroView.VIEW_TYPE);
      if (!leaves.length) this.runAutoAction(()=> this.activateView({ source:"auto" }));
    });

    // 对齐整秒的调度器
    this._tickTimeout = null;
    this._unloading = false;
    this._scheduleTick = () => {
      if (this._unloading) return;
      const now = Date.now();
      const base = this.runtime.startedAt || now;
      const delay = Math.max(50, 1000 - ((now - base) % 1000));
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
  onunload(){
    this._unloading = true;
    this.stopPersistentAlertSound();
    if (this._tickTimeout) window.clearTimeout(this._tickTimeout);
  }

  async loadState(){ return (await this.app.loadLocalStorage("pomodoro-aio-runtime")) || null; }
  async saveState(){ await this.app.saveLocalStorage("pomodoro-aio-runtime", this.runtime); }
  async loadSettings(){
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    return this.settings;
  }
  async saveSettings(){ await this.saveData(this.settings); }

  /* ====== 环境守护 ====== */
  respectGuardsEnabled(){ return this.settings?.respectModalInputFocus !== false; }
  isElementVisible(el){
    if (!el) return false;
    try {
      const style = window.getComputedStyle?.(el);
      if (style) {
        if (style.display === "none") return false;
        if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      if (el.offsetParent === null && style?.position !== "fixed") return false;
      return true;
    } catch { return true; }
  }
  isTextInputTarget(target){
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
  hasBlockingOverlay(){
    if (!this.respectGuardsEnabled()) return false;
    try {
      const root = document?.body || document;
      const selectors = [
        ".modal", ".modal-container", ".modal-bg",
        ".prompt", ".suggestion-container", ".popover",
        ".quick-switcher", ".command-palette", ".mod-command-palette"
      ];
      const nodes = root?.querySelectorAll?.(selectors.join(", ")) || [];
      for (const el of nodes) {
        if (this.isElementVisible(el)) return true;
      }
      return false;
    } catch { return false; }
  }
  shouldBlockHotkeys(evt, opts={}){
    if (!this.respectGuardsEnabled()) return false;
    if (evt?.defaultPrevented) return true;
    if (this.hasBlockingOverlay()) return true;
    const allowInPluginInput = !!opts.allowInPluginInput;
    const allowInText = !!opts.allowInText;
    let target = evt?.target;
    if (!target){
      try { target = document?.activeElement; } catch {}
    }
    if (!allowInPluginInput && !allowInText && target && this.isTextInputTarget(target)) return true;
    return false;
  }
  shouldBlockFocusLayoutSideEffects(opts={}){
    if (!this.respectGuardsEnabled()) return false;
    const source = opts.source || "auto";
    if (this.hasBlockingOverlay()) return true;
    if (source === "auto") {
      let active = null;
      try { active = document.activeElement; } catch {}
      if (active && this.isTextInputTarget(active)) return true;
    }
    return false;
  }
  runUserCommand(fn, evt){
    if (this.shouldBlockHotkeys(evt, { allowInText:true })) return false;
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return false;
    try { fn(); } catch(err){ console.error(err); }
    return true;
  }
  runAutoAction(fn){
    if (this.shouldBlockFocusLayoutSideEffects({ source:"auto" })) return false;
    try { fn(); } catch(err){ console.error(err); }
    return true;
  }

  /* ====== 视图与广播 ====== */
  async activateView(opts={}) {
    const source = opts.source || "user";
    if (this.shouldBlockFocusLayoutSideEffects({ source })) return;
    const leaves = this.app.workspace.getLeavesOfType(PomodoroView.VIEW_TYPE);
    if (leaves.length) { this.app.workspace.revealLeaf(leaves[0]); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: PomodoroView.VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
  broadcast() {
    const snap = this.snapshot();
    this.updateRibbonVisuals(snap.runtime);
    this.app.workspace.trigger('pomodoro:aio-state', snap);
  }
  snapshot(){
    const left = this.getLeftSec();
    return {
      settings: this.settings,
      runtime: Object.assign({}, this.runtime, { leftSec: left })
    };
  }
  updateRibbonVisuals(runtime){
    if (!this.ribbon) return;
    const r = runtime || Object.assign({}, this.runtime, { leftSec: this.getLeftSec() });
    this.updateRibbonBadge(r);
    this.updateRibbonAlertUI(!!r.strongAlert);
  }
  updateRibbonBadge(runtime){
    if (!this.ribbonBadge) return;
    const phase = runtime?.phase || this.runtime.phase;
    const sec = runtime
      ? (runtime.paused ? (runtime.pausedLeftSec || 0) : (runtime.leftSec ?? this.getLeftSec()))
      : this.getLeftSec();
    const show = phase !== 'idle' && sec > 0;
    if (show) {
      const minutes = Math.max(0, Math.ceil(sec / 60));
      this.ribbonBadge.setText(String(minutes));
      this.ribbon.addClass("pomodoro-ribbon-has-badge");
    } else {
      this.ribbonBadge.setText("");
      this.ribbon.removeClass("pomodoro-ribbon-has-badge");
    }
  }
  updateRibbonAlertUI(active){
    if (!this.ribbon) return;
    if (active) this.ribbon.addClass("pomodoro-ribbon-alert");
    else this.ribbon.removeClass("pomodoro-ribbon-alert");
  }
  startPersistentAlertSound(){
    if (!this.settings.enableSound || !this.settings.persistentAlertSound) return;
    if (this._alertInterval || this._alertEscalationTimeout) return;
    const alertKind = ()=> this.runtime.pendingPhase === 'focus' ? this.settings.breakAlertSound : this.settings.focusAlertSound;
    const delay = Math.max(1, Number(this.settings.strongAlertDelaySec) || 30) * 1000;
    const interval = Math.max(1, Number(this.settings.strongAlertIntervalSec) || 60) * 1000;
    this._alertEscalationTimeout = window.setTimeout(()=> {
      this._alertEscalationTimeout = null;
      playBeep(alertKind(), true, this.settings.soundWaveform, true);
      this._alertInterval = window.setInterval(()=> playBeep(alertKind(), true, this.settings.soundWaveform, true), interval);
    }, delay);
  }
  stopPersistentAlertSound(){
    if (this._alertEscalationTimeout) {
      window.clearTimeout(this._alertEscalationTimeout);
      this._alertEscalationTimeout = null;
    }
    if (this._alertInterval) {
      window.clearInterval(this._alertInterval);
      this._alertInterval = null;
    }
  }
  applyStrongAlertStateFromRuntime(){
    if (!this.runtime.strongAlert) {
      this.updateRibbonAlertUI(false);
      this.stopPersistentAlertSound();
      return;
    }
    this.updateRibbonAlertUI(true);
    this.startPersistentAlertSound();
  }
  onRibbonClick(evt){
    if (!this.runtime.strongAlert) return;
    if (!this.settings.ribbonClickAutoNext || this.runtime.pendingAutoStarted) {
      this.stopStrongAlert();
      return;
    }
    this.startPendingStage();
  }
  startPendingStage(){
    const next = {
      type: this.runtime.pendingPhase || "",
      isLong: !!this.runtime.pendingIsLong,
      cycleSlot: this.runtime.pendingCycleSlot
    };
    this.stopStrongAlert();
    if (next.type === 'break') {
      if (this.runtime.phase === 'break' && this.runtime.paused) {
        this.togglePause(true);
      } else {
        this.startBreak(next.isLong, { forceRun:true, cause:'manual' });
      }
    } else if (next.type === 'focus') {
      if (Number.isInteger(next.cycleSlot)) {
        this.startCycle(next.cycleSlot, { cause:'manual' });
        return;
      }
      if (this.runtime.phase === 'focus' && this.runtime.paused) {
        this.togglePause(true);
      } else {
        this.startFocus({ cause:'manual' });
      }
    }
  }
  beginStrongAlert(nextPhase){
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
  stopStrongAlert(){
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
  currentTomatoAmount(){
    if (this.runtime.phase !== 'focus') return this.runtime.tomatoCredit || 0;
    const credit = this.runtime.tomatoCredit;
    if (typeof credit === "number" && isFinite(credit) && credit > 0) return Math.round(credit * 10) / 10;
    if (this.runtime.durationSec) return Math.round((this.runtime.durationSec / 1500) * 10) / 10;
    return Math.round(((this.settings.focusMin || 25) / 25) * 10) / 10;
  }
  focusCompletionBody(tomatoAmount, next){
    const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
    return `${task ? `完成：${task} · ` : ""}+${formatTomatoNumber(tomatoAmount)}🍅\n下一步：${next}`;
  }
  executeStageCommand(commandId){
    const id = String(commandId||"").trim();
    if (!id) return false;
    if (this.isWorkspaceLayoutActive(id)) return true;
    try {
      const executed = this.app?.commands?.executeCommandById?.(id);
      if (executed === false) new Notice("附带命令不可用，请重新选择");
      return executed !== false;
    } catch (err) {
      console.error(err);
      new Notice("附带命令执行失败，请重新选择");
      return false;
    }
  }
  getWorkspaceLayoutCommands(){
    return (this.app?.commands?.listCommands?.() || [])
      .filter(command=> command?.id?.startsWith("workspaces-plus:") && /(?:^|:\s)Load:\s/.test(String(command.name||"")))
      .sort((a, b)=> String(a.name).localeCompare(String(b.name), "zh-CN"));
  }
  isWorkspaceLayoutActive(commandId){
    const id = String(commandId||"");
    if (!this.getWorkspaceLayoutCommands().some(command=> command.id === id)) return false;
    const activeWorkspace = this.app?.internalPlugins?.getPluginById?.("workspaces")?.instance?.activeWorkspace;
    return activeWorkspace === id.slice("workspaces-plus:".length);
  }

  /* ====== 计时控制 ====== */
  getLeftMs(){
    const r = this.runtime;
    if (r.phase === 'idle') {
      const slot = this.settings.workMode === 'cycle' && Number.isInteger(r.pendingCycleSlot)
        ? r.pendingCycleSlot : r.cycleSlot;
      const minutes = this.settings.workMode === 'cycle'
        ? (slot === 1 ? this.settings.cycleMinB : this.settings.cycleMinA)
        : this.settings.focusMin;
      return (Number(minutes) || 25) * 60 * 1000;
    }
    if (r.paused) return Math.max(0, (r.pausedLeftSec || 0) * 1000);
    if (!r.startedAt || !r.durationSec) return 0;
    const ms = (r.durationSec * 1000) - (Date.now() - r.startedAt);
    return Math.max(0, ms);
  }
  getLeftSec(){
    return Math.ceil(this.getLeftMs() / 1000);
  }
  ensureDayFreshness(){
    const cur = this.logicalTodayKey();
    if (this.runtime.dayKey !== cur){
      this.runtime.dayKey = cur;
      this.runtime.sessionCount = 0; // 跨天清空“本次已完成段数”
      this.saveState();
      this.broadcast();
    }
  }
  startFocus(options){
    this.ensureDayFreshness();
    let opts = { suppressNotify:false, cause:'manual', minutes:null, cycle:false };
    if (typeof options === 'boolean') opts.suppressNotify = options;
    else if (options && typeof options === 'object') opts = Object.assign(opts, options);
    const minutesRaw = typeof opts.minutes === 'number' && isFinite(opts.minutes) && opts.minutes > 0 ? opts.minutes : (this.settings.focusMin || 25);
    const minutes = Math.max(0.1, minutesRaw);
    if (opts.minutes != null) this.setLongFocusMinutes(minutes, false);
    const durationSec = Math.max(1, Math.round(minutes * 60));
    if (opts.cause !== 'auto') this.stopStrongAlert();
    if (!opts.cycle) {
      this.runtime.cycleActive = false;
      this.runtime.cycleSlot = 0;
    }
    this.runtime.phase='focus';
    this.runtime.durationSec=durationSec;
    this.runtime.startedAt=Date.now();
    this.runtime.paused=false;
    this.runtime.pausedLeftSec=0;
    this.runtime.tomatoCredit = Math.max(0.1, Math.round((minutes / 25) * 10) / 10);
    this.saveState();
    this.broadcast();
    playBeep(this.settings.focusStartSound, this.settings.enableSound, this.settings.soundWaveform);
    if (!opts.suppressNotify) {
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("开始专注", `${formatTomatoNumber(minutes)} 分钟${task ? ` · 任务：${task}` : ""}`, this.settings.enableNotify);
    }
    const commandId = opts.cycle
      ? (this.runtime.cycleSlot === 1 ? this.settings.cycleWorkspaceCommandB : this.settings.cycleWorkspaceCommandA)
      : this.settings.focusStartCommandId;
    if (opts.cause !== 'auto' && commandId) this.executeStageCommand(commandId);
    this._resyncTick();
  }
  startCycle(slot=this.runtime.cycleSlot, options={}){
    const cycleSlot = slot === 1 ? 1 : 0;
    const task = String(cycleSlot ? this.settings.cycleTaskB : this.settings.cycleTaskA).trim();
    const minutes = Number(cycleSlot ? this.settings.cycleMinB : this.settings.cycleMinA);
    if (!task) { new Notice(`请先填写任务 ${cycleSlot ? "B" : "A"}`); return; }
    if (!isFinite(minutes) || minutes <= 0) { new Notice(`请设置任务 ${cycleSlot ? "B" : "A"} 的时长`); return; }
    this.runtime.cycleActive = true;
    this.runtime.cycleSlot = cycleSlot;
    this.runtime.currentTaskName = task;
    this.startFocus(Object.assign({ cause:'manual', minutes, cycle:true }, options));
  }
  startBreak(isLong=false, options){
    this.ensureDayFreshness();
    let opts = { forceRun:true, suppressNotify:false, cause:'manual' };
    if (typeof options === 'boolean') opts.forceRun = options;
    else if (options && typeof options === 'object') opts = Object.assign(opts, options);
    if (opts.cause !== 'auto') this.stopStrongAlert();
    this.runtime.cycleActive = false;
    this.runtime.cycleSlot = 0;
    const minutes = isLong ? (this.settings.longBreakMin||15) : (this.settings.breakMin||5);
    const dur = Math.max(1, Math.round(minutes * 60));
    this.runtime.phase='break';
    this.runtime.durationSec=dur;
    this.runtime.startedAt=Date.now();
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
      sysNotify("开始休息", `${formatTomatoNumber(minutes)} 分钟${task ? ` · 刚完成：${task}` : ""}`, this.settings.enableNotify);
    }
    if (opts.cause !== 'auto' && this.settings.breakStartCommandId) this.executeStageCommand(this.settings.breakStartCommandId);
    this._resyncTick();
  }
  togglePause(triggerCommand=false){
    this.ensureDayFreshness();
    if (this.runtime.phase==='idle') return;
    const wasPaused = this.runtime.paused;
    this.stopStrongAlert();
    if (!this.runtime.paused){
      this.runtime.pausedLeftSec = this.getLeftSec();
      this.runtime.paused = true;
    } else {
      this.runtime.startedAt = Date.now() - (this.runtime.durationSec - this.runtime.pausedLeftSec)*1000;
      this.runtime.paused = false;
    }
    this.saveState(); this.broadcast();
    this._resyncTick();
    if (triggerCommand && wasPaused && !this.runtime.paused) {
      const focusCommandId = this.runtime.cycleActive
        ? (this.runtime.cycleSlot === 1 ? this.settings.cycleWorkspaceCommandB : this.settings.cycleWorkspaceCommandA)
        : this.settings.focusStartCommandId;
      if (this.runtime.phase === 'focus' && focusCommandId) this.executeStageCommand(focusCommandId);
      else if (this.runtime.phase === 'break' && this.settings.breakStartCommandId) this.executeStageCommand(this.settings.breakStartCommandId);
    }
  }
  reset(showNotice=true){
    this.ensureDayFreshness();
    this.stopStrongAlert();
    this.runtime = Object.assign(this.runtime, {
      phase:'idle', startedAt:0, durationSec:0, paused:false, pausedLeftSec:0,
      cycleActive:false, cycleSlot:0
    });
    this.saveState(); this.broadcast();
    this._resyncTick();
    if (showNotice) new Notice("已重置");
  }

  /* ====== 到点/补记 ====== */
  async tick(){
    this.ensureDayFreshness();
    // 每次对齐触发时先广播，保证视图秒表顺滑
    this.broadcast();
    if (this._completionInFlight) return;

    const r = this.runtime;
    if (r.phase==='idle' || r.paused || !r.startedAt || !r.durationSec) return;

    const leftMs = this.getLeftMs();
    if (leftMs > 0) return;

    if (r.phase==='focus'){
      this._completionInFlight = true;
      try{
        const tomatoAmount = this.currentTomatoAmount() || 1;
        await this.applyTomatoAndSum(tomatoAmount);
        await this.safeBumpProjectTomato(tomatoAmount);
        r.sessionCount = (r.sessionCount||0) + 1;

        playBeep(this.settings.focusEndSound, this.settings.enableSound, this.settings.soundWaveform);

        if (r.cycleActive) {
          const nextSlot = r.cycleSlot === 1 ? 0 : 1;
          const nextTask = String(nextSlot ? this.settings.cycleTaskB : this.settings.cycleTaskA).trim();
          sysNotify("专注完成", this.focusCompletionBody(tomatoAmount, `${nextTask || "下一段专注"}（点击番茄图标开始）`), this.settings.enableNotify);
          r.phase = 'idle'; r.startedAt = 0; r.durationSec = 0; r.paused = false; r.pausedLeftSec = 0;
          this.saveState(); this.broadcast();
          this.beginStrongAlert({ type:'focus', cycleSlot:nextSlot, autoStarted:false });
        } else {
          const isLong = (this.settings.longEvery>0) && (r.sessionCount % this.settings.longEvery === 0);
          const autoNext = !!this.settings.autoNext;
          const breakMinutes = isLong ? this.settings.longBreakMin : this.settings.breakMin;
          sysNotify("专注完成", this.focusCompletionBody(tomatoAmount, `${isLong ? "长休" : "短休"} ${formatTomatoNumber(breakMinutes)} 分钟${autoNext ? "（已开始）" : "（点击番茄图标开始）"}`), this.settings.enableNotify);
          this.startBreak(isLong, { forceRun:autoNext, cause:'auto' });
          this.beginStrongAlert({ type:'break', isLong, autoStarted:autoNext });
        }
      } catch(e){
        console.error(e); new Notice("写入失败，请检查设置/任务/项目");
        this.reset();
      } finally {
        this._completionInFlight = false;
      }
    } else if (r.phase==='break'){
      playBeep(this.settings.breakEndSound, this.settings.enableSound, this.settings.soundWaveform);
      const autoNext = !!this.settings.autoNext;
      const task = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
      sysNotify("休息结束", `下一步：${autoNext ? "已开始" : "点击番茄图标开始"}专注${task ? ` · 任务：${task}` : ""}`, this.settings.enableNotify);
      if (autoNext) this.startFocus({ suppressNotify:true, cause:'auto' });
      else this.reset(false);
      this.beginStrongAlert({ type:'focus', autoStarted:autoNext });
    }
  }
  async forceCompleteFocusOnce(){
    this.ensureDayFreshness();
    if (this.runtime.phase!=='focus') { new Notice("当前不在专注阶段"); return; }
    if (this._completionInFlight) { new Notice("正在结算当前专注"); return; }
    this._completionInFlight = true;
    try {
      const tomatoAmount = this.currentTomatoAmount() || 1;
      await this.applyTomatoAndSum(tomatoAmount);
      await this.safeBumpProjectTomato(tomatoAmount);
      this.runtime.sessionCount = (this.runtime.sessionCount||0) + 1;
      if (this.runtime.cycleActive) {
        const nextSlot = this.runtime.cycleSlot === 1 ? 0 : 1;
        const nextTask = String(nextSlot ? this.settings.cycleTaskB : this.settings.cycleTaskA).trim();
        sysNotify("专注完成（手动）", this.focusCompletionBody(tomatoAmount, `${nextTask || "下一段专注"}（点击番茄图标开始）`), this.settings.enableNotify);
        this.runtime.phase = 'idle'; this.runtime.startedAt = 0; this.runtime.durationSec = 0; this.runtime.paused = false; this.runtime.pausedLeftSec = 0;
        this.saveState(); this.broadcast();
        this.beginStrongAlert({ type:'focus', cycleSlot:nextSlot, autoStarted:false });
      } else {
        const isLong = (this.settings.longEvery>0) && (this.runtime.sessionCount % this.settings.longEvery === 0);
        const autoNext = !!this.settings.autoNext;
        const breakMinutes = isLong ? this.settings.longBreakMin : this.settings.breakMin;
        sysNotify("专注完成（手动）", this.focusCompletionBody(tomatoAmount, `${isLong ? "长休" : "短休"} ${formatTomatoNumber(breakMinutes)} 分钟${autoNext ? "（已开始）" : "（点击番茄图标开始）"}`), this.settings.enableNotify);
        this.startBreak(isLong, { forceRun:false, cause:'manual' });
        this.beginStrongAlert({ type:'break', isLong, autoStarted:false });
      }
      this._resyncTick();
      playBeep(this.settings.focusEndSound, this.settings.enableSound, this.settings.soundWaveform);
    } catch (e) {
      console.error(e);
      new Notice("写入失败，请检查设置/任务/项目");
    } finally {
      this._completionInFlight = false;
    }
  }

  _resyncTick(){
    if (this._tickTimeout) window.clearTimeout(this._tickTimeout);
    this._scheduleTick && this._scheduleTick();
  }

  /* ====== 文件相关 ====== */
  logicalTodayKey(){ return getLogicalDayKey(new Date(), this.settings.dayStartHHMM || "00:00"); }
  todayFilePath(){
    return renderPattern(this.settings.fallbackPattern || "Daily/{{date:YYYY-MM-DD}}.md", this.logicalTodayKey());
  }
  async ensureTodayFile(){
    const p = this.todayFilePath();
    let f = this.app.vault.getAbstractFileByPath(p);
    if (!f){
      if (!this.settings.allowCreateDaily) throw new Error("找不到当天文件，且未开启自动创建");
      const parts = p.split("/");
      if (parts.length>1){
        let acc=""; for (let i=0;i<parts.length-1;i++){ acc = acc? `${acc}/${parts[i]}`: parts[i]; try{ await this.app.vault.createFolder(acc);}catch{} }
      }
      f = await this.app.vault.create(p, "");
    }
    if (!(f instanceof TFile)) throw new Error("目标不是文件");
    return f;
  }
  async readToday(){ const f = await this.ensureTodayFile(); return { file:f, text: await this.app.vault.read(f) }; }
  async listUncheckedTasksFromText(text){
    const lines = text.split(/\r?\n/); const names = new Set();
    for (const l of lines){
      if (!/^\s*-\s*\[\s\]\s+/.test(l)) continue;
      const base = stripBaseName(l); if (base) names.add(base);
    }
    return Array.from(names);
  }

  // 当日任务行尾追加对应 🍅 数量，并写入 frontmatter[fmKey]；返回今日累计
  async applyTomatoAndSum(amount=1){
    const taskName = String(this.runtime.currentTaskName || this.settings.defaultTaskName || "").trim();
    if (!taskName) throw new Error("任务名为空");
    const add = Math.max(0, Number(amount) || 0);
    if (!add) return getTomatoSum((await this.readToday()).text);
    const f = await this.ensureTodayFile(); let text = await this.app.vault.read(f);

    // 找任务行：优先未勾选 - [ ]，再已勾选 - [x]
    const lines = text.split(/\r?\n/);
    const want = taskName.toLowerCase().trim();
    let iUnchecked=-1, iAny=-1;

    for (let i=0;i<lines.length;i++){
      const l = lines[i];
      if (!/^\s*-\s*\[[^\]]\]\s+/.test(l)) continue;
      const base = stripBaseName(l).toLowerCase();
      if (base === want){
        if (/^\s*-\s*\[\s\]/.test(l) && iUnchecked===-1) iUnchecked=i;
        if (iAny===-1) iAny=i;
      }
    }
    const hit = (iUnchecked!==-1? iUnchecked : iAny);
    if (hit!==-1){
      const oldLine = lines[hit];
      const m = oldLine.match(/(\d+(?:\.\d+)?)\s*🍅\s*$/);
      const old = m ? parseFloat(m[1]) || 0 : 0;
      const prefix = oldLine.match(/^\s*-\s*\[[^\]]\]\s*/)?.[0] || "- [ ] ";
      const base = stripBaseName(oldLine);
      lines[hit] = `${prefix}${base} ${formatTomatoNumber(old + add)}🍅`;
      text = lines.join("\n");
    } else {
      if (!this.settings.allowAutoCreateTask) throw new Error("未找到同名任务，且未开启自动创建");
      const newLine = `- [ ] ${taskName} ${formatTomatoNumber(add)}🍅`;
      text = insertUnderHeading(text, this.settings.tasksHeading, newLine);
    }

    const sum = getTomatoSum(text);
    await this.app.vault.modify(f, text);
    try {
      await this.app.fileManager.processFrontMatter(f, (fm)=>{ fm[this.settings.fmKey || "番茄数"] = sum; });
    } catch (err) {
      console.error(err);
      new Notice("当日日记 frontmatter 汇总写入失败，任务行记录已保留");
    }
    this.broadcast();
    return sum;
  }

  // 为所选项目文件 frontmatter[projectFmKey] +1
  async bumpProjectTomato(amount=1){
    if (!this.settings.projectEnable) return;
    const add = Math.max(0, Number(amount) || 0);
    if (!add) return;
    const p = (this.settings.currentProjectPath || "").trim();
    if (!p) return;
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!f || !(f instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(f, (fm)=>{
      const k = this.settings.projectFmKey || "番茄数";
      const prev = parseFloat(fm[k]) || 0;
      fm[k] = Math.round((prev + add) * 10) / 10;
    });
  }
  async safeBumpProjectTomato(amount=1){
    try {
      await this.bumpProjectTomato(amount);
    } catch (err) {
      console.error(err);
      new Notice("项目番茄同步失败，已保留当日日记记录");
    }
  }

  /* ====== 提供给视图的查询/动作 ====== */
  async refreshTodaySnapshot(){
    const { file, text } = await this.readToday();
    const sum = getTomatoSum(text);
    const unchecked = await this.listUncheckedTasksFromText(text);
    return { file, sum, unchecked };
  }
  projectCandidates(){
    const tagWant = normalizeTag(this.settings.projectTag || "#project");
    const white = new Set(String(this.settings.projectStatusWhitelist||"进行中,筹划中").split(",").map(s=>s.trim()).filter(Boolean));
    const files = this.app.vault.getMarkdownFiles();
    const out = [];
    for (const f of files){
      const cache = this.app.metadataCache.getFileCache(f) || {};
      // tags
      let hasTag=false;
      const fm = cache.frontmatter || {};
      const tags = new Set();
      const fmTags = fm.tags;
      if (Array.isArray(fmTags)) fmTags.forEach(t=> tags.add(normalizeTag(t)));
      else if (typeof fmTags === "string") fmTags.split(/[,\s]+/).forEach(t=> t && tags.add(normalizeTag(t)));
      (cache.tags||[]).forEach(obj=> obj?.tag && tags.add(obj.tag));
      hasTag = tags.has(tagWant);
      if (!hasTag) continue;

      const status = String(fm[this.settings.projectStatusKey || "项目状态"] || "").trim();
      if (!white.has(status)) continue;

      out.push({ label: `${f.basename} — ${status} (${f.path})`, path: f.path });
    }
    return out;
  }
  setCurrentTaskName(name){
    this.runtime.currentTaskName = String(name||"").trim();
    this.saveState(); this.broadcast();
  }
  setCurrentProjectPath(path){
    this.settings.currentProjectPath = String(path||"").trim();
    this.saveSettings(); this.broadcast();
  }
  setWorkMode(mode){
    if (this.runtime.phase !== 'idle' || this.runtime.cycleActive) { new Notice("请先重置当前计时，再切换工作模式"); return false; }
    this.settings.workMode = mode === 'cycle' ? 'cycle' : 'standard';
    this.saveSettings(); this.broadcast();
    return true;
  }
  setCycleConfig(patch){
    Object.assign(this.settings, patch);
    this.saveSettings(); this.broadcast();
  }
  selectCycleSlot(slot){
    if (this.settings.workMode !== 'cycle' || this.runtime.phase !== 'idle' || this.runtime.strongAlert) return false;
    this.runtime.cycleSlot = slot === 1 ? 1 : 0;
    this.saveState(); this.broadcast();
    return true;
  }
  setLongFocusMinutes(minutes, broadcast=true){
    const num = Number(minutes);
    if (!isFinite(num)) return;
    const normalized = Math.max(0.1, Math.round(num * 10) / 10);
    this.runtime.longFocusMinutes = normalized;
    this.saveState();
    if (broadcast) this.broadcast();
  }

  // 打开当日日记
  async openToday() {
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return;
    const f = await this.ensureTodayFile();
    await this.app.workspace.getLeaf(true).openFile(f);
  }
  // 打开当前选择的项目文件
  async openCurrentProject() {
    if (this.shouldBlockFocusLayoutSideEffects({ source:"user" })) return;
    const p = (this.settings.currentProjectPath || "").trim();
    if (!p) { new Notice("未选择项目"); return; }
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!f || !(f instanceof TFile)) { new Notice("项目文件不存在"); return; }
    await this.app.workspace.getLeaf(true).openFile(f);
  }
}

/* ========== 视图（UI） ========== */
class PomodoroView extends ItemView {
  static VIEW_TYPE = "pomodoro-aio-view";
  constructor(leaf, plugin){ super(leaf); this.plugin=plugin; this.disposers=[]; }
  getViewType(){ return PomodoroView.VIEW_TYPE; }
  getDisplayText(){ return "番茄钟"; }
  getIcon(){ return "clock"; }

  async onOpen(){
    try {
      this.plugin.runtime.viewWasOpen = true;
      this.plugin.saveState();
    } catch {}

    try {
      const container = this.containerEl;
      container.empty(); container.addClass("pmd-root");

      // 顶部：环形 + 时间 + 状态
      const head = container.createDiv({ cls:"pmd-head" });
      const ring = head.createDiv({ cls:"pmd-ring" });
      ring.innerHTML = `<svg class="pmd-ring-svg" width="72" height="72" viewBox="0 0 72 72">
        <g transform="rotate(-90 36 36)">
          <circle cx="36" cy="36" r="30" class="pmd-ring-track"></circle>
          <circle cx="36" cy="36" r="30" class="pmd-ring-prog" stroke-dasharray="${2*Math.PI*30}" stroke-dashoffset="${2*Math.PI*30}"></circle>
        </g>
      </svg>
      <div class="pmd-ring-text">0/8</div>`;
      const ringText = ring.querySelector(".pmd-ring-text");
      const ringProgress = ring.querySelector(".pmd-ring-prog");
      ring.setAttribute("role", "progressbar");
      ring.setAttribute("aria-label", "今日番茄进度");
      ring.setAttribute("aria-valuemin", "0");
      const timeEl  = head.createDiv({ cls:"pmd-time", text:mmss(this.plugin.getLeftSec()), attr:{ role:"timer", "aria-label":"剩余时间" } });
      const stateEl = head.createDiv({ cls:"pmd-state", text:"待机" });

      const modeButton = head.createEl("button", {
        text:"普通专注",
        cls:"pmd-btn pmd-mode-toggle",
        attr:{ type:"button", "aria-label":"切换工作模式", "aria-pressed":"false" }
      });

      // 顶部右侧：打开当日日记（放到右上角）
      const openTodayBtn = head.createEl("button", { text:"打开当日日记", cls:"pmd-btn pmd-btn-secondary", attr:{ type:"button" } });

      // —— 项目输入：普通模式直显，循环模式按需展开 ——
      const projectDetails = container.createEl("details", { cls:"pmd-project" });
      const projectSummary = projectDetails.createEl("summary", { text:"共同项目（可选）" });
      const projWrap = projectDetails.createDiv({ cls:"pmd-row-inline pmd-project-row" });
      const projBox  = projWrap.createDiv({ cls:"pmd-input-wrap" });
      const projectTagLabel = normalizeTag(this.plugin.settings.projectTag || "#project") || "#project";
      const projInput = projBox.createEl("input", { type:"text", attr:{ list:"pmdProjList", placeholder:`关联项目（可选；${projectTagLabel} 且状态在白名单）`, "aria-label":"关联项目（可选）" }, cls:"pmd-input" });
      const projList  = projBox.createEl("datalist", { attr:{ id:"pmdProjList" } });
      // 让输入框获得焦点时直接展开 datalist
      const _openDatalist = (input)=>{
        const prev = input.value;
        const inputWrap = !prev && input.closest(".pmd-input-wrap");
        inputWrap?.classList.add("pmd-datalist-opening");
        input.value = prev + "\u200B"; // 零宽空格触发 suggestions
        input.dispatchEvent(new Event('input', {bubbles:true}));
        setTimeout(()=>{
          input.value = prev;
          input.dispatchEvent(new Event('input', {bubbles:true}));
          inputWrap?.classList.remove("pmd-datalist-opening");
        }, 0);
      };
      projInput.addEventListener('focus', ()=> _openDatalist(projInput));
      projInput.addEventListener('click', ()=> _openDatalist(projInput));
      // 内嵌清空（×）
      const clearProjBtn = projBox.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空项目选择", 'aria-label':"清空项目选择", type:"button" } });
      // Esc 清空
      projInput.onkeydown = (e)=>{
        if (this.plugin.shouldBlockHotkeys(e, { allowInPluginInput:true })) return;
        if (e.key === "Escape") { e.preventDefault(); projInput.value = ""; this.plugin.setCurrentProjectPath(""); }
      };
      const openProjBtn = projWrap.createEl("button", { text:"打开项目", cls:"pmd-btn pmd-btn-secondary", attr:{ type:"button" } });
      openProjBtn.onclick = ()=> this.plugin.openCurrentProject();

      // —— 任务输入（在项目下方）——
      const taskWrap = container.createDiv({ cls:"pmd-row pmd-row-inline" });
      const taskBox  = taskWrap.createDiv({ cls:"pmd-input-wrap" });
      const taskInput = taskBox.createEl("input", { type:"text", attr:{ list:"pmdTaskList", placeholder:"输入/选择任务名（仅显示未勾选）", "aria-label":"当前任务" }, cls:"pmd-input" });
      taskInput.addEventListener('focus', ()=> _openDatalist(taskInput));
      taskInput.addEventListener('click', ()=> _openDatalist(taskInput));
      const taskList  = taskBox.createEl("datalist", { attr:{ id:"pmdTaskList" } });
      // 抑制回填：使用“截至时间戳”，避免广播抖动导致的闪动
      let _suppressTaskSyncUntil = 0;
      // 内嵌清空（×）
      const clearTaskBtn = taskBox.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空任务名", 'aria-label':"清空任务名", type:"button" } });
      // Esc 清空
      taskInput.onkeydown = (e)=>{
        if (this.plugin.shouldBlockHotkeys(e, { allowInPluginInput:true })) return;
        if (e.key === "Escape") { e.preventDefault(); _suppressTaskSyncUntil = Date.now() + 1200; taskInput.value = ""; this.plugin.setCurrentTaskName(""); }
      };

      // —— 长专注控制 —— 
      const longWrap = container.createDiv({ cls:"pmd-row pmd-row-inline pmd-long-row" });
      const longLabel = longWrap.createSpan({ cls:"pmd-long-label", text:"长专注（分钟）" });
      const longInput = longWrap.createEl("input", {
        type:"number",
        cls:"pmd-long-input",
        attr:{ min:"1", step:"5", placeholder:"50", "aria-label":"长专注时长（分钟）" }
      });
      const ensureLongValue = ()=>{
        const fallback = this.plugin.runtime.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25;
        const val = Number(longInput.value);
        const normalized = isFinite(val) && val > 0 ? Math.round(val * 10) / 10 : Math.round(fallback * 10) / 10;
        longInput.value = String(normalized);
        this.plugin.setLongFocusMinutes(normalized);
        return normalized;
      };
      longInput.value = String(this.plugin.runtime.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25);
      longInput.onchange = ()=> ensureLongValue();
      longInput.onblur = ()=> ensureLongValue();
      const longBtn = longWrap.createEl("button", { text:"开始长专注", cls:"pmd-btn", attr:{ type:"button" } });

      const cycleWrap = container.createDiv({ cls:"pmd-cycle" });
      const cycleRowA = cycleWrap.createDiv({ cls:"pmd-cycle-row" });
      const cycleRoleA = cycleRowA.createSpan({ cls:"pmd-cycle-role", text:"当前" });
      const cycleFieldsA = cycleRowA.createDiv({ cls:"pmd-cycle-fields" });
      const cycleTaskWrapA = cycleFieldsA.createDiv({ cls:"pmd-input-wrap" });
      const cycleTaskA = cycleTaskWrapA.createEl("input", {
        type:"text", cls:"pmd-input",
        attr:{ list:"pmdCycleTaskListA", placeholder:"任务 A", "aria-label":"循环任务 A" }
      });
      const cycleTaskListA = cycleTaskWrapA.createEl("datalist", { attr:{ id:"pmdCycleTaskListA" } });
      const clearCycleTaskA = cycleTaskWrapA.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空任务名", "aria-label":"清空任务名", type:"button" } });
      const cycleWorkspaceA = cycleFieldsA.createEl("input", {
        type:"text",
        cls:"pmd-cycle-workspace",
        attr:{ list:"pmdCycleWorkspaceListA", placeholder:"筛选/选择布局", "aria-label":"任务 A 工作区布局", title:"开始任务 A 时加载的 Workspaces Plus 布局" }
      });
      const cycleWorkspaceListA = cycleFieldsA.createEl("datalist", { attr:{ id:"pmdCycleWorkspaceListA" } });
      const cycleDurationA = cycleRowA.createDiv({ cls:"pmd-cycle-duration" });
      const cycleMinA = cycleDurationA.createEl("input", {
        type:"number", cls:"pmd-cycle-min",
        attr:{ min:"1", step:"1", placeholder:"时长", "aria-label":"任务 A 时长（分钟）" }
      });
      cycleDurationA.createSpan({ cls:"pmd-cycle-unit", text:"分钟" });

      const cycleRowB = cycleWrap.createDiv({ cls:"pmd-cycle-row" });
      const cycleRoleB = cycleRowB.createSpan({ cls:"pmd-cycle-role", text:"下一段" });
      const cycleFieldsB = cycleRowB.createDiv({ cls:"pmd-cycle-fields" });
      const cycleTaskWrapB = cycleFieldsB.createDiv({ cls:"pmd-input-wrap" });
      const cycleTaskB = cycleTaskWrapB.createEl("input", {
        type:"text", cls:"pmd-input",
        attr:{ list:"pmdCycleTaskListB", placeholder:"任务 B", "aria-label":"循环任务 B" }
      });
      const cycleTaskListB = cycleTaskWrapB.createEl("datalist", { attr:{ id:"pmdCycleTaskListB" } });
      const clearCycleTaskB = cycleTaskWrapB.createEl("button", { text:"×", cls:"pmd-clear", attr:{ title:"清空任务名", "aria-label":"清空任务名", type:"button" } });
      const cycleWorkspaceB = cycleFieldsB.createEl("input", {
        type:"text",
        cls:"pmd-cycle-workspace",
        attr:{ list:"pmdCycleWorkspaceListB", placeholder:"筛选/选择布局", "aria-label":"任务 B 工作区布局", title:"开始任务 B 时加载的 Workspaces Plus 布局" }
      });
      const cycleWorkspaceListB = cycleFieldsB.createEl("datalist", { attr:{ id:"pmdCycleWorkspaceListB" } });
      const cycleDurationB = cycleRowB.createDiv({ cls:"pmd-cycle-duration" });
      const cycleMinB = cycleDurationB.createEl("input", {
        type:"number", cls:"pmd-cycle-min",
        attr:{ min:"1", step:"1", placeholder:"时长", "aria-label":"任务 B 时长（分钟）" }
      });
      cycleDurationB.createSpan({ cls:"pmd-cycle-unit", text:"分钟" });
      cycleTaskA.value = this.plugin.settings.cycleTaskA || "";
      cycleTaskB.value = this.plugin.settings.cycleTaskB || "";
      cycleMinA.value = String(this.plugin.settings.cycleMinA || 15);
      cycleMinB.value = String(this.plugin.settings.cycleMinB || 15);
      const fillWorkspaceList = (input, list, selected="")=> {
        const commands = this.plugin.getWorkspaceLayoutCommands();
        list.empty();
        commands.forEach(command=> list.createEl("option", { attr:{ value:workspaceLayoutLabel(command) } }));
        const selectedCommand = commands.find(command=> command.id === selected);
        input.dataset.commandId = selectedCommand?.id || "";
        input.value = selectedCommand ? workspaceLayoutLabel(selectedCommand) : selected ? "布局已失效，请重选" : "";
      };
      const selectWorkspace = input=> {
        const command = this.plugin.getWorkspaceLayoutCommands().find(item=> workspaceLayoutLabel(item) === input.value.trim());
        if (!command && input.value.trim()) {
          const current = this.plugin.getWorkspaceLayoutCommands().find(item=> item.id === input.dataset.commandId);
          input.value = current ? workspaceLayoutLabel(current) : "";
          return;
        }
        input.dataset.commandId = command?.id || "";
        saveCycleConfig();
      };
      fillWorkspaceList(cycleWorkspaceA, cycleWorkspaceListA, this.plugin.settings.cycleWorkspaceCommandA || "");
      fillWorkspaceList(cycleWorkspaceB, cycleWorkspaceListB, this.plugin.settings.cycleWorkspaceCommandB || "");
      cycleWorkspaceA.onfocus = ()=> fillWorkspaceList(cycleWorkspaceA, cycleWorkspaceListA, cycleWorkspaceA.dataset.commandId || "");
      cycleWorkspaceB.onfocus = ()=> fillWorkspaceList(cycleWorkspaceB, cycleWorkspaceListB, cycleWorkspaceB.dataset.commandId || "");

      // 操作按钮
      const actions = container.createDiv({ cls:"pmd-actions" });
      const startBtn = actions.createEl("button", { text:"开始专注", cls:"pmd-btn pmd-btn-primary", attr:{ type:"button" } });
      const pauseBtn = actions.createEl("button", { text:"暂停", cls:"pmd-btn", attr:{ type:"button" } });
      const resetBtn = actions.createEl("button", { text:"重置", cls:"pmd-btn", attr:{ type:"button" } });
      const doneBtn  = actions.createEl("button", { text:"完成本段", cls:"pmd-btn", attr:{ type:"button" } });
      const refreshBtn = actions.createEl("button", { text:"刷新", cls:"pmd-btn pmd-btn-secondary", attr:{ type:"button" } });

      // 底部信息
      const meta = container.createDiv({ cls:"pmd-meta" });
      const sumEl = meta.createSpan({ text:"今日累计：0🍅" });
      const sessionEl = meta.createSpan({ text:"  本次已完成：0 段" });

      /* 事件绑定 */
      let taskSaveTimer = null;
      const saveTask = ()=>{
        if (taskSaveTimer) window.clearTimeout(taskSaveTimer);
        taskSaveTimer = null;
        if (this.plugin.runtime.currentTaskName === taskInput.value.trim()) return;
        this.plugin.setCurrentTaskName(taskInput.value);
      };
      taskInput.oninput = ()=> {
        _suppressTaskSyncUntil = Date.now() + 1200;
        if (taskSaveTimer) window.clearTimeout(taskSaveTimer);
        taskSaveTimer = window.setTimeout(saveTask, 180);
      };
      taskInput.onchange = saveTask;
      modeButton.onclick = ()=> {
        const next = this.plugin.settings.workMode === 'cycle' ? 'standard' : 'cycle';
        this.plugin.setWorkMode(next);
      };
      let cycleSaveTimer = null;
      const saveCycleConfig = ()=> {
        if (cycleSaveTimer) window.clearTimeout(cycleSaveTimer);
        cycleSaveTimer = null;
        const patch = {
        cycleTaskA: cycleTaskA.value.trim(), cycleMinA: Math.max(1, Number(cycleMinA.value) || 15), cycleWorkspaceCommandA: cycleWorkspaceA.dataset.commandId || "",
        cycleTaskB: cycleTaskB.value.trim(), cycleMinB: Math.max(1, Number(cycleMinB.value) || 15), cycleWorkspaceCommandB: cycleWorkspaceB.dataset.commandId || ""
        };
        if (Object.entries(patch).every(([key, value])=> this.plugin.settings[key] === value)) return;
        this.plugin.setCycleConfig(patch);
      };
      const queueCycleSave = ()=>{
        if (cycleSaveTimer) window.clearTimeout(cycleSaveTimer);
        cycleSaveTimer = window.setTimeout(saveCycleConfig, 180);
      };
      [cycleTaskA, cycleMinA, cycleTaskB, cycleMinB].forEach(input=>{
        input.oninput = queueCycleSave;
        input.onchange = saveCycleConfig;
      });
      [cycleWorkspaceA, cycleWorkspaceB].forEach(input=> {
        input.oninput = ()=> {
          if (this.plugin.getWorkspaceLayoutCommands().some(command=> workspaceLayoutLabel(command) === input.value.trim())) selectWorkspace(input);
        };
        input.onchange = ()=> selectWorkspace(input);
      });
      [cycleTaskA, cycleTaskB].forEach(input=> {
        input.addEventListener('focus', ()=> _openDatalist(input));
        input.addEventListener('click', ()=> _openDatalist(input));
      });
      cycleRowA.ondblclick = (event)=> { if (!event.target.closest("input, button, select")) this.plugin.selectCycleSlot(0); };
      cycleRowB.ondblclick = (event)=> { if (!event.target.closest("input, button, select")) this.plugin.selectCycleSlot(1); };
      const clearCurrentTask = (event)=> {
        event?.preventDefault();
        if (taskSaveTimer) window.clearTimeout(taskSaveTimer);
        taskSaveTimer = null;
        _suppressTaskSyncUntil = Date.now() + 1500;
        taskInput.value = "";
        this.plugin.setCurrentTaskName("");
        taskInput.focus();
      };
      const clearCycleTask = (input, event)=> {
        event?.preventDefault();
        input.value = "";
        saveCycleConfig();
        input.focus();
      };
      clearTaskBtn.onpointerdown = clearCurrentTask;
      clearTaskBtn.onclick = (event)=> { if (event.detail === 0) clearCurrentTask(event); };
      clearCycleTaskA.onpointerdown = (event)=> clearCycleTask(cycleTaskA, event);
      clearCycleTaskA.onclick = (event)=> { if (event.detail === 0) clearCycleTask(cycleTaskA, event); };
      clearCycleTaskB.onpointerdown = (event)=> clearCycleTask(cycleTaskB, event);
      clearCycleTaskB.onclick = (event)=> { if (event.detail === 0) clearCycleTask(cycleTaskB, event); };
      projInput.onchange = ()=>{
        const label = projInput.value;
        const hit = (this._projOpts||[]).find(x=> x.label===label);
        this.plugin.setCurrentProjectPath(hit? hit.path : "");
      };
      const clearProject = (event)=> {
        event?.preventDefault();
        projInput.value = "";
        this.plugin.setCurrentProjectPath("");
        projInput.focus();
      };
      clearProjBtn.onpointerdown = clearProject;
      clearProjBtn.onclick = (event)=> { if (event.detail === 0) clearProject(event); };
      openTodayBtn.onclick = ()=> this.plugin.openToday();
      longBtn.onclick = ()=>{
        const minutes = ensureLongValue();
        this.plugin.startFocus({ cause:'manual', minutes });
      };

      startBtn.onclick = ()=>{
        const snap = this.plugin.snapshot();
        if (snap.runtime.paused) { this.plugin.togglePause(true); return; }
        if (snap.runtime.strongAlert && snap.runtime.pendingPhase) {
          this.plugin.startPendingStage();
          return;
        }
        if (this.plugin.settings.workMode === 'cycle') {
          saveCycleConfig();
          this.plugin.startCycle();
        } else {
          saveTask();
          this.plugin.startFocus({ cause:'manual' });
        }
      };
      pauseBtn.onclick = ()=> this.plugin.togglePause();
      resetBtn.onclick = ()=> this.plugin.reset();
      doneBtn.onclick  = ()=> this.plugin.forceCompleteFocusOnce();
      const refreshTodayUI = async ()=>{
        const snap = await this._safeRefreshTodaySnapshot();
        this._todaySumCache = snap.sum;
        this._fillTaskOptions(taskList, snap.unchecked);
        this._fillTaskOptions(cycleTaskListA, snap.unchecked);
        this._fillTaskOptions(cycleTaskListB, snap.unchecked);
        sumEl.setText(`今日累计：${formatTomatoNumber(snap.sum)}🍅`);
        this.plugin.broadcast();
      };
      refreshBtn.onclick = refreshTodayUI;

      // 订阅状态广播
      let lastRenderKey = "";
      let lastProjectMode = null;
      const show = (el, visible)=> el.classList.toggle("pmd-hidden", !visible);
      const onState = (snap)=> {
        const { settings:s, runtime:r } = snap;
        const cycleMode = s.workMode === 'cycle';
        timeEl.setText(mmss(r.leftSec||0));

        const renderKey = [
          cycleMode, s.showProjectSelector, s.currentProjectPath, s.dailyGoal,
          s.cycleTaskA, s.cycleMinA, s.cycleWorkspaceCommandA,
          s.cycleTaskB, s.cycleMinB, s.cycleWorkspaceCommandB,
          r.phase, r.paused, r.strongAlert, r.pendingPhase, r.pendingCycleSlot,
          r.cycleActive, r.cycleSlot, r.sessionCount, r.currentTaskName,
          r.longFocusMinutes, this._todaySumCache
        ].join("|");
        if (renderKey === lastRenderKey) return;
        lastRenderKey = renderKey;

        projectDetails.classList.toggle('pmd-hidden', s.showProjectSelector === false);
        projectDetails.classList.toggle('is-cycle', cycleMode);
        if (lastProjectMode !== cycleMode) {
          projectDetails.open = !cycleMode;
          lastProjectMode = cycleMode;
        }
        const projectName = String(s.currentProjectPath||"").split("/").pop()?.replace(/\.md$/i, "");
        projectSummary.setText(projectName ? `共同项目 · ${projectName}` : "共同项目（可选）");
        projInput.setAttribute("placeholder", cycleMode ? "选择共同项目（可选）" : `关联项目（可选；${projectTagLabel} 且状态在白名单）`);
        projInput.setAttribute("aria-label", cycleMode ? "共同项目（可选）" : "关联项目（可选）");
        taskWrap.classList.toggle('pmd-hidden', cycleMode);
        longWrap.classList.toggle('pmd-hidden', cycleMode);
        cycleWrap.classList.toggle('pmd-hidden', !cycleMode);
        const modeLocked = r.phase !== 'idle' || r.cycleActive;
        modeButton.disabled = modeLocked;
        modeButton.setText(cycleMode ? "循环工作" : "普通专注");
        modeButton.setAttribute("aria-pressed", String(cycleMode));
        modeButton.setAttribute("aria-label", cycleMode ? "当前为循环工作，点击切换到普通专注" : "当前为普通专注，点击切换到循环工作");
        modeButton.setAttribute("title", cycleMode ? "切换到普通专注" : "切换到循环工作");
        const lockCycleA = r.cycleActive && r.cycleSlot === 0;
        const lockCycleB = r.cycleActive && r.cycleSlot === 1;
        [cycleTaskA, cycleMinA, clearCycleTaskA, cycleWorkspaceA].forEach(input=> input.disabled = lockCycleA);
        [cycleTaskB, cycleMinB, clearCycleTaskB, cycleWorkspaceB].forEach(input=> input.disabled = lockCycleB);
        if (document.activeElement !== cycleWorkspaceA && cycleWorkspaceA.dataset.commandId !== (s.cycleWorkspaceCommandA || "")) {
          fillWorkspaceList(cycleWorkspaceA, cycleWorkspaceListA, s.cycleWorkspaceCommandA || "");
        }
        if (document.activeElement !== cycleWorkspaceB && cycleWorkspaceB.dataset.commandId !== (s.cycleWorkspaceCommandB || "")) {
          fillWorkspaceList(cycleWorkspaceB, cycleWorkspaceListB, s.cycleWorkspaceCommandB || "");
        }
        if (cycleMode) {
          const currentSlot = Number.isInteger(r.pendingCycleSlot) ? r.pendingCycleSlot : (r.cycleSlot === 1 ? 1 : 0);
          const canSelectSlot = r.phase === 'idle' && !r.strongAlert;
          cycleRowA.classList.toggle("is-current", currentSlot === 0);
          cycleRowB.classList.toggle("is-current", currentSlot === 1);
          cycleRowA.classList.toggle("is-selectable", canSelectSlot);
          cycleRowB.classList.toggle("is-selectable", canSelectSlot);
          cycleRowA.setAttribute("title", canSelectSlot ? "双击设为当前任务" : "");
          cycleRowB.setAttribute("title", canSelectSlot ? "双击设为当前任务" : "");
          cycleRoleA.setText(currentSlot === 0 ? (r.strongAlert ? "待开始" : "当前") : "下一段");
          cycleRoleB.setText(currentSlot === 1 ? (r.strongAlert ? "待开始" : "当前") : "下一段");
          cycleRowA.setAttribute("aria-label", `${cycleRoleA.textContent}：任务 A`);
          cycleRowB.setAttribute("aria-label", `${cycleRoleB.textContent}：任务 B`);
        }

        // 环形进度
        const max = s.dailyGoal||8; const done = this._todaySumCache ?? 0;
        ringText.textContent = `${formatTomatoNumber(done)}/${max}`;
        ring.setAttribute("aria-valuemax", String(max));
        ring.setAttribute("aria-valuenow", String(done));
        const C = 2*Math.PI*30; const offset = C * (1 - Math.min(done/max,1));
        ringProgress.setAttribute("stroke-dashoffset", String(offset));

        // 状态与可用操作
        stateEl.setText(r.strongAlert && r.phase === "idle" ? "待确认" : r.phase==="focus" ? "专注" : r.phase==="break" ? "休息" : "待机");
        const idle = r.phase === "idle";
        show(startBtn, idle || r.paused);
        show(pauseBtn, !idle && !r.paused);
        show(resetBtn, !idle || r.strongAlert);
        show(doneBtn, r.phase === "focus");

        if (r.paused) startBtn.setText("继续");
        else if (r.strongAlert && r.pendingPhase === "break") startBtn.setText("开始休息");
        else if (r.strongAlert && r.pendingPhase === "focus") startBtn.setText(cycleMode ? "开始下一段" : "开始专注");
        else startBtn.setText(cycleMode ? "开始循环工作" : "开始专注");

        // 任务名与会话数
        if (Date.now() >= _suppressTaskSyncUntil && document.activeElement !== taskInput && taskInput.value !== (r.currentTaskName||"")) taskInput.value = r.currentTaskName||"";
        sessionEl.setText(`本次已完成：${r.sessionCount||0} 段`);
        if (document.activeElement !== longInput) {
          const target = r.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25;
          longInput.value = String(Math.round(target * 10) / 10);
        }
      };
      this.app.workspace.on('pomodoro:aio-state', onState);
      this.disposers.push(()=> this.app.workspace.off('pomodoro:aio-state', onState));

      // 先渲染可操作界面，再读取日记和项目数据。
      taskInput.value = this.plugin.runtime.currentTaskName || this.plugin.settings.defaultTaskName || "";
      longInput.value = String(Math.round((this.plugin.runtime.longFocusMinutes || this.plugin.settings.longFocusDefaultMin || this.plugin.settings.focusMin || 25) * 10) / 10);
      onState(this.plugin.snapshot());
      await refreshTodayUI();

      const projects = this._safeProjectCandidates();
      this._projOpts = projects;
      this._fillProjectOptions(projList, projects);
      if (this.plugin.settings.currentProjectPath){
        const hit = projects.find(p=> p.path === this.plugin.settings.currentProjectPath);
        if (hit) projInput.value = hit.label;
      }

      // 只在当日日记变化时刷新，避免固定轮询整个文件。
      let vaultRefreshTimer = null;
      const onVaultModify = file=>{
        if (file?.path !== this.plugin.todayFilePath()) return;
        if (vaultRefreshTimer) window.clearTimeout(vaultRefreshTimer);
        vaultRefreshTimer = window.setTimeout(refreshTodayUI, 180);
      };
      const vaultModifyRef = this.app.vault.on("modify", onVaultModify);
      this.disposers.push(()=>{
        if (vaultRefreshTimer) window.clearTimeout(vaultRefreshTimer);
        this.app.vault.offref(vaultModifyRef);
      });
      this.disposers.push(()=>{
        if (taskSaveTimer) saveTask();
        if (cycleSaveTimer) saveCycleConfig();
      });
    } catch(err){
      console.error(err);
      new Notice("番茄视图加载失败，请检查日志");
    }
  }

  _fillTaskOptions(datalist, arr){
    datalist.empty(); arr.forEach((n)=> datalist.createEl("option", { attr:{ value:n } }));
  }
  _fillProjectOptions(datalist, arr){
    datalist.empty(); arr.forEach((o)=> datalist.createEl("option", { attr:{ value:o.label } }));
  }

  async _safeRefreshTodaySnapshot(){
    try { return await this.plugin.refreshTodaySnapshot(); }
    catch(err){ console.error(err); return { file:null, sum:0, unchecked:[] }; }
  }
  _safeProjectCandidates(){
    try { return this.plugin.projectCandidates(); }
    catch(err){ console.error(err); return []; }
  }

  async onClose(){
    if (this._projTimer) window.clearInterval(this._projTimer);
    this.disposers.forEach(off=>{
      try {
        if (typeof off === 'function') off();
        else if (off?.off) off.off();
      } catch(err){ console.error(err); }
    });
    this.disposers.length=0;
    try {
      this.plugin.runtime.viewWasOpen = false;
      this.plugin.saveState();
    } catch {}
  }
}

/* ========== 设置面板 ========== */
class PomodoroSettingTab extends PluginSettingTab {
  constructor(app, plugin){ super(app, plugin); this.plugin=plugin; }
  display(){
    const s = this.plugin.settings;
    const set = async(patch)=>{ Object.assign(this.plugin.settings, patch); await this.plugin.saveSettings(); this.plugin.broadcast(); };
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
      else if (this.plugin.runtime.strongAlert) this.plugin.startPersistentAlertSound();
    }));
    new Setting(c).setName("提示音波形").setDesc("sine/square/triangle；若需静音可在上方关闭‘启用蜂鸣音’")
      .addDropdown(d=>{
        d.addOptions({ sine:"sine", square:"square", triangle:"triangle" });
        d.setValue(this.plugin.settings.soundWaveform || "sine");
        d.onChange(v=>{
          const value = (v==="square"||v==="triangle")? v : "sine";
          set({ soundWaveform: value });
          if (this.plugin.runtime.strongAlert) {
            this.plugin.stopPersistentAlertSound();
            this.plugin.startPersistentAlertSound();
          }
        });
      });
    const soundOptions = {
      "focus-start": "上扬双音",
      "break-start": "下行双音",
      "focus-end": "三连完成音",
      "break-end": "回归专注音",
      "focus-alert": "四连强提醒",
      "break-alert": "三连强提醒"
    };
    [
      ["开始专注提示音", "focusStartSound"],
      ["开始休息提示音", "breakStartSound"],
      ["专注结束提示音", "focusEndSound"],
      ["休息结束提示音", "breakEndSound"],
      ["专注结束强提醒音", "focusAlertSound"],
      ["休息结束强提醒音", "breakAlertSound"]
    ].forEach(([name, key]) => new Setting(c).setName(name).addDropdown(d=>{
      d.addOptions(soundOptions);
      d.setValue(s[key] || DEFAULT_SETTINGS[key]);
      d.onChange(v=>set({ [key]: soundOptions[v] ? v : DEFAULT_SETTINGS[key] }));
    }));
    new Setting(c).setName("每日目标（段）").addText(t=>t.setValue(String(s.dailyGoal)).onChange(v=>set({dailyGoal: positiveNumber(v, 8)})));

    c.createEl("h3", { text:"强提醒与自动化" });
    new Setting(c).setName("持续提示音（强提醒）").setDesc("按下方间隔再次提醒，直到点击左侧番茄图标")
      .addToggle(t=>t.setValue(s.persistentAlertSound).onChange(v=>{
        set({ persistentAlertSound: v });
        if (!v) this.plugin.stopPersistentAlertSound();
        else if (this.plugin.runtime.strongAlert) this.plugin.startPersistentAlertSound();
      }));
    const restartStrongAlert = ()=> {
      if (!this.plugin.runtime.strongAlert) return;
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
    const commandOptions = { "": "（不执行命令）" };
    const allCommands = this.app.commands?.listCommands?.() || [];
    allCommands.forEach(cmd => { if (cmd?.id) commandOptions[cmd.id] = `${cmd.name} (${cmd.id})`; });
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

/* ========== 样式注册 ========== */
PomodoroAIO.prototype.registerStyles = function(){
  // 使用 styles.css；无需额外逻辑。
};

module.exports = PomodoroAIO;
