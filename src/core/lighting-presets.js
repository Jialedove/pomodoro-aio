// Ready-made light programs and plain-language summaries for the settings page.
// Templates are only added to the DeviceBridge library when the user asks; base
// state steps use progress or fixed offsets so they stay valid for any task length.
/** @typedef {import("../../types/contracts").LightProgram} LightProgram */
/** @typedef {import("../../types/contracts").LightStep} LightStep */
/** @typedef {import("../../types/contracts").LightTarget} LightTarget */

/** @param {string} id @param {LightStep["trigger"]} trigger @param {LightTarget} target @param {number} [transitionMs] @returns {LightStep} */
function stateStep(id, trigger, target, transitionMs=0) {
  return { id, trigger, action:"state", target, transitionMs, repeatCount:1, cueDurationMs:2000 };
}
/** @param {string} id @param {LightStep["trigger"]} trigger @param {LightStep["action"]} action @param {number} repeatCount @param {number} [cueDurationMs] @returns {LightStep} */
function cueStep(id, trigger, action, repeatCount, cueDurationMs=2000) {
  return { id, trigger, action, transitionMs:0, repeatCount, cueDurationMs };
}

/** @type {{program:LightProgram, use:"work"|"rest", description:string}[]} */
const LIGHT_PROGRAM_TEMPLATES = [
  { use:"work", description:"开始时柔和，1 分钟内提亮到专注光；结束前 1 分钟轻微明暗提示两次。", program:{ id:"preset-focus-ramp", name:"专注渐入", revision:1, steps:[
    stateStep("start", { kind:"elapsed", value:0 }, { power:true, brightnessPct:50, colorTempKelvin:3800 }),
    stateStep("ramp", { kind:"elapsed", value:10 }, { power:true, brightnessPct:90, colorTempKelvin:4800 }, 60_000),
    cueStep("ending", { kind:"remaining", value:60 }, "pulse", 2)
  ] } },
  { use:"work", description:"冷白高亮，适合需要清醒的任务；剩 5 分钟轻提示，剩 1 分钟暖光提醒。", program:{ id:"preset-deep-focus", name:"深度专注", revision:1, steps:[
    stateStep("start", { kind:"elapsed", value:0 }, { power:true, brightnessPct:100, colorTempKelvin:5000 }),
    cueStep("five-left", { kind:"remaining", value:300 }, "pulse", 1),
    cueStep("one-left", { kind:"remaining", value:60 }, "warning", 1, 3000)
  ] } },
  { use:"work", description:"中等亮度暖白光，适合晚上工作，减少刺眼感；结束前 1 分钟轻提示。", program:{ id:"preset-evening-work", name:"夜间柔光", revision:1, steps:[
    stateStep("start", { kind:"elapsed", value:0 }, { power:true, brightnessPct:65, colorTempKelvin:3300 }),
    cueStep("ending", { kind:"remaining", value:60 }, "pulse", 2)
  ] } },
  { use:"work", description:"当天最后一段使用：从中性光在后半程 10 分钟内渐变到低亮暖光。", program:{ id:"preset-wind-down", name:"收尾渐暗", revision:1, steps:[
    stateStep("start", { kind:"elapsed", value:0 }, { power:true, brightnessPct:70, colorTempKelvin:4000 }),
    stateStep("dim", { kind:"progress", value:50 }, { power:true, brightnessPct:35, colorTempKelvin:2700 }, 600_000)
  ] } },
  { use:"rest", description:"先调成低亮暖光放松；进度 80% 后 1 分钟内恢复亮度，准备回到工作。", program:{ id:"preset-rest-relax", name:"放松休息", revision:1, steps:[
    stateStep("start", { kind:"elapsed", value:0 }, { power:true, brightnessPct:30, colorTempKelvin:2700 }),
    stateStep("wake", { kind:"progress", value:80 }, { power:true, brightnessPct:75, colorTempKelvin:4200 }, 60_000)
  ] } },
  { use:"rest", description:"关灯让眼睛休息，结束前 30 秒用柔和暖光唤醒。", program:{ id:"preset-eyes-closed", name:"闭眼休息", revision:1, steps:[
    stateStep("start", { kind:"elapsed", value:0 }, { power:false }),
    stateStep("wake", { kind:"remaining", value:30 }, { power:true, brightnessPct:40, colorTempKelvin:3000 })
  ] } }
];

/** @param {number} seconds */
function formatSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60), rest = total % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/** @param {LightStep["trigger"]} trigger */
function describeLightTrigger(trigger) {
  if (trigger.kind === "progress") return trigger.value === 0 ? "开始时" : `进度 ${trigger.value}%`;
  if (trigger.kind === "remaining") return trigger.value === 0 ? "结束时" : `剩余 ${formatSeconds(trigger.value)}`;
  return trigger.value === 0 ? "开始时" : `开始后 ${formatSeconds(trigger.value)}`;
}

/** @param {LightStep} step */
function describeLightAction(step) {
  const times = step.repeatCount > 1 ? ` ×${step.repeatCount}` : "";
  if (step.action === "pulse") return `轻微明暗提示${times}`;
  if (step.action === "blink") return `开关闪烁提示${times}`;
  if (step.action === "warning") return `暖光提醒${times}`;
  if (step.action === "finished") return `完成提示${times}`;
  const target = step.target;
  if (!target || !target.power) return "关灯";
  const parts = target.effect ? [`效果「${target.effect}」`]
    : [target.brightnessPct != null ? `亮度 ${target.brightnessPct}%` : "", target.colorTempKelvin != null ? `${target.colorTempKelvin}K` : ""].filter(Boolean);
  const transition = step.transitionMs > 0 && !target.effect ? `，${formatSeconds(step.transitionMs / 1000)}内渐变` : "";
  return `开灯${parts.length ? ` ${parts.join(" · ")}` : ""}${transition}`;
}

/** @param {LightStep} step */
function describeLightStep(step) { return `${describeLightTrigger(step.trigger)}：${describeLightAction(step)}`; }

/** @param {LightProgram} program @returns {string[]} */
function describeLightProgram(program) { return program.steps.map(describeLightStep); }

/** Approximate lamp colour for a swatch; off shows as empty. @param {LightTarget | undefined} target */
function lightSwatchColor(target) {
  if (!target || !target.power) return "";
  const kelvin = Math.min(6500, Math.max(2700, target.colorTempKelvin ?? 4000));
  const warmth = (6500 - kelvin) / 3800;
  const alpha = 0.35 + 0.65 * Math.min(100, Math.max(1, target.brightnessPct ?? 80)) / 100;
  const g = Math.round(244 - 60 * warmth), b = Math.round(255 - 165 * warmth);
  return `rgba(255, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

module.exports = { LIGHT_PROGRAM_TEMPLATES, formatSeconds, describeLightTrigger, describeLightAction, describeLightStep, describeLightProgram, lightSwatchColor };
