import { ChatMessage, ModelProvider } from './types.js';
import { ExperienceStore, tokenize, jaccardSimilarity } from './experience-store.js';
import {
  Instinct,
  InstinctDomain,
  Memory,
  ToolObservation,
  DistillSummary
} from './experience-types.js';

/**
 * 模式提炼引擎（文章的 Instinct Engine）。
 *
 * 双路径提炼，由会话结束时调用：
 *   - 路径 A：统计模式检测（零 token，硬编码高频模式）
 *   - 路径 B：LLM 语义分析（智能触发：仅当有失败样本或新观测≥20条时才消耗 token）
 *
 * 提炼产出的规则交由 ExperienceStore.evolveInstincts() 做置信度演化与持久化。
 */

/** LLM 路径的触发阈值：本会话观测数达到此值才触发。 */
const LLM_TRIGGER_MIN_OBS = 20;
/** LLM 路径的失败样本触发门槛：单次失败不触发，避免日常小错每次都烧 token。 */
const LLM_TRIGGER_MIN_FAILURES = 2;
/** LLM 调用的超时时间，避免阻塞退出过久。 */
const LLM_TIMEOUT_MS = 30_000;
/** 统计检测器触发所需的最低出现次数。 */
const STATISTICAL_MIN_OCCURRENCES = 2;

/**
 * 工具注册名常量（与 packages/plugins/src/*-tool.ts 的 definition.function.name 一致）。
 * 集中管理避免检测器里硬编码字面量与运行时漂移——历史教训：早期版本写成
 * 'Edit'/'ReadFile'/'WriteFile'/'Bash'/'GrepSearch' 全部失效。
 */
const TOOL = {
  READ: 'read',
  EDIT: 'edit',
  WRITE: 'write',
  BASH: 'bash',
  GREP: 'grep',
  SUBAGENT: 'subagent',
  VERIFY: 'verifyagent'
} as const;

export interface DistillEngineOptions {
  store: ExperienceStore;
  /** 闭包按需取 provider，避免 /model 切换后持有失效引用。返回 null 时跳过 LLM 路径。 */
  provider: () => ModelProvider | null;
  /** 闭包按需取当前模型名。 */
  model: () => string;
  /** 可选日志回调（用于向用户反馈提炼进度）。 */
  logger?: (message: string) => void;
}

export class DistillEngine {
  constructor(private readonly options: DistillEngineOptions) {}

  /**
   * 主入口：会话结束时调用。
   * 分析本会话观测，提炼规则与记忆候选，更新 store。
   */
  async runDistill(
    sessionObservations: ToolObservation[],
    context: { messages: ChatMessage[]; cwd: string; sessionId: string }
  ): Promise<DistillSummary> {
    const notes: string[] = [];
    if (sessionObservations.length === 0) {
      return emptySummary('本会话无工具观测，跳过提炼');
    }

    // 路径 A：统计模式检测（始终运行，零成本）
    const statisticalInstincts = this.detectStatisticalPatterns(sessionObservations);
    notes.push(`统计路径检测到 ${statisticalInstincts.length} 条候选规则`);

    // 路径 B：LLM 语义分析（智能触发：失败数达门槛 或 观测数足够大才烧 token）
    const failedCount = sessionObservations.filter(o => o.failed).length;
    const shouldTriggerLLM = failedCount >= LLM_TRIGGER_MIN_FAILURES || sessionObservations.length >= LLM_TRIGGER_MIN_OBS;
    let llmInstincts: Instinct[] = [];
    let memoryCandidates: Memory[] = [];
    let llmTriggered = false;

    if (shouldTriggerLLM) {
      llmTriggered = true;
      try {
        const result = await this.analyzeWithLLM(sessionObservations, context.messages);
        llmInstincts = result.instincts;
        memoryCandidates = result.memories;
        notes.push(`LLM 路径产出 ${llmInstincts.length} 条规则、${memoryCandidates.length} 条记忆候选`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        notes.push(`LLM 路径失败（已跳过）：${detail}`);
      }
    } else {
      notes.push(`LLM 路径未触发（失败 ${failedCount} 次，观测 ${sessionObservations.length} 条，阈值 ${LLM_TRIGGER_MIN_OBS}）`);
    }

    // 合并两条路径的规则，做语义去重后演化
    const allDetected = this.deduplicateInstincts([...statisticalInstincts, ...llmInstincts]);
    const { reinforced } = await this.options.store.evolveInstincts(allDetected);

    // 记忆候选写入 staging（等用户 /memory confirm）
    for (const mem of memoryCandidates) {
      await this.options.store.stageMemory(mem);
    }

    const summary: DistillSummary = {
      statisticalInstincts: statisticalInstincts.length,
      llmInstincts: llmInstincts.length,
      memoryCandidates: memoryCandidates.length,
      reinforced: reinforced.size,
      llmTriggered,
      notes
    };
    this.options.logger?.(formatSummaryLine(summary));
    return summary;
  }

  // ─── 路径 A：统计模式检测 ──────────────────────────────────────────────────

  /**
   * 硬编码的高频模式检测器。
   * 每个检测器扫描观测序列，识别出现次数达阈值的模式，产出 Instinct 候选。
   */
  private detectStatisticalPatterns(obs: ToolObservation[]): Instinct[] {
    const results: Instinct[] = [];
    const detectors = [
      this.detectEditBeforeRead.bind(this),
      this.detectBashFailureRetry.bind(this),
      this.detectGrepThenRead.bind(this),
      this.detectSubagentVerify.bind(this),
      this.detectRepeatedWriteReplace.bind(this),
      this.detectFailedPatternCluster.bind(this)
    ];
    for (const detector of detectors) {
      try {
        const detected = detector(obs);
        results.push(...detected);
      } catch {
        // 单个检测器出错不影响其他
      }
    }
    return results;
  }

  /**
   * 模式 1：Edit 前缺 Read。
   * 若 Edit 调用前短期内没有 Read 同一文件，且出现≥2 次，强化"先读后改"。
   */
  private detectEditBeforeRead(obs: ToolObservation[]): Instinct[] {
    const edits = obs.filter(o => o.toolName === TOOL.EDIT);
    if (edits.length < STATISTICAL_MIN_OCCURRENCES) return [];
    let missingRead = 0;
    for (const edit of edits) {
      const filePath = String(edit.args?.file_path || edit.args?.path || '');
      if (!filePath) continue;
      // 查找同会话、同文件、Edit 之前 5 分钟内的 Read
      const editTime = new Date(edit.ts).getTime();
      const hasPriorRead = obs.some(o =>
        o.toolName === TOOL.READ
        && String(o.args?.file_path || o.args?.path || '') === filePath
        && new Date(o.ts).getTime() <= editTime
        && editTime - new Date(o.ts).getTime() < 5 * 60 * 1000
      );
      if (!hasPriorRead) missingRead++;
    }
    if (missingRead < STATISTICAL_MIN_OCCURRENCES) return [];
    return [makeInstinct(
      'edit-before-read',
      'workflow',
      '当要 Edit 一个文件时（尤其是较长文件或会话外有过改动）',
      '先调用 Read 读取该文件当前内容，再执行 Edit，避免基于过时内容产生错误修改'
    )];
  }

  /**
   * 模式 2：Bash 命令失败后重试成功。
   * 识别"失败→（修正）→成功"序列，提取前置检查建议。
   */
  private detectBashFailureRetry(obs: ToolObservation[]): Instinct[] {
    const bash = obs.filter(o => o.toolName === TOOL.BASH);
    const failedCommands = bash.filter(o => o.failed);
    if (failedCommands.length === 0) return [];
    const retryPatterns = new Set<string>();
    for (const fail of failedCommands) {
      const cmd = normalizeCommand(String(fail.args?.command || ''));
      if (!cmd) continue;
      // 查找后续相同命令前缀的成功调用
      const failTime = new Date(fail.ts).getTime();
      const retrySucceeded = bash.some(o =>
        !o.failed
        && normalizeCommand(String(o.args?.command || '')).startsWith(cmd.slice(0, 30))
        && new Date(o.ts).getTime() > failTime
      );
      if (retrySucceeded) retryPatterns.add(cmd.slice(0, 40));
    }
    if (retryPatterns.size < 1) return [];
    return [makeInstinct(
      'bash-retry-after-check',
      'error-prevention',
      '当执行 Bash 命令（尤其是 install/build/test 类）失败时',
      '先检查错误信息中的依赖缺失、路径错误或权限问题，修正后再重试；避免反复触发相同错误'
    )];
  }

  /**
   * 模式 3：Grep 命中后 Read 确认。
   */
  private detectGrepThenRead(obs: ToolObservation[]): Instinct[] {
    const greps = obs.filter(o => o.toolName === TOOL.GREP && !o.failed);
    if (greps.length < STATISTICAL_MIN_OCCURRENCES) return [];
    let followedByRead = 0;
    for (const grep of greps) {
      const grepTime = new Date(grep.ts).getTime();
      const hasFollowUpRead = obs.some(o =>
        o.toolName === TOOL.READ
        && Math.abs(new Date(o.ts).getTime() - grepTime) < 5 * 60 * 1000
        && new Date(o.ts).getTime() > grepTime
      );
      if (hasFollowUpRead) followedByRead++;
    }
    if (followedByRead < STATISTICAL_MIN_OCCURRENCES) return [];
    return [makeInstinct(
      'grep-then-read-confirm',
      'workflow',
      '当用 Grep 搜索到匹配结果后',
      '对关键匹配项调用 Read 读取上下文，确认匹配语义而非仅靠字面量判断'
    )];
  }

  /**
   * 模式 4：subagent 后必有 verifyagent。
   */
  private detectSubagentVerify(obs: ToolObservation[]): Instinct[] {
    const subagentCalls = obs.filter(o => o.toolName === TOOL.SUBAGENT && !o.failed);
    if (subagentCalls.length < STATISTICAL_MIN_OCCURRENCES) return [];
    let missingVerify = 0;
    for (const sub of subagentCalls) {
      const subTime = new Date(sub.ts).getTime();
      const hasVerify = obs.some(o =>
        o.toolName === TOOL.VERIFY
        && new Date(o.ts).getTime() > subTime
      );
      if (!hasVerify) missingVerify++;
    }
    if (missingVerify < STATISTICAL_MIN_OCCURRENCES) return [];
    return [makeInstinct(
      'verify-subagent-result',
      'workflow',
      '当子代理（subagent）返回结果后',
      '使用 verifyagent 工具独立验证子代理结论，不要直接采信未验证的子代理输出'
    )];
  }

  /**
   * 模式 5：连续 Write 同文件（应改用 Edit）。
   */
  private detectRepeatedWriteReplace(obs: ToolObservation[]): Instinct[] {
    const writes = obs.filter(o => o.toolName === TOOL.WRITE && !o.failed);
    const byFile = new Map<string, number>();
    for (const w of writes) {
      const filePath = String(w.args?.file_path || w.args?.path || '');
      if (!filePath) continue;
      byFile.set(filePath, (byFile.get(filePath) || 0) + 1);
    }
    const repeated = Array.from(byFile.entries()).filter(([, count]) => count >= STATISTICAL_MIN_OCCURRENCES);
    if (repeated.length === 0) return [];
    return [makeInstinct(
      'use-edit-not-repeated-write',
      'code-style',
      '当同一文件在会话内被多次完整重写',
      '改用 Edit 工具做局部修改，避免 Write 整文件覆盖引入回归风险，也减少 token 消耗'
    )];
  }

  /**
   * 模式 6：同 tool 同错误模式聚集（≥3次）。
   * 这是错误预防的核心：把反复出错的场景固化为前置检查规则。
   */
  private detectFailedPatternCluster(obs: ToolObservation[]): Instinct[] {
    const failed = obs.filter(o => o.failed);
    const clusters = new Map<string, ToolObservation[]>();
    for (const f of failed) {
      const signature = `${f.toolName}:${extractErrorSignature(f.output)}`;
      if (!clusters.has(signature)) clusters.set(signature, []);
      clusters.get(signature)!.push(f);
    }
    const results: Instinct[] = [];
    for (const [signature, samples] of clusters) {
      if (samples.length < 3) continue;
      const [toolName, errorSig] = signature.split(':');
      const sampleCmd = samples[0].args?.command || samples[0].args?.file_path || samples[0].args?.path || '';
      const hint = sampleSuggestHint(toolName, errorSig, String(sampleCmd));
      results.push(makeInstinct(
        `error-cluster-${toolName}-${errorSig}`.slice(0, 60),
        'error-prevention',
        `当调用 ${toolName} 且可能触发 ${errorSig} 类错误时`,
        hint
      ));
    }
    return results;
  }

  // ─── 路径 B：LLM 语义分析 ──────────────────────────────────────────────────

  /**
   * 用 LLM 分析观测摘要，捕获统计路径无法识别的深层模式。
   * 照抄 summarizeMessagesForCompaction 的 provider.complete() 调用形状。
   */
  private async analyzeWithLLM(
    obs: ToolObservation[],
    messages: ChatMessage[]
  ): Promise<{ instincts: Instinct[]; memories: Memory[] }> {
    const provider = this.options.provider();
    if (!provider) return { instincts: [], memories: [] };

    const obsDigest = this.buildObservationDigest(obs);
    const recentMessages = messages.slice(-12).map(m => `[${m.role}] ${m.content.slice(0, 300)}`).join('\n');

    const instruction = [
      '你是编程行为分析器。分析下面的工具调用观测与对话摘要，提炼可复用的行为规则与项目知识。',
      '只输出 JSON，不要任何解释文字。格式：',
      '{"instincts":[{"id":"kebab-case-id","trigger":"触发条件","action":"建议动作","domain":"workflow|testing|git|code-style|project-context|error-prevention|other"}],"memories":[{"id":"kebab-case-id","name":"简短名称","type":"user|project|feedback","content":"详细内容，可含 Why 与 How to apply"}]}',
      '要求：',
      '- instinct 的 id 必须是稳定的 kebab-case，同一模式每次产出相同 id（用于置信度累积）',
      '- 只提炼有复用价值的模式，忽略一次性事件；trigger 要具体可判定',
      '- memories 只提取确实有价值的项目事实或用户偏好，宁缺毋滥',
      '- 失败样本应优先提炼为 error-prevention 类 instinct',
      '- 最多输出 5 条 instinct 和 3 条 memory'
    ].join('\n');

    const userContent = `## 工具调用观测（共 ${obs.length} 条，失败 ${obs.filter(o => o.failed).length} 条）\n${obsDigest}\n\n## 最近对话摘要\n${recentMessages}`;

    const raw = await withTimeout(
      provider.complete(
        [
          { role: 'system', content: instruction },
          { role: 'user', content: userContent }
        ],
        {
          model: this.options.model(),
          temperature: 0.2,
          reasoningEffort: 'low',
          thinking: false,
          maxTokens: 4000
        }
      ),
      LLM_TIMEOUT_MS,
      'LLM 提炼超时'
    );

    return this.parseLLMResponse(raw);
  }

  /** 把观测序列压缩成 LLM 可读的摘要（控制 token）。 */
  private buildObservationDigest(obs: ToolObservation[]): string {
    const recent = obs.slice(-40); // 只取最近 40 条
    return recent.map(o => {
      const status = o.failed ? '❌' : '✓';
      // 兜底取参数：bash 用 command，grep 用 query，文件类用 path（file_path 兼容历史）
      const arg = o.args?.command || o.args?.query || o.args?.path || o.args?.file_path || o.args?.pattern || '';
      const argStr = typeof arg === 'string' ? arg.slice(0, 80) : '';
      const output = o.failed ? o.output.slice(0, 120) : '';
      return `${status} ${o.toolName}(${argStr})${output ? ' -> ' + output : ''}`;
    }).join('\n');
  }

  /** 解析 LLM 返回的 JSON，容错处理。 */
  private parseLLMResponse(raw: string): { instincts: Instinct[]; memories: Memory[] } {
    const text = raw.trim();
    // 提取首个 JSON 对象（容错：模型可能包多余文字）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { instincts: [], memories: [] };
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        instincts?: Array<{ id: string; trigger: string; action: string; domain?: string }>;
        memories?: Array<{ id: string; name: string; type?: string; content: string }>;
      };
      const instincts: Instinct[] = (parsed.instincts || [])
        .filter(x => x.id && x.trigger && x.action)
        .map(x => makeInstinct(x.id, sanitizeDomain(x.domain), x.trigger, x.action, 'llm'));
      const now = new Date().toISOString();
      const memories: Memory[] = (parsed.memories || [])
        .filter(x => x.id && x.content)
        .map(x => ({
          id: x.id,
          name: x.name || x.id,
          type: sanitizeMemoryType(x.type),
          content: x.content,
          status: 'staging' as const,
          confidence: 0.7,
          createdAt: now,
          updatedAt: now,
          keywords: Array.from(tokenize(`${x.name || ''} ${x.content}`))
        }));
      return { instincts, memories };
    } catch {
      return { instincts: [], memories: [] };
    }
  }

  // ─── 去重 ─────────────────────────────────────────────────────────────────

  /**
   * 基于 Jaccard 相似度的 Union-Find 去重（仿文章 auto-evolve.py）。
   * 相似度 ≥ 0.5 的规则合并为一组，取 trigger+action 描述更长的为代表。
   */
  private deduplicateInstincts(instincts: Instinct[]): Instinct[] {
    if (instincts.length <= 1) return instincts;
    const tokens = instincts.map(i => tokenize(`${i.trigger} ${i.action} ${i.domain}`));
    const parent = Array.from({ length: instincts.length }, (_, i) => i);
    const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const union = (a: number, b: number): void => { parent[find(a)] = find(b); };

    for (let i = 0; i < instincts.length; i++) {
      for (let j = i + 1; j < instincts.length; j++) {
        if (jaccardSimilarity(tokens[i], tokens[j]) >= 0.5) union(i, j);
      }
    }
    // 分组，每组取描述最长的为代表（保留更多信息）
    const groups = new Map<number, Instinct[]>();
    for (let i = 0; i < instincts.length; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(instincts[i]);
    }
    return Array.from(groups.values()).map(group =>
      group.reduce((best, cur) =>
        (cur.trigger.length + cur.action.length) > (best.trigger.length + best.action.length) ? cur : best
      )
    );
  }
}

// ─── 模块级辅助 ──────────────────────────────────────────────────────────────

function makeInstinct(
  id: string,
  domain: InstinctDomain,
  trigger: string,
  action: string,
  source: 'statistical' | 'llm' = 'statistical'
): Instinct {
  return {
    id,
    trigger,
    action,
    confidence: 0.5,
    domain,
    source,
    deprecated: false,
    observedAt: new Date().toISOString(),
    occurrenceCount: 1
  };
}

function emptySummary(note: string): DistillSummary {
  return {
    statisticalInstincts: 0,
    llmInstincts: 0,
    memoryCandidates: 0,
    reinforced: 0,
    llmTriggered: false,
    notes: [note]
  };
}

function formatSummaryLine(s: DistillSummary): string {
  const parts = [`统计 ${s.statisticalInstincts}`, `LLM ${s.llmInstincts}`, `强化 ${s.reinforced}`];
  if (s.memoryCandidates > 0) parts.push(`记忆候选 ${s.memoryCandidates}`);
  return `提炼完成：${parts.join(' / ')}${s.llmTriggered ? '' : '（LLM 未触发）'}`;
}

/** 归一化命令：取首个 token（去掉路径、参数），用于跨调用比较。 */
function normalizeCommand(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] || '';
}

/** 从错误输出中提取错误签名（用于聚集同类错误）。 */
function extractErrorSignature(output: string): string {
  // 优先提取已知错误关键词（跨不同上下文信息聚集同类错误）
  const keywords = output.match(/(ENOENT|EACCES|ECONNREFUSED|EPERM|not found|undefined|null|timeout|timed out|refused|unauthorized|invalid|failed)/i);
  if (keywords) return keywords[0].toLowerCase();
  // 退回到错误前缀的前若干字符（去掉标点，保留信息量）
  if (output.startsWith('执行出错:')) return output.slice(0, 40).replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  if (output.startsWith('错误:')) return output.slice(0, 40).replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  return 'generic';
}

/** 根据工具和错误签名给出可操作的建议。 */
function sampleSuggestHint(toolName: string, errorSig: string, sample: string): string {
  const sampleHint = sample ? `（曾出错样本：${sample.slice(0, 60)}）` : '';
  return `调用 ${toolName} 前预检可能导致 ${errorSig} 的问题${sampleHint}；参考观测中的失败与成功对照，先做前置检查。`;
}

function sanitizeDomain(d: string | undefined): InstinctDomain {
  const valid: InstinctDomain[] = ['workflow', 'testing', 'git', 'code-style', 'project-context', 'error-prevention', 'other'];
  return (d && valid.includes(d as InstinctDomain)) ? d as InstinctDomain : 'other';
}

function sanitizeMemoryType(t: string | undefined): Memory['type'] {
  if (t === 'user' || t === 'project' || t === 'feedback') return t;
  return 'project';
}

/**
 * 带超时的 Promise 包装。超时则 reject，避免 LLM 调用阻塞会话退出过久。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${reason}（${ms}ms）`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}
