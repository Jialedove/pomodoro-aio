const { formatTomatoNumber } = require("./validation");
/** @typedef {import("../../types/contracts").Settings} Settings */
/** @typedef {import("../../types/contracts").TaskMutationPlan} TaskMutationPlan */

/** @param {unknown} text */
function getTomatoSum(text) {
  const re = /^\s*-\s*\[[^\]]\]\s+.*?(\d+(?:\.\d+)?)\s*🍅\s*$/;
  let sum = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(re);
    if (match) sum += parseFloat(match[1]) || 0;
  }
  return Math.round(sum * 10) / 10;
}

/** @param {unknown} line */
function stripBaseName(line) {
  return String(line || "")
    .replace(/^\s*-\s*\[[^\]]\]\s*/, "")
    .replace(/\s*\d+(?:\.\d+)?🍅\s*$/, "")
    .trim();
}

/** @param {unknown} value */
function escapeReg(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} text @param {unknown} headingRaw @param {string} newLine @param {"\n" | "\r\n"} [eol] */
function insertUnderHeading(text, headingRaw, newLine, eol = "\n") {
  const heading = String(headingRaw || "").trim();
  if (!heading) return text.replace(/\s*$/, match => match.endsWith("\n") ? "" : eol) + newLine + eol;
  const label = heading.replace(/^#+\s*/, "");
  const re = new RegExp(`^\\s*#+\\s*${escapeReg(label)}\\s*$`, "m");
  const match = text.match(re);
  if (!match) {
    const block = `${eol}${heading.startsWith("#") ? heading : "## " + label}${eol}${newLine}${eol}`;
    return text.replace(/\s*$/, value => value.endsWith("\n") ? "" : eol) + block;
  }
  const index = (match.index ?? 0) + match[0].length;
  return text.slice(0, index) + eol + newLine + eol + text.slice(index);
}

/** @param {unknown} text */
function textHash(text) {
  let hash = 2166136261;
  for (const char of String(text || "")) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** @param {string} message */
function settlementConflict(message) {
  /** @type {Error & { code?: string }} */
  const error = new Error(message);
  error.code = "SETTLEMENT_CONFLICT";
  return error;
}

/** @param {unknown} text @param {unknown} taskName @param {number} amount @param {Pick<Settings, "allowAutoCreateTask" | "tasksHeading">} settings @returns {TaskMutationPlan} */
function planTaskLineMutation(text, taskName, amount, settings) {
  const source = String(text || "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const cleanTaskName = String(taskName || "").trim();
  if (!cleanTaskName) throw new Error("任务名为空");
  const want = cleanTaskName.toLowerCase();
  let uncheckedIndex = -1;
  let anyIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*-\s*\[[^\]]\]\s+/.test(line)) continue;
    if (stripBaseName(line).toLowerCase() !== want) continue;
    if (/^\s*-\s*\[\s\]/.test(line) && uncheckedIndex === -1) uncheckedIndex = i;
    if (anyIndex === -1) anyIndex = i;
  }
  const hit = uncheckedIndex !== -1 ? uncheckedIndex : anyIndex;
  if (hit !== -1) {
    const lineBefore = lines[hit];
    const oldAmount = parseFloat(lineBefore.match(/(\d+(?:\.\d+)?)\s*🍅\s*$/)?.[1] || "0") || 0;
    const prefix = lineBefore.match(/^\s*-\s*\[[^\]]\]\s*/)?.[0] || "- [ ] ";
    const base = stripBaseName(lineBefore);
    const lineAfter = `${prefix}${base} ${formatTomatoNumber(oldAmount + amount)}🍅`;
    const afterLines = lines.slice();
    afterLines[hit] = lineAfter;
    return {
      kind: "line",
      targetIndex: hit,
      lineBefore,
      lineAfter,
      beforeHash: textHash(source),
      expectedSum: getTomatoSum(afterLines.join(eol)),
      eol
    };
  }
  if (!settings.allowAutoCreateTask) throw new Error("未找到同名任务，且未开启自动创建");
  const lineAfter = `- [ ] ${cleanTaskName} ${formatTomatoNumber(amount)}🍅`;
  const afterText = insertUnderHeading(source, settings.tasksHeading, lineAfter, eol);
  return {
    kind: "insert",
    targetIndex: null,
    lineBefore: null,
    lineAfter,
    heading: settings.tasksHeading,
    beforeHash: textHash(source),
    expectedSum: getTomatoSum(afterText),
    eol
  };
}

/** @param {unknown} text @param {TaskMutationPlan} plan */
function applyTaskLineMutation(text, plan) {
  const source = String(text || "");
  const eol = plan.eol || (source.includes("\r\n") ? "\r\n" : "\n");
  const lines = source.split(/\r?\n/);
  if (plan.kind === "insert") {
    if (lines.includes(plan.lineAfter)) return { text: source, alreadyApplied: true };
    if (textHash(source) !== plan.beforeHash) throw settlementConflict("任务插入前的日记内容已发生变化");
    return { text: insertUnderHeading(source, plan.heading, plan.lineAfter, eol), alreadyApplied: false };
  }
  const index = typeof plan.targetIndex === "number" && Number.isInteger(plan.targetIndex) ? plan.targetIndex : -1;
  if (lines[index] === plan.lineAfter) return { text: source, alreadyApplied: true };
  if (lines[index] === plan.lineBefore) {
    lines[index] = plan.lineAfter;
    return { text: lines.join(eol), alreadyApplied: false };
  }
  if (lines.includes(plan.lineAfter)) return { text: source, alreadyApplied: true };
  const fallbackIndex = plan.lineBefore === null ? -1 : lines.indexOf(plan.lineBefore);
  if (fallbackIndex !== -1) {
    lines[fallbackIndex] = plan.lineAfter;
    return { text: lines.join(eol), alreadyApplied: false };
  }
  throw settlementConflict("目标任务行已被外部修改，无法安全重试");
}

module.exports = {
  getTomatoSum,
  stripBaseName,
  insertUnderHeading,
  textHash,
  settlementConflict,
  planTaskLineMutation,
  applyTaskLineMutation
};
