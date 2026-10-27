import path from "node:path";
import type { ExperienceStore } from "./experience-store.js";
import type { PromptContext, SystemPromptPart } from "./types.js";

/**
 * 经验记忆系统提示词分片。
 *
 * 把 ExperienceStore 中积累的高置信度规则与已确认记忆，作为常驻上下文注入
 * system prompt。priority=46，介于 skills-catalog(45) 与 plan-mode(50) 之间。
 *
 * 设计要点：
 *   - 每轮 LLM 调用前 SystemPromptManager 会重算所有分片，因此本分片天然反映最新经验
 *   - 切模型/切权限模式时 refreshSystemPromptPreservingContext() 会自动重拼，无需额外维护
 *   - 空库返回空串，被 generatePrompt 的 trim 跳过，不占 token
 *   - 召回基于当前工作目录的项目名作为 query，Top-K 限制注入规模
 *
 * 召回策略：以最近一条用户消息 + 项目名为 query 做关键词召回（Jaccard），
 * 让注入的经验跟随当前任务；无消息时回落到固定领域词表兜底。
 * 关键词召回是 O(token 集合) 的轻量操作，避免每轮对话跑向量检索。
 */
export class ExperiencesPromptPart implements SystemPromptPart {
  public readonly id = "experiences";
  public readonly priority = 46;

  /** 单次注入的字符上限，防止经验库膨胀后挤占上下文。 */
  private readonly maxChars: number;

  constructor(
    private readonly store: ExperienceStore,
    options: { maxChars?: number } = {},
  ) {
    this.maxChars = options.maxChars ?? 2000;
  }

  public getContent(context: PromptContext): string {
    return buildExperienceRecall(this.store, this.buildQuery(context), this.maxChars) ?? "";
  }

  /**
   * 召回 query：优先用最近一条用户消息（任务语义的最强信号），
   * 附加项目名匹配项目知识；无消息时（会话启动/压缩恢复）回落到固定词表。
   * 截断防止超长历史消息把 token 集稀释成噪声。
   */
  private buildQuery(context: PromptContext): string {
    const projectName = path.basename(context.cwd);
    const recent = (context.recentUserMessage || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (recent) return `${recent} ${projectName}`;
    return `${projectName} workflow edit read test git error prevention`;
  }
}

/** 随用户消息注入时的边界标记：回放会话时按它剥掉，避免把注入内容当成用户原话。 */
export const EXPERIENCE_RECALL_OPEN = "<experience_recall>";
export const EXPERIENCE_RECALL_CLOSE = "</experience_recall>";

/**
 * 按 query 召回经验并格式化成一段文本；没有命中返回 undefined。
 *
 * 两个入口共用同一份格式化逻辑：
 * - 系统提示词分片（`ExperiencesPromptPart`）——分片内容变了会打断前缀缓存；
 * - 随用户消息注入（A/B: experience_recall=message）——只动本轮用户消息的尾部。
 */
export function buildExperienceRecall(
  store: ExperienceStore,
  query: string,
  maxChars = 2000,
): string | undefined {
  const instincts = store.recallInstincts(query);
  const memories = store.recallMemories(query, 5);
  if (instincts.length === 0 && memories.length === 0) return undefined;

  const sections: string[] = ["# 经验记忆（系统自动积累，请优先参考）"];
  const used = sections.join("\n").length;
  let budget = maxChars - used;

  if (instincts.length > 0) {
    const instinctLines = formatInstincts(instincts, budget);
    if (instinctLines) {
      sections.push(instinctLines.formatted);
      budget -= instinctLines.used;
    }
  }
  if (memories.length > 0 && budget > 100) {
    const memoryLines = formatMemories(memories, budget);
    if (memoryLines) sections.push(memoryLines);
  }

  const result = sections.join("\n\n");
  return result.length > maxChars ? `${result.slice(0, maxChars)}…` : result;
}

/** 给召回文本套上边界标记，注入到用户消息尾部。 */
export function wrapExperienceRecall(text: string): string {
  return `${EXPERIENCE_RECALL_OPEN}\n${text}\n${EXPERIENCE_RECALL_CLOSE}`;
}

/** 回放会话时剥掉注入块，只显示用户原话。 */
export function stripExperienceRecall(text: string): string {
  const start = text.indexOf(EXPERIENCE_RECALL_OPEN);
  if (start < 0) return text;
  const end = text.indexOf(EXPERIENCE_RECALL_CLOSE, start);
  const tail = end < 0 ? "" : text.slice(end + EXPERIENCE_RECALL_CLOSE.length);
  return `${text.slice(0, start)}${tail}`.trimEnd();
}

function formatInstincts(
  instincts: {
    id: string;
    domain: string;
    confidence: number;
    action: string;
    scope?: "user" | "project";
  }[],
  budget: number,
): { formatted: string; used: number } | null {
  const lines: string[] = ["## 行为规则（自动提炼，按置信度）"];
  let used = lines.join("\n").length;
  for (const inst of instincts) {
    const conf = inst.confidence.toFixed(2);
    const action = inst.action.replace(/\s+/g, " ").slice(0, 160);
    const globalTag = inst.scope === "user" ? " · 全局" : "";
    const line = `- [${inst.domain} ${conf}${globalTag}] ${action}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length <= 1) return null;
  return { formatted: lines.join("\n"), used };
}

function formatMemories(
  memories: { type: string; content: string; scope?: "user" | "project" }[],
  budget: number,
): string {
  const lines: string[] = ["## 项目知识与偏好"];
  let used = lines.join("\n").length;
  for (const mem of memories) {
    const content = mem.content.replace(/\s+/g, " ").slice(0, 200);
    const globalTag = mem.scope === "user" ? " · 全局" : "";
    const line = `- [${mem.type}${globalTag}] ${content}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length <= 1 ? "" : lines.join("\n");
}
