import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Instinct,
  InstinctDomain,
  InstinctSource,
  Memory,
  MemoryStatus,
  MemoryType,
  ToolObservation
} from './experience-types.js';
import { replaceFileAtomically } from './atomic-file.js';

/**
 * 经验系统持久化与召回层。
 *
 * 设计参考 SessionManager 的「内存真源 + 原子落盘」模式，但承担两类数据：
 *   - 观测流（observations.jsonl）：会话内追加式，超阈值自动按月归档
 *   - 规则/记忆（每条一个 .md 文件）：两级目录，项目级覆盖用户级同名条目
 *
 * 与 SkillRegistry 的区别：后者只读扫描器，无写入 API、frontmatter 字段固定；
 * 本模块面向频繁读写，frontmatter 扩展 confidence/domain/source/status 等元数据。
 *
 * 目录布局：
 *   <project>/.haji/observations.jsonl              # 当前观测流（主文件，30 天滚动）
 *   <project>/.haji/observations_YYYY-MM.jsonl      # 按月归档
 *   <project>/.haji/instincts/<domain>__<id>.md     # 项目级规则
 *   <project>/.haji/memory/active/<type>__<id>.md   # 项目级已确认记忆
 *   <project>/.haji/memory/staging/<type>__<id>.md  # 项目级候选记忆
 *   ~/.haji/instincts/  ~/.haji/memory/             # 用户级（跨项目共用）
 */

/** 观测流归档阈值：仿文章设计，超 5MB 或 8000 行触发按月分片。 */
const OBSERVATIONS_MAX_BYTES = 5 * 1024 * 1024;
const OBSERVATIONS_MAX_LINES = 8000;
/** 主文件保留天数，超出部分在归档时裁剪。 */
const OBSERVATIONS_RETAIN_DAYS = 30;

/** Instinct 被标记为 deprecated 的置信度下限。 */
const DEPRECATE_BELOW = 0.55;
/** Instinct 长期未触发的衰减阈值（天数）。 */
const DECAY_AFTER_DAYS = 90;
/** 衰减步长。 */
const DECAY_STEP = 0.05;
/** 重复观测的强化步长与上限。 */
const REINFORCE_STEP = 0.05;
const CONFIDENCE_MAX = 0.9;
/** Instinct 首次出现的初始置信度。 */
const CONFIDENCE_INITIAL = 0.5;

/** 召回时对 args 序列化的截断长度，避免巨型参数污染关键词。 */
const ARGS_SERIALIZE_LIMIT = 2000;

/** Memory active 库的裁剪上限，超出按 confidence 淘汰。 */
const MEMORY_ACTIVE_MAX = 100;

/**
 * 解析用户级与项目级目录。默认沿用 hajicli 的 ~/.haji 与 <cwd>/.haji 约定，
 * 但允许调用方覆盖（便于测试）。
 */
export interface ExperienceStoreOptions {
  cwd: string;
  userDir?: string;
  projectDir?: string;
  /** 自定义观测文件路径（默认 <projectDir>/observations.jsonl）。测试用。 */
  observationsFile?: string;
}

export class ExperienceStore {
  private readonly cwd: string;
  private readonly userDir: string;
  private readonly projectDir: string;
  private readonly observationsFile: string;

  /** 会话内待 flush 的观测样本缓冲。 */
  private pendingObservations: ToolObservation[] = [];
  private observationFlushChain: Promise<void> = Promise.resolve();

  constructor(options: ExperienceStoreOptions) {
    this.cwd = options.cwd;
    this.userDir = options.userDir ?? path.join(os.homedir(), '.haji');
    this.projectDir = options.projectDir ?? path.join(this.cwd, '.haji');
    this.observationsFile = options.observationsFile ?? path.join(this.projectDir, 'observations.jsonl');
  }

  // ─── 观测流 ──────────────────────────────────────────────────────────────

  /**
   * 追加一条观测样本到内存缓冲。
   * 会话内高频调用，零 I/O；由 flushObservations() 落盘。
   */
  appendObservation(obs: ToolObservation): void {
    this.pendingObservations.push(obs);
  }

  /**
   * 把缓冲的观测样本追加到 observations.jsonl。
   * 追加后若超阈值，异步触发按月归档（不阻塞调用方）。
   */
  flushObservations(): Promise<void> {
    if (this.pendingObservations.length === 0) return Promise.resolve();
    const batch = this.pendingObservations.splice(0);
    this.observationFlushChain = this.observationFlushChain.then(async () => {
      await this.ensureDir(path.dirname(this.observationsFile));
      const lines = batch.map(o => JSON.stringify(this.compactObservation(o))).join('\n') + '\n';
      try {
        await fsp.appendFile(this.observationsFile, lines, 'utf8');
      } catch {
        // 落盘失败不抛——观测是尽力而为，不能阻塞主流程
        this.pendingObservations.unshift(...batch);
        return;
      }
      // 触发异步归档检查（不 await，避免阻塞退出）
      this.maybeArchiveObservations().catch(() => { /* 归档失败忽略 */ });
    });
    return this.observationFlushChain;
  }

  /**
   * 读取最近 N 天的观测样本（默认 30 天），用于提炼引擎。
   * 合并主文件与当月归档文件中的近期记录。
   */
  async loadRecentObservations(days = OBSERVATIONS_RETAIN_DAYS): Promise<ToolObservation[]> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const results: ToolObservation[] = [];
    const files = await this.collectObservationFiles();
    for (const file of files) {
      try {
        const content = await fsp.readFile(file, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obs = JSON.parse(trimmed) as ToolObservation;
            if (new Date(obs.ts).getTime() >= cutoff) results.push(obs);
          } catch {
            // 损坏行跳过
          }
        }
      } catch {
        // 文件读取失败跳过
      }
    }
    return results;
  }

  /**
   * 读取当前会话内存中尚未 flush 的观测（提炼时合并使用）。
   */
  getPendingObservations(): ToolObservation[] {
    return [...this.pendingObservations];
  }

  // ─── Instinct CRUD ───────────────────────────────────────────────────────

  /**
   * 加载所有规则：两级目录合并，项目级覆盖用户级同名 id。
   * 自动跳过 deprecated 标记（除非 includeDeprecated）。
   */
  loadInstincts(includeDeprecated = false): Instinct[] {
    const merged = new Map<string, Instinct>();
    // 用户级先加载，项目级后加载并覆盖
    for (const dir of [this.userInstinctsDir(), this.projectInstinctsDir()]) {
      const entries = this.scanMarkdownFiles(dir);
      for (const entry of entries) {
        const parsed = this.parseInstinctFile(entry.content);
        if (!parsed) continue;
        merged.set(parsed.id, parsed);
      }
    }
    const result = Array.from(merged.values());
    return includeDeprecated ? result : result.filter(i => !i.deprecated);
  }

  /**
   * 写入或更新一条规则。
   * 默认写项目级（source=manual 时写用户级，便于跨项目偏好）。
   */
  async upsertInstinct(instinct: Instinct): Promise<void> {
    const targetDir = instinct.source === 'manual' ? this.userInstinctsDir() : this.projectInstinctsDir();
    await this.ensureDir(targetDir);
    const fileName = `${instinct.domain}__${this.sanitizeId(instinct.id)}.md`;
    const filePath = path.join(targetDir, fileName);
    const content = this.serializeInstinct(instinct);
    await this.atomicWrite(filePath, content);
  }

  /** 删除指定 id 的规则（两级目录都清）。 */
  async forgetInstinct(id: string): Promise<boolean> {
    return this.deleteById(id, this.userInstinctsDir(), this.projectInstinctsDir());
  }

  /**
   * 置信度演化：把新观测到的规则与既有规则合并。
   * - 同 id 重复：confidence += 0.05（上限 0.9），occurrenceCount++，observedAt 更新
   * - 新规则：写入，confidence 初始 0.5
   * - 既有规则本次未触发：若超 90 天未观测则 -0.05
   * 返回更新后的完整规则列表与本次被强化的 id 集合。
   */
  async evolveInstincts(detected: Instinct[]): Promise<{ updated: Instinct[]; reinforced: Set<string> }> {
    const existing = this.loadInstincts(true);
    const existingMap = new Map(existing.map(i => [i.id, i]));
    const reinforced = new Set<string>();
    const detectedIds = new Set(detected.map(i => i.id));
    const now = new Date().toISOString();

    for (const det of detected) {
      const prev = existingMap.get(det.id);
      if (prev) {
        prev.confidence = round2(Math.min(CONFIDENCE_MAX, prev.confidence + REINFORCE_STEP));
        prev.occurrenceCount += 1;
        prev.observedAt = now;
        prev.deprecated = prev.confidence < DEPRECATE_BELOW;
        // action/trigger 以较新描述为准（LLM 可能给出更精炼表述）
        if (det.action) prev.action = det.action;
        if (det.trigger) prev.trigger = det.trigger;
        reinforced.add(prev.id);
      } else {
        // 新规则强制使用初始置信度，忽略 detected 里的 confidence（该值是检测器的临时评分）
        const fresh: Instinct = {
          ...det,
          confidence: CONFIDENCE_INITIAL,
          occurrenceCount: 1,
          observedAt: now,
          deprecated: false
        };
        existingMap.set(fresh.id, fresh);
      }
    }

    // 未触发的既有规则衰减
    for (const inst of existingMap.values()) {
      if (detectedIds.has(inst.id)) continue;
      const ageDays = (Date.now() - new Date(inst.observedAt).getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays > DECAY_AFTER_DAYS) {
        inst.confidence = round2(Math.max(0, inst.confidence - DECAY_STEP));
        if (inst.confidence < DEPRECATE_BELOW) inst.deprecated = true;
      }
    }

    const updated = Array.from(existingMap.values());
    // 批量落盘（仅写有变化的——简化实现：全量重写项目级，用户级只写 manual）
    await this.persistInstincts(updated);
    return { updated, reinforced };
  }

  // ─── Memory CRUD ─────────────────────────────────────────────────────────

  /**
   * 加载记忆，默认只读 active。两级目录合并，项目级覆盖用户级同名 id。
   */
  loadMemories(status: MemoryStatus | 'all' = 'active'): Memory[] {
    const merged = new Map<string, Memory>();
    const scopes: Array<{ dir: string; status: MemoryStatus }> = [
      { dir: path.join(this.userMemoryDir(), 'active'), status: 'active' },
      { dir: path.join(this.userMemoryDir(), 'staging'), status: 'staging' },
      { dir: path.join(this.projectMemoryDir(), 'active'), status: 'active' },
      { dir: path.join(this.projectMemoryDir(), 'staging'), status: 'active' } // 项目级 staging 视作 active 覆盖
    ];
    for (const scope of scopes) {
      const entries = this.scanMarkdownFiles(scope.dir);
      for (const entry of entries) {
        const parsed = this.parseMemoryFile(entry.content, scope.status);
        if (!parsed) continue;
        merged.set(parsed.id, parsed);
      }
    }
    const all = Array.from(merged.values());
    if (status === 'all') return all;
    return all.filter(m => m.status === status);
  }

  /** 把一条 memory 候选写入 staging 区（等用户 confirm）。 */
  async stageMemory(memory: Memory): Promise<void> {
    const dir = path.join(this.projectMemoryDir(), 'staging');
    await this.ensureDir(dir);
    const fileName = `${memory.type}__${this.sanitizeId(memory.id)}.md`;
    const filePath = path.join(dir, fileName);
    await this.atomicWrite(filePath, this.serializeMemory(memory));
  }

  /** 直接写入 active 区（用于手工 /memory add 或高置信度直入）。 */
  async upsertMemory(memory: Memory): Promise<void> {
    const dir = path.join(this.projectMemoryDir(), 'active');
    await this.ensureDir(dir);
    const fileName = `${memory.type}__${this.sanitizeId(memory.id)}.md`;
    const filePath = path.join(dir, fileName);
    await this.atomicWrite(filePath, this.serializeMemory(memory));
  }

  /**
   * 确认一条 staging 候选：从 staging 移到 active。
   * 返回是否成功找到并迁移。
   */
  async confirmMemory(id: string): Promise<boolean> {
    const stagingDir = path.join(this.projectMemoryDir(), 'staging');
    const entries = this.scanMarkdownFiles(stagingDir);
    for (const entry of entries) {
      const parsed = this.parseMemoryFile(entry.content, 'staging');
      if (parsed && parsed.id === id) {
        parsed.status = 'active';
        parsed.updatedAt = new Date().toISOString();
        await this.upsertMemory(parsed);
        await this.removeFile(entry.filePath);
        return true;
      }
    }
    return false;
  }

  /** 删除指定 id 的记忆（两级目录都清）。 */
  async forgetMemory(id: string): Promise<boolean> {
    return this.deleteById(id,
      path.join(this.userMemoryDir(), 'active'),
      path.join(this.userMemoryDir(), 'staging'),
      path.join(this.projectMemoryDir(), 'active'),
      path.join(this.projectMemoryDir(), 'staging')
    );
  }

  /** active 库超限裁剪：按 confidence 升序淘汰多余条目。 */
  async pruneMemories(): Promise<number> {
    const active = this.loadMemories('active');
    if (active.length <= MEMORY_ACTIVE_MAX) return 0;
    const sorted = active.sort((a, b) => a.confidence - b.confidence);
    const toRemove = sorted.slice(0, active.length - MEMORY_ACTIVE_MAX);
    for (const mem of toRemove) {
      await this.forgetMemory(mem.id);
    }
    return toRemove.length;
  }

  // ─── 召回（关键词匹配，无向量） ────────────────────────────────────────────

  /**
   * 召回与查询最相关的 Top-K 规则。
   * 使用 Jaccard 相似度（英文 token）+ 中文关键字符，跨语言匹配。
   * 默认过滤 deprecated 与 confidence < minConfidence 的规则。
   */
  recallInstincts(query: string, topK = 8, minConfidence = 0.7): Instinct[] {
    const queryTokens = tokenize(query);
    const candidates = this.loadInstincts().filter(i => !i.deprecated && i.confidence >= minConfidence);
    return candidates
      .map(i => ({
        instinct: i,
        score: jaccardSimilarity(queryTokens, tokenize(`${i.trigger} ${i.action} ${i.domain}`))
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || b.instinct.confidence - a.instinct.confidence)
      .slice(0, topK)
      .map(x => x.instinct);
  }

  /**
   * 召回与查询最相关的 Top-K 记忆（仅 active）。
   */
  recallMemories(query: string, topK = 5): Memory[] {
    const queryTokens = tokenize(query);
    const candidates = this.loadMemories('active');
    return candidates
      .map(m => ({
        memory: m,
        score: jaccardSimilarity(queryTokens, new Set([...m.keywords, ...tokenize(`${m.name} ${m.content}`)]))
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.confidence - a.memory.confidence)
      .slice(0, topK)
      .map(x => x.memory);
  }

  // ─── 内部辅助 ─────────────────────────────────────────────────────────────

  private userInstinctsDir(): string { return path.join(this.userDir, 'instincts'); }
  private projectInstinctsDir(): string { return path.join(this.projectDir, 'instincts'); }
  private userMemoryDir(): string { return path.join(this.userDir, 'memory'); }
  private projectMemoryDir(): string { return path.join(this.projectDir, 'memory'); }

  private async ensureDir(dir: string): Promise<void> {
    try { await fsp.mkdir(dir, { recursive: true }); } catch { /* 并发创建忽略 */ }
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.writeFile(tmp, content, 'utf8');
      await replaceFileAtomically(tmp, filePath);
    } catch (error) {
      try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  }

  private scanMarkdownFiles(dir: string): Array<{ filePath: string; content: string }> {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const result: Array<{ filePath: string; content: string }> = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const filePath = path.join(dir, entry.name);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          result.push({ filePath, content });
        } catch { /* 读取失败跳过 */ }
      }
      return result;
    } catch {
      return [];
    }
  }

  private async removeFile(filePath: string): Promise<void> {
    try { await fsp.rm(filePath, { force: true }); } catch { /* ignore */ }
  }

  private async deleteById(id: string, ...dirs: string[]): Promise<boolean> {
    const sanitized = this.sanitizeId(id);
    let removed = false;
    for (const dir of dirs) {
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        // 文件名格式 <type>__<id>.md，匹配 __ 后到 .md 前的部分
        const match = name.match(/^(.+?)__(.+)\.md$/);
        if (match && match[2] === sanitized) {
          await this.removeFile(path.join(dir, name));
          removed = true;
        }
      }
    }
    return removed;
  }

  private sanitizeId(id: string): string {
    // 仅保留字母数字、连字符、下划线，其余替换为 -
    return id.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 64);
  }

  /** 序列化观测样本，对 args/output 做截断保护。 */
  private compactObservation(obs: ToolObservation): ToolObservation {
    const argsStr = safeStringify(obs.args);
    const trimmedArgs = argsStr.length > ARGS_SERIALIZE_LIMIT
      ? { _truncated: true, preview: argsStr.slice(0, ARGS_SERIALIZE_LIMIT) }
      : obs.args;
    const trimmedOutput = obs.output.length > ARGS_SERIALIZE_LIMIT
      ? obs.output.slice(0, ARGS_SERIALIZE_LIMIT) + '…[truncated]'
      : obs.output;
    return { ...obs, args: trimmedArgs as Record<string, unknown>, output: trimmedOutput };
  }

  /** 收集主文件与所有按月归档文件。 */
  private async collectObservationFiles(): Promise<string[]> {
    const files: string[] = [];
    try {
      await fsp.access(this.observationsFile);
      files.push(this.observationsFile);
    } catch { /* 主文件不存在忽略 */ }
    try {
      const dir = path.dirname(this.observationsFile);
      const entries = await fsp.readdir(dir);
      for (const name of entries) {
        if (/observations_\d{4}-\d{2}\.jsonl$/.test(name)) {
          files.push(path.join(dir, name));
        }
      }
    } catch { /* ignore */ }
    return files;
  }

  /**
   * 检查主观测文件大小/行数，超阈值则把旧数据按月归档。
   * 仿文章 observations_rotate.py 的策略。
   */
  private async maybeArchiveObservations(): Promise<void> {
    let stat;
    try { stat = await fsp.stat(this.observationsFile); } catch { return; }
    if (stat.size < OBSERVATIONS_MAX_BYTES) return;
    const content = await fsp.readFile(this.observationsFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length < OBSERVATIONS_MAX_LINES) return;

    // 按月份分组
    const byMonth = new Map<string, string[]>();
    const cutoff = Date.now() - OBSERVATIONS_RETAIN_DAYS * 24 * 60 * 60 * 1000;
    const retained: string[] = [];
    for (const line of lines) {
      try {
        const obs = JSON.parse(line) as ToolObservation;
        const monthKey = obs.ts.slice(0, 7); // YYYY-MM
        if (new Date(obs.ts).getTime() < cutoff) {
          if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
          byMonth.get(monthKey)!.push(line);
        } else {
          retained.push(line);
        }
      } catch {
        retained.push(line); // 损坏行保留
      }
    }
    // 追加到各月归档文件
    for (const [month, monthLines] of byMonth) {
      const archiveFile = path.join(path.dirname(this.observationsFile), `observations_${month}.jsonl`);
      await fsp.appendFile(archiveFile, monthLines.join('\n') + '\n', 'utf8');
    }
    // 主文件只保留近期数据
    await fsp.writeFile(this.observationsFile, retained.join('\n') + (retained.length ? '\n' : ''), 'utf8');
  }

  /**
   * 增量持久化演化后的规则（演化时使用）。
   *
   * 历史教训：早期实现 clearInstinctsDir 清空整个目录再重写，有两个风险——
   * (1) clear 与重写之间崩溃会丢失全部规则；
   * (2) 用户级 non-manual 规则会被一并清除。
   * 改为增量 upsert：只更新本次有变化的条目，先按 id 清掉两级目录的同名旧文件
   * （处理 domain 改名导致的残文件），再写入对应目录。其他无关规则不动。
   */
  private async persistInstincts(instincts: Instinct[]): Promise<void> {
    const projectDir = this.projectInstinctsDir();
    const userDir = this.userInstinctsDir();
    await this.ensureDir(projectDir);
    await this.ensureDir(userDir);
    for (const inst of instincts) {
      // 先清掉两级目录中该 id 的旧文件（容忍 domain 改名后的残文件）
      await this.removeInstinctFilesById(inst.id, projectDir, userDir);
      const targetDir = inst.source === 'manual' ? userDir : projectDir;
      const fileName = `${inst.domain}__${this.sanitizeId(inst.id)}.md`;
      await this.atomicWrite(path.join(targetDir, fileName), this.serializeInstinct(inst));
    }
  }

  /** 删除指定 id 在给定目录中的所有 .md 文件（匹配 `__<id>.md` 后缀）。 */
  private async removeInstinctFilesById(id: string, ...dirs: string[]): Promise<void> {
    const sanitized = this.sanitizeId(id);
    for (const dir of dirs) {
      let entries: string[];
      try { entries = await fsp.readdir(dir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.md')) continue;
        const match = name.match(/^(.+?)__(.+)\.md$/);
        if (match && match[2] === sanitized) {
          await this.removeFile(path.join(dir, name));
        }
      }
    }
  }

  // ─── Frontmatter 序列化/反序列化 ───────────────────────────────────────────

  private serializeInstinct(i: Instinct): string {
    const frontmatter = [
      `id: ${i.id}`,
      `confidence: ${i.confidence.toFixed(2)}`,
      `domain: ${i.domain}`,
      `source: ${i.source}`,
      `deprecated: ${i.deprecated}`,
      `observedAt: ${JSON.stringify(i.observedAt)}`,
      `occurrenceCount: ${i.occurrenceCount}`
    ].join('\n');
    return `---\n${frontmatter}\n---\n## Trigger\n${i.trigger}\n\n## Action\n${i.action}\n`;
  }

  private parseInstinctFile(content: string): Instinct | null {
    const fm = parseFrontmatter(content);
    if (!fm) return null;
    const body = content.slice(content.indexOf('---', 3) + 3).trim();
    const trigger = extractSection(body, 'Trigger');
    const action = extractSection(body, 'Action');
    const id = String(fm.id || '');
    if (!id || !trigger || !action) return null;
    return {
      id,
      trigger,
      action,
      confidence: Number(fm.confidence ?? CONFIDENCE_INITIAL),
      domain: (String(fm.domain || 'other') as InstinctDomain),
      source: (String(fm.source || 'statistical') as InstinctSource),
      deprecated: String(fm.deprecated) === 'true',
      observedAt: parseIsoString(fm.observedAt),
      occurrenceCount: Number(fm.occurrenceCount || 0)
    };
  }

  private serializeMemory(m: Memory): string {
    const frontmatter = [
      `id: ${m.id}`,
      `name: ${JSON.stringify(m.name)}`,
      `type: ${m.type}`,
      `status: ${m.status}`,
      `confidence: ${m.confidence.toFixed(2)}`,
      `createdAt: ${JSON.stringify(m.createdAt)}`,
      `updatedAt: ${JSON.stringify(m.updatedAt)}`,
      `keywords: ${JSON.stringify(m.keywords)}`
    ].join('\n');
    return `---\n${frontmatter}\n---\n${m.content}\n`;
  }

  private parseMemoryFile(content: string, defaultStatus: MemoryStatus): Memory | null {
    const fm = parseFrontmatter(content);
    if (!fm) return null;
    const body = content.slice(content.indexOf('---', 3) + 3).trim();
    const id = String(fm.id || '');
    if (!id) return null;
    const status = (String(fm.status || defaultStatus) as MemoryStatus);
    return {
      id,
      name: String(fm.name || id),
      type: (String(fm.type || 'project') as MemoryType),
      content: body,
      status,
      confidence: Number(fm.confidence ?? 0.6),
      createdAt: parseIsoString(fm.createdAt),
      updatedAt: parseIsoString(fm.updatedAt),
      keywords: parseKeywordArray(fm.keywords)
    };
  }
}

// ─── 模块级工具函数 ──────────────────────────────────────────────────────────

/**
 * 提取查询/文本的关键词 token 集合。
 * 英文按非字母数字分割取小写；中文按单字符逐个加入（用于跨语言 Jaccard）。
 * 仿文章「只提取英文关键词」的设计，但额外保留中文单字以支持中文描述。
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  // 英文 token：长度 >= 2 的字母数字串
  const ascii = text.toLowerCase().match(/[a-z0-9][a-z0-9-_]{1,}/g);
  if (ascii) for (const t of ascii) tokens.add(t);
  // 中文单字（CJK 统一表意范围）
  const cjk = text.match(/[\u4e00-\u9fff]/g);
  if (cjk) for (const c of cjk) tokens.add(c);
  return tokens;
}

/** 计算两个 token 集合的 Jaccard 相似度。 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const t of smaller) if (larger.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 安全 JSON 序列化，处理循环引用与大对象。 */
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

/** 将数值规整到两位小数，避免浮点累加误差（0.8 + 0.05 = 0.85000...1）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 极简 YAML frontmatter 解析：只处理 `key: value` 与 `key: "value"` 形式。 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = content.slice(3, end);
  const result: Record<string, unknown> = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value: string = trimmed.slice(colon + 1).trim();
    // 去引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** 从 Markdown 正文中提取指定二级标题下的内容（直到下一个同级标题或正文结束）。 */
function extractSection(body: string, heading: string): string {
  const lines = body.split('\n');
  let capturing = false;
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (capturing) break; // 遇到下一个二级标题，结束捕获
      if (line.slice(3).trim() === heading) capturing = true;
    } else if (capturing) {
      result.push(line);
    }
  }
  return result.join('\n').trim();
}

function parseIsoString(raw: unknown): string {
  if (typeof raw !== 'string') return new Date().toISOString();
  const trimmed = raw.replace(/^["']|["']$/g, '');
  return trimmed || new Date().toISOString();
}

function parseKeywordArray(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.replace(/^\[|]$/g, '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(`[${trimmed}]`);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
