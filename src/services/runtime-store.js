function cloneValue(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

class RuntimeStore {
  /**
   * @param {{
   *   readRuntime: () => unknown | Promise<unknown>,
   *   writeRuntime: (snapshot: unknown) => unknown | Promise<unknown>,
   *   readSettings: () => unknown | Promise<unknown>,
   *   writeSettings: (snapshot: unknown) => unknown | Promise<unknown>,
   *   onError?: (error: unknown, context: { critical?: boolean, operation?: string, sessionId?: string|null, stage?: string|null, target?: string|null, step?: string|null }) => void
   * }} options
   */
  constructor({ readRuntime, writeRuntime, readSettings, writeSettings, onError = () => {} }) {
    this.readRuntime = readRuntime;
    this.writeRuntime = writeRuntime;
    this.readSettings = readSettings;
    this.writeSettings = writeSettings;
    this.onError = onError;
    this.queue = Promise.resolve();
    this.lastError = null;
  }

  async loadRuntime() {
    return (await this.readRuntime()) || null;
  }

  async loadSettings() {
    return this.readSettings();
  }

  enqueue(task, critical = false, context = {}) {
    const previous = this.queue || Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    const handled = operation.catch(error => {
      this.lastError = error;
      this.onError(error, { critical, ...context });
      if (critical) throw error;
    });
    this.queue = handled.catch(() => {});
    return critical ? handled : this.queue;
  }

  /** @param {unknown} runtime @param {{critical?: boolean}} [options] */
  saveRuntime(runtime, options = {}) {
    const snapshot = cloneValue(runtime);
    return this.enqueue(() => this.writeRuntime(snapshot), !!options.critical, {
      operation: "saveRuntime",
      sessionId: snapshot?.sessionId || null,
      stage: snapshot?.stage || null
    });
  }

  saveSettings(settings) {
    const snapshot = cloneValue(settings);
    return this.enqueue(() => this.writeSettings(snapshot), false, { operation: "saveSettings" });
  }

  async flush() {
    await (this.queue || Promise.resolve());
  }
}

module.exports = { RuntimeStore, cloneValue };
