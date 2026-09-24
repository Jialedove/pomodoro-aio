const {
  getTomatoSum,
  stripBaseName,
  planTaskLineCompletion,
  planTaskLineMutation,
  applyTaskLineMutation,
  settlementConflict
} = require("../core/task-lines");
const { normalizePath } = require("obsidian");
const { normalizeTag, normalizeTomatoValue, normalizeMarkdownPath } = require("../core/validation");
const { appendCaptureToHeading } = require("../core/quick-capture");
/** @typedef {import("../../types/contracts").Settings} Settings */
/** @typedef {import("../../types/contracts").TaskMutationPlan} TaskMutationPlan */
/** @typedef {import("../../types/contracts").ProjectSettlementPlan} ProjectSettlementPlan */
/** @typedef {Record<string, any>} ObsidianRecord */

class DailyRepository {
  /** @param {{vault:ObsidianRecord, fileManager:ObsidianRecord, isFile:(file:unknown)=>boolean, todayPath:()=>string, allowCreateDaily:()=>boolean}} options */
  constructor({ vault, fileManager, isFile, todayPath, allowCreateDaily }) {
    this.vault = vault;
    this.fileManager = fileManager;
    this._isFile = isFile;
    this._todayPath = todayPath;
    this._allowCreateDaily = allowCreateDaily;
  }

  /** @param {unknown} path */
  getFile(path) {
    return this.vault.getAbstractFileByPath(normalizeMarkdownPath(path, normalizePath));
  }

  /** @param {unknown} file */
  isFile(file) {
    return !!file && this._isFile(file);
  }

  async ensureTodayFile() {
    return this.ensureFileAtPath(this._todayPath());
  }

  /** @param {unknown} path */
  async ensureFileAtPath(path) {
    const targetPath = normalizeMarkdownPath(path, normalizePath);
    let file = this.vault.getAbstractFileByPath(targetPath);
    if (!file) {
      if (!this._allowCreateDaily()) throw new Error("找不到当天文件，且未开启自动创建");
      const parts = targetPath.split("/");
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
      file = await this.vault.create(targetPath, "");
    }
    if (!this.isFile(file)) throw new Error("目标不是文件");
    return file;
  }

  /** @param {any} file */
  async read(file) {
    return this.vault.read(file);
  }

  /** @param {unknown} path */
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

  /** @param {{text:unknown, kind?:"todo"|"idea", heading?:unknown, path?:unknown}} input */
  async appendCapture(input) {
    const file = input?.path === undefined ? await this.ensureTodayFile() : await this.ensureFileAtPath(input.path);
    /** @type {{text:string, heading:string, line:string, createdHeading:boolean} | null} */
    let capture = null;
    await this.process(file, current => {
      capture = appendCaptureToHeading(current, input);
      return capture.text;
    });
    if (!capture) throw new Error("快速记录写入失败");
    return { file, .../** @type {{text:string, heading:string, line:string, createdHeading:boolean}} */ (capture) };
  }

  /** @param {any} file @param {(text:string)=>string} callback */
  async process(file, callback) {
    if (typeof this.vault.process !== "function") throw new Error("当前 Obsidian 不支持原子日记处理");
    return this.vault.process(file, callback);
  }

  /** @param {any} file @param {(frontmatter:ObsidianRecord)=>void} callback */
  async processFrontMatter(file, callback) {
    return this.fileManager.processFrontMatter(file, callback);
  }

  /** @param {unknown} text */
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

  /** @param {{taskName:unknown, amount?:number, settings:Settings, frontmatterKey?:string}} input */
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
    /** @type {unknown} */
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

  /** @param {{taskName:unknown, path?:unknown}} input */
  async completeTask({ taskName, path }) {
    const targetPath = path ? normalizeMarkdownPath(path, normalizePath) : this._todayPath();
    const file = this.getFile(targetPath);
    if (!this.isFile(file)) throw new Error("找不到当天任务文件");
    /** @type {{text:string, alreadyApplied:boolean}} */
    let mutation = { text:"", alreadyApplied:false };
    await this.process(file, current => {
      const plan = planTaskLineCompletion(current, taskName);
      mutation = applyTaskLineMutation(current, plan);
      return mutation.text;
    });
    return { file, ...mutation };
  }

  /** @param {any} file @param {TaskMutationPlan} plan */
  async applyPlannedMutation(file, plan) {
    let mutation = { text:"", alreadyApplied:false };
    await this.process(file, current => {
      mutation = applyTaskLineMutation(current, plan);
      return mutation.text;
    });
    return {
      text: mutation.text || await this.read(file),
      alreadyApplied: mutation.alreadyApplied
    };
  }
}

class ProjectRepository {
  /** @param {{vault:ObsidianRecord, fileManager:ObsidianRecord, metadataCache:ObsidianRecord, isFile:(file:unknown)=>boolean, readFrontmatter:(file:any)=>Promise<ObsidianRecord>}} options */
  constructor({ vault, fileManager, metadataCache, isFile, readFrontmatter }) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.metadataCache = metadataCache;
    this._isFile = isFile;
    this._readFrontmatter = readFrontmatter;
  }

  /** @param {unknown} path */
  getFile(path) {
    return this.vault.getAbstractFileByPath(normalizeMarkdownPath(path, normalizePath));
  }

  /** @param {unknown} file */
  isFile(file) {
    return !!file && this._isFile(file);
  }

  /** @param {any} file @param {(frontmatter:ObsidianRecord)=>void} callback */
  async processFrontMatter(file, callback) {
    return this.fileManager.processFrontMatter(file, callback);
  }

  /** @param {{path:unknown, key:string, amount:number, enabled:boolean}} input @returns {Promise<ProjectSettlementPlan>} */
  async prepareSettlementPlan({ path, key, amount, enabled }) {
    const rawPath = String(path || "").trim();
    const frontmatterKey = key || "番茄数";
    if (!enabled || !rawPath) return { path: rawPath, key: frontmatterKey, status: "skipped", amount };
    const projectPath = normalizeMarkdownPath(rawPath, normalizePath);
    const file = this.getFile(projectPath);
    if (!this.isFile(file)) return { path: projectPath, key: frontmatterKey, status: "missing", amount, deferred: true };
    const frontmatter = await this._readFrontmatter(file);
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

  /** @param {ProjectSettlementPlan | null | undefined} plan @returns {Promise<{status:ProjectSettlementPlan["status"], error?:string}>} */
  async applyPlan(plan) {
    if (!plan || plan.status === "applied" || plan.status === "skipped") return { status: plan?.status || "skipped" };
    const projectPath = normalizeMarkdownPath(plan.path, normalizePath);
    const file = this.vault.getAbstractFileByPath(projectPath);
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
        status: error && typeof error === "object" && "code" in error && error.code === "SETTLEMENT_CONFLICT" ? "conflict" : "pending",
        error: String(error instanceof Error ? error.message : error)
      };
    }
  }

  /** @param {{tag:unknown, statusKey:string, statusWhitelist:string}} input */
  listCandidates({ tag, statusKey, statusWhitelist }) {
    const tagWant = normalizeTag(tag || "#project");
    const whitelist = new Set(String(statusWhitelist || "进行中,筹划中").split(",").map(value => value.trim()).filter(Boolean));
    const result = [];
    for (const file of this.vault.getMarkdownFiles()) {
      const cache = this.metadataCache.getFileCache(file) || {};
      const frontmatter = cache.frontmatter || {};
      const tags = new Set();
      const frontmatterTags = frontmatter.tags;
      if (Array.isArray(frontmatterTags)) frontmatterTags.forEach((/** @type {any} */ value) => tags.add(normalizeTag(value)));
      else if (typeof frontmatterTags === "string") frontmatterTags.split(/[,\s]+/).forEach(value => value && tags.add(normalizeTag(value)));
      (cache.tags || []).forEach((/** @type {Record<string, any>} */ entry) => entry?.tag && tags.add(entry.tag));
      if (!tags.has(tagWant)) continue;
      const status = String(frontmatter[statusKey || "项目状态"] || "").trim();
      if (!whitelist.has(status)) continue;
      result.push({ label: `${file.basename} — ${status} (${file.path})`, path: file.path });
    }
    return result;
  }

  /** @param {{path:unknown, key?:string, amount?:number}} input */
  async bumpTomato({ path, key, amount = 1 }) {
    const add = Math.max(0, Number(amount) || 0);
    if (!add) return;
    const rawPath = String(path || "").trim();
    if (!rawPath) return;
    const projectPath = normalizeMarkdownPath(rawPath, normalizePath);
    const file = this.vault.getAbstractFileByPath(projectPath);
    if (!this.isFile(file)) return;
    await this.processFrontMatter(file, frontmatter => {
      const field = key || "番茄数";
      frontmatter[field] = normalizeTomatoValue(normalizeTomatoValue(frontmatter[field]) + add);
    });
  }
}

module.exports = { DailyRepository, ProjectRepository };
