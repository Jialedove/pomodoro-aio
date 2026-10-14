// 时间归属：人在电脑前的每一分钟必须属于工作、休息或声明不计时；其余为未归属时间。
// 纯函数，不读系统时间或 Obsidian 状态。设计见 docs/time-accounting.md。
const { TIMER_STATUS } = require("./timer");
const { positiveNumber } = require("./validation");
/** @typedef {import("../../types/contracts").Runtime} Runtime */
/** @typedef {"idle"|"paused"|"awaiting"} UnaccountedReason */
/** @typedef {"work"|"rest"|"unaccounted"|"busy"} RuntimeCategory */
/** @typedef {"leisure"|"errand"} DeclarationKind */
/** @typedef {{id:string,kind:DeclarationKind,reason:string,startedAtMs:number,plannedMs:number,dayKey:string,dailyPath:string}} Declaration */
/** @typedef {{startedAtMs:number,lastPresentAtMs:number,countedMs:number}} Stretch */
/** @typedef {{kind:"line",path:string,text:string} | {kind:"summary",path:string,values:Record<string, number>}} OutboxEntry */
/**
 * @typedef {object} AccountingStore
 * @property {number} schemaVersion
 * @property {string} dayKey
 * @property {string} dailyPath
 * @property {number} unaccountedMs
 * @property {number} leisureMs
 * @property {number} snoozeCount
 * @property {number} snoozeUntilMs
 * @property {number} summaryBucket
 * @property {Stretch | null} stretch
 * @property {Declaration | null} declaration
 * @property {OutboxEntry[]} outbox
 */
/** @typedef {{type:"declaration-ended",declaration:Declaration,expired:boolean,actualMs:number}} AccountingEvent */

const STORE_SCHEMA_VERSION = 1;
const MAX_POLL_GAP_MS = 15_000;
const SUMMARY_BUCKET_MS = 5 * 60_000;
const MAX_OUTBOX = 200;
const MAX_DECLARATION_MIN = 480;
const SUMMARY_KEYS = Object.freeze({ unaccounted:"未归属分钟", leisure:"消遣分钟", snooze:"稍后提醒次数" });
const KIND_LABEL = Object.freeze({ leisure:"消遣", errand:"事务" });

const ACCOUNTING_DEFAULTS = Object.freeze({
  accountingEnabled:true,
  accountingMode:/** @type {"remind"|"strict"} */ ("remind"),
  accountingAwaySec:120,
  accountingNotifyAfterMin:1,
  accountingPromptAfterMin:5,
  accountingPromptRepeatMin:5,
  accountingSnoozeMin:10,
  accountingSnoozeLimit:3,
  accountingLeisureBudgetMin:30,
  accountingHeading:"时间归属",
  /** @type {{requestedDayKey:string, patch:Record<string, any>} | null} */
  accountingPending:null
});

// 强制模式下这些设置变大即为放宽，次日生效。
const LOOSEN_WHEN_LARGER = Object.freeze(["accountingAwaySec", "accountingNotifyAfterMin", "accountingPromptAfterMin",
  "accountingPromptRepeatMin", "accountingSnoozeMin", "accountingSnoozeLimit", "accountingLeisureBudgetMin"]);
const DEFERRABLE_KEYS = Object.freeze(["accountingEnabled", "accountingMode", ...LOOSEN_WHEN_LARGER]);

/** @param {Record<string, any>} source @param {Record<string, any>} [base] */
function normalizeAccountingSettings(source, base = ACCOUNTING_DEFAULTS) {
  /** @type {Record<string, any>} */
  const fallback = { ...ACCOUNTING_DEFAULTS, ...base };
  /** @param {string} key @param {number} min */
  const num = (key, min) => Math.round(positiveNumber(source?.[key], fallback[key], min) * 10) / 10;
  /** @param {string} key */
  const count = key => {
    const value = Number(source?.[key]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Math.floor(Number(fallback[key]) || 0);
  };
  const heading = String(source?.accountingHeading ?? fallback.accountingHeading).replace(/^#{1,6}\s*/, "").trim();
  const mode = ["remind", "strict"].includes(source?.accountingMode) ? source.accountingMode
    : ["remind", "strict"].includes(fallback.accountingMode) ? fallback.accountingMode : "remind";
  return {
    accountingEnabled:typeof source?.accountingEnabled === "boolean" ? source.accountingEnabled : fallback.accountingEnabled === true,
    accountingMode:/** @type {"remind"|"strict"} */ (mode),
    accountingAwaySec:Math.round(num("accountingAwaySec", 10)),
    accountingNotifyAfterMin:num("accountingNotifyAfterMin", 0.1),
    accountingPromptAfterMin:num("accountingPromptAfterMin", 0.5),
    accountingPromptRepeatMin:num("accountingPromptRepeatMin", 0.5),
    accountingSnoozeMin:num("accountingSnoozeMin", 1),
    accountingSnoozeLimit:count("accountingSnoozeLimit"),
    accountingLeisureBudgetMin:count("accountingLeisureBudgetMin"),
    accountingHeading:heading || ACCOUNTING_DEFAULTS.accountingHeading,
    accountingPending:normalizePending(source?.accountingPending === undefined ? fallback.accountingPending : source.accountingPending)
  };
}

/** @param {unknown} value @returns {{requestedDayKey:string, patch:Record<string, any>} | null} */
function normalizePending(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = /** @type {Record<string, any>} */ (value);
  const requestedDayKey = String(source.requestedDayKey || "");
  const patch = Object.fromEntries(Object.entries(source.patch && typeof source.patch === "object" ? source.patch : {})
    .filter(([key]) => DEFERRABLE_KEYS.includes(key)));
  return requestedDayKey && Object.keys(patch).length ? { requestedDayKey, patch } : null;
}

/** @param {Record<string, any>} settings */
function isStrict(settings) {
  const config = normalizeAccountingSettings(settings);
  return config.accountingEnabled && config.accountingMode === "strict";
}

/**
 * 强制模式下把设置改动拆成“立即生效（收紧或无关）”和“次日生效（放宽）”。
 * @param {Record<string, any>} current 当前生效的设置
 * @param {Record<string, any>} patch 已规范化的新值
 * @param {string} dayKey 今天的逻辑日期
 * @returns {{immediate:Record<string, any>, pending:{requestedDayKey:string, patch:Record<string, any>} | null, deferredKeys:string[]}}
 */
function splitAccountingPatch(current, patch, dayKey) {
  const immediate = { ...patch };
  const previous = normalizePending(current.accountingPending);
  /** @type {Record<string, any>} */
  const pendingPatch = previous ? { ...previous.patch } : {};
  /** @type {string[]} */
  const deferredKeys = [];
  const strict = isStrict(current);
  for (const key of DEFERRABLE_KEYS) {
    if (!(key in patch)) continue;
    const before = current[key];
    const after = patch[key];
    const loosens = key === "accountingEnabled" ? before === true && after === false
      : key === "accountingMode" ? before === "strict" && after !== "strict"
        : Number(after) > Number(before);
    if (strict && loosens) {
      pendingPatch[key] = after;
      deferredKeys.push(key);
      delete immediate[key];
    } else {
      delete pendingPatch[key];
    }
  }
  const keys = Object.keys(pendingPatch);
  const pending = keys.length ? { requestedDayKey:deferredKeys.length || !previous ? dayKey : previous.requestedDayKey, patch:pendingPatch } : null;
  return { immediate:{ ...immediate, accountingPending:pending }, pending, deferredKeys };
}

/** 跨天后应用待生效的放宽设置。 @param {Record<string, any>} settings @param {string} dayKey */
function duePendingPatch(settings, dayKey) {
  const pending = normalizePending(settings.accountingPending);
  return pending && pending.requestedDayKey !== dayKey ? pending.patch : null;
}

/** @returns {AccountingStore} */
function createAccountingStore() {
  return { schemaVersion:STORE_SCHEMA_VERSION, dayKey:"", dailyPath:"", unaccountedMs:0, leisureMs:0,
    snoozeCount:0, snoozeUntilMs:0, summaryBucket:0, stretch:null, declaration:null, outbox:[] };
}

/** @param {unknown} value */
function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/** @param {unknown} value @returns {AccountingStore} */
function normalizeAccountingStore(value) {
  const store = createAccountingStore();
  if (!value || typeof value !== "object" || Array.isArray(value)) return store;
  const source = /** @type {Record<string, any>} */ (value);
  if (source.schemaVersion !== STORE_SCHEMA_VERSION) return store;
  store.dayKey = String(source.dayKey || "");
  store.dailyPath = String(source.dailyPath || "");
  for (const key of /** @type {const} */ (["unaccountedMs", "leisureMs", "snoozeCount", "snoozeUntilMs", "summaryBucket"])) store[key] = finite(source[key]);
  const stretch = source.stretch;
  if (stretch && finite(stretch.startedAtMs) > 0) {
    store.stretch = { startedAtMs:finite(stretch.startedAtMs), lastPresentAtMs:finite(stretch.lastPresentAtMs, stretch.startedAtMs), countedMs:finite(stretch.countedMs) };
  }
  const d = source.declaration;
  if (d && ["leisure", "errand"].includes(d.kind) && String(d.reason || "").trim() && finite(d.startedAtMs) > 0 && finite(d.plannedMs) > 0) {
    store.declaration = { id:String(d.id || d.startedAtMs), kind:d.kind, reason:String(d.reason).trim(), startedAtMs:finite(d.startedAtMs),
      plannedMs:finite(d.plannedMs), dayKey:String(d.dayKey || store.dayKey), dailyPath:String(d.dailyPath || store.dailyPath) };
  }
  store.outbox = Array.isArray(source.outbox) ? source.outbox.filter((/** @type {any} */ entry) => entry && typeof entry.path === "string" && entry.path
    && ((entry.kind === "line" && typeof entry.text === "string") || (entry.kind === "summary" && entry.values && typeof entry.values === "object"))).slice(-MAX_OUTBOX) : [];
  return store;
}

/** @param {Runtime} runtime @returns {{category:RuntimeCategory, reason:UnaccountedReason|null}} */
function classifyRuntime(runtime) {
  if (!runtime) return { category:"busy", reason:null };
  if (runtime.pendingSettlement || runtime.pendingBreakTransition
    || runtime.status === TIMER_STATUS.SETTLING || runtime.status === TIMER_STATUS.FAILED) return { category:"busy", reason:null };
  if (runtime.status === TIMER_STATUS.RUNNING) {
    const type = runtime.moduleRun?.type || (runtime.stage === "break" ? "rest" : "work");
    return { category:type === "rest" ? "rest" : "work", reason:null };
  }
  if (runtime.status === TIMER_STATUS.PAUSED) return { category:"unaccounted", reason:"paused" };
  if (runtime.attention) return { category:"unaccounted", reason:"awaiting" };
  if (runtime.status === TIMER_STATUS.IDLE) return { category:"unaccounted", reason:"idle" };
  return { category:"busy", reason:null };
}

/** @param {number} ms */
function clockText(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** @param {number} ms */
function minutesOf(ms) {
  return Math.max(0, Math.round(ms / 60_000));
}

/** @param {AccountingStore} store @param {string} path */
function summaryEntry(store, path) {
  return /** @type {OutboxEntry} */ ({ kind:"summary", path, values:{
    [SUMMARY_KEYS.unaccounted]:minutesOf(store.unaccountedMs),
    [SUMMARY_KEYS.leisure]:minutesOf(store.leisureMs),
    [SUMMARY_KEYS.snooze]:store.snoozeCount
  } });
}

/** 同一路径的汇总只保留最新一条。 @param {AccountingStore} store @param {OutboxEntry} entry */
function enqueue(store, entry) {
  const outbox = entry.kind === "summary"
    ? store.outbox.filter(item => !(item.kind === "summary" && item.path === entry.path))
    : [...store.outbox];
  outbox.push(entry);
  store.outbox = outbox.slice(-MAX_OUTBOX);
}

/** @param {AccountingStore} store @param {number} endAtMs */
function closeStretch(store, endAtMs) {
  const stretch = store.stretch;
  if (!stretch) return;
  store.stretch = null;
  // 离开时最后一段无输入的时间已经被计入，扣回来。
  const overCounted = Math.max(0, Math.min(stretch.countedMs, stretch.lastPresentAtMs - endAtMs));
  store.unaccountedMs = Math.max(0, store.unaccountedMs - overCounted);
  const countedMs = stretch.countedMs - overCounted;
  if (countedMs >= 60_000 && store.dailyPath) {
    enqueue(store, { kind:"line", path:store.dailyPath, text:`${clockText(stretch.startedAtMs)}–${clockText(Math.max(stretch.startedAtMs, endAtMs))} 未归属 ${minutesOf(countedMs)} 分钟` });
  }
  if (store.dailyPath) enqueue(store, summaryEntry(store, store.dailyPath));
}

/**
 * 结束声明并记账。超出消遣额度时在日记行中标记。
 * @param {AccountingStore} store @param {number} endAtMs @param {number} budgetMs
 * @returns {number} 实际时长
 */
function closeDeclaration(store, endAtMs, budgetMs) {
  const declaration = store.declaration;
  if (!declaration) return 0;
  store.declaration = null;
  const end = Math.min(Math.max(endAtMs, declaration.startedAtMs), declaration.startedAtMs + declaration.plannedMs);
  const actualMs = end - declaration.startedAtMs;
  const sameDay = declaration.dayKey === store.dayKey;
  let note = "";
  if (declaration.kind === "leisure" && sameDay) {
    const before = store.leisureMs;
    store.leisureMs += actualMs;
    const overMs = Math.min(actualMs, Math.max(0, store.leisureMs - budgetMs));
    if (overMs >= 30_000 || (before >= budgetMs && actualMs > 0)) note = `（超出额度 ${Math.max(1, minutesOf(overMs))} 分钟）`;
  }
  const path = declaration.dailyPath || store.dailyPath;
  if (path) {
    enqueue(store, { kind:"line", path, text:`${clockText(declaration.startedAtMs)}–${clockText(end)} ${KIND_LABEL[declaration.kind]} ${Math.max(1, minutesOf(actualMs))} 分钟：${declaration.reason}${note}` });
    if (sameDay) enqueue(store, summaryEntry(store, path));
  }
  return actualMs;
}

/**
 * 每次轮询推进一次记账。
 * @param {AccountingStore} previous
 * @param {{nowMs:number, dayKey:string, dailyPath:string, idleSec:number|null, category:RuntimeCategory, settings:Record<string, any>}} input
 * @returns {{store:AccountingStore, events:AccountingEvent[], present:boolean}}
 */
function advanceAccounting(previous, { nowMs, dayKey, dailyPath, idleSec, category, settings }) {
  const config = normalizeAccountingSettings(settings);
  const store = { ...previous, outbox:[...previous.outbox] };
  /** @type {AccountingEvent[]} */
  const events = [];
  const budgetMs = config.accountingLeisureBudgetMin * 60_000;

  if (store.dayKey !== dayKey) {
    if (store.dayKey) {
      if (store.stretch) closeStretch(store, store.stretch.lastPresentAtMs);
      if (store.dailyPath) enqueue(store, summaryEntry(store, store.dailyPath));
    }
    Object.assign(store, { dayKey, unaccountedMs:0, leisureMs:0, snoozeCount:0, snoozeUntilMs:0, summaryBucket:0, stretch:null });
  }
  store.dailyPath = dailyPath;

  if (store.declaration) {
    const declaration = store.declaration;
    const expired = nowMs >= declaration.startedAtMs + declaration.plannedMs;
    if (expired || category === "work" || category === "rest") {
      const actualMs = closeDeclaration(store, nowMs, budgetMs);
      events.push({ type:"declaration-ended", declaration, expired, actualMs });
    }
  }

  const present = idleSec !== null && Number.isFinite(idleSec) && idleSec < config.accountingAwaySec;
  const unaccounted = config.accountingEnabled && category === "unaccounted" && !store.declaration;
  const stretch = store.stretch;
  // 插件关闭或电脑睡眠造成的空档：在最后一次在场时结束上一段。
  if (stretch && nowMs - stretch.lastPresentAtMs > config.accountingAwaySec * 1000 + MAX_POLL_GAP_MS) closeStretch(store, stretch.lastPresentAtMs);

  if (unaccounted && present) {
    if (!store.stretch) store.stretch = { startedAtMs:nowMs, lastPresentAtMs:nowMs, countedMs:0 };
    else {
      const delta = Math.min(MAX_POLL_GAP_MS, Math.max(0, nowMs - store.stretch.lastPresentAtMs));
      store.stretch = { ...store.stretch, lastPresentAtMs:nowMs, countedMs:store.stretch.countedMs + delta };
      store.unaccountedMs += delta;
    }
  } else if (store.stretch) {
    closeStretch(store, present || idleSec === null ? nowMs : nowMs - idleSec * 1000);
  }

  const bucket = Math.floor(store.unaccountedMs / SUMMARY_BUCKET_MS);
  if (bucket !== store.summaryBucket) {
    store.summaryBucket = bucket;
    if (store.dailyPath) enqueue(store, summaryEntry(store, store.dailyPath));
  }
  return { store, events, present };
}

/** @param {AccountingStore} store @param {Record<string, any>} settings */
function snoozesLeft(store, settings) {
  return Math.max(0, normalizeAccountingSettings(settings).accountingSnoozeLimit - store.snoozeCount);
}

/**
 * @param {AccountingStore} previous @param {number} nowMs @param {Record<string, any>} settings
 * @returns {{ok:true, store:AccountingStore} | {ok:false, error:string}}
 */
function snoozeAccounting(previous, nowMs, settings) {
  const config = normalizeAccountingSettings(settings);
  if (snoozesLeft(previous, settings) <= 0) return { ok:false, error:`今天的 ${config.accountingSnoozeLimit} 次稍后提醒已用完` };
  const store = { ...previous, outbox:[...previous.outbox], snoozeCount:previous.snoozeCount + 1,
    snoozeUntilMs:nowMs + config.accountingSnoozeMin * 60_000 };
  if (store.dailyPath) {
    enqueue(store, { kind:"line", path:store.dailyPath, text:`${clockText(nowMs)} 稍后提醒（今日第 ${store.snoozeCount} 次）` });
    enqueue(store, summaryEntry(store, store.dailyPath));
  }
  return { ok:true, store };
}

/**
 * @param {AccountingStore} previous
 * @param {{kind:unknown, reason:unknown, minutes:unknown, nowMs:number, id?:string}} input
 * @param {Record<string, any>} settings
 * @returns {{ok:true, store:AccountingStore, overBudgetMin:number, cappedMin:number} | {ok:false, error:string}}
 */
function declareUntracked(previous, { kind, reason, minutes, nowMs, id }, settings) {
  if (kind !== "leisure" && kind !== "errand") return { ok:false, error:"请选择消遣或事务" };
  const text = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!text) return { ok:false, error:"请写下理由" };
  const plannedMin = Number(minutes);
  if (!Number.isFinite(plannedMin) || plannedMin <= 0) return { ok:false, error:"请填写时长（分钟）" };
  if (plannedMin > MAX_DECLARATION_MIN) return { ok:false, error:`单次声明最长 ${MAX_DECLARATION_MIN} 分钟` };
  if (previous.declaration) return { ok:false, error:"已有进行中的声明" };
  const config = normalizeAccountingSettings(settings);
  let plannedMs = Math.round(plannedMin * 60_000);
  const remainingMs = Math.max(0, config.accountingLeisureBudgetMin * 60_000 - previous.leisureMs);
  let cappedMin = 0;
  if (kind === "leisure" && isStrict(settings)) {
    if (remainingMs < 60_000) return { ok:false, error:"今日消遣额度已用完（强制模式）" };
    if (plannedMs > remainingMs) {
      plannedMs = Math.floor(remainingMs / 60_000) * 60_000;
      cappedMin = minutesOf(plannedMs);
    }
  }
  const overBudgetMin = kind === "leisure" ? minutesOf(Math.max(0, plannedMs - remainingMs)) : 0;
  const store = { ...previous, outbox:[...previous.outbox], snoozeUntilMs:0 };
  if (store.stretch) closeStretch(store, nowMs);
  store.declaration = { id:id || `declaration-${nowMs}`, kind, reason:text, startedAtMs:nowMs, plannedMs,
    dayKey:store.dayKey, dailyPath:store.dailyPath };
  return { ok:true, store, overBudgetMin, cappedMin };
}

/** 强制模式下长按 Esc 紧急退出选择屏：写一行日记。 @param {AccountingStore} previous @param {number} nowMs */
function logEmergencyExit(previous, nowMs) {
  const store = { ...previous, outbox:[...previous.outbox] };
  if (store.dailyPath) enqueue(store, { kind:"line", path:store.dailyPath, text:`${clockText(nowMs)} 紧急退出归属选择` });
  return store;
}

/** @param {AccountingStore} previous @param {number} nowMs @param {Record<string, any>} settings */
function endDeclaration(previous, nowMs, settings) {
  if (!previous.declaration) return { store:previous, actualMs:0 };
  const store = { ...previous, outbox:[...previous.outbox] };
  const actualMs = closeDeclaration(store, nowMs, normalizeAccountingSettings(settings).accountingLeisureBudgetMin * 60_000);
  return { store, actualMs };
}

/** @typedef {{stretchStartedAtMs:number|null,notified:boolean,lastPromptAtMs:number|null,promptWaitSinceMs:number|null}} LadderState */

/** @returns {LadderState} */
function createLadderState() {
  return { stretchStartedAtMs:null, notified:false, lastPromptAtMs:null, promptWaitSinceMs:null };
}


const TYPING_PAUSE_SEC = 2;
const MAX_PROMPT_WAIT_MS = 30_000;

/**
 * 提醒阶梯：L1 通知 → L2 全屏黑色选择屏，按间隔重复。选择屏出现前等用户停手，避免打字时抢焦点。
 * 选择屏显示期间不再升级；关闭或紧急退出时由调用方把 lastPromptAtMs 设为关闭时刻，从那时起算间隔。
 * @param {LadderState} previous
 * @param {{nowMs:number, stretch:Stretch|null, reason:UnaccountedReason|null, idleSec:number|null, snoozeUntilMs:number, promptOpen:boolean, settings:Record<string, any>}} input
 * @returns {{action:"none"|"notify"|"prompt"|"wait", state:LadderState}}
 */
function evaluateLadder(previous, { nowMs, stretch, reason, idleSec, snoozeUntilMs, promptOpen, settings }) {
  if (!stretch || !reason) return { action:"none", state:createLadderState() };
  const config = normalizeAccountingSettings(settings);
  const state = previous.stretchStartedAtMs === stretch.startedAtMs ? { ...previous } : { ...createLadderState(), stretchStartedAtMs:stretch.startedAtMs };
  if (nowMs < snoozeUntilMs || promptOpen) return { action:"none", state:{ ...state, promptWaitSinceMs:null } };
  const elapsedMs = nowMs - stretch.startedAtMs;
  if (elapsedMs >= config.accountingPromptAfterMin * 60_000
    && (state.lastPromptAtMs === null || nowMs - state.lastPromptAtMs >= config.accountingPromptRepeatMin * 60_000)) {
    const typing = idleSec !== null && idleSec < TYPING_PAUSE_SEC;
    const waitSince = state.promptWaitSinceMs ?? nowMs;
    if (typing && nowMs - waitSince < MAX_PROMPT_WAIT_MS) return { action:"wait", state:{ ...state, promptWaitSinceMs:waitSince } };
    return { action:"prompt", state:{ ...state, notified:true, lastPromptAtMs:nowMs, promptWaitSinceMs:null } };
  }
  if (!state.notified && reason !== "awaiting" && elapsedMs >= config.accountingNotifyAfterMin * 60_000) {
    return { action:"notify", state:{ ...state, notified:true } };
  }
  return { action:"none", state };
}

/** ioreg 输出中的 HIDIdleTime 单位是纳秒。 @param {unknown} output @returns {number | null} */
function parseHidIdleSeconds(output) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(output || ""));
  return match ? Number(match[1]) / 1e9 : null;
}

module.exports = {
  ACCOUNTING_DEFAULTS,
  DEFERRABLE_KEYS,
  SUMMARY_KEYS,
  KIND_LABEL,
  normalizeAccountingSettings,
  isStrict,
  splitAccountingPatch,
  duePendingPatch,
  createAccountingStore,
  normalizeAccountingStore,
  classifyRuntime,
  advanceAccounting,
  snoozesLeft,
  snoozeAccounting,
  declareUntracked,
  endDeclaration,
  logEmergencyExit,
  createLadderState,
  evaluateLadder,
  parseHidIdleSeconds,
  clockText
};
