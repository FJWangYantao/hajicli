import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { replaceFileAtomically } from "./atomic-file.js";
import { performanceMonitor } from "./performance-monitor.js";
import { acquireFileLock, writeFileAtomicallySync } from "./persistence-file.js";
import type { ChatMessage } from "./types.js";

const SESSION_FLUSH_DELAY_MS = 120;

/**
 * 一条模型调用的记账：只存 token 与时刻，不存金额。
 * 金额在展示时按调用时刻的单价复算，因此事后补单价也能把旧调用算对。
 */
export interface SessionCostRecord {
  model: string;
  purpose: string;
  /** 所属轮次（1 起）；0/缺省表示老会话没有轮次信息。 */
  turn?: number;
  /** 调用发生时刻（ms）；峰谷价按它判定。 */
  at: number;
  promptTokens: number;
  /** 其中命中缓存的输入 token（≤ promptTokens）。 */
  cachedPromptTokens: number;
  completionTokens: number;
  /** provider 是否上报了缓存命中；缺省表示老会话无从判断。 */
  cacheReported?: boolean;
  /** 本次请求耗时（ms）；老会话没有这项，页面显示「—」。 */
  durationMs?: number;
  /** 本次请求的推理 token（估算）。 */
  reasoningTokens?: number;
  /** 该轮用户问题摘要，只记在每轮第一条记录上。 */
  turnPrompt?: string;
  /** 按次收费项（官方网页检索）；存在时 token 恒为 0。 */
  flatFee?: "websearch";
}

/**
 * 最近一次上下文压缩的结果：随会话落盘，/resume 用它回放压缩记录，
 * selfstate 用它回答「上下文是怎么变小的」。老会话没有该字段。
 */
export interface SessionCompaction {
  /** 压缩时刻（ISO）。 */
  at: string;
  beforeTokens: number;
  afterTokens: number;
  /** 压缩前后的字符占用（用于回放「释放了多少空间」那行）；老会话缺省。 */
  beforeChars?: number;
  afterChars?: number;
  /** 应用的压缩层，例如 `L1:大结果落盘 -> L4:模型结构化摘要`。 */
  layers: string[];
  /** 压缩前完整轨迹（transcript_*.jsonl）；落盘失败时缺省。 */
  transcriptPath?: string;
  /** 摘要来源；`fallback` 表示模型摘要失败、用了本地降级摘要。 */
  summaryMode?: "model" | "fallback";
  /** 模型摘要失败的原因；`summaryMode` 为 `fallback` 时才有，/resume 回放时一并显示。 */
  summaryError?: string;
}

/** 会话内用量：/resume 时据此把侧栏的费用、压缩次数与上轮耗时复原。 */
export interface SessionUsage {
  costRecords?: SessionCostRecord[];
  /** 本会话已发生的上下文压缩次数。 */
  compactionCount?: number;
  /** 上一轮回合耗时（ms）。 */
  lastTurnMs?: number;
  /** 最近一次压缩的详情；与消息一起落盘，压缩记录才能跨 /resume 还原。 */
  lastCompaction?: SessionCompaction;
}

/** 会话目标：setgoal 工具设定（模型从用户请求中提炼），随会话记录持久化；/resume 后恢复、/clear 后归零。 */
export interface SessionGoal {
  /** 目标原文（用户输入，任务是数据而不是指令）。 */
  text: string;
  status: "active" | "achieved";
  createdAt: string;
  /** 达成时刻（status === "achieved" 时存在）。 */
  achievedAt?: string;
  /** 完成审计摘要（goalfinish 时留档：逐条「验收点 → 证据」）。 */
  evidence?: string;
}

export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** 用量记账；老会话文件没有该字段，按零值处理。 */
  usage?: SessionUsage;
  /** 会话目标；老会话文件没有该字段，视为未设定。 */
  goal?: SessionGoal;
}

interface PendingSessionWrite {
  session?: StoredSession;
  remove?: boolean;
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    tool_calls: message.tool_calls?.map((toolCall) => ({
      ...toolCall,
      function: { ...toolCall.function },
    })),
  };
}

function sameMessages(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const candidate = right[index];
    if (
      !candidate ||
      message.role !== candidate.role ||
      message.content !== candidate.content ||
      message.reasoning_content !== candidate.reasoning_content ||
      message.snapshotId !== candidate.snapshotId ||
      message.tool_call_id !== candidate.tool_call_id
    )
      return false;
    const leftCalls = message.tool_calls || [];
    const rightCalls = candidate.tool_calls || [];
    return (
      leftCalls.length === rightCalls.length &&
      leftCalls.every((toolCall, toolIndex) => {
        const other = rightCalls[toolIndex];
        return Boolean(
          other &&
            toolCall.id === other.id &&
            toolCall.type === other.type &&
            toolCall.function.name === other.function.name &&
            toolCall.function.arguments === other.function.arguments,
        );
      })
    );
  });
}

/** In-memory session state with debounced, atomic background persistence. */
/**
 * 清理模型生成的会话标题：取第一行非空文本，去掉 Markdown 标记、“标题：”前缀、
 * 引号书名号与收尾标点，最多保留 20 个字符；清理后为空时返回 fallback。
 */
export function cleanGeneratedTitle(raw: string, fallback: string): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const cleaned = firstLine
    .replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+|>\s*)+/, "")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*+|`+|~~/g, "")
    .replace(/^(?:标题|title)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’《「『【\s]+|["'“”‘’》」』】\s]+$/g, "")
    .replace(/[。.!！?？:：;；,，、\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, 20).join("") || fallback;
}

export class SessionManager {
  private sessionsDir: string;
  /**
   * 跨目录检索的附加会话目录（同仓库其他 haji 工作树）：listSessions 会合并展示、
   * loadSession 命中后把主目录切过去。写盘永远只走主目录。
   */
  private searchDirs: string[] = [];
  /** 已移除工作树的归档会话目录：只读，选中后复制回主目录继续。 */
  private archiveDirs: string[] = [];
  private currentSession: StoredSession;
  private lastQueuedMessages: ChatMessage[] = [];
  private lastQueuedTitle = "";
  /** 已经入队的用量快照（JSON 序列化）；用于识别「只有用量变了」的保存请求。 */
  private lastQueuedUsage = "";
  private readonly pendingWrites = new Map<string, PendingSessionWrite>();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly diskVersions = new Map<string, string | null>();
  private readonly loadedVersions = new WeakMap<StoredSession, string>();
  private activeWrites = 0;

  public hasPendingWrites(): boolean {
    return this.pendingWrites.size > 0 || this.activeWrites > 0;
  }

  private diskVersion(filePath: string): string | null {
    try {
      return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private flushTimer: NodeJS.Timeout | null = null;
  private warningHandler?: (message: string) => void;
  private readonly pendingWarnings: string[] = [];
  /** 已入队的目标快照（JSON 序列化）；用于识别「只有目标变了」的保存请求。 */
  private lastQueuedGoal = "null";

  constructor(
    sessionsDir = path.join(process.cwd(), ".haji", "sessions"),
    onWarning?: (message: string) => void,
  ) {
    this.sessionsDir = sessionsDir;
    this.warningHandler = onWarning;
    const now = new Date().toISOString();
    this.currentSession = {
      id: crypto.randomUUID(),
      title: "新对话会话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.ensureDir();
  }

  public setWarningHandler(handler: (message: string) => void): void {
    this.warningHandler = handler;
    for (const warning of this.pendingWarnings.splice(0)) handler(warning);
  }

  private warn(operation: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const warning = `${operation}：${detail}`;
    if (this.warningHandler) this.warningHandler(warning);
    else this.pendingWarnings.push(warning);
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    } catch (error) {
      this.warn("会话目录创建失败", error);
    }
  }

  private getSessionPath(id: string): string {
    return this.getSessionPathFor(this.sessionsDir, id);
  }

  private getSessionPathFor(dir: string, id: string): string {
    return path.join(dir, `session_${id}.json`);
  }

  /** 当前主会话目录（写盘目标）。 */
  public getSessionsDir(): string {
    return this.sessionsDir;
  }

  /**
   * 设置跨目录检索的附加会话目录：/resume、-c/-r 跨工作树发现并行会话用。
   * 只扩大 listSessions / loadSession 的查找范围，不改变写盘位置。
   */
  public setSearchDirs(dirs: string[]): void {
    const primary = path.resolve(this.sessionsDir);
    this.searchDirs = dirs.filter((dir) => path.resolve(dir) !== primary);
  }

  /**
   * 设置归档会话目录（`/worktree remove` 留下的 `.haji/worktree-archive/<名称>/sessions`）。
   * 与 setSearchDirs 的区别：原工作树已不存在，加载时把会话文件复制回主目录续写，
   * 而不是把主目录切过去（否则后续写盘会落进归档里）。
   */
  public setArchiveDirs(dirs: string[]): void {
    const primary = path.resolve(this.sessionsDir);
    this.archiveDirs = dirs.filter((dir) => path.resolve(dir) !== primary);
  }

  /** 会话是否只存在于归档目录（/resume 列表据此标注「已归档」）。 */
  public isArchivedSession(id: string): boolean {
    const dir = this.locateSessionDir(id);
    return (
      dir !== null &&
      this.archiveDirs.some((candidate) => path.resolve(candidate) === path.resolve(dir))
    );
  }

  /**
   * 把主会话目录切到别处：恢复其他 worktree 的会话后跟着会话走，
   * 后续保存写回会话原来的目录，避免同一会话在两棵树里各存一份。
   */
  public setSessionsDir(dir: string): void {
    this.sessionsDir = dir;
    this.ensureDir();
    const moved = path.resolve(dir);
    this.searchDirs = this.searchDirs.filter((candidate) => path.resolve(candidate) !== moved);
  }

  /** 先校验可恢复性，避免加载失败时已经切换目录或替换当前会话。 */
  private readSession(dir: string, id: string): StoredSession | null {
    try {
      const content = fs.readFileSync(this.getSessionPathFor(dir, id), "utf8");
      const session = JSON.parse(content);
      if (
        !session ||
        session.id !== id ||
        typeof session.title !== "string" ||
        !Array.isArray(session.messages) ||
        !session.messages.every(
          (message: ChatMessage) =>
            message &&
            ["system", "user", "assistant", "tool"].includes(message.role) &&
            typeof message.content === "string",
        ) ||
        !this.hasEffectiveMessages(session.messages)
      ) {
        return null;
      }
      // 同时验证工具调用可被快照复制；失败时不接纳这个副本。
      session.messages.map(cloneMessage);
      this.loadedVersions.set(session, crypto.createHash("sha256").update(content).digest("hex"));
      return session as StoredSession;
    } catch {
      return null;
    }
  }

  /** 与列表去重口径一致：选择最新可恢复副本，同时间优先主目录。 */
  public locateSessionDir(id: string): string | null {
    let selected: string | null = null;
    let latest = -Infinity;
    for (const dir of [this.sessionsDir, ...this.searchDirs, ...this.archiveDirs]) {
      const session = this.readSession(dir, id);
      if (!session) continue;
      const timestamp = new Date(session.updatedAt).getTime();
      const updatedAt = Number.isFinite(timestamp) ? timestamp : -Infinity;
      if (selected === null || updatedAt > latest) {
        selected = dir;
        latest = updatedAt;
      }
    }
    return selected;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, SESSION_FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  public hasEffectiveMessages(messages: ChatMessage[] = []): boolean {
    return messages.some((message) => message.role === "user" || message.role === "assistant");
  }

  public getCurrentSession(): StoredSession {
    return this.currentSession;
  }

  /**
   * 更新当前会话的用量记账（费用明细 / 压缩次数 / 上轮耗时）。
   * 只改内存并标脏：真正的落盘与消息一起由 flush 完成。
   */
  public setUsage(usage: SessionUsage): void {
    const compaction = usage.lastCompaction;
    this.currentSession.usage = {
      costRecords: usage.costRecords?.map((record) => ({ ...record })) ?? [],
      compactionCount: usage.compactionCount ?? 0,
      lastTurnMs: usage.lastTurnMs ?? 0,
      ...(compaction
        ? {
            lastCompaction: {
              ...compaction,
              layers: [...compaction.layers],
            },
          }
        : {}),
    };
  }

  /**
   * 更新当前会话的目标（undefined 表示清除）。只改内存并标脏：
   * 真正的落盘与消息一起由随后的 saveCurrentSession / flush 完成。
   */
  public setGoal(goal: SessionGoal | undefined): void {
    this.currentSession.goal = goal;
  }

  /** Updates memory immediately and coalesces disk writes for the same session. */
  public saveCurrentSession(messages: ChatMessage[], title?: string): void {
    if (title) this.currentSession.title = title;

    const usageKey = JSON.stringify(this.currentSession.usage ?? null);
    const goalKey = JSON.stringify(this.currentSession.goal ?? null);
    const unchanged =
      this.lastQueuedTitle === this.currentSession.title &&
      this.lastQueuedUsage === usageKey &&
      this.lastQueuedGoal === goalKey &&
      sameMessages(this.lastQueuedMessages, messages);
    if (unchanged) return;

    this.currentSession.messages = messages;
    this.currentSession.updatedAt = new Date().toISOString();
    const filePath = this.getSessionPath(this.currentSession.id);
    // 新会话只允许创建新文件；恢复会话的基线在 loadSession 时记录。
    if (!this.diskVersions.has(filePath)) this.diskVersions.set(filePath, null);
    // Keep one immutable snapshot for both duplicate detection and the
    // pending write. Cloning twice noticeably stalls long conversations.
    const snapshot = messages.map(cloneMessage);

    if (!this.hasEffectiveMessages(messages)) {
      this.pendingWrites.set(filePath, { remove: true });
    } else {
      this.pendingWrites.set(filePath, {
        session: {
          ...this.currentSession,
          messages: snapshot,
          ...(this.currentSession.usage
            ? {
                usage: {
                  costRecords: this.currentSession.usage.costRecords?.map((record) => ({
                    ...record,
                  })),
                  compactionCount: this.currentSession.usage.compactionCount,
                  lastTurnMs: this.currentSession.usage.lastTurnMs,
                  ...(this.currentSession.usage.lastCompaction
                    ? {
                        lastCompaction: {
                          ...this.currentSession.usage.lastCompaction,
                          layers: [...this.currentSession.usage.lastCompaction.layers],
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(this.currentSession.goal
            ? {
                goal: {
                  ...this.currentSession.goal,
                },
              }
            : {}),
        },
      });
    }

    this.lastQueuedMessages = snapshot;
    this.lastQueuedTitle = this.currentSession.title;
    this.lastQueuedUsage = usageKey;
    this.lastQueuedGoal = goalKey;
    this.scheduleFlush();
  }

  /** Forces all coalesced writes to disk; call before resume/list/exit boundaries. */
  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const operations = [...this.pendingWrites.entries()];
    this.pendingWrites.clear();
    let writeFailed = false;
    const completed = new Set<string>();
    if (operations.length > 0) {
      this.activeWrites++;
      this.writeChain = this.writeChain
        .then(async () => {
          const startedAt = performance.now();
          await fs.promises.mkdir(this.sessionsDir, { recursive: true });
          for (const [filePath, operation] of operations) {
            const unlock = acquireFileLock(filePath);
            const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
            try {
              const currentVersion = this.diskVersion(filePath);
              if (currentVersion !== this.diskVersions.get(filePath)) {
                throw new Error(
                  "会话写入冲突：文件已被其他进程更新；未覆盖磁盘数据，请先备份当前内容再恢复最新会话",
                );
              }
              if (operation.remove) {
                await fs.promises.rm(filePath, { force: true });
                this.diskVersions.set(filePath, null);
              } else if (operation.session) {
                const content = JSON.stringify(operation.session, null, 2);
                await fs.promises.writeFile(tempPath, content, "utf8");
                await replaceFileAtomically(tempPath, filePath);
                this.diskVersions.set(
                  filePath,
                  crypto.createHash("sha256").update(content).digest("hex"),
                );
              }
              // 已完成的操作不因后续文件写入失败而重新入队。
              completed.add(filePath);
            } finally {
              try {
                await fs.promises.rm(tempPath, { force: true });
              } finally {
                unlock();
              }
            }
          }
          performanceMonitor.record("session.flush", performance.now() - startedAt);
        })
        .catch((error) => {
          writeFailed = true;
          for (const [filePath, operation] of operations) {
            if (!completed.has(filePath) && !this.pendingWrites.has(filePath))
              this.pendingWrites.set(filePath, operation);
          }
          this.warn("会话持久化失败，数据已保留并将在下次保存时重试", error);
        })
        .finally(() => {
          this.activeWrites--;
        });
    }
    await this.writeChain;
    if (!writeFailed && this.pendingWrites.size > 0) await this.flush();
  }

  public loadSession(id: string): StoredSession | null {
    const dir = this.locateSessionDir(id);
    if (!dir) return null;
    try {
      const session = this.readSession(dir, id);
      if (!session) return null;
      const snapshot = session.messages.map(cloneMessage);
      const archived = this.archiveDirs.some(
        (candidate) => path.resolve(candidate) === path.resolve(dir),
      );
      if (archived) {
        // 归档会话：原工作树已删，复制回主目录继续写；归档副本保持原样。
        this.ensureDir();
        fs.copyFileSync(this.getSessionPathFor(dir, id), this.getSessionPath(id));
      } else if (path.resolve(dir) !== path.resolve(this.sessionsDir)) {
        // 命中附加目录（其他 worktree 的会话）：主目录跟着切过去，后续保存写回原处。
        this.setSessionsDir(dir);
      }
      this.diskVersions.set(this.getSessionPath(id), this.loadedVersions.get(session) ?? null);
      this.currentSession = session;
      this.lastQueuedMessages = snapshot;
      this.lastQueuedTitle = session.title;
      this.lastQueuedUsage = JSON.stringify(session.usage ?? null);
      this.lastQueuedGoal = JSON.stringify(session.goal ?? null);
      return session;
    } catch {
      return null;
    }
  }

  public listSessions(): StoredSession[] {
    try {
      this.ensureDir();
    } catch {
      /* 目录不可读时按空处理 */
    }
    const collected: StoredSession[] = [];
    // 主目录里没有有效消息的会话文件按原语义清掉；附加目录（别的 worktree）只读不删。
    for (const dir of [this.sessionsDir, ...this.searchDirs, ...this.archiveDirs]) {
      const isPrimary = path.resolve(dir) === path.resolve(this.sessionsDir);
      collected.push(...this.readSessionsFrom(dir, isPrimary));
    }
    // 同一 id 可能出现在多个目录（跨树恢复后两侧都有副本）：按 updatedAt 取最新。
    const byId = new Map<string, StoredSession>();
    for (const session of collected) {
      if (!session?.id) continue;
      const existing = byId.get(session.id);
      if (
        !existing ||
        new Date(session.updatedAt).getTime() > new Date(existing.updatedAt).getTime()
      ) {
        byId.set(session.id, session);
      }
    }
    return [...byId.values()].sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
  }

  /** 读取单个目录下的会话文件；mayDeleteEmpty 只对主目录开启（附加目录只读）。 */
  private readSessionsFrom(dir: string, mayDeleteEmpty: boolean): StoredSession[] {
    let files: string[];
    try {
      files = fs
        .readdirSync(dir)
        .filter((file) => file.startsWith("session_") && file.endsWith(".json"));
    } catch {
      return [];
    }
    const sessions: StoredSession[] = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const session = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredSession;
        const valid = session?.id ? this.readSession(dir, session.id) : null;
        if (valid) {
          sessions.push(valid);
        } else if (
          mayDeleteEmpty &&
          session &&
          Array.isArray(session.messages) &&
          session.messages.every(
            (message: ChatMessage) => message && typeof message.role === "string",
          ) &&
          !this.hasEffectiveMessages(session.messages)
        ) {
          try {
            fs.unlinkSync(filePath);
          } catch {}
        }
      } catch {}
    }
    return sessions;
  }

  /** Persist the fork before switching; inherited history cannot roll back the source's files. */
  public async forkCurrentSession(title?: string): Promise<StoredSession> {
    await this.flush();
    if (this.hasPendingWrites()) throw new Error("当前会话仍有未保存数据，未创建分叉。");
    if (!this.hasEffectiveMessages(this.currentSession.messages)) {
      throw new Error("当前会话暂无可分叉的对话。");
    }
    const source = this.currentSession;
    const fork: StoredSession = structuredClone(source);
    fork.id = crypto.randomUUID();
    fork.title = title?.trim() || `${source.title}（分叉）`;
    fork.createdAt = fork.updatedAt = new Date().toISOString();
    for (const message of fork.messages) delete message.snapshotId;
    // Historical requests belong to the source; retain only context compaction metadata.
    if (fork.usage) {
      fork.usage.costRecords = [];
      fork.usage.lastTurnMs = 0;
    }
    const filePath = this.getSessionPath(fork.id);
    writeFileAtomicallySync(filePath, JSON.stringify(fork, null, 2));
    this.diskVersions.set(filePath, this.diskVersion(filePath));
    this.currentSession = fork;
    this.lastQueuedMessages = [];
    this.lastQueuedTitle = "";
    this.lastQueuedUsage = "null";
    this.lastQueuedGoal = "null";
    return fork;
  }

  public startNewSession(): StoredSession {
    const now = new Date().toISOString();
    this.currentSession = {
      id: crypto.randomUUID(),
      title: "新对话会话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.lastQueuedMessages = [];
    this.lastQueuedTitle = "";
    this.lastQueuedUsage = "null";
    this.lastQueuedGoal = "null";
    return this.currentSession;
  }

  public async generateTitleAsync(
    firstUserMsg: string,
    titleSummarizer?: (prompt: string) => Promise<string>,
  ): Promise<string> {
    const defaultTitle =
      firstUserMsg.length > 25 ? `${firstUserMsg.slice(0, 25)}...` : firstUserMsg;
    if (!titleSummarizer) {
      this.currentSession.title = defaultTitle;
      this.saveCurrentSession(this.currentSession.messages);
      return defaultTitle;
    }

    try {
      const prompt = `请针对以下用户的第一条需求，总结出一个 10 以内的简短形象标题。注意：直接回答标题本身，不要包含任何标点符号、解释或多余字符。\n\n需求：${firstUserMsg}`;
      const generated = await titleSummarizer(prompt);
      const cleanTitle = cleanGeneratedTitle(generated, defaultTitle);
      this.currentSession.title = cleanTitle;
      this.saveCurrentSession(this.currentSession.messages);
      return cleanTitle;
    } catch {
      this.currentSession.title = defaultTitle;
      this.saveCurrentSession(this.currentSession.messages);
      return defaultTitle;
    }
  }
}
