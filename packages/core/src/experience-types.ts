/**
 * 自学习经验系统的核心数据模型。
 *
 * 本系统移植自「Claude Code 自我进化与记忆系统」的三件套设计：
 *   - 观测（Observation）：每次工具调用的样本
 *   - 规则（Instinct）：从观测中提炼的行为模式
 *   - 记忆（Memory）：项目事实、用户偏好、反馈约束
 *
 * 与只读的 SkillRegistry 不同，这里的类型独立定义，支持 confidence 动态演化、
 * source 追溯、deprecated 标记等元数据，供 ExperienceStore 频繁读写。
 */

/**
 * 行为规则所属的领域分类。
 * 用于按 domain 聚合（仿文章 evolved-skill 的分组逻辑），便于注入时分类呈现。
 */
export type InstinctDomain =
  | 'workflow'           // 工作流模式（先读后改、检索→确认等）
  | 'testing'            // 测试相关
  | 'git'                // 版本控制
  | 'code-style'         // 代码风格
  | 'project-context'    // 项目上下文
  | 'error-prevention'   // 错误预防（核心目标：降低工具出错率）
  | 'other';

/**
 * 规则的来源路径。
 * - statistical：路径 A 统计模式检测器产出（零 token）
 * - llm：路径 B LLM 语义分析产出
 * - manual：用户通过 /instinct add 手工录入
 */
export type InstinctSource = 'statistical' | 'llm' | 'manual';

/**
 * 单条原子行为模式（对应文章的 Instinct）。
 * 一个 Instinct 只描述一个 trigger + action，原子性优先。
 */
export interface Instinct {
  /** 稳定唯一 id，如 'read-before-edit'。同名 id 在两级目录间按项目级覆盖用户级。 */
  id: string;
  /** 触发条件，自然语言描述。 */
  trigger: string;
  /** 建议动作，自然语言描述。 */
  action: string;
  /** 置信度 0-1，动态演化：首现 0.5，重复 +0.05（上限 0.9），未触发 -0.05（<0.55 deprecated）。 */
  confidence: number;
  domain: InstinctDomain;
  source: InstinctSource;
  deprecated: boolean;
  /** 最近一次观测到该模式的 ISO 日期。 */
  observedAt: string;
  /** 累计被观测/强化次数。 */
  occurrenceCount: number;
}

/** 记忆的类型分类。 */
export type MemoryType = 'user' | 'project' | 'feedback';

/**
 * 记忆的生命周期状态。
 * - staging：LLM 提取的候选，需用户 /memory confirm 后才生效（防噪声）
 * - active：已确认，进入召回
 * - archived：归档，不再注入但仍保留在磁盘（可恢复）
 */
export type MemoryStatus = 'staging' | 'active' | 'archived';

/**
 * 单条事实/偏好记忆（对应文章的 Memory）。
 * 与 Instinct 互补：Instinct 描述「怎么做」，Memory 描述「要知道什么」。
 */
export interface Memory {
  id: string;
  name: string;
  type: MemoryType;
  /** 正文内容，可包含 Why / How to apply 段落。 */
  content: string;
  status: MemoryStatus;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  /** 召回用的关键词数组（从 name+content 提取的英文 token + 中文关键字符）。 */
  keywords: string[];
}

/**
 * 工具调用观测样本。
 * 由 PostToolUse hook 采集，追加到 observations.jsonl，作为提炼引擎的输入。
 */
export interface ToolObservation {
  /** ISO 时间戳。 */
  ts: string;
  /** 会话 id。 */
  sessionId: string;
  toolName: string;
  /** 工具入参（与 trace 一样会做截断保护）。 */
  args: Record<string, unknown>;
  /** 工具输出（成功输出或错误字符串，同字段）。 */
  output: string;
  /** 是否失败，由 isFailedToolOutput() 判定。 */
  failed: boolean;
  /** 执行耗时（毫秒），可选。 */
  duration?: number;
  /** 子代理 id（主循环工具调用时为 undefined）。 */
  agentId?: string;
  /** 调用深度（主循环为 0，子代理为 1）。 */
  depth?: number;
}

/** 提炼摘要，runDistill 返回给调用方用于打印反馈。 */
export interface DistillSummary {
  /** 统计路径产出的规则数。 */
  statisticalInstincts: number;
  /** LLM 路径产出的规则数。 */
  llmInstincts: number;
  /** 新增的 memory 候选数（待用户确认）。 */
  memoryCandidates: number;
  /** 被演化的既有规则数（confidence 提升）。 */
  reinforced: number;
  /** 本次是否触发了 LLM 路径。 */
  llmTriggered: boolean;
  /** 提炼过程中产生的可读消息（用于调试/日志）。 */
  notes: string[];
}
