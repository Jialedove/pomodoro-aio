const {
  getTomatoSum,
  stripBaseName,
  planTaskLineMutation,
  applyTaskLineMutation,
  settlementConflict
} = require("../core/task-lines");
const { normalizeTag, normalizeTomatoValue } = require("../core/validation");

class DailyRepository {
  constructor({ vault, fileManager, isFile, todayPath, allowCreateDaily }) {
    this.vault = vault;
    this.fileManager = fileManager;
    this._isFile = isFile;
    this._todayPath = todayPath;
    this._allowCreateDaily = allowCreateDaily;
  }

  getFile(path) {
    return this.vault.getAbstractFileByPath(path);
  }

  isFile(file) {
    return !!file && this._isFile(file);
  }

  async ensureTodayFile() {
    const path = this._todayPath();
    let file = this.getFile(path);
    if (!file) {
      if (!this._allowCreateDaily()) throw new Error("找不到当天文件，且未开启自动创建");
      const parts = path.split("/");
      if (parts.length > 1) {
        let accumulated = "";
        for (let i = 0; i < parts.length - 1; i++) {
          accumulated = accumulated ? `${accumulated}/${parts[i]}` : parts[i];
          try {
            await this.vault.createFolder(accumulated);
          } catch (error) {
            if (!this.vault.getAbstractFileByPath(accumulated)) throw error;
          }
        }
      }
      file = await this.vault.create(path, "");
    }
    if (!this.isFile(file)) throw new Error("目标不是文件");
    return file;
  }

  async read(file) {
    return this.vault.read(file);
  }

  async readPath(path) {
    const file = this.getFile(path);
    return {
      file,
      text: this.isFile(file) ? await this.read(file) : ""
    };
  }

  async readToday() {
    const file = await this.ensureTodayFile();
    return { file, text: await this.read(file) };
  }

  async process(file, callback) {
    if (typeof this.vault.process !== "function") throw new Error("当前 Obsidian 不支持原子日记处理");
    return this.vault.process(file, callback);
  }

  async processFrontMatter(file, callback) {
    return this.fileManager.processFrontMatter(file, callback);
  }

  listUncheckedTasksFromText(text) {
    const lines = String(text || "").split(/\r?\n/);
    const names = new Set();
    for (const line of lines) {
      if (!/^\s*-\s*\[\s\]\s+/.test(line)) continue;
      const base = stripBaseName(line);
      if (base) names.add(base);
    }
    return Array.from(names);
  }

  async addTomatoAndSum({ taskName, amount = 1, settings, frontmatterKey }) {
    const cleanTaskName = String(taskName || "").trim();
    if (!cleanTaskName) throw new Error("任务名为空");
    const add = Math.max(0, Number(amount) || 0);
    const file = await this.ensureTodayFile();
    let text = await this.read(file);
    if (add) {
      await this.process(file, current => {
        const plan = planTaskLineMutation(current, cleanTaskName, add, settings);
        const result = applyTaskLineMutation(current, plan);
        text = result.text;
        return result.text;
      });
    }
    const sum = getTomatoSum(text);
    let frontmatterError = null;
    try {
      await this.processFrontMatter(file, frontmatter => {
        frontmatter[frontmatterKey || "番茄数"] = sum;
      });
    } catch (error) {
      frontmatterError = error;
    }
    return { file, text, sum, frontmatterError };
  }

  async applyPlannedMutation(file, plan) {
    let mutation = null;
    await this.process(file, current => {
      mutation = applyTaskLineMutation(current, plan);
      return mutation.text;
    });
    return {
      text: mutation?.text || await this.read(file),
      alreadyApplied: !!mutation?.alreadyApplied
    };
  }
}

class ProjectRepository {
  constructor({ vault, fileManager, metadataCache, isFile }) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.metadataCache = metadataCache;
    this._isFile = isFile;
  }

  getFile(path) {
    return this.vault.getAbstractFileByPath(path);
  }

  isFile(file) {
    return !!file && this._isFile(file);
  }

  async processFrontMatter(file, callback) {
    return this.fileManager.processFrontMatter(file, callback);
  }

  prepareSettlementPlan({ path, key, amount, enabled }) {
    const projectPath = String(path || "").trim();
    const frontmatterKey = key || "番茄数";
    if (!enabled || !projectPath) return { path: projectPath, key: frontmatterKey, status: "skipped", amount };
    const file = this.getFile(projectPath);
    if (!this.isFile(file)) return { path: projectPath, key: frontmatterKey, status: "missing", amount, deferred: true };
    const cache = this.metadataCache?.getFileCache?.(file) || {};
    const frontmatter = cache.frontmatter || file.frontmatter || {};
    const beforeValue = normalizeTomatoValue(frontmatter[frontmatterKey]);
    return {
      path: projectPath,
      key: frontmatterKey,
      amount,
      beforeValue,
      afterValue: normalizeTomatoValue(beforeValue + amount),
      status: "pending"
    };
  }

  async applyPlan(plan) {
    if (!plan || plan.status === "applied" || plan.status === "skipped") return { status: plan?.status || "skipped" };
    const file = this.getFile(plan.path);
    if (!this.isFile(file)) return { status: "missing", error: "项目文件不存在" };
    try {
      await this.processFrontMatter(file, frontmatter => {
        const currentValue = normalizeTomatoValue(frontmatter[plan.key]);
        if (plan.deferred && plan.beforeValue === undefined) {
          plan.beforeValue = currentValue;
          plan.afterValue = normalizeTomatoValue(currentValue + plan.amount);
          plan.deferred = false;
          frontmatter[plan.key] = plan.afterValue;
          return;
        }
        if (currentValue === normalizeTomatoValue(plan.afterValue)) return;
        if (currentValue !== normalizeTomatoValue(plan.beforeValue)) throw settlementConflict("项目 frontmatter 已被外部修改");
        frontmatter[plan.key] = normalizeTomatoValue(plan.afterValue);
      });
      return { status: "applied" };
    } catch (error) {
      return {
        status: error?.code === "SETTLEMENT_CONFLICT" ? "conflict" : "pending",
        error: String(error?.message || error)
      };
    }
  }

  listCandidates({ tag, statusKey, statusWhitelist }) {
    const tagWant = normalizeTag(tag || "#project");
    const whitelist = new Set(String(statusWhitelist || "进行中,筹划中").split(",").map(value => value.trim()).filter(Boolean));
    const result = [];
    for (const file of this.vault.getMarkdownFiles()) {
      const cache = this.metadataCache.getFileCache(file) || {};
      const frontmatter = cache.frontmatter || {};
      const tags = new Set();
      const frontmatterTags = frontmatter.tags;
      if (Array.isArray(frontmatterTags)) frontmatterTags.forEach(value => tags.add(normalizeTag(value)));
      else if (typeof frontmatterTags === "string") frontmatterTags.split(/[,\s]+/).forEach(value => value && tags.add(normalizeTag(value)));
      (cache.tags || []).forEach(entry => entry?.tag && tags.add(entry.tag));
      if (!tags.has(tagWant)) continue;
      const status = String(frontmatter[statusKey || "项目状态"] || "").trim();
      if (!whitelist.has(status)) continue;
      result.push({ label: `${file.basename} — ${status} (${file.path})`, path: file.path });
    }
    return result;
  }

  async bumpTomato({ path, key, amount = 1 }) {
    const add = Math.max(0, Number(amount) || 0);
    if (!add) return;
    const file = this.getFile(String(path || "").trim());
    if (!this.isFile(file)) return;
    await this.processFrontMatter(file, frontmatter => {
      const field = key || "番茄数";
      frontmatter[field] = normalizeTomatoValue(normalizeTomatoValue(frontmatter[field]) + add);
    });
  }
}

module.exports = { DailyRepository, ProjectRepository };
