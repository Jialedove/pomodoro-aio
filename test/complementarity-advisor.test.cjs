const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ComplementarityAdvisor,
  HeterogeneityAdvisorError,
  normalizeConfig,
  parseAssessment
} = require("../src/services/complementarity-advisor.js");

test("异质性顾问只发送用户选中的两件事并解析结构化判断", async () => {
  const requests = [];
  const advisor = new ComplementarityAdvisor({
    requestUrl: async options => {
      requests.push(options);
      return {
        status: 200,
        json: {
          choices: [{ message: { content: '{"verdict":"heterogeneous","reason":"一个偏高强度屏幕写作，另一个偏离屏整理。"}' } }]
        }
      };
    }
  });

  const result = await advisor.assess({
    endpoint: "https://example.test/v1/chat/completions",
    model: "test-model",
    apiKey: " secret "
  }, "撰写研究报告", "整理房间");

  assert.deepEqual(result, { verdict: "heterogeneous", reason: "一个偏高强度屏幕写作，另一个偏离屏整理。" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.test/v1/chat/completions");
  assert.equal(requests[0].headers.Authorization, "Bearer secret");
  const body = JSON.parse(requests[0].body);
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.messages.at(-1), {
    role: "user",
    content: '{"taskA":"撰写研究报告","taskB":"整理房间"}'
  });
});

test("异质性顾问拒绝无效配置和不可识别的模型输出", async () => {
  assert.throws(
    () => normalizeConfig({ endpoint: "file:///private/data", model: "model" }),
    HeterogeneityAdvisorError
  );
  assert.throws(() => parseAssessment('{"verdict":"maybe"}'), HeterogeneityAdvisorError);

  const advisor = new ComplementarityAdvisor({
    requestUrl: async () => ({ status: 401, json: { error: { message: "bad key" } } })
  });
  await assert.rejects(
    advisor.assess({ endpoint: "https://example.test/v1/chat/completions", model: "model", apiKey: "bad" }, "A", "B"),
    /AI 服务未返回成功结果/
  );
});
