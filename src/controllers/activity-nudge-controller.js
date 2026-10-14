const { Notice } = require("obsidian");
const { createNudgeState, untrackedReason, evaluateNudge, snoozeNudge } = require("../core/activity-nudge");
/** @typedef {import("../core/activity-nudge").NudgeReason} NudgeReason */

const POLL_INTERVAL_MS = 5000;

class ActivityNudgeController {
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
    this.state = createNudgeState();
    /** @type {unknown} */
    this._interval = null;
    this._polling = false;
  }

  start() {
    if (this._interval !== null) return;
    this._interval = this.timers.setInterval(() => {
      this.poll().catch(error => this.helpers.logPluginError("activity-nudge", error, { step:"poll" }));
    }, POLL_INTERVAL_MS);
  }

  async poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const settings = this.plugin.settings;
      const reason = untrackedReason(this.plugin.runtime);
      const idleSec = settings.activityNudgeEnabled && reason ? await this.monitor.readIdleSeconds() : null;
      const nowMs = this.now();
      // 读取空闲时间期间可能已开始计时，判定前重新取状态。
      const currentReason = untrackedReason(this.plugin.runtime);
      const decision = evaluateNudge(this.state, { nowMs, idleSec, untracked:!!currentReason, settings });
      this.state = decision.state;
      if (!currentReason || decision.action === "none") return;
      if (decision.action === "gentle") this.gentle(currentReason);
      else await this.strong(currentReason, decision.activeMs);
    } finally {
      this._polling = false;
    }
  }

  /** @param {NudgeReason} reason */
  gentle(reason) {
    const settings = this.plugin.settings;
    const body = reason === "paused" ? "计时已暂停，回来工作了就继续吧。" : "你在用电脑，但番茄钟没有在计时。设置一下现在在做的事吧。";
    this.helpers.sysNotify("Pomodoro AIO", body, settings.enableNotify);
    this.helpers.playBeep("focus-alert", settings.enableSound, settings.soundWaveform);
  }

  /** @param {NudgeReason} reason @param {number} activeMs */
  async strong(reason, activeMs) {
    const settings = this.plugin.settings;
    this.helpers.playBeep("focus-alert", settings.enableSound, settings.soundWaveform, true);
    await this.monitor.activateObsidian();
    this.plugin.openActivityNudgeModal(reason, activeMs / 60_000);
  }

  snooze() {
    const minutes = this.plugin.settings.activitySnoozeMin;
    this.state = snoozeNudge(this.state, this.now(), minutes);
    new Notice(`活动提醒已暂停 ${minutes} 分钟`);
  }

  dispose() {
    if (this._interval !== null) this.timers.clearInterval(this._interval);
    this._interval = null;
    this.monitor.dispose();
  }
}

module.exports = { ActivityNudgeController, POLL_INTERVAL_MS };
