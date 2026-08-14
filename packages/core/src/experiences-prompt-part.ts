import path from 'node:path';
import { ExperienceStore } from './experience-store.js';
import { PromptContext, SystemPromptPart } from './types.js';

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
 * 召回策略：不按用户单条消息做相关性检索（那是运行期成本高的做法），
 * 而是注入「项目相关 + 全局高置信度」的规则集，让模型在每轮对话都感知。
 */
export class ExperiencesPromptPart implements SystemPromptPart {
  public readonly id = 'experiences';
  public readonly priority = 46;

  /** 单次注入的字符上限，防止经验库膨胀后挤占上下文。 */
  private readonly maxChars: number;

  constructor(
    private readonly store: ExperienceStore,
    options: { maxChars?: number } = {}
  ) {
    this.maxChars = options.maxChars ?? 2000;
  }

  public getContent(context: PromptContext): string {
    const query = this.buildQuery(context);
    const instincts = this.store.recallInstincts(query, 8, 0.7);
    const memories = this.store.recallMemories(query, 5);
    if (instincts.length === 0 && memories.length === 0) return '';

    const sections: string[] = ['# 经验记忆（系统自动积累，请优先参考）'];
    const used = sections.join('\n').length;
    let budget = this.maxChars - used;

    if (instincts.length > 0) {
      const instinctLines = this.formatInstincts(instincts, budget);
      if (instinctLines) {
        sections.push(instinctLines.formatted);
        budget -= instinctLines.used;
      }
    }
    if (memories.length > 0 && budget > 100) {
      const memoryLines = this.formatMemories(memories, budget);
      if (memoryLines) sections.push(memoryLines);
    }

    const result = sections.join('\n\n');
    return result.length > this.maxChars ? result.slice(0, this.maxChars) + '…' : result;
  }

  /** 召回 query：以项目名为主，附带 domain 关键词提升匹配率。 */
  private buildQuery(context: PromptContext): string {
    const projectName = path.basename(context.cwd);
    return `${projectName} workflow edit read test git error prevention`;
  }

  private formatInstincts(instincts: { id: string; domain: string; confidence: number; action: string; scope?: 'user' | 'project' }[], budget: number): { formatted: string; used: number } | null {
    const lines: string[] = ['## 行为规则（自动提炼，按置信度）'];
    let used = lines.join('\n').length;
    for (const inst of instincts) {
      const conf = inst.confidence.toFixed(2);
      const action = inst.action.replace(/\s+/g, ' ').slice(0, 160);
      const globalTag = inst.scope === 'user' ? ' · 全局' : '';
      const line = `- [${inst.domain} ${conf}${globalTag}] ${action}`;
      if (used + line.length + 1 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length <= 1) return null;
    return { formatted: lines.join('\n'), used };
  }

  private formatMemories(memories: { type: string; content: string; scope?: 'user' | 'project' }[], budget: number): string {
    const lines: string[] = ['## 项目知识与偏好'];
    let used = lines.join('\n').length;
    for (const mem of memories) {
      const content = mem.content.replace(/\s+/g, ' ').slice(0, 200);
      const globalTag = mem.scope === 'user' ? '·全局' : '';
      const line = `- [${mem.type}${globalTag}] ${content}`;
      if (used + line.length + 1 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.length <= 1 ? '' : lines.join('\n');
  }
}
