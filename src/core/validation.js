function parseHHMMToMinutes(hhmm) {
  const m = String(hhmm || "").trim().match(/^(\d{2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

function positiveNumber(value, fallback, min = 0.1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(min, number) : fallback;
}

function normalizeTag(tag) {
  const value = String(tag || "").trim();
  if (!value) return "";
  return value.startsWith("#") ? value : `#${value}`;
}

function formatTomatoNumber(value) {
  const number = Number(value) || 0;
  const rounded = Math.round(number * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function isValidHHMM(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function normalizeTomatoValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 10) / 10 : 0;
}

module.exports = {
  parseHHMMToMinutes,
  positiveNumber,
  normalizeTag,
  formatTomatoNumber,
  isValidHHMM,
  normalizeTomatoValue
};
