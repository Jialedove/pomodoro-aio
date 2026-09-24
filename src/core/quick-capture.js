/** @typedef {"todo" | "idea"} CaptureKind */

/** @param {unknown} value */
function normalizeCaptureText(value) {
  return String(value || "").replace(/\s*\r?\n\s*/g, " ").replace(/[\t ]+/g, " ").trim();
}

/** @param {unknown} value */
function normalizeCaptureHeading(value) {
  const heading = normalizeCaptureText(value).replace(/^#{1,6}\s*/, "").trim();
  return heading || "Inbox";
}

/** @param {unknown} text @param {CaptureKind} kind */
function buildCaptureLine(text, kind) {
  const content = normalizeCaptureText(text);
  if (!content) throw new Error("记录内容为空");
  return kind === "idea" ? `- ${content}` : `- [ ] ${content}`;
}

/**
 * Append one capture to an existing Markdown section while preserving its EOL style.
 * The configured section is created as a level-two heading when absent.
 * @param {unknown} source
 * @param {{heading?:unknown, kind?:CaptureKind, text:unknown}} input
 */
function appendCaptureToHeading(source, input) {
  const original = String(source || "");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const heading = normalizeCaptureHeading(input?.heading);
  const line = buildCaptureLine(input?.text, input?.kind === "idea" ? "idea" : "todo");
  const hadTrailingEol = original.endsWith("\n");
  const lines = original ? original.split(/\r?\n/) : [];
  if (hadTrailingEol) lines.pop();

  let headingIndex = -1;
  let headingLevel = 2;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})[\t ]+(.+?)[\t ]*$/);
    if (match && match[2].trim() === heading) {
      headingIndex = index;
      headingLevel = match[1].length;
      break;
    }
  }

  if (headingIndex === -1) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push("");
    lines.push(`## ${heading}`, "", line);
    return { text:`${lines.join(eol)}${eol}`, heading, line, createdHeading:true };
  }

  let sectionEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})[\t ]+/);
    if (match && match[1].length <= headingLevel) {
      sectionEnd = index;
      break;
    }
  }
  const body = lines.slice(headingIndex + 1, sectionEnd);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  body.push(line);
  const replacement = ["", ...body];
  if (sectionEnd < lines.length) replacement.push("");
  lines.splice(headingIndex + 1, sectionEnd - headingIndex - 1, ...replacement);
  return { text:`${lines.join(eol)}${hadTrailingEol || lines.length ? eol : ""}`, heading, line, createdHeading:false };
}

module.exports = {
  appendCaptureToHeading,
  buildCaptureLine,
  normalizeCaptureHeading,
  normalizeCaptureText
};
