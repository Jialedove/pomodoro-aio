const Module = require("node:module");

class FakeTFile {
  constructor(path, content = "") {
    this.path = path;
    this.content = content;
    this.frontmatter = {};
  }

  get basename() {
    return this.path.split("/").pop().replace(/\.md$/i, "");
  }
}

class FakeVault {
  constructor(files = {}) {
    this.files = new Map();
    for (const [path, content] of Object.entries(files)) this.addFile(path, content);
  }

  addFile(path, content = "") {
    const file = content instanceof FakeTFile ? content : new FakeTFile(path, content);
    this.files.set(path, file);
    return file;
  }

  getAbstractFileByPath(path) {
    return this.files.get(path) || null;
  }

  getMarkdownFiles() {
    return [...this.files.values()].filter(file => file.path.endsWith(".md"));
  }

  async read(file) {
    return file.content;
  }

  async modify(file, content) {
    file.content = content;
  }

  async process(file, callback) {
    file.content = await callback(file.content);
    return file;
  }

  async create(path, content = "") {
    return this.addFile(path, content);
  }

  async createFolder() {}
}

class FakeClock {
  constructor(now = 0) {
    this.value = now;
  }

  now() {
    return this.value;
  }

  advance(milliseconds) {
    this.value += milliseconds;
  }

  runSync(fn) {
    const originalNow = Date.now;
    Date.now = () => this.value;
    try {
      return fn();
    } finally {
      Date.now = originalNow;
    }
  }

  async run(fn) {
    const originalNow = Date.now;
    Date.now = () => this.value;
    try {
      return await fn();
    } finally {
      Date.now = originalNow;
    }
  }
}

class FailureStore {
  constructor(value = null, options = {}) {
    this.value = value;
    this.failures = new Set();
    this.saves = [];
    this.saveDelays = [...(options.saveDelays || [])];
  }

  failNext(operation) {
    this.failures.add(operation);
  }

  async load() {
    this.throwIfScheduled("load");
    return clone(this.value);
  }

  async save(value) {
    this.throwIfScheduled("save");
    const delay = this.saveDelays.shift() || 0;
    if (delay) await new Promise(resolve => { setTimeout(resolve, delay); });
    this.value = clone(value);
    this.saves.push(clone(value));
  }

  throwIfScheduled(operation) {
    if (!this.failures.delete(operation)) return;
    throw new Error(`injected ${operation} failure`);
  }
}

class CommandSimulator {
  constructor(commands = [], activeWorkspace = "") {
    this.commands = commands;
    this.activeWorkspace = activeWorkspace;
    this.executed = [];
    this.failIds = new Set();
  }

  listCommands() {
    return this.commands.slice();
  }

  executeCommandById(id) {
    if (this.failIds.has(id)) return false;
    this.executed.push(id);
    return true;
  }
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function createApp({ vault, commands = new CommandSimulator(), metadata = new Map(), activeWorkspace = "", stateStore = null }) {
  return {
    vault,
    metadataCache: {
      getFileCache(file) {
        return metadata.get(file.path) || {};
      }
    },
    fileManager: {
      async processFrontMatter(file, callback) {
        const frontmatter = file.frontmatter || {};
        await callback(frontmatter);
        file.frontmatter = frontmatter;
      }
    },
    commands,
    internalPlugins: {
      getPluginById(id) {
        return id === "workspaces"
          ? { instance: { activeWorkspace: activeWorkspace || commands.activeWorkspace } }
          : null;
      }
    },
    workspace: { trigger() {} },
    async loadLocalStorage() { return stateStore ? stateStore.load() : null; },
    async saveLocalStorage(key, value) { if (stateStore) await stateStore.save(value); }
  };
}

function loadPomodoro() {
  const originalLoad = Module._load;
  const notices = [];
  class FakeNotice {
    constructor(message) {
      notices.push(message);
    }
  }
  class FakePlugin {}
  class FakeItemView {}
  class FakeModal {
    constructor(app) { this.app = app; }
    open() {}
    close() {}
  }
  class FakePluginSettingTab {}
  class FakeSetting {}
  const getFrontMatterInfo = content => {
    const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    return { exists: !!match, frontmatter: match?.[1] || "" };
  };
  const parseYaml = yaml => Object.fromEntries(String(yaml || "").split(/\r?\n/).map(line => {
    const index = line.indexOf(":");
    if (index === -1) return null;
    const key = line.slice(0, index).trim();
    const raw = line.slice(index + 1).trim();
    const number = Number(raw);
    return [key, raw !== "" && Number.isFinite(number) ? number : raw];
  }).filter(Boolean));
  const normalizePath = path => String(path || "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");

  Module._load = (request, parent, isMain) => request === "obsidian"
    ? {
        Plugin: FakePlugin,
        Notice: FakeNotice,
        TFile: FakeTFile,
        getFrontMatterInfo,
        parseYaml,
        normalizePath,
        ItemView: FakeItemView,
        Modal: FakeModal,
        PluginSettingTab: FakePluginSettingTab,
        Setting: FakeSetting,
        setIcon() {}
      }
    : originalLoad(request, parent, isMain);

  try {
    return { PomodoroAIO: require("../src/main.js"), notices };
  } finally {
    Module._load = originalLoad;
  }
}

const { PomodoroAIO, notices } = loadPomodoro();

const BASE_SETTINGS = {
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longFocusDefaultMin: 50,
  longEvery: 4,
  autoNext: true,
  dayStartHHMM: "00:00",
  fallbackPattern: "Daily/{{date:YYYY-MM-DD}}.md",
  allowCreateDaily: true,
  fmKey: "番茄数",
  allowAutoCreateTask: true,
  tasksHeading: "",
  defaultTaskName: "",
  captureHeading: "Inbox",
  capturePathPattern: "",
  projectEnable: true,
  enableProjects: true,
  projectTag: "#project",
  projectStatusKey: "项目状态",
  projectStatusWhitelist: "进行中,筹划中",
  projectFmKey: "番茄数",
  currentProjectPath: "",
  enableSound: false,
  enableNotify: false,
  persistentAlertSound: false,
  ribbonClickAutoNext: true,
  focusStartCommandId: "",
  breakStartCommandId: "",
  breakBlackoutEnabled: false,
  workMode: "standard",
  cycleTaskA: "",
  cycleMinA: 15,
  cycleWorkspaceCommandA: "",
  cycleTaskB: "",
  cycleMinB: 15,
  cycleWorkspaceCommandB: "",
  cycleBreakEvery: 0
};

const BASE_RUNTIME = {
  schemaVersion: 3,
  status: "idle",
  stage: null,
  mode: "standard",
  cycleSlot: 0,
  durationMs: 0,
  startedAtMs: 0,
  elapsedMs: 0,
  remainingMs: 0,
  pausedAtMs: 0,
  sessionId: null,
  plannedTomatoCredit: 1,
  attention: null,
  pendingSettlement: null,
  pendingBreakTransition: null,
  projectQueue: [],
  frontmatterQueue: [],
  sessionCount: 0,
  cycleRoundCount: 0,
  currentTaskName: "",
  longFocusMinutes: 50,
  dayKey: "",
  viewWasOpen: false
};

function createPlugin(options = {}) {
  const vault = options.vault || new FakeVault();
  const commands = options.commands || new CommandSimulator();
  const plugin = new PomodoroAIO();
  // Runtime regression tests must never control real local devices.
  plugin.deviceBridge = { syncFromRuntime:async () => {}, dispose:async () => {} };
  plugin.settings = { ...BASE_SETTINGS, ...(options.settings || {}) };
  if (!Array.isArray(plugin.settings.modules)) {
    plugin.completeTask = function(completeOptions) { return this._getLegacyController().completeTask(completeOptions); };
  }
  plugin.runtime = { ...BASE_RUNTIME, ...(options.runtime || {}) };
  plugin.app = createApp({
    vault,
    commands,
    metadata: options.metadata,
    activeWorkspace: options.activeWorkspace,
    stateStore: options.stateStore
  });
  plugin._saveQueue = Promise.resolve();
  plugin._lastPersistenceError = null;
  plugin.savedStates = [];
  plugin.broadcastCount = 0;
  if (!options.stateStore) {
    plugin.saveState = async () => {
      const state = clone(plugin.runtime);
      plugin.savedStates.push(state);
    };
  }
  plugin.saveSettings = async () => {};
  plugin.broadcast = () => { plugin.broadcastCount += 1; };
  plugin.ensureDayFreshness = () => {};
  plugin._resyncTick = () => {};
  plugin.todayFilePath = () => options.todayPath || "Daily/today.md";
  plugin.notices = notices;
  return plugin;
}

module.exports = {
  CommandSimulator,
  FailureStore,
  FakeClock,
  FakeTFile,
  FakeVault,
  PomodoroAIO,
  clone,
  createPlugin
};
