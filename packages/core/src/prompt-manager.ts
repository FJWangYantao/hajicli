import { PromptContext, SystemPromptPart } from './types.js';

/**
 * 基础角色定义提示词分片。
 */
export class BasePromptPart implements SystemPromptPart {
  public readonly id: string = 'base';
  public readonly priority: number = 10;

  /**
   * 获取基础角色提示词内容。
   * @param context - 提示词上下文。
   */
  public getContent(context: PromptContext): string {
    return '你是一个轻量级的终端内 AI 辅助编程助手，名为 haji。你正通过命令行交互界面（REPL）与用户合作。\n\n交互与回复风格：\n- 回答保持短小精炼、直入主题，避免长篇大论或客套话。\n- 优先使用 Markdown 表格或列表展示文件信息。';
  }
}

/**
 * 动态环境信息提示词分片。
 */
export class EnvPromptPart implements SystemPromptPart {
  public readonly id: string = 'env';
  public readonly priority: number = 20;

  /**
   * 获取当前环境变量相关的提示词内容。
   * @param context - 提示词上下文。
   */
  public getContent(context: PromptContext): string {
    return `当前工作环境信息：\n- 操作系统 (OS): ${context.os}\n- 当前工作目录 (Cwd): ${context.cwd}`;
  }
}

/**
 * 工具使用规范提示词分片。
 */
export class ToolsPromptPart implements SystemPromptPart {
  public readonly id: string = 'tools';
  public readonly priority: number = 30;

  /**
   * 获取工具使用相关的提示词内容。
   * @param context - 提示词上下文。
   */
  public getContent(context: PromptContext): string {
    const activeTools = context.tools || [];
    if (activeTools.length === 0) {
      return '';
    }

    const rules: string[] = [];
    rules.push('工具调用通用规范：');
    rules.push('- 针对具体的研发任务，你必须优先选用对应的专用工具，非必要不使用通用 bash 工具。这能带来更高的执行效率和更好的跨平台安全性。');

    if (activeTools.includes('global')) {
      rules.push('\n1. 查找文件 (global)：\n- 递归查找并列出当前工作目录下的文件列表。需要定位文件或了解项目结构时优先选用此工具，支持根据名称关键字过滤。');
    }
    if (activeTools.includes('grep')) {
      rules.push('\n2. 文本检索 (grep)：\n- 在文本文件中搜索匹配关键字的行。当你需要在项目内查找特定类、函数、变量的定义或引用时，应优先选用，切忌在 bash 中运行 grep 或 findstr。');
    }
    if (activeTools.includes('read')) {
      rules.push('\n3. 读取文件 (read)：\n- 读取指定路径文件的内容。阅读文件必须优先使用此工具，严禁使用 bash 中的 cat/type。如果是大文件，请务必提供 startLine 和 endLine 参数进行范围读取，防止单次内容过大撑满上下文。');
    }
    if (activeTools.includes('edit')) {
      rules.push('\n4. 精准编辑 (edit)：\n- 在已有文件中以精准搜索与替换的形式修改局部代码。当你对已有文件进行微调、Bug 修复或局部重构时，必须优先使用此工具，严禁为了局部修改而使用 write 工具覆写整个文件。提供 oldText 时，建议包含前后几行代码作为上下文，保证其在目标文件中唯一存在，以防匹配失败。');
    }
    if (activeTools.includes('write')) {
      rules.push('\n5. 写入文件 (write)：\n- 向指定路径创建新文件，或完全覆盖写入整个文件。当且仅当需要创建新文件，或需要将已有文件 100% 覆写（彻底重构）时，才应选用此工具。严禁使用此工具修改局部少数几行代码，局部编辑应使用 edit 工具。');
    }
    if (activeTools.includes('websearch')) {
      rules.push('\n6. 网页搜索 (websearch)：\n- 在互联网上搜索指定关键字。当需要查询最新技术文档、解决疑难报错或获取实时信息时选用此工具。');
    }
    if (activeTools.includes('webfetch')) {
      rules.push('\n7. 网页抓取 (webfetch)：\n- 抓取指定 URL 网页的纯文本内容。获取第三方官方文档或网页教程时，优先选用此工具抓取，严禁使用 bash 中的 curl 或 wget。');
    }
    if (activeTools.includes('bash')) {
      rules.push('\n8. 本地终端命令 (bash)：\n- 仅在没有其他专有工具能够解决该任务时作为兜底手段使用。主要用于安装/更新依赖、编译/构建项目、执行单元测试（如 vitest）或启动开发服务。\n- 在发出命令前，请务必确认当前 Windows 平台是否支持该命令。绝不要在 Windows 下执行无法直接运行的 Linux 指令（如 cat, rm, ls）。如果命令报错，请阅读 stderr 信息自动纠正后重新尝试。');
    }

    return rules.join('\n');
  }
}

/**
 * 系统提示词管理器，负责收集、排序并拼接各层级的提示词内容。
 */
export class SystemPromptManager {
  private parts: Map<string, SystemPromptPart> = new Map();

  constructor() {
    // 注册内置默认提示词分片
    this.registerPart(new BasePromptPart());
    this.registerPart(new EnvPromptPart());
    this.registerPart(new ToolsPromptPart());
  }

  /**
   * 注册一个新的提示词分片。如果已存在相同 id 的分片，则会进行覆盖。
   * @param part - 要注册的系统提示词分片。
   */
  public registerPart(part: SystemPromptPart): void {
    this.parts.set(part.id, part);
  }

  /**
   * 注销指定 id 的提示词分片。
   * @param id - 提示词分片的唯一标识符。
   */
  public unregisterPart(id: string): boolean {
    return this.parts.delete(id);
  }

  /**
   * 获取指定 id 的提示词分片。
   * @param id - 提示词分片的唯一标识符。
   */
  public getPart(id: string): SystemPromptPart | undefined {
    return this.parts.get(id);
  }

  /**
   * 动态生成最终的系统提示词。
   * 会将所有已注册的分片按照优先级（priority）从小到大进行排序并拼接。
   * @param context - 生成提示词所需的动态上下文信息。
   */
  public async generatePrompt(context: PromptContext): Promise<string> {
    const sortedParts = Array.from(this.parts.values())
      .sort((a, b) => a.priority - b.priority);

    const contents: string[] = [];
    for (const part of sortedParts) {
      const content = await part.getContent(context);
      const trimmed = content.trim();
      if (trimmed) {
        contents.push(trimmed);
      }
    }

    return contents.join('\n\n');
  }
}
