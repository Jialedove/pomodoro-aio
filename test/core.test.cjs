const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseHHMMToMinutes,
  positiveNumber,
  normalizeTag,
  formatTomatoNumber,
  isValidHHMM,
  normalizeMarkdownPath
} = require("../src/core/validation.js");
const {
  getTomatoSum,
  insertUnderHeading,
  planTaskLineMutation,
  applyTaskLineMutation,
  settlementConflict
} = require("../src/core/task-lines.js");

test("validation 纯函数拒绝非法时间并规范数值", () => {
  assert.equal(parseHHMMToMinutes("09:30"), 570);
  assert.equal(parseHHMMToMinutes("9:30"), null);
  assert.equal(parseHHMMToMinutes("24:00"), null);
  assert.equal(parseHHMMToMinutes("12:60"), null);
  assert.equal(isValidHHMM("00:00"), true);
  assert.equal(isValidHHMM("23:59"), true);
  assert.equal(isValidHHMM("24:00"), false);
  assert.equal(positiveNumber("-1", 25), 25);
  assert.equal(positiveNumber("1.5", 25), 1.5);
  assert.equal(normalizeTag(" project "), "#project");
  assert.equal(normalizeTag("#project"), "#project");
  assert.equal(formatTomatoNumber(1.25), "1.3");
});

test("Markdown Vault 路径拒绝非规范或非 Markdown 输入", () => {
  let normalizeCalls = 0;
  const normalizePath = value => { normalizeCalls += 1; return value; };

  assert.equal(normalizeMarkdownPath(" Daily/2026-08-06.md ", normalizePath), "Daily/2026-08-06.md");
  assert.equal(normalizeCalls, 1);
  for (const path of ["../escape.md", "Daily\\today.md", "Daily//today.md", "/Daily/today.md", "Daily/./today.md", "Daily/today.txt"]) {
    assert.throws(() => normalizeMarkdownPath(path, normalizePath), /路径/);
  }
});

test("task-lines 纯函数按完整任务名规划并应用变更", () => {
  const source = "- [x] A+B 1🍅\r\n  - [ ] A+B (测试) ✅ 2🍅\r\n- [ ] A+B extra 9🍅";
  const plan = planTaskLineMutation(source, "A+B (测试) ✅", 0.5, { allowAutoCreateTask: true, tasksHeading: "" });
  const result = applyTaskLineMutation(source, plan);

  assert.equal(plan.targetIndex, 1);
  assert.equal(result.text, "- [x] A+B 1🍅\r\n  - [ ] A+B (测试) ✅ 2.5🍅\r\n- [ ] A+B extra 9🍅");
  assert.equal(getTomatoSum(result.text), 12.5);
  assert.equal(applyTaskLineMutation(result.text, plan).alreadyApplied, true);
});

test("task-lines 插入保留标题和换行约定，并检测外部冲突", () => {
  const source = "# 任务\r\n";
  const inserted = insertUnderHeading(source, "# 任务", "- [ ] 新任务 0.2🍅", "\r\n");
  assert.equal(inserted, "# 任务\r\n\r\n- [ ] 新任务 0.2🍅\r\n");

  const plan = planTaskLineMutation(source, "新任务", 0.2, { allowAutoCreateTask: true, tasksHeading: "# 任务" });
  assert.throws(
    () => applyTaskLineMutation("# 任务\r\n外部修改\r\n", plan),
    error => error.code === "SETTLEMENT_CONFLICT"
  );
  assert.equal(settlementConflict("冲突").code, "SETTLEMENT_CONFLICT");
});
