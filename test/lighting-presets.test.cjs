const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLightProgram, DEFAULT_LIGHT_PROGRAMS } = require("../src/core/lighting.js");
const { LIGHT_PROGRAM_TEMPLATES, describeLightStep, formatSeconds, lightSwatchColor } = require("../src/core/lighting-presets.js");

// Mirrors DeviceBridge LightProgram.validate(durationMs:) for base state steps.
function stateTimesValid(program, durationMs) {
  const at = step => step.trigger.kind === "progress" ? durationMs * step.trigger.value / 100
    : step.trigger.kind === "remaining" ? Math.max(0, durationMs - step.trigger.value * 1000) : step.trigger.value * 1000;
  const states = program.steps.filter(step => step.action === "state").sort((a, b) => at(a) - at(b));
  const seen = new Set();
  let previousEnd = 0;
  for (const step of states) {
    const time = at(step);
    if (seen.has(time) || time < previousEnd) return false;
    seen.add(time);
    previousEnd = time + step.transitionMs;
  }
  return true;
}

test("常用方案均可通过校验，标识唯一且不与内置默认方案冲突", () => {
  const ids = new Set(DEFAULT_LIGHT_PROGRAMS.map(program => program.id));
  for (const { program, use, description } of LIGHT_PROGRAM_TEMPLATES) {
    assert.deepEqual(normalizeLightProgram(program), program);
    assert.ok(!ids.has(program.id), program.id);
    ids.add(program.id);
    assert.ok(["work", "rest"].includes(use));
    assert.ok(description.length > 0);
  }
  assert.ok(LIGHT_PROGRAM_TEMPLATES.length >= 5);
});

test("常用方案在 1–180 分钟任务中都不会出现重叠或同时刻的基础灯光", () => {
  for (const { program } of LIGHT_PROGRAM_TEMPLATES) {
    for (const minutes of [1, 2, 5, 10, 15, 25, 45, 50, 90, 180]) {
      assert.ok(stateTimesValid(program, minutes * 60_000), `${program.name} @ ${minutes}min`);
    }
  }
});

test("步骤摘要用自然语言描述触发时间和动作", () => {
  const [focus] = LIGHT_PROGRAM_TEMPLATES;
  assert.deepEqual(focus.program.steps.map(describeLightStep), [
    "开始时：开灯 亮度 50% · 3800K",
    "开始后 10 秒：开灯 亮度 90% · 4800K，1 分钟内渐变",
    "剩余 1 分钟：轻微明暗提示 ×2"
  ]);
  assert.equal(describeLightStep({ id:"a", trigger:{ kind:"progress", value:80 }, action:"state", target:{ power:false }, transitionMs:0, repeatCount:1, cueDurationMs:2000 }), "进度 80%：关灯");
  assert.equal(formatSeconds(90), "1 分 30 秒");
  assert.equal(lightSwatchColor({ power:false }), "");
  assert.match(lightSwatchColor({ power:true, brightnessPct:100, colorTempKelvin:6500 }), /^rgba\(255, 244, 255, 1\.00\)$/);
});
