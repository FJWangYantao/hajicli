import { BaseTool, SkillRegistry, ToolDefinition, ToolExecutionContext } from '@hajicli/core';

/** 按注册表名称加载 Skill，拒绝直接接收任意文件路径。 */
export class LoadSkillTool implements BaseTool {
  public readonly name = 'loadskill';
  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'loadskill',
      description: '按名称加载一个已注册 Skill 的完整说明。只有任务确实匹配目录描述时才调用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill 目录中列出的精确名称' },
          args: { type: 'string', description: '可选：本次调用 Skill 的任务参数，最多 4000 字符' }
        },
        required: ['name']
      }
    }
  };

  constructor(private readonly registry: SkillRegistry) {}

  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    if (context?.abortSignal?.aborted) return '[Skill 加载已中止]';
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return '错误: loadskill 缺少 name 参数。';
    const invocationArgs = typeof args.args === 'string' ? args.args : undefined;
    const result = this.registry.load(name, invocationArgs, context?.agentId || 'main');
    if (context?.abortSignal?.aborted) return '[Skill 加载已中止]';
    return result;
  }
}
