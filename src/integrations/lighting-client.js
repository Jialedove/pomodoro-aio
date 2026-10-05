const { DeviceBridgeAdapter } = require("./device-bridge");
const { TIMER_STATUS } = require("../core/timer");
const { normalizeBridgeUrl, normalizeLightProgram } = require("../core/lighting");
/** @typedef {Record<string, any>} AnyRecord */

class LightingClient extends DeviceBridgeAdapter {
  /** @param {AnyRecord} [options] */
  constructor(options = {}) {
    super({ ...options, timeoutMs:options.timeoutMs ?? 5000 });
    this.onStatus = options.onStatus || (() => {});
    this.status = { status:"idle", programName:"", step:0, error:"" };
    /** @type {AnyRecord[]} */
    this.devices = [];
    this._lightingQueue = Promise.resolve();
    this._lightingGeneration = 0;
    this._lightingSignature = "";
    this._nextSyncAt = 0;
    this._nextPollAt = 0;
    /** @type {Promise<void> | null} */
    this._pollPending = null;
    this._serial = Date.now() * 1000;
    /** @type {AnyRecord | null} */
    this._activeRuntime = null;
    /** @type {AnyRecord | null} */
    this._preview = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._previewTimer = null;
    /** @type {Map<string, AnyRecord>} */
    this._releases = new Map();
    /** @type {Map<string, Promise<void>>} */
    this._lightingPending = new Map();
    this.deviceId = "";
  }
  /** @param {AnyRecord} settings */
  configure(settings) {
    this.enabled = settings.lightingEnabled !== false;
    this.baseUrl = normalizeBridgeUrl(settings.lightingBaseUrl);
    this.deviceId = String(settings.lightingDeviceId || "");
  }
  _nextSequence() { this._serial = Math.max(this._serial + 1, Date.now() * 1000); return this._serial; }
  /** @param {AnyRecord} state */
  _setStatus(state) {
    const next = { status:String(state.status || "idle"), programName:String(state.programName || ""), step:Number(state.step) || 0, error:String(state.error || "") };
    if (JSON.stringify(next) !== JSON.stringify(this.status)) { this.status = next; this.onStatus(next); }
  }
  /** @param {AnyRecord} runtime @param {{elapsedMs?:number}} [options] */
  async syncFromRuntime(runtime, options = {}) {
    if (this._disposed) return;
    // Existing pre-feature runtimes retain the compatibility path until a new module starts.
    if (runtime.moduleRun && !Object.prototype.hasOwnProperty.call(runtime.moduleRun, "lighting")) return super.syncFromRuntime(runtime);
    const lighting = runtime.moduleRun?.lighting;
    const active = this.enabled && lighting && runtime.sessionId
      && [TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED].includes(runtime.status);
    if (!active) return this.stopRuntime(runtime);
    const baseUrl = lighting.baseUrl || this.baseUrl;
    const deviceId = lighting.deviceId || this.deviceId;
    const signature = JSON.stringify([baseUrl, deviceId, runtime.sessionId, runtime.status, lighting.program.id, lighting.program.revision]);
    if (signature !== this._lightingSignature) {
      this._lightingSignature = signature; this._lightingGeneration += 1; this._nextSyncAt = 0;
    }
    if (Date.now() < this._nextSyncAt) return this.pollStatus();
    const generation = this._lightingGeneration;
    const key = `${generation}:${signature}`;
    const pending = this._lightingPending.get(key);
    if (pending) return pending;
    const epoch = String(runtime.sessionId);
    const submittedAt = Date.now();
    const operation = this._lightingQueue.then(async () => {
      if (generation !== this._lightingGeneration || this._disposed) return;
      if (this._activeRuntime && (this._activeRuntime.epoch !== epoch || this._activeRuntime.baseUrl !== baseUrl || this._activeRuntime.requestedDeviceId !== deviceId)) this._enqueueRelease(this._activeRuntime);
      await this._drainReleases();
      if (generation !== this._lightingGeneration || this._disposed) return;
      const scope = { baseUrl, deviceId, requestedDeviceId:deviceId, clientId:this.clientId, epoch,
        status:runtime.status, durationMs:runtime.durationMs, elapsedMs:options.elapsedMs ?? runtime.elapsedMs ?? 0, submittedAt };
      this._activeRuntime = scope;
      try {
        const state = await this.requestJson("POST", "/v1/program-runs/sync", {
          clientId:this.clientId, epoch, deviceId:deviceId || null, sequence:this._nextSequence(),
          status:runtime.status === TIMER_STATUS.PAUSED ? "paused" : "running",
          elapsedMs:Math.max(0, (options.elapsedMs ?? runtime.elapsedMs ?? 0) + (runtime.status === TIMER_STATUS.RUNNING ? Date.now() - submittedAt : 0)), durationMs:runtime.durationMs,
          program:lighting.program
        }, baseUrl);
        if (generation !== this._lightingGeneration || this._disposed) return;
        scope.deviceId = state.deviceId || deviceId;
        this._nextSyncAt = Date.now() + (state.status === "error" ? 5000 : 15000);
        this._setStatus(state);
      } catch (error) {
        if (generation !== this._lightingGeneration || this._disposed) return;
        this._nextSyncAt = Date.now() + 5000;
        this._setStatus({ status:"error", programName:lighting.program.name, error:error instanceof Error ? error.message : String(error) });
      }
    });
    this._lightingQueue = operation;
    this._lightingPending.set(key, operation);
    try { await operation; } finally { this._lightingPending.delete(key); }
  }
  /** @param {AnyRecord} scope */
  _enqueueRelease(scope) {
    const key = JSON.stringify([scope.baseUrl, scope.deviceId, scope.clientId, scope.epoch]);
    if (!this._releases.has(key)) this._releases.set(key, { ...scope, nextAt:0, expiresAt:Date.now() + 65000 });
  }
  async _drainReleases() {
    for (const [key, scope] of this._releases) {
      if (Date.now() > scope.expiresAt) { this._releases.delete(key); continue; }
      if (Date.now() < scope.nextAt) continue;
      try {
        await this.requestJson("POST", "/v1/program-runs/release", {
          deviceId:scope.deviceId, clientId:scope.clientId, epoch:scope.epoch, sequence:this._nextSequence(), completed:scope.completed === true
        }, scope.baseUrl);
        this._releases.delete(key);
      } catch { scope.nextAt = Date.now() + 5000; }
    }
  }
  /** @param {AnyRecord} [runtime] */
  async stopRuntime(runtime) {
    this._lightingGeneration += 1;
    this._lightingSignature = ""; this._nextSyncAt = 0;
    const operation = this._lightingQueue.then(async () => {
      if (this._activeRuntime) {
        const scope = this._activeRuntime;
        const elapsed = scope.elapsedMs + (scope.status === TIMER_STATUS.RUNNING ? Math.max(0, Date.now() - scope.submittedAt) : 0);
        scope.completed = this.enabled && !!runtime && [TIMER_STATUS.IDLE, TIMER_STATUS.AWAITING].includes(runtime.status) && elapsed >= scope.durationMs;
        this._enqueueRelease(scope); this._activeRuntime = null;
      }
      await this._drainReleases();
      this._setStatus({ status:this.enabled ? "idle" : "disabled" });
    });
    this._lightingQueue = operation;
    await operation;
  }
  async pollStatus() {
    if (!this._activeRuntime || this._disposed || Date.now() < this._nextPollAt) return;
    if (this._pollPending) return this._pollPending;
    const scope = this._activeRuntime;
    const operation = (async () => {
      try {
        const runs = await this.requestJson("GET", "/v1/program-runs", undefined, scope.baseUrl);
        if (this._activeRuntime !== scope || this._disposed) return;
        if (!Array.isArray(runs)) throw new Error("灯光运行状态无效");
        const run = runs.find(item => item.epoch === scope.epoch && item.clientId === scope.clientId);
        if (run) this._setStatus(run); else this._nextSyncAt = 0;
        this._nextPollAt = Date.now() + 2000;
      } catch (error) {
        if (this._activeRuntime !== scope || this._disposed) return;
        this._nextPollAt = Date.now() + 5000;
        this._nextSyncAt = Math.min(this._nextSyncAt, Date.now() + 5000);
        this._setStatus({ status:"error", programName:this.status.programName, error:error instanceof Error ? error.message : String(error) });
      }
    })();
    this._pollPending = operation;
    try { await operation; } finally { this._pollPending = null; }
  }
  async refreshLibrary() {
    const health = await this.requestJson("GET", "/v1/health");
    if (health.service !== "DeviceBridge" || !health.features?.includes("light-programs-v1")) throw new Error("请启动新版 DeviceBridge，当前服务尚不支持灯光方案");
    const [library, devices] = await Promise.all([this.requestJson("GET", "/v1/light-programs"), this.requestJson("GET", "/v1/devices")]);
    if (!Array.isArray(library) || !Array.isArray(devices)) throw new Error("服务返回的方案或设备列表无效");
    this.devices = devices;
    return { programs:library.map(normalizeLightProgram), devices };
  }
  /** @param {unknown} program */
  async saveProgram(program) { return normalizeLightProgram(await this.requestJson("POST", "/v1/light-programs/save", normalizeLightProgram(program))); }
  /** @param {AnyRecord} program */
  async deleteProgram(program) { await this.requestJson("POST", "/v1/light-programs/delete", { id:program.id, revision:program.revision }); }
  /** @param {unknown} input */
  async preview(input) {
    if (this._activeRuntime) throw new Error("请先结束当前任务，再预览灯光");
    await this.stopPreview();
    const program = normalizeLightProgram(input);
    const scope = { baseUrl:this.baseUrl, deviceId:this.deviceId, clientId:"pomodoro-aio-preview", epoch:`preview-${this._nextSequence()}` };
    this._preview = scope;
    try {
      const state = await this.requestJson("POST", "/v1/program-runs/sync", { ...scope, deviceId:scope.deviceId || null,
        sequence:this._nextSequence(), status:"running", elapsedMs:0, durationMs:60000, program });
      scope.deviceId = state.deviceId || scope.deviceId;
      this._previewTimer = setTimeout(() => { void this.stopPreview(); }, 60000);
      return state;
    } catch (error) { await this.stopPreview(); throw error; }
  }
  async stopPreview() {
    if (this._previewTimer) clearTimeout(this._previewTimer);
    this._previewTimer = null;
    if (this._preview) { this._enqueueRelease(this._preview); this._preview = null; }
    await this._drainReleases();
  }
  async dispose() {
    this._disposed = true;
    await this.stopRuntime(); await this.stopPreview(); await super.releaseControl();
    this.enabled = false;
  }
  /** @param {string} method @param {string} path @param {AnyRecord} [body] @param {string} [baseUrl] @returns {Promise<any>} */
  async requestJson(method, path, body, baseUrl = this.baseUrl) {
    const request = this.requestFn || (typeof fetch === "function" ? fetch : null);
    if (!request) throw new Error("本机 HTTP 连接不可用");
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout;
    try {
      return await Promise.race([(async () => {
        const response = await request(baseUrl + path, { method, headers:{ "Content-Type":"application/json" },
          ...(body ? { body:JSON.stringify(body) } : {}), signal:controller?.signal });
        const data = typeof response.json === "function" ? await response.json() : {};
        if (!response.ok) throw new Error(data.error || `DeviceBridge 请求失败（${response.status}）`);
        return data;
      })(), new Promise((_, reject) => {
        timeout = setTimeout(() => { controller?.abort(); reject(new Error("DeviceBridge 连接超时，请检查菜单栏应用是否正在运行")); }, this.timeoutMs);
      })]);
    } finally { clearTimeout(timeout); }
  }
}
module.exports = { LightingClient };
