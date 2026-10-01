/**
 * Device Bridge Adapter for Pomodoro AIO
 * Integrates Pomodoro lifecycle with local Device Bridge API (Task 5 & Task 6).
 *
 * Rules:
 * 1. WORK   -> apply "work" profile
 * 2. REST   -> apply "rest" profile (lamp off)
 * 3. PAUSED -> hold current state (no network action)
 * 4. RESET  -> release control
 *
 * Manual Override (Task 6):
 * Automatic controls carry the current sessionId as an epoch lease.
 * When user manually modifies the light via the Menu Bar, BridgeCore enters Manual Override
 * and suppresses automation until the next module epoch begins or user explicitly restores auto.
 */

const { TIMER_STATUS, TIMER_STAGE } = require("../core/timer");

/**
 * Projects a Runtime snapshot into a Device Bridge action.
 * Pure function with zero side effects.
 *
 * @param {Record<string, any> | null | undefined} runtime
 * @returns {{ type: "APPLY_PROFILE" | "HOLD" | "RELEASE" | "NONE", profileId?: string, epoch: string | null }}
 */
function projectRuntimeToBridgeAction(runtime) {
  if (!runtime || typeof runtime !== "object") {
    return { type: "NONE", epoch: null };
  }

  const status = runtime.status;
  const stage = runtime.stage;
  const moduleType = runtime.moduleRun?.type;
  const epoch = runtime.sessionId ? String(runtime.sessionId) : null;

  if (status === TIMER_STATUS.PAUSED) {
    // 暂停：PAUSED → 默认保持
    return { type: "HOLD", epoch };
  }

  if (status === TIMER_STATUS.IDLE) {
    // 重置：RESET → release
    return { type: "RELEASE", epoch };
  }

  if (status === TIMER_STATUS.RUNNING) {
    const isWork = moduleType === "work" || stage === TIMER_STAGE.FOCUS;
    const isRest = moduleType === "rest" || stage === TIMER_STAGE.BREAK;

    if (isWork) {
      // 工作：WORK → work profile
      return { type: "APPLY_PROFILE", profileId: "work", epoch };
    }
    if (isRest) {
      // 休息：REST → off
      return { type: "APPLY_PROFILE", profileId: "rest", epoch };
    }
  }

  return { type: "NONE", epoch };
}

class DeviceBridgeAdapter {
  /**
   * @param {{
   *   baseUrl?: string,
   *   clientId?: string,
   *   enabled?: boolean,
   *   requestFn?: (url: string, init: Record<string, any>) => Promise<any>
   * }} [options]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || "http://127.0.0.1:18473").replace(/\/+$/, "");
    this.clientId = options.clientId || "pomodoro-aio";
    this.enabled = options.enabled !== false;
    this.requestFn = options.requestFn || null;
    /** @type {string | null} */
    this.lastActionSignature = null;
  }

  /**
   * Synchronizes the Device Bridge based on a successfully persisted Runtime.
   *
   * @param {Record<string, any>} runtime
   */
  async syncFromRuntime(runtime) {
    if (!this.enabled) return;

    const action = projectRuntimeToBridgeAction(runtime);
    const signature = `${action.type}:${action.profileId || ""}:${action.epoch || ""}`;

    if (signature === this.lastActionSignature) {
      // Deduplicate consecutive identical actions
      return;
    }
    this.lastActionSignature = signature;

    try {
      if (action.type === "APPLY_PROFILE" && action.profileId) {
        await this.applyProfile(action.profileId, action.epoch);
      } else if (action.type === "RELEASE") {
        await this.releaseControl(action.epoch);
      }
      // "HOLD" or "NONE" -> no API call
    } catch (error) {
      // Fail-soft: Never crash or block Pomodoro state machine
      const errMsg = error instanceof Error ? error.message : String(error || "");
      console.debug("Pomodoro AIO Device Bridge sync notice (daemon may be offline):", errMsg);
    }
  }

  /**
   * @param {string} profileId
   * @param {string | null} epoch
   */
  async applyProfile(profileId, epoch) {
    const url = `${this.baseUrl}/v1/profiles/${encodeURIComponent(profileId)}/apply`;
    const payload = {
      clientId: this.clientId,
      epoch: epoch || `epoch-${Date.now()}`
    };
    await this._postJson(url, payload);
  }

  /**
   * @param {string | null} [epoch]
   */
  async releaseControl(epoch) {
    const url = `${this.baseUrl}/v1/control/release`;
    const payload = {
      clientId: this.clientId,
      epoch: epoch || undefined
    };
    await this._postJson(url, payload);
  }

  /**
   * @private
   * @param {string} url
   * @param {Record<string, any>} body
   */
  async _postJson(url, body) {
    if (this.requestFn) {
      return this.requestFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    }

    if (typeof fetch !== "undefined") {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeout = setTimeout(() => controller?.abort(), 2000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller?.signal
        }).catch(() => null);
        return res;
      } catch (_) {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

module.exports = {
  projectRuntimeToBridgeAction,
  DeviceBridgeAdapter
};
