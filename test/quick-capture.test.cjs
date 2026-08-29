const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appendCaptureToHeading,
  buildCaptureLine,
  normalizeCaptureHeading,
  normalizeCaptureText
} = require("../src/core/quick-capture.js");

test("快速记录规范单行内容、标题和记录类型", () => {
  assert.equal(normalizeCaptureText("  查询机票\n  比较价格  "), "查询机票 比较价格");
  assert.equal(normalizeCaptureHeading("## 收集箱"), "收集箱");
  assert.equal(normalizeCaptureHeading(""), "Inbox");
  assert.equal(buildCaptureLine("查询机票", "todo"), "- [ ] 查询机票");
  assert.equal(buildCaptureLine("文章灵感", "idea"), "- 文章灵感");
  assert.throws(() => buildCaptureLine("   ", "todo"), /内容为空/);
});

test("快速记录在缺少区域时创建 Inbox 并保留 frontmatter", () => {
  const source = "---\ntitle: 今天\n---\n\n# 日记\n";
  const result = appendCaptureToHeading(source, { text:"查询机票", kind:"todo", heading:"Inbox" });

  assert.equal(result.createdHeading, true);
  assert.equal(result.text, "---\ntitle: 今天\n---\n\n# 日记\n\n## Inbox\n\n- [ ] 查询机票\n");
});

test("快速记录追加到已有区域末尾且不越过后续标题", () => {
  const source = "# 日记\n\n## Inbox\n\n- 已有想法\n\n## 总结\n正文\n";
  const result = appendCaptureToHeading(source, { text:"新的想法", kind:"idea", heading:"Inbox" });

  assert.equal(result.createdHeading, false);
  assert.equal(result.text, "# 日记\n\n## Inbox\n\n- 已有想法\n- 新的想法\n\n## 总结\n正文\n");
});

test("快速记录保留 CRLF 并连续追加", () => {
  const first = appendCaptureToHeading("## Inbox\r\n", { text:"A", kind:"todo" });
  const second = appendCaptureToHeading(first.text, { text:"B", kind:"idea" });

  assert.equal(second.text, "## Inbox\r\n\r\n- [ ] A\r\n- B\r\n");
});
