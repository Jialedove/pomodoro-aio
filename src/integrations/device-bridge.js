/**
 * Device Bridge Adapter for Pomodoro AIO
 * Integrates Pomodoro lifecycle with local Device Bridge API (Task 5 & Task 6).
 *
 * Rules:
 * 1. WORK   -> apply "work" profile
 * 2. REST   -> apply "rest" profile (lamp off)
 * 3. PAUSED -> hold current state (no network action)
 * 4. RESET  -> stop local automation
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
    // 重置：停止本地自动请求，保留用户手动覆盖。
    return { type: "RELEASE", epoch };
  }

  if (status === TIMER_STATUS.RUNNING && epoch) {
    // Module snapshots are authoritative; stage is only a legacy fallback.
    const type = moduleType === "work" || moduleType === "rest"
      ? moduleType
      : stage === TIMER_STAGE.FOCUS ? "work" : stage === TIMER_STAGE.BREAK ? "rest" : null;

    if (type === "work") {
      // 工作：WORK → work profile
      return { type: "APPLY_PROFILE", profileId: "work", epoch };
    }
    if (type === "rest") {
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
   *   timeoutMs?: number,
   *   retryDelayMs?: number,
   *   requestFn?: (url: string, init: Record<string, any>) => Promise<any>
   * }} [options]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || "http://127.0.0.1:18473").replace(/\/+$/, "");
    this.clientId = options.clientId || "pomodoro-aio";
    this.enabled = options.enabled !== false;
    this.requestFn = options.requestFn || null;
    this.timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      && options.timeoutMs > 0 ? options.timeoutMs : 2000;
    this.retryDelayMs = typeof options.retryDelayMs === "number" && Number.isFinite(options.retryDelayMs)
      && options.retryDelayMs >= 0 ? options.retryDelayMs : 5000;
    /** @type {string | null} */
    this.lastActionSignature = null;
    this._generation = 0;
    this._disposed = false;
    this._queue = Promise.resolve();
    /** @type {Map<string, Promise<void>>} */
    this._pendingActions = new Map();
    /** @type {string | null} */
    this._retrySignature = null;
    this._retryAfterMs = 0;
  }

  /**
   * Synchronizes the Device Bridge based on a successfully persisted Runtime.
   *
   * @param {Record<string, any>} runtime
   */
  async syncFromRuntime(runtime) {
    if (!this.enabled || this._disposed) return;

    const action = projectRuntimeToBridgeAction(runtime);
    if (action.type === "RELEASE") return this.releaseControl();
    // HOLD preserves successful deduplication but cancels unsent actions.
    if (action.type !== "APPLY_PROFILE" || !action.profileId) {
      this._generation += 1;
      this._pendingActions.clear();
      return;
    }
    const signature = `${action.type}:${action.profileId || ""}:${action.epoch || ""}`;
    if (signature === this.lastActionSignature) return;
    if (signature === this._retrySignature && Date.now() < this._retryAfterMs) return;
    const generation = this._generation;
    const pendingKey = `${generation}:${signature}`;
    const pending = this._pendingActions.get(pendingKey);
    if (pending) return pending;
    const profileId = action.profileId;
    const operation = this._queue.then(async () => {
      if (!this.enabled || this._disposed || generation !== this._generation) return;
      if (signature === this.lastActionSignature) return;
      try {
        await this.applyProfile(profileId, action.epoch);
        if (generation === this._generation && !this._disposed) {
          this.lastActionSignature = signature;
          this._retrySignature = null;
          this._retryAfterMs = 0;
        }
      } catch (error) {
        if (generation === this._generation && !this._disposed) {
          this._retrySignature = signature;
          this._retryAfterMs = Date.now() + this.retryDelayMs;
        }
        // Fail softly and retry the same module after a short backoff.
        const errMsg = error instanceof Error ? error.message : String(error || "");
        console.debug("Pomodoro AIO Device Bridge sync notice (daemon may be offline):", errMsg);
      }
    });
    this._queue = operation;
    this._pendingActions.set(pendingKey, operation);
    try {
      await operation;
    } finally {
      this._pendingActions.delete(pendingKey);
    }
  }

  /**
   * @param {string} profileId
   * @param {string | null} epoch
   */
  async applyProfile(profileId, epoch) {
    if (!epoch) throw new Error("Device Bridge automation requires a stable session epoch");
    const url = `${this.baseUrl}/v1/profiles/${encodeURIComponent(profileId)}/apply`;
    const payload = {
      clientId: this.clientId,
      epoch
    };
    await this._postJson(url, payload);
  }

  /**
   * Invalidates queued automation locally. The daemon's /v1/control/release
   * endpoint restores automatic control by clearing manual override; it does
   * not release a lease and must never be called on reset or unload.
   */
  async releaseControl() {
    this._generation += 1;
    this.lastActionSignature = null;
    this._pendingActions.clear();
    this._retrySignature = null;
    this._retryAfterMs = 0;
    await this._queue;
  }

  async dispose() {
    this._disposed = true;
    this.enabled = false;
    await this.releaseControl();
  }

  /**
   * @private
   * @param {string} url
   * @param {Record<string, any>} body
   */
  async _postJson(url, body) {
    const request = this.requestFn || (typeof fetch !== "undefined" ? fetch : null);
    if (!request) throw new Error("Device Bridge HTTP transport is unavailable");
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout;
    try {
      const response = await Promise.race([request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller?.signal
      }), new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller?.abort();
          reject(new Error("Device Bridge request timed out"));
        }, this.timeoutMs);
      })]);
      if (!response?.ok) throw new Error(`Device Bridge HTTP request failed (${response?.status || "no response"})`);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = {
  projectRuntimeToBridgeAction,
  DeviceBridgeAdapter
};
