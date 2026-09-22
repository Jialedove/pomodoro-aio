const { TIMER_STATUS, TIMER_STAGE } = require("../core/timer");

/**
 * Obsidian plugins run in Electron's renderer process. BrowserWindow is a main
 * process API and Obsidian exposes no supported bridge for a plugin to create
 * another always-on-top window. Keep the limitation explicit rather than
 * attempting an unsupported `require("electron").BrowserWindow` call.
 */
/** @param {Document | null | undefined} document */
function getBlackoutCapability(document) {
  return {
    scope: "obsidian-window",
    canCoverOtherApps: false,
    canRequestCurrentDisplayFullscreen: typeof document?.documentElement?.requestFullscreen === "function",
    reason: "Obsidian 插件只能安全操作当前渲染窗口，不能创建独立的置顶全屏 Electron 窗口。"
  };
}

/** @param {Record<string, any> | null | undefined} runtime @param {Record<string, any> | null | undefined} settings */
function shouldShowBlackout(runtime, settings) {
  const active = /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(runtime?.status);
  if (!active) return false;
  if (runtime?.stage === TIMER_STAGE.BREAK) return settings?.breakBlackoutEnabled === true;
  if (runtime?.stage !== TIMER_STAGE.FOCUS) return false;
  if (runtime?.mode === "cycle") return runtime?.cycleSlot === 1
    ? settings?.cycleTaskBlackoutB === true
    : settings?.cycleTaskBlackoutA === true;
  return settings?.taskBlackoutEnabled === true;
}

/** @param {Record<string, any> | null | undefined} runtime */
function blackoutKey(runtime) {
  if (!runtime?.stage) return "";
  // A break has no persisted session id. Its phase stays the same across
  // pause/resume while startedAtMs is deliberately reset, so do not use that
  // mutable timestamp to decide whether a dismissed screen may reappear.
  if (runtime.stage === TIMER_STAGE.BREAK) return "break:active";
  return `${runtime.stage}:${runtime.sessionId || runtime.startedAtMs || "pending"}`;
}

/** @param {number} seconds */
function formatBlackoutTime(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

class BreakBlackoutController {
  /** @param {{document:Document, onDismiss?:()=>void}} options */
  constructor({ document, onDismiss }) {
    this.document = document;
    this.onDismiss = onDismiss || (() => {});
    /** @type {HTMLElement | null} */
    this.overlay = null;
    /** @type {HTMLElement | null} */
    this.timeEl = null;
    this.dismissedKey = "";
    this.finishedKey = "";
    this.fullscreenRequested = false;
    this._onKeydown = (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== "Escape" || !this.overlay) return;
      event.preventDefault();
      this.dismiss();
    };
  }

  /** @param {Record<string, any>} runtime @param {number} leftSec */
  show(runtime, leftSec) {
    if (!this.overlay) {
      const overlay = this.document.createElement("div");
      overlay.className = "pmd-blackout-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "全屏专注提示");
      const content = this.document.createElement("div");
      content.className = "pmd-blackout-content";
      const label = this.document.createElement("div");
      label.className = "pmd-blackout-label";
      label.textContent = "现在离开电脑，做一件不看屏幕的事";
      const time = this.document.createElement("div");
      time.className = "pmd-blackout-time";
      const title = this.document.createElement("div");
      title.className = "pmd-blackout-title";
      title.textContent = "离开电脑";
      const exit = this.document.createElement("button");
      exit.className = "pmd-blackout-exit";
      exit.type = "button";
      exit.textContent = "立即退出（计时继续）";
      exit.onclick = event => {
        event.stopPropagation();
        this.dismiss();
      };
      content.appendChild(label);
      content.appendChild(title);
      content.appendChild(time);
      content.appendChild(exit);
      overlay.appendChild(content);
      overlay.onclick = () => this.dismiss();
      this.document.body.appendChild(overlay);
      this.document.addEventListener("keydown", this._onKeydown, true);
      this.overlay = overlay;
      this.timeEl = time;
    }
    if (this.timeEl) this.timeEl.textContent = formatBlackoutTime(leftSec);
    const key = blackoutKey(runtime);
    if (leftSec <= 0 && this.finishedKey !== key) {
      this.finishedKey = key;
      this.overlay?.classList?.add?.("pmd-blackout-finished");
    }
  }

  dismiss() {
    if (!this.overlay) return;
    this.dismissedKey = blackoutKey(this.runtime);
    this.hide();
    this.exitCurrentDisplayFullscreen();
    this.onDismiss();
  }

  hide() {
    if (this.overlay) this.overlay.remove();
    this.document.removeEventListener("keydown", this._onKeydown, true);
    this.overlay = null;
    this.timeEl = null;
  }

  /**
   * Must be called synchronously from a direct user gesture. It only makes the
   * current Obsidian window fullscreen; it cannot cover another application.
   */
  requestCurrentDisplayFullscreen() {
    const root = this.document?.documentElement;
    if (!root || typeof root.requestFullscreen !== "function") return false;
    try {
      const requested = root.requestFullscreen({ navigationUI: "hide" });
      requested?.catch?.(() => {});
      this.fullscreenRequested = true;
      return true;
    } catch {
      return false;
    }
  }

  exitCurrentDisplayFullscreen() {
    if (!this.fullscreenRequested) return false;
    this.fullscreenRequested = false;
    if (typeof this.document?.exitFullscreen !== "function") return false;
    try {
      const exited = this.document.exitFullscreen();
      exited?.catch?.(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /** @param {Record<string, any> | null | undefined} runtime @param {Record<string, any> | null | undefined} settings @param {number} leftSec */
  sync(runtime, settings, leftSec) {
    this.runtime = runtime || null;
    const key = blackoutKey(runtime);
    if (!key || this.dismissedKey !== key) {
      this.dismissedKey = "";
      if (this.finishedKey && this.finishedKey !== key) this.finishedKey = "";
    }
    if (!shouldShowBlackout(runtime, settings)) {
      this.hide();
      return false;
    }
    if (this.dismissedKey === key) {
      this.hide();
      return false;
    }
    this.show(/** @type {Record<string, any>} */ (runtime), leftSec);
    return true;
  }

  destroy() {
    this.hide();
    this.exitCurrentDisplayFullscreen();
    this.dismissedKey = "";
    this.finishedKey = "";
    this.runtime = null;
  }
}

/** @param {Record<string, any> | null | undefined} runtime @param {unknown} enabled */
function shouldShowBreakBlackout(runtime, enabled) {
  return shouldShowBlackout(runtime, { breakBlackoutEnabled: enabled });
}

module.exports = {
  BreakBlackoutController,
  formatBlackoutTime,
  shouldShowBlackout,
  shouldShowBreakBlackout,
  getBlackoutCapability
};
