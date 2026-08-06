const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeTFile, FakeVault } = require("./support.cjs");
const { DailyRepository, ProjectRepository } = require("../src/services/repositories.js");

function createRepository(vault, path = "Daily/today.md", allowCreateDaily = true) {
  return new DailyRepository({
    vault,
    fileManager: {
      async processFrontMatter(file, callback) {
        await callback(file.frontmatter);
      }
    },
    isFile: file => file instanceof FakeTFile,
    todayPath: () => path,
    allowCreateDaily: () => allowCreateDaily
  });
}

function createProjectRepository(vault, metadata = new Map()) {
  return new ProjectRepository({
    vault,
    fileManager: {
      async processFrontMatter(file, callback) {
        await callback(file.frontmatter);
      }
    },
    metadataCache: { getFileCache: file => metadata.get(file.path) || {} },
    isFile: file => file instanceof FakeTFile,
    readFrontmatter: async file => file.frontmatter
  });
}

test("DailyRepository 保留任务行、CRLF 和 frontmatter 汇总行为", async () => {
  const vault = new FakeVault({ "Daily/today.md": "- [ ] 写报告 0🍅\r\n" });
  const repository = createRepository(vault);
  const result = await repository.addTomatoAndSum({
    taskName: "写报告",
    amount: 0.2,
    settings: { allowAutoCreateTask: true, tasksHeading: "" },
    frontmatterKey: "番茄数"
  });

  assert.equal(result.sum, 0.2);
  assert.equal(result.frontmatterError, null);
  assert.equal(vault.getAbstractFileByPath("Daily/today.md").content, "- [ ] 写报告 0.2🍅\r\n");
  assert.equal(vault.getAbstractFileByPath("Daily/today.md").frontmatter["番茄数"], 0.2);
});

test("DailyRepository 可按设置创建当天文件并列出未完成任务", async () => {
  const vault = new FakeVault();
  const repository = createRepository(vault);
  const file = await repository.ensureTodayFile();
  file.content = "- [ ] A 0🍅\n- [x] B 1🍅\n  - [ ] C 2🍅\n";

  assert.equal(file.path, "Daily/today.md");
  assert.deepEqual(repository.listUncheckedTasksFromText(file.content), ["A", "C"]);
});

test("DailyRepository 只按规范 Markdown 路径创建目录和文件", async () => {
  const vault = new FakeVault();
  const folders = [];
  vault.createFolder = async path => { folders.push(path); };
  const repository = createRepository(vault, "Daily/2026/08/today.md");

  const file = await repository.ensureTodayFile();
  assert.equal(file.path, "Daily/2026/08/today.md");
  assert.deepEqual(folders, ["Daily", "Daily/2026", "Daily/2026/08"]);
  for (const path of ["../escape.md", "Daily\\today.md", "Daily//today.md", "Daily/today.txt"]) {
    await assert.rejects(() => repository.ensureFileAtPath(path), /路径/);
  }
});

test("ProjectRepository 筛选候选并幂等应用项目结算", async () => {
  const vault = new FakeVault({ "Projects/demo.md": "" });
  const project = vault.getAbstractFileByPath("Projects/demo.md");
  project.frontmatter = { "番茄数": 1 };
  const metadata = new Map([
    [project.path, { frontmatter: { tags: ["project"], "项目状态": "进行中", "番茄数": 1 } }]
  ]);
  const repository = createProjectRepository(vault, metadata);

  assert.deepEqual(repository.listCandidates({ tag: "#project", statusKey: "项目状态", statusWhitelist: "进行中" }), [
    { label: "demo — 进行中 (Projects/demo.md)", path: "Projects/demo.md" }
  ]);
  const plan = await repository.prepareSettlementPlan({ path: project.path, key: "番茄数", amount: 0.5, enabled: true });
  assert.deepEqual(plan, {
    path: "Projects/demo.md",
    key: "番茄数",
    amount: 0.5,
    beforeValue: 1,
    afterValue: 1.5,
    status: "pending"
  });

  assert.deepEqual(await repository.applyPlan(plan), { status: "applied" });
  assert.equal(project.frontmatter["番茄数"], 1.5);
  assert.deepEqual(await repository.applyPlan({ ...plan, status: "pending" }), { status: "applied" });
  assert.equal(project.frontmatter["番茄数"], 1.5);
});

test("ProjectRepository 外部修改时返回冲突，不覆盖项目 frontmatter", async () => {
  const vault = new FakeVault({ "Projects/demo.md": "" });
  const project = vault.getAbstractFileByPath("Projects/demo.md");
  project.frontmatter = { "番茄数": 1 };
  const repository = createProjectRepository(vault);
  const plan = await repository.prepareSettlementPlan({ path: project.path, key: "番茄数", amount: 1, enabled: true });
  project.frontmatter["番茄数"] = 9;

  const result = await repository.applyPlan(plan);
  assert.equal(result.status, "conflict");
  assert.equal(project.frontmatter["番茄数"], 9);
});

test("ProjectRepository 连续结算使用真实 frontmatter，不受 metadata cache 滞后影响", async () => {
  const vault = new FakeVault({ "Projects/demo.md": "" });
  const project = vault.getAbstractFileByPath("Projects/demo.md");
  project.frontmatter = { "番茄数": 1 };
  const metadata = new Map([[project.path, { frontmatter: { "番茄数": 1 } }]]);
  const repository = createProjectRepository(vault, metadata);

  const first = await repository.prepareSettlementPlan({ path: project.path, key: "番茄数", amount: 1, enabled: true });
  await repository.applyPlan(first);
  const second = await repository.prepareSettlementPlan({ path: project.path, key: "番茄数", amount: 1, enabled: true });
  await repository.applyPlan(second);

  assert.deepEqual([second.beforeValue, second.afterValue], [2, 3]);
  assert.equal(project.frontmatter["番茄数"], 3);
});

test("ProjectRepository 规范项目路径并拒绝非法输入", async () => {
  const vault = new FakeVault({ "Projects/demo.md": "" });
  const repository = createProjectRepository(vault);
  const plan = await repository.prepareSettlementPlan({ path:" Projects/demo.md ", key:"番茄数", amount:1, enabled:true });

  assert.equal(plan.path, "Projects/demo.md");
  for (const path of ["../demo.md", "Projects\\demo.md", "Projects//demo.md", "Projects/demo.txt"]) {
    await assert.rejects(() => repository.prepareSettlementPlan({ path, key:"番茄数", amount:1, enabled:true }), /路径/);
  }
});
