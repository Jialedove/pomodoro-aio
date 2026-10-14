const { Notice } = require("obsidian");
const {
  KIND_LABEL,
  normalizeAccountingSettings,
  normalizeAccountingStore,
  classifyRuntime,
  advanceAccounting,
  snoozesLeft,
  snoozeAccounting,
  declareUntracked,
  endDeclaration,
  extendDeclaration,
  logEmergencyExit,
  createLadderState,
  evaluateLadder
} = require("../core/time-accounting");
const { appendCaptureToHeading } = require("../core/quick-capture");
/** @typedef {import("../core/time-accounting").AccountingStore} AccountingStore */
/** @typedef {import("../core/time-accounting").UnaccountedReason} UnaccountedReason */

const POLL_INTERVAL_MS = 5000;
const WAIT_POLL_MS = 1000;
const STORAGE_KEY = "pomodoro-aio-accounting";

class TimeAccountingController {
  /**
   * @param {any} plugin
   * @param {{monitor:any, timers:import("../services/background-timers").BackgroundTimers, playBeep:Function, sysNotify:Function, logPluginError:Function, now?:()=>number}} deps
   */
  constructor(plugin, { monitor, timers, playBeep, sysNotify, logPluginError, now = () => Date.now() }) {
    this.plugin = plugin;
    this.monitor = monitor;
    this.timers = timers;
    this.helpers = { playBeep, sysNotify, logPluginError };
    this.now = now;
    this.store = normalizeAccountingStore(null);
    this.ladder = createLadderState();
    /** @type {UnaccountedReason | null} */
    this.reason = null;
    this.present = false;
    this.promptOpen = false;
    /** @type {unknown} */
    this._interval = null;
    /** @type {unknown} */
    this._waitTimeout = null;
    this._polling = false;
    /** @type {Promise<void> | null} */
    this._flushPromise = null;
    this._savedJson = "";
    this._flushErrorLogged = false;
    /** @type {Promise<void> | null} */
    this._loaded = null;
  }

  get settings() {
    return normalizeAccountingSettings(this.plugin.settings);
  }

  async load() {
    let raw = null;
    try { raw = await (this.plugin.app?.loadLocalStorage?.(STORAGE_KEY) ?? null); }
    catch (error) { this.helpers.logPluginError("accounting-load", error, { step:"read" }); }
    this.store = normalizeAccountingStore(raw);
    this._savedJson = JSON.stringify(this.store);
  }

  _save() {
    const json = JSON.stringify(this.store);
    if (json === this._savedJson) return;
    try {
      this.plugin.app?.saveLocalStorage?.(STORAGE_KEY, JSON.parse(json));
      this._savedJson = json;
    } catch (error) {
      this.helpers.logPluginError("accounting-save", error, { step:"write" });
    }
  }

  start() {
    if (this._interval !== null) return;
    this._loaded = this.load();
    this._interval = this.timers.setInterval(() => this._pollSafely(), POLL_INTERVAL_MS);
    this._pollSafely();
  }

  _pollSafely() {
    this.poll().catch(error => this.helpers.logPluginError("accounting", error, { step:"poll" }));
  }

  async poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      await this._loaded;
      await this.plugin.applyDueAccountingSettings?.();
      const settings = this.plugin.settings;
      const config = this.settings;
      const idleSec = config.accountingEnabled ? await this.monitor.readIdleSeconds() : null;
      // 读取空闲时间期间状态可能已改变，之后再分类。
      const { category, reason } = classifyRuntime(this.plugin.runtime);
      const nowMs = this.now();
      const result = advanceAccounting(this.store, {
        nowMs, idleSec, category, settings,
        dayKey:this.plugin.logicalTodayKey(), dailyPath:this.plugin.todayFilePath()
      });
      this.store = result.store;
      this.present = result.present;
      this.reason = this.store.declaration ? null : reason;
      for (const event of result.events) {
        if (!event.expired) continue;
        // 小计时到点：立即弹出黑屏，必须重新选择。
        this.helpers.playBeep("focus-end", settings.enableSound, settings.soundWaveform, true);
        if (this.reason) this.plugin.openAccountingPrompt(this.reason, "work", { ended:event.declaration });
      }
      const ladder = evaluateLadder(this.ladder, {
        nowMs, stretch:this.store.stretch, reason:this.reason, idleSec,
        snoozeUntilMs:this.store.snoozeUntilMs, promptOpen:this.promptOpen, settings
      });
      this.ladder = ladder.state;
      this._save();
      // 已经归属（比如从侧栏开始了计时）时撤下选择屏；仍未归属时刷新上面的分钟数。
      if (this.promptOpen) {
        if (!this.store.stretch && this.reason === null) this.plugin.closeAccountingPrompt?.();
        else this.plugin.refreshAccountingPrompt?.();
      }
      if (ladder.action === "notify") this.notify(/** @type {UnaccountedReason} */ (this.reason));
      else if (ladder.action === "prompt") this.prompt(/** @type {UnaccountedReason} */ (this.reason));
      else if (ladder.action === "wait") this._scheduleWaitPoll();
      void this.flush();
    } finally {
      this._polling = false;
    }
  }

  _scheduleWaitPoll() {
    if (this._waitTimeout !== null) return;
    this._waitTimeout = this.timers.setTimeout(() => {
      this._waitTimeout = null;
      this._pollSafely();
    }, WAIT_POLL_MS);
  }

  /** @param {UnaccountedReason} reason */
  notify(reason) {
    const settings = this.plugin.settings;
    const body = reason === "paused" ? "计时已暂停，这段时间算作未归属。继续计时，或选择现在在做的事。"
      : "你在用电脑，但这段时间还没有归属。开始工作、休息，或声明不计时。";
    this.helpers.sysNotify("这段时间还没有归属", body, settings.enableNotify);
    this.helpers.playBeep("focus-alert", settings.enableSound, settings.soundWaveform);
  }

  /** @param {UnaccountedReason} reason */
  prompt(reason) {
    const settings = this.plugin.settings;
    this.helpers.playBeep("focus-alert", settings.enableSound, settings.soundWaveform, true);
    this.plugin.openAccountingPrompt(reason);
  }

  /** 每秒由插件调用：小计时到点时立刻推进，不等 5 秒一次的轮询。 */
  checkExpiry() {
    const declaration = this.store.declaration;
    if (declaration && this.now() >= declaration.startedAtMs + declaration.plannedMs) this._pollSafely();
  }

  /** @param {number} minutes @returns {{ok:boolean, error?:string}} */
  extend(minutes) {
    const result = extendDeclaration(this.store, minutes, this.now(), this.plugin.settings);
    if (!result.ok) { new Notice(result.error); return { ok:false, error:result.error }; }
    this.store = result.store;
    this._save();
    new Notice(`小计时延长 ${result.addedMin} 分钟`);
    this.plugin.broadcast?.();
    return { ok:true };
  }

  /** 选择屏被关闭（提醒模式）或被外部结束：从现在起按间隔再弹。 */
  promptClosed() {
    this.ladder = { ...this.ladder, lastPromptAtMs:this.now() };
  }

  /** 强制模式下长按 Esc 紧急退出：写日记，并从现在起按间隔再弹。 */
  emergencyExit() {
    this.store = logEmergencyExit(this.store, this.now());
    this.promptClosed();
    this._save();
    void this.flush();
  }

  /** @param {boolean} open */
  setPromptOpen(open) {
    this.promptOpen = open;
  }

  /** @returns {{ok:boolean, error?:string}} */
  snooze() {
    const result = snoozeAccounting(this.store, this.now(), this.plugin.settings);
    if (!result.ok) { new Notice(result.error); return { ok:false, error:result.error }; }
    this.store = result.store;
    this._save();
    void this.flush();
    new Notice(`${this.settings.accountingSnoozeMin} 分钟后再提醒（今天还剩 ${snoozesLeft(this.store, this.plugin.settings)} 次）`);
    this.plugin.broadcast?.();
    return { ok:true };
  }

  /** @param {{kind:unknown, reason:unknown, minutes:unknown}} input @returns {{ok:boolean, error?:string}} */
  declare(input) {
    if (classifyRuntime(this.plugin.runtime).reason !== "idle") {
      const error = "只有在序列空闲时才能开始小计时";
      new Notice(error);
      return { ok:false, error };
    }
    const nowMs = this.now();
    // 跨天后第一次声明前先对齐日期与日记路径。
    if (this.store.dayKey !== this.plugin.logicalTodayKey()) {
      this.store = advanceAccounting(this.store, { nowMs, idleSec:null, category:"busy", settings:this.plugin.settings,
        dayKey:this.plugin.logicalTodayKey(), dailyPath:this.plugin.todayFilePath() }).store;
    }
    const result = declareUntracked(this.store, { ...input, nowMs }, this.plugin.settings);
    if (!result.ok) { new Notice(result.error); return { ok:false, error:result.error }; }
    this.store = result.store;
    this.ladder = createLadderState();
    this._save();
    void this.flush();
    const label = KIND_LABEL[/** @type {"leisure"|"errand"} */ (input.kind)];
    new Notice(result.cappedMin > 0 ? `强制模式：消遣已按剩余额度截为 ${result.cappedMin} 分钟`
      : result.overBudgetMin > 0 ? `已开始小计时（${label}），将超出今日额度 ${result.overBudgetMin} 分钟，会记入日记`
        : `已开始小计时（${label}）：${this.store.declaration?.reason}`);
    this.plugin.broadcast?.();
    return { ok:true };
  }

  endDeclaration() {
    if (!this.store.declaration) return false;
    this.store = endDeclaration(this.store, this.now(), this.plugin.settings).store;
    this._save();
    void this.flush();
    this.plugin.broadcast?.();
    return true;
  }

  /** 把待写入的日记行与汇总依次写入；失败的条目留在队列里，下次轮询重试。 @returns {Promise<void>} */
  flush() {
    // 已在写入时排在它之后再写一次，保证调用方等到的是包含新条目的写入。
    if (this._flushPromise) return this._flushPromise.then(() => this.flush());
    if (!this.store.outbox.length) return Promise.resolve();
    this._flushPromise = this._drain().finally(() => { this._flushPromise = null; });
    return this._flushPromise;
  }

  async _drain() {
    try {
      const daily = this.plugin._getDailyRepository();
      while (this.store.outbox.length) {
        const entry = this.store.outbox[0];
        const file = await daily.ensureFileAtPath(entry.path);
        if (entry.kind === "line") {
          await daily.process(file, (/** @type {string} */ text) => appendCaptureToHeading(text, {
            heading:this.settings.accountingHeading, kind:"idea", text:entry.text
          }).text);
        } else {
          await daily.processFrontMatter(file, (/** @type {Record<string, any>} */ frontmatter) => { Object.assign(frontmatter, entry.values); });
        }
        this.store = { ...this.store, outbox:this.store.outbox.filter(item => item !== entry) };
        this._save();
      }
      this._flushErrorLogged = false;
    } catch (error) {
      if (!this._flushErrorLogged) this.helpers.logPluginError("accounting-flush", error, { target:this.store.outbox[0]?.path, step:"write" });
      this._flushErrorLogged = true;
    }
  }

  /** 给视图和 Ribbon 的只读摘要。 */
  view() {
    const config = this.settings;
    const nowMs = this.now();
    const declaration = this.store.declaration;
    return {
      enabled:config.accountingEnabled,
      strict:config.accountingEnabled && config.accountingMode === "strict",
      reason:this.reason,
      present:this.present,
      stretchMin:this.store.stretch ? Math.floor((nowMs - this.store.stretch.startedAtMs) / 60_000) : null,
      unaccountedMin:Math.round(this.store.unaccountedMs / 60_000),
      leisureUsedMin:Math.round(this.store.leisureMs / 60_000),
      leisureBudgetMin:config.accountingLeisureBudgetMin,
      snoozesLeft:snoozesLeft(this.store, this.plugin.settings),
      snoozedUntilMs:this.store.snoozeUntilMs > nowMs ? this.store.snoozeUntilMs : 0,
      declaration:declaration ? {
        kind:declaration.kind, label:KIND_LABEL[declaration.kind], reason:declaration.reason,
        endsAtMs:declaration.startedAtMs + declaration.plannedMs
      } : null
    };
  }

  dispose() {
    if (this._interval !== null) this.timers.clearInterval(this._interval);
    if (this._waitTimeout !== null) this.timers.clearTimeout(this._waitTimeout);
    this._interval = null;
    this._waitTimeout = null;
    this._save();
    this.monitor.dispose();
  }
}

module.exports = { TimeAccountingController, POLL_INTERVAL_MS, STORAGE_KEY };
