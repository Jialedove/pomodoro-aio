const { TIMER_STATUS, TIMER_STAGE } = require("../core/timer");

/** @param {Record<string, any> | null | undefined} runtime @param {unknown} enabled */
function shouldShowBreakBlackout(runtime, enabled) {
  return enabled === true
    && runtime?.stage === TIMER_STAGE.BREAK
    && /** @type {string[]} */ ([TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED]).includes(runtime?.status);
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
    this.dismissed = false;
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
      overlay.setAttribute("aria-label", "休息黑屏");
      const content = this.document.createElement("div");
      content.className = "pmd-blackout-content";
      const label = this.document.createElement("div");
      label.className = "pmd-blackout-label";
      label.textContent = "休息一下";
      const time = this.document.createElement("div");
      time.className = "pmd-blackout-time";
      const exit = this.document.createElement("button");
      exit.className = "pmd-blackout-exit";
      exit.type = "button";
      exit.textContent = "退出黑屏（休息继续）";
      exit.onclick = event => {
        event.stopPropagation();
        this.dismiss();
      };
      content.appendChild(label);
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
  }

  dismiss() {
    if (!this.overlay) return;
    this.dismissed = true;
    this.hide();
    this.onDismiss();
  }

  hide() {
    if (this.overlay) this.overlay.remove();
    this.document.removeEventListener("keydown", this._onKeydown, true);
    this.overlay = null;
    this.timeEl = null;
  }

  /** @param {Record<string, any> | null | undefined} runtime @param {unknown} enabled @param {number} leftSec */
  sync(runtime, enabled, leftSec) {
    const remainsBreakStage = runtime?.stage === TIMER_STAGE.BREAK;
    if (!remainsBreakStage) this.dismissed = false;
    if (!shouldShowBreakBlackout(runtime, enabled)) {
      this.hide();
      return false;
    }
    if (this.dismissed) {
      this.hide();
      return false;
    }
    this.show(/** @type {Record<string, any>} */ (runtime), leftSec);
    return true;
  }

  destroy() {
    this.hide();
    this.dismissed = false;
  }
}

module.exports = { BreakBlackoutController, formatBlackoutTime, shouldShowBreakBlackout };
