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
    return this.registry.load(name, invocationArgs, context?.agentId || 'main');
  }
}

/** 枚举已加载 Skill 的附属资源，不暴露宿主机绝对路径。 */
export class ListSkillResourcesTool implements BaseTool {
  public readonly name = 'listskillresources';
  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'listskillresources',
      description: '列出一个已加载 Skill 内的 references、scripts、assets 和其他附属资源。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '已经通过 loadskill 加载的精确 Skill 名称' }
        },
        required: ['name']
      }
    }
  };

  constructor(private readonly registry: SkillRegistry) {}

  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    if (context?.abortSignal?.aborted) return '[Skill 资源枚举已中止]';
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return '错误: listskillresources 缺少 name 参数。';
    try {
      const result = await this.registry.listResources(name, context?.agentId || 'main', context?.abortSignal);
      const lines = [
        `[Skill 资源列表 - ${name}，共 ${result.resources.length} 个]`,
        ...result.resources.map(resource => `- ${resource.path} [${resource.kind}, ${resource.size} bytes]`),
        ...result.warnings.map(warning => `警告: ${warning}`)
      ];
      const output = lines.join('\n');
      return output.length > 12_000
        ? `${output.slice(0, 12_000)}\n[资源列表已截断]`
        : output;
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return '[Skill 资源枚举已中止]';
      }
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/** 读取已加载 Skill 内的 UTF-8 文本资源。 */
export class ReadSkillResourceTool implements BaseTool {
  public readonly name = 'readskillresource';
  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'readskillresource',
      description: '安全读取一个已加载 Skill 内的 UTF-8 文本资源，可指定行范围。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '已经通过 loadskill 加载的精确 Skill 名称' },
          path: { type: 'string', description: 'Skill 目录内的相对资源路径，例如 references/rules.md' },
          startLine: { type: 'number', description: '可选，开始行号，从 1 开始' },
          endLine: { type: 'number', description: '可选，结束行号，包含该行' }
        },
        required: ['name', 'path']
      }
    }
  };

  constructor(private readonly registry: SkillRegistry) {}

  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    if (context?.abortSignal?.aborted) return '[Skill 资源读取已中止]';
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const resourcePath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!name) return '错误: readskillresource 缺少 name 参数。';
    if (!resourcePath) return '错误: readskillresource 缺少 path 参数。';

    const parseLine = (value: unknown, field: string): number | undefined => {
      if (value === undefined) return undefined;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${field} 必须是大于等于 1 的整数`);
      return parsed;
    };

    try {
      const startLine = parseLine(args.startLine, 'startLine');
      const endLine = parseLine(args.endLine, 'endLine');
      if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
        return `错误: 起始行号 ${startLine} 大于结束行号 ${endLine}。`;
      }
      const resource = await this.registry.readResource(
        name,
        resourcePath,
        context?.agentId || 'main',
        context?.abortSignal
      );
      const lines = resource.content.split(/\r?\n/);
      const start = startLine === undefined ? 0 : Math.min(lines.length, startLine - 1);
      const end = endLine === undefined ? lines.length : Math.min(lines.length, endLine);
      const range = startLine !== undefined || endLine !== undefined
        ? `，第 ${start + 1}-${end} 行/共 ${lines.length} 行`
        : '';
      let output = `[Skill 资源读取 - ${name}/${resource.path}${range}]\n${lines.slice(start, end).join('\n')}`;
      if (output.length > 8_000) {
        output = `${output.slice(0, 8_000)}\n\n[输出已被截断，因为内容超过了 8000 字符限制]`;
      }
      return output;
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return '[Skill 资源读取已中止]';
      }
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
