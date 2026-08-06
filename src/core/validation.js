/** @param {unknown} hhmm @returns {number | null} */
function parseHHMMToMinutes(hhmm) {
  const m = String(hhmm || "").trim().match(/^(\d{2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

/** @param {unknown} value @param {number} fallback @param {number} [min] */
function positiveNumber(value, fallback, min = 0.1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(min, number) : fallback;
}

/** @param {unknown} tag */
function normalizeTag(tag) {
  const value = String(tag || "").trim();
  if (!value) return "";
  return value.startsWith("#") ? value : `#${value}`;
}

/** @param {unknown} value */
function formatTomatoNumber(value) {
  const number = Number(value) || 0;
  const rounded = Math.round(number * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** @param {unknown} value */
function isValidHHMM(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

/** @param {unknown} value */
function normalizeTomatoValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 10) / 10 : 0;
}

/** @param {unknown} value @param {(path: string) => string} pathNormalizer */
function normalizeMarkdownPath(value, pathNormalizer) {
  const raw = String(value || "").trim();
  const parts = raw.split("/");
  if (!raw || raw.includes("\\") || parts.some(part => !part || part === "." || part === "..")) {
    throw new Error("Markdown 路径非法");
  }
  const normalized = pathNormalizer(raw);
  if (!normalized || !/\.md$/i.test(normalized)) throw new Error("路径必须指向 Markdown 文件");
  return normalized;
}

module.exports = {
  parseHHMMToMinutes,
  positiveNumber,
  normalizeTag,
  formatTomatoNumber,
  isValidHHMM,
  normalizeTomatoValue,
  normalizeMarkdownPath
};
