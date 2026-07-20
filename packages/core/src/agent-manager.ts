import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { formatSubagentResult, SubagentResult, SubagentRole } from './subagent-runner.js';

export type AgentStatus =
  | 'queued'
  | 'running'
  | 'awaiting_verification'
  | 'verified'
  | 'rejected'
  | 'failed'
  | 'aborted';

export type AgentAccess = 'readonly' | 'workspace-write';

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentRecord {
  id: string;
  role: SubagentRole;
  description: string;
  taskId?: string;
  background: boolean;
  access: AgentAccess;
  status: AgentStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  currentTool?: string;
  timeoutMs?: number;
  usage: AgentUsage;
  result?: SubagentResult;
  verification?: {
    verdict: 'verified' | 'rejected';
    evidence: string;
    evidenceToolCallIds: string[];
    verifiedAt: number;
  };
}

export const AGENT_VERIFICATION_CONTEXT_START = '[当前未验证子代理状态]';
export const AGENT_VERIFICATION_CONTEXT_END = '[当前未验证子代理状态结束]';

/** Builds a durable prompt fragment from AgentManager state instead of chat-history side effects. */
export function formatPendingAgentVerificationContext(records: readonly AgentRecord[]): string {
  const pending = records.filter(record => record.status === 'awaiting_verification' && record.result);
  if (pending.length === 0) return '';
  return [
    AGENT_VERIFICATION_CONTEXT_START,
    '以下子代理结果尚未验证。父 Agent 必须独立调用 read、grep、bash 等工具检查关键结论，再使用工具结果中明确给出的 verification_evidence_id 调用 verifyagent。',
    ...pending.map(record => [
      `Agent ${record.id}（${record.role}）：${record.description}`,
      formatSubagentResult(record.result!)
    ].join('\n')),
    AGENT_VERIFICATION_CONTEXT_END
  ].join('\n\n');
}

interface ParentEvidence {
  toolCallId: string;
  toolName: string;
  timestamp: number;
  consumedByAgentId?: string;
}

interface PersistedAgentState {
  version: 1;
  records: AgentRecord[];
  parentEvidence: ParentEvidence[];
}

type ReadAgentStateResult =
  | { status: 'missing'; records: AgentRecord[]; parentEvidence: ParentEvidence[]; legacy: false }
  | { status: 'loaded'; records: AgentRecord[]; parentEvidence: ParentEvidence[]; legacy: boolean }
  | { status: 'error'; error: Error };

const AGENT_STATUSES = new Set<AgentStatus>([
  'queued', 'running', 'awaiting_verification', 'verified', 'rejected', 'failed', 'aborted'
]);

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_SUBAGENT_TIMEOUT_MS = 100;
export const MAX_SUBAGENT_TIMEOUT_MS = 60 * 60 * 1000;

export function normalizeSubagentTimeoutMs(
  value: number | undefined,
  fallback = DEFAULT_SUBAGENT_TIMEOUT_MS
): number {
  const candidate = Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
  return Math.max(MIN_SUBAGENT_TIMEOUT_MS, Math.min(MAX_SUBAGENT_TIMEOUT_MS, Math.trunc(candidate)));
}

function isAgentRecord(value: unknown): value is AgentRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AgentRecord>;
  const usage = record.usage as Partial<AgentUsage> | undefined;
  return typeof record.id === 'string'
    && ['research', 'review', 'implement'].includes(String(record.role))
    && typeof record.description === 'string'
    && typeof record.background === 'boolean'
    && ['readonly', 'workspace-write'].includes(String(record.access))
    && AGENT_STATUSES.has(record.status as AgentStatus)
    && Number.isFinite(record.createdAt)
    && (record.timeoutMs === undefined || Number.isFinite(record.timeoutMs))
    && Boolean(usage)
    && Number.isFinite(usage?.promptTokens)
    && Number.isFinite(usage?.completionTokens)
    && Number.isFinite(usage?.totalTokens);
}

function isParentEvidence(value: unknown): value is ParentEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ParentEvidence>;
  return typeof item.toolCallId === 'string'
    && typeof item.toolName === 'string'
    && Number.isFinite(item.timestamp)
    && (item.consumedByAgentId === undefined || typeof item.consumedByAgentId === 'string');
}

export interface AgentNotification {
  id: string;
  agentId: string;
  type: 'completed' | 'failed' | 'aborted' | 'verified' | 'rejected';
  message: string;
  createdAt: number;
  background: boolean;
}

export interface AgentLaunchRequest {
  role: SubagentRole;
  description: string;
  taskId?: string;
  background: boolean;
  access: AgentAccess;
  parentSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgentLaunch {
  agent: AgentRecord;
  completion: Promise<AgentRecord>;
}

export interface AgentExecutionContext {
  agentId: string;
  signal: AbortSignal;
}

type AgentExecutor = (context: AgentExecutionContext) => Promise<SubagentResult>;

interface RuntimeEntry {
  controller: AbortController;
  executor: AgentExecutor;
  resolve: (record: AgentRecord) => void;
  parentSignal?: AbortSignal;
  parentAbort?: () => void;
  timeoutMs: number;
  timeoutHandle?: NodeJS.Timeout;
}

export interface AgentManagerOptions {
  agentsDir?: string;
  maxReadonlyConcurrency?: number;
  onChange?: (agents: AgentRecord[]) => void;
  onNotification?: (notification: AgentNotification) => void;
  onWarning?: (message: string) => void;
}

/** Owns child-agent lifecycle, read-only concurrency and verification evidence. */
export class AgentManager {
  private scope = 'default';
  private readonly records = new Map<string, AgentRecord>();
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly queue: string[] = [];
  private readonly notifications: AgentNotification[] = [];
  private readonly parentEvidence: ParentEvidence[] = [];
  private readonly agentsDir: string;
  private readonly maxReadonlyConcurrency: number;
  private persistenceBlocked = false;

  constructor(private readonly options: AgentManagerOptions = {}) {
    this.agentsDir = options.agentsDir || path.join(process.cwd(), '.haji', 'agents');
    this.maxReadonlyConcurrency = Math.max(1, Math.min(3, options.maxReadonlyConcurrency || 3));
  }

  setScope(scope: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(scope)) throw new Error('无效的 Agent 作用域');
    let previousScopeChanged = false;
    for (const [id, runtime] of this.runtimes) {
      runtime.controller.abort();
      if (runtime.timeoutHandle) clearTimeout(runtime.timeoutHandle);
      if (runtime.parentSignal && runtime.parentAbort) runtime.parentSignal.removeEventListener('abort', runtime.parentAbort);
      const record = this.records.get(id);
      if (record) {
        record.status = 'aborted';
        record.finishedAt = Date.now();
        runtime.resolve(this.copy(record));
        previousScopeChanged = true;
      }
    }
    this.runtimes.clear();
    if (previousScopeChanged) this.persist();

    this.scope = scope;
    this.records.clear();
    this.queue.length = 0;
    this.notifications.length = 0;
    this.parentEvidence.length = 0;
    this.persistenceBlocked = false;

    const state = this.readState();
    if (state.status === 'error') {
      this.persistenceBlocked = true;
      this.options.onWarning?.(
        `Agent 状态文件读取失败，已保留原文件且暂停该会话的 Agent 持久化：${state.error.message}`
      );
      this.emitChange();
      return;
    }

    let normalizedRuntimeState = false;
    for (const record of state.records) {
      if (record.status === 'running' || record.status === 'queued') {
        record.status = 'aborted';
        record.finishedAt = Date.now();
        normalizedRuntimeState = true;
      }
      this.records.set(record.id, record);
    }
    this.parentEvidence.push(...state.parentEvidence.slice(-200));
    if (state.status === 'missing' || state.legacy || normalizedRuntimeState) this.persist();
    this.emitChange();
  }

  launch(request: AgentLaunchRequest, executor: AgentExecutor): AgentLaunch {
    const id = `sub-${randomUUID().slice(0, 8)}`;
    const timeoutMs = normalizeSubagentTimeoutMs(request.timeoutMs);
    const record: AgentRecord = {
      id,
      role: request.role,
      description: request.description.trim(),
      taskId: request.taskId,
      background: request.background,
      access: request.access,
      timeoutMs,
      status: 'queued',
      createdAt: Date.now(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
    if (!record.description) throw new Error('子代理任务描述不能为空');
    if (request.background && request.access !== 'readonly') {
      throw new Error('第一版后台 Agent 仅支持只读访问');
    }
    if (request.access === 'workspace-write' && [...this.records.values()].some(item => ['queued', 'running'].includes(item.status))) {
      throw new Error('写入型 Agent 不能与其他子代理并行；请等待或中止现有 Agent');
    }

    let resolveCompletion!: (value: AgentRecord) => void;
    const completion = new Promise<AgentRecord>(resolve => { resolveCompletion = resolve; });
    const runtime: RuntimeEntry = {
      controller: new AbortController(),
      executor,
      resolve: resolveCompletion,
      parentSignal: request.parentSignal,
      timeoutMs
    };
    if (request.parentSignal) {
      runtime.parentAbort = () => this.abort(id);
      request.parentSignal.addEventListener('abort', runtime.parentAbort, { once: true });
    }
    this.records.set(id, record);
    this.runtimes.set(id, runtime);

    if (this.shouldQueue(record)) {
      this.queue.push(id);
      this.persistAndEmit();
    } else {
      this.start(id);
    }
    return { agent: this.copy(record), completion };
  }

  list(): AgentRecord[] {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(record => this.copy(record));
  }

  get(agentId: string): AgentRecord | undefined {
    const record = this.records.get(agentId);
    return record ? this.copy(record) : undefined;
  }

  updateTool(agentId: string, toolName: string): void {
    const record = this.records.get(agentId);
    if (!record || record.status !== 'running') return;
    record.currentTool = toolName;
    this.persistAndEmit();
  }

  addUsage(agentId: string, usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): void {
    const record = this.records.get(agentId);
    if (!record) return;
    record.usage.promptTokens += usage.prompt_tokens || 0;
    record.usage.completionTokens += usage.completion_tokens || 0;
    record.usage.totalTokens += usage.total_tokens || 0;
    this.persistAndEmit();
  }

  abort(agentId: string): boolean {
    const record = this.records.get(agentId);
    const runtime = this.runtimes.get(agentId);
    if (!record || !runtime || !['queued', 'running'].includes(record.status)) return false;
    runtime.controller.abort();
    if (record.status === 'queued') {
      const index = this.queue.indexOf(agentId);
      if (index >= 0) this.queue.splice(index, 1);
      this.finishRuntime(record, runtime, 'aborted', undefined);
      this.pump();
    }
    return true;
  }

  abortAll(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (this.abort(record.id)) count += 1;
    }
    return count;
  }

  clearFinished(): number {
    let count = 0;
    for (const [id, record] of this.records) {
      if (['verified', 'rejected', 'failed', 'aborted'].includes(record.status)) {
        this.records.delete(id);
        count += 1;
      }
    }
    if (count > 0) this.persistAndEmit();
    return count;
  }

  recordParentEvidence(toolCallId: string, toolName: string, timestamp = Date.now()): void {
    if (!toolCallId || ['subagent', 'verifyagent'].includes(toolName) || toolName.startsWith('task')) return;
    if (this.parentEvidence.some(item => item.toolCallId === toolCallId)) return;
    this.parentEvidence.push({ toolCallId, toolName, timestamp });
    if (this.parentEvidence.length > 200) this.parentEvidence.splice(0, this.parentEvidence.length - 200);
    try {
      this.persist();
    } catch (error) {
      this.options.onWarning?.(`验证证据持久化失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  verify(
    agentId: string,
    verdict: 'verified' | 'rejected',
    evidence: string,
    evidenceToolCallIds: readonly string[]
  ): AgentRecord {
    const record = this.records.get(agentId);
    if (!record) throw new Error(`Agent 不存在: ${agentId}`);
    if (record.status !== 'awaiting_verification') throw new Error(`Agent ${agentId} 当前不等待验证`);
    if (!evidence.trim()) throw new Error('必须提供父 Agent 的独立验证证据');
    const requestedIds = [...new Set(evidenceToolCallIds.map(id => id.trim()).filter(Boolean))];
    if (requestedIds.length === 0) {
      throw new Error('必须提供至少一个 evidenceToolCallId，将独立验证工具调用绑定到该 Agent');
    }
    const evidenceItems = requestedIds.map(toolCallId => {
      const item = this.parentEvidence.find(candidate => candidate.toolCallId === toolCallId);
      if (!item) throw new Error(`验证证据不存在或不是父 Agent 工具调用: ${toolCallId}`);
      if (item.timestamp < (record.finishedAt || 0)) throw new Error(`验证证据早于子代理完成时间: ${toolCallId}`);
      if (item.consumedByAgentId) throw new Error(`验证证据 ${toolCallId} 已被 Agent ${item.consumedByAgentId} 使用`);
      return item;
    });
    for (const item of evidenceItems) item.consumedByAgentId = agentId;
    record.status = verdict;
    record.verification = {
      verdict,
      evidence: evidence.trim(),
      evidenceToolCallIds: requestedIds,
      verifiedAt: Date.now()
    };
    this.notify(record, verdict, verdict === 'verified' ? '父 Agent 已独立验证结果' : '父 Agent 已拒绝结果');
    this.persistAndEmit();
    return this.copy(record);
  }

  drainNotifications(): AgentNotification[] {
    return this.notifications.splice(0).map(item => ({ ...item }));
  }

  private shouldQueue(record: AgentRecord): boolean {
    if (record.access !== 'readonly') return false;
    const writeRunning = [...this.records.values()].some(item => item.status === 'running' && item.access === 'workspace-write');
    return writeRunning || this.runningReadonlyCount() >= this.maxReadonlyConcurrency;
  }

  private runningReadonlyCount(): number {
    return [...this.records.values()].filter(record => record.status === 'running' && record.access === 'readonly').length;
  }

  private start(agentId: string): void {
    const record = this.records.get(agentId);
    const runtime = this.runtimes.get(agentId);
    if (!record || !runtime || runtime.controller.signal.aborted) return;
    record.status = 'running';
    record.startedAt = Date.now();
    this.persistAndEmit();
    runtime.timeoutHandle = setTimeout(() => {
      if (this.runtimes.get(agentId) !== runtime) return;
      const timeoutError = new Error(`子代理运行超过 ${runtime.timeoutMs}ms，已自动中止。`);
      timeoutError.name = 'TimeoutError';
      runtime.controller.abort(timeoutError);
      const result: SubagentResult = {
        agentId,
        status: 'aborted',
        summary: timeoutError.message,
        filesChanged: [],
        verification: [],
        unresolved: ['timeout']
      };
      this.finishRuntime(record, runtime, 'aborted', result);
    }, runtime.timeoutMs);
    void runtime.executor({ agentId, signal: runtime.controller.signal })
      .then(result => {
        if (this.runtimes.get(agentId) !== runtime) return;
        const aborted = runtime.controller.signal.aborted || result.status === 'aborted';
        const status: AgentStatus = aborted
          ? 'aborted'
          : result.status === 'completed'
            ? 'awaiting_verification'
            : 'failed';
        this.finishRuntime(record, runtime, status, result);
      })
      .catch(error => {
        if (this.runtimes.get(agentId) !== runtime) return;
        const aborted = runtime.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        const result: SubagentResult = {
          agentId,
          status: aborted ? 'aborted' : 'failed',
          summary: aborted ? '子代理已被中止。' : `子代理失败：${error instanceof Error ? error.message : String(error)}`,
          filesChanged: [], verification: [], unresolved: [aborted ? 'aborted' : 'runtime_error']
        };
        this.finishRuntime(record, runtime, aborted ? 'aborted' : 'failed', result);
      });
  }

  private finishRuntime(record: AgentRecord, runtime: RuntimeEntry, status: AgentStatus, result?: SubagentResult): void {
    record.status = status;
    record.finishedAt = Date.now();
    record.currentTool = undefined;
    if (result) record.result = result;
    if (runtime.timeoutHandle) clearTimeout(runtime.timeoutHandle);
    if (runtime.parentSignal && runtime.parentAbort) runtime.parentSignal.removeEventListener('abort', runtime.parentAbort);
    this.runtimes.delete(record.id);
    runtime.resolve(this.copy(record));
    const type = status === 'awaiting_verification' ? 'completed' : status === 'aborted' ? 'aborted' : 'failed';
    this.notify(record, type, status === 'awaiting_verification' ? '子代理已完成，等待父 Agent 独立验证' : result?.summary || status);
    this.persistAndEmit();
    this.pump();
  }

  private pump(): void {
    while (this.queue.length > 0 && this.runningReadonlyCount() < this.maxReadonlyConcurrency) {
      const id = this.queue.shift()!;
      this.start(id);
    }
  }

  private notify(record: AgentRecord, type: AgentNotification['type'], message: string): void {
    const notification: AgentNotification = {
      id: randomUUID(), agentId: record.id, type, message, createdAt: Date.now(), background: record.background
    };
    if (record.background) this.notifications.push(notification);
    this.options.onNotification?.(notification);
  }

  private copy(record: AgentRecord): AgentRecord {
    return JSON.parse(JSON.stringify(record)) as AgentRecord;
  }

  private emitChange(): void {
    this.options.onChange?.(this.list());
  }

  private persistAndEmit(): void {
    this.persist();
    this.emitChange();
  }

  private persist(): void {
    if (this.persistenceBlocked) return;
    fs.mkdirSync(this.agentsDir, { recursive: true });
    const targetPath = this.filePath();
    const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    const state: PersistedAgentState = {
      version: 1,
      records: this.list(),
      parentEvidence: this.parentEvidence.map(item => ({ ...item }))
    };
    let fd: number | undefined;
    try {
      fd = fs.openSync(tempPath, 'w');
      fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
  }

  private readState(): ReadAgentStateResult {
    try {
      if (!fs.existsSync(this.filePath())) {
        return { status: 'missing', records: [], parentEvidence: [], legacy: false };
      }
      const value: unknown = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
      if (Array.isArray(value)) {
        if (!value.every(isAgentRecord)) throw new Error('旧版 Agent 记录包含无效项目');
        return { status: 'loaded', records: value as AgentRecord[], parentEvidence: [], legacy: true };
      }
      if (!value || typeof value !== 'object') throw new Error('根节点不是对象或旧版数组');
      const state = value as Partial<PersistedAgentState>;
      if (state.version !== 1 || !Array.isArray(state.records) || !Array.isArray(state.parentEvidence)) {
        throw new Error('状态文件结构或版本无效');
      }
      if (!state.records.every(isAgentRecord)) throw new Error('Agent 记录包含无效项目');
      if (!state.parentEvidence.every(isParentEvidence)) throw new Error('验证证据账本包含无效项目');
      return { status: 'loaded', records: state.records, parentEvidence: state.parentEvidence, legacy: false };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  private filePath(): string {
    return path.join(this.agentsDir, `${this.scope}.json`);
  }
}
