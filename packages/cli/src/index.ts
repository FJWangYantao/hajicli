#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { SystemPromptManager, SessionTracker, ObservableModelProvider, startTraceServer, ChatMessage, ToolCall, ReasoningEffort, REASONING_EFFORTS, isReasoningEffort, PermissionEngine, PermissionMode, PERMISSION_MODES, isPermissionMode, RiskLevel, HookEngine, SnapshotEngine, runCompactionPipeline, estimateMessagesChars, estimateMessagesTokens, SessionManager } from '@hajicli/core';
import {
  DeepSeekProvider,
  VolcengineProvider,
  BashTool,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GlobalFindFilesTool,
  GrepSearchTool,
  WebSearchTool,
  WebFetchTool
} from '@hajicli/plugins';
import { TerminalUI, TerminalInputCancelledError } from './terminal-input.js';
import { MarkdownStreamRenderer } from './markdown-renderer.js';

// 原生 ANSI 终端转义色彩工具类，保持零外部依赖
const colors = {
  purple: (text: string) => `\x1b[35m${text}\x1b[0m`,
  boldPurple: (text: string) => `\x1b[1m\x1b[35m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  boldGreen: (text: string) => `\x1b[1m\x1b[32m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  boldYellow: (text: string) => `\x1b[1m\x1b[33m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  boldRed: (text: string) => `\x1b[1m\x1b[31m${text}\x1b[0m`,
  blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
  boldBlue: (text: string) => `\x1b[1m\x1b[34m${text}\x1b[0m`,
  gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  userMsg: (text: string) => {
    const prefix = '\x1b[1;35m ❯ \x1b[0m';
    const lines = text.split('\n');
    return lines.map((line, idx) => {
      if (idx === 0) {
        return `${prefix}${line}`;
      }
      return `   ${line}`;
    }).join('\n');
  }
};

// 像素画风格的大写 HAJI 启动 Logo
const LOGO = `
${colors.boldPurple('██╗  ██╗  ██████╗      █████╗ ████████╗')}
${colors.boldPurple('██║  ██║ ██╔═══██╗     ╚══██║ ╚══██╔══╝')}
${colors.boldPurple('███████║ ████████║        ██║    ██║   ')}
${colors.boldPurple('██╔══██║ ██╔═══██║   ██   ██║    ██║   ')}
${colors.boldPurple('██║  ██║ ██║   ██║   ╚█████╔╝ ████████╗')}
${colors.boldPurple('╚═╝  ╚═╝ ╚═╝   ╚═╝    ╚════╝  ╚═══════╝')}
`;

const DEEPSEEK_MODELS = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: '快速 · 高性价比', provider: 'deepseek' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: '更强 · 复杂任务', provider: 'deepseek' }
] as const;

const VOLCENGINE_MODELS = [
  { value: 'glm-5.2', label: 'GLM 5.2', description: '火山方舟 · 强力通用/代码模型', provider: 'volcengine' },
  { value: 'doubao-pro-32k', label: 'Doubao Pro 32k', description: '火山方舟 · 豆包大模型', provider: 'volcengine' },
  { value: 'doubao-lite-32k', label: 'Doubao Lite 32k', description: '火山方舟 · 豆包轻量大模型', provider: 'volcengine' }
] as const;

const EFFORT_OPTIONS = REASONING_EFFORTS.map(value => ({
  value,
  label: value.toUpperCase(),
  description: ({
    low: '快速',
    medium: '均衡',
    high: '深入',
    xhigh: '严谨',
    max: '极致'
  } as const)[value]
}));

/**
 * 判断给定 model value 属于哪个 provider。
 */
function detectProviderForModel(modelValue: string): 'deepseek' | 'volcengine' {
  if (DEEPSEEK_MODELS.some(m => m.value === modelValue)) return 'deepseek';
  return 'volcengine';
}

/** 偏好文件路径：.haji/preferences.json */
const PREFERENCES_PATH = path.join(process.cwd(), '.haji', 'preferences.json');

/** 用户偏好结构 */
interface Preferences {
  model: string;
  reasoningEffort: string;
  permissionMode?: string;
  riskThreshold?: string;
}

/** 读取上次保存的用户偏好，若文件不存在或解析失败则返回 null */
function loadPreference(): Preferences | null {
  try {
    const raw = fs.readFileSync(PREFERENCES_PATH, 'utf-8');
    return JSON.parse(raw) as Preferences;
  } catch {
    return null;
  }
}

/** 将用户偏好持久化到 .haji/preferences.json */
function savePreference(pref: Preferences): void {
  try {
    fs.mkdirSync(path.dirname(PREFERENCES_PATH), { recursive: true });
    fs.writeFileSync(PREFERENCES_PATH, JSON.stringify(pref, null, 2), 'utf-8');
  } catch {
    // 保存失败时静默忽略，不影响主流程
  }
}

/**
 * 将工具参数格式化为单行摘要字符串（超长自动截断）。
 */
function formatToolArgs(args: Record<string, any>, maxLen = 45): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const formatted = keys.map(k => {
    const val = typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k]);
    const singleLineVal = String(val).replace(/\r?\n/g, ' ');
    return `${k}: "${singleLineVal}"`;
  }).join(', ');

  if (formatted.length > maxLen) {
    return formatted.slice(0, maxLen - 3) + '...';
  }
  return formatted;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 动态获取当前 package.json 中的版本号。
 */
function getCliVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const version = getCliVersion();

  if (cliArgs.includes('--version') || cliArgs.includes('-v')) {
    console.log(`haji v${version}`);
    process.exit(0);
  }

  if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
    console.log(`
${colors.boldPurple('HAJI CLI')} - 轻量级终端 AI 辅助编程工具 (v${version})

${colors.bold('用法:')}
  haji [选项]

${colors.bold('选项:')}
  -v, --version       显示版本号
  -h, --help          显示帮助手册

${colors.bold('快捷命令 (对话内):')}
  /help               显示内部帮助
  /permission         切换权限模式 (default, accept-edit, auto, bypass-permissions)
  /effort             切换思考强度 (low, medium, high, xhigh, max)
  /model              选择大模型与思考强度
  /clear              清空聊天历史与上下文
  /viewer             打开 Trace 观测中心
  /exit               退出 haji

${colors.bold('环境变量配置:')}
  DEEPSEEK_API_KEY    DeepSeek 平台 API Key
  VOLC_API_KEY        火山引擎 API Key (或 ARK_API_KEY)
`);
    process.exit(0);
  }

  const volcApiKey = process.env.VOLC_API_KEY || process.env.ARK_API_KEY;
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY;

  if (!volcApiKey && !deepseekApiKey) {
    console.error(colors.boldRed('错误: 请在运行前配置 DEEPSEEK_API_KEY 或 火山引擎 API Key (VOLC_API_KEY / ARK_API_KEY)。'));
    process.exit(1);
  }

  // 启动时清空终端屏幕，实现“置顶并开辟新页面”效果
  console.clear();

  console.log(LOGO);
  console.log(colors.gray('正在初始化大模型提供商、系统工具和 Trace 观测服务器...'));

  // 读取上次保存的偏好（模型 + 思考强度）
  const savedPreference = loadPreference();

  // 根据 selectedModel 动态构建 Provider 实例的工厂函数
  const tracker = new SessionTracker();
  const buildProvider = (modelValue: string): ObservableModelProvider => {
    const providerName = detectProviderForModel(modelValue);
    if (providerName === 'volcengine') {
      if (!volcApiKey) {
        throw new Error('未配置 VOLC_API_KEY 或 ARK_API_KEY，无法使用火山引擎模型。');
      }
      return new ObservableModelProvider(
        new VolcengineProvider({
          apiKey: volcApiKey,
          baseUrl: process.env.VOLC_BASE_URL || process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3',
          defaultModel: modelValue
        }),
        tracker
      );
    }
    if (!deepseekApiKey) {
      throw new Error('未配置 DEEPSEEK_API_KEY，无法使用 DeepSeek 模型。');
    }
    return new ObservableModelProvider(
      new DeepSeekProvider({ apiKey: deepseekApiKey, defaultModel: modelValue }),
      tracker
    );
  };

  // 构建所有可用的模型选项（仅包含有对应 API Key 的 Provider 的模型）
  const availableModels = [
    ...(deepseekApiKey ? DEEPSEEK_MODELS : []),
    ...(volcApiKey ? VOLCENGINE_MODELS : [])
  ];

  // 确定初始模型：优先顺序 = 环境变量 > 上次保存偏好 > 硬编码默认值（deepseek-v4-flash）
  const envModel = (deepseekApiKey
    ? process.env.DEEPSEEK_MODEL
    : process.env.VOLC_MODEL || process.env.ARK_MODEL)?.trim().toLowerCase();
  let selectedModel: string = envModel
    || (savedPreference?.model && availableModels.some(m => m.value === savedPreference!.model)
      ? savedPreference!.model
      : 'deepseek-v4-flash');
  let currentProviderName: 'volcengine' | 'deepseek' = detectProviderForModel(selectedModel);

  // 确定初始思考强度：优先顺序 = 环境变量 > 上次保存偏好 > 默认 medium
  const configuredEffort = process.env.HAJI_REASONING_EFFORT?.trim().toLowerCase();
  let reasoningEffort: ReasoningEffort = isReasoningEffort(configuredEffort)
    ? configuredEffort
    : (isReasoningEffort(savedPreference?.reasoningEffort) ? savedPreference!.reasoningEffort : 'medium');

  const permissionEngine = new PermissionEngine();
  let permissionMode: PermissionMode = isPermissionMode(savedPreference?.permissionMode)
    ? savedPreference!.permissionMode
    : 'default';
  let riskThreshold: RiskLevel = (['low', 'medium', 'high'].includes(savedPreference?.riskThreshold || '')
    ? savedPreference!.riskThreshold
    : 'medium') as RiskLevel;

  const hookEngine = new HookEngine();

  // 1. 注册 PreToolUse Hook：用于安全权限判断与用户授权确认
  hookEngine.register('PreToolUse', async (ctx) => {
    const checkResult = await permissionEngine.evaluate({
      mode: ctx.permissionMode as PermissionMode,
      toolName: ctx.toolName!,
      args: ctx.args || {},
      userIntent: ctx.userIntent || '',
      riskThreshold: ctx.riskThreshold as RiskLevel
    });

    const argsSummary = formatToolArgs(ctx.args || {});
    const displayArgs = argsSummary ? `(${colors.cyan(argsSummary)})` : '';

    if (checkResult.action === 'allow') {
      return null;
    }
    if (checkResult.action === 'prompt') {
      if (ui.isInputActive()) {
        ui.cancelInput();
      }
      const answer = await ui.readInput({
        prompt: `  ${colors.boldYellow('⚠️  AI 申请执行修改型工具：')}${colors.purple(ctx.toolName!)}${displayArgs} ${colors.boldYellow('授权？(y/N)')} › `
      });
      const approved = answer.trim().toLowerCase() === 'y';
      if (!approved) {
        ui.writeLine(`  ${colors.boldRed('✕')} ${colors.purple(ctx.toolName!)}${displayArgs} ${colors.gray('(已拒绝执行)')}`);
        return '错误: 用户拒绝了此命令的执行请求。';
      }
      return null;
    }
    if (checkResult.action === 'deny') {
      const autoDeniedReason = checkResult.reason || 'Auto 分类器安全拦截';
      ui.writeLine(`  ${colors.boldRed('🛡️ [Auto安全拦截]')} ${colors.purple(ctx.toolName!)}${displayArgs} ${colors.red(`(评级: ${checkResult.riskLevel} - ${autoDeniedReason})`)}`);
      return `[安全引擎拒绝拦截] 命令 "${ctx.toolName}" 被 Auto 分类器检测为超出允许的危险阈值 (${checkResult.riskLevel})。拒绝原因: ${autoDeniedReason}。请重新分析用户意图，改用更安全的替代指令或步骤。`;
    }
    return null;
  });

  // 2. 注册 PostToolUse Hook：用于 Trace 轨迹审计收集与自动 Git 快照生成
  hookEngine.register('PostToolUse', async (ctx) => {
    const isApproved = !ctx.toolOutput?.startsWith('错误:') && !ctx.toolOutput?.startsWith('[安全引擎拒绝拦截]');
    tracker.recordToolExecution(
      ctx.toolCallId || '',
      ctx.toolName!,
      ctx.args || {},
      isApproved,
      ctx.toolOutput || ''
    );

    // AI 执行修改文件的工具后自动捕获提交轻量快照
    if (isApproved && ['write_file', 'edit_file', 'bash'].includes(ctx.toolName || '')) {
      const snapshotEngine = new SnapshotEngine(process.cwd());
      snapshotEngine.createSnapshot(`auto snapshot after ${ctx.toolName}`);
    }
  });

  // 3. 注册 UserPromptSubmit Hook：检测上下文膨胀并自动预压缩
  hookEngine.register('UserPromptSubmit', async (ctx) => {
    if (ctx.messages && estimateMessagesChars(ctx.messages) > 60_000) {
      ui.writeLine(colors.gray('🧹 检测到上下文空间消耗较高，已自动触发多层预压缩...'));
      const result = await runCompactionPipeline(ctx.messages, { forceL4: false });
      ctx.messages = result.messages;
    }
  });

  let provider = buildProvider(selectedModel);
  const systemPromptManager = new SystemPromptManager();
  // 在进入全屏 TUI 前启动服务，避免后台日志破坏固定布局。
  await startTraceServer(3000, false, false).catch(() => { });

  // 注册并实例化所有已实现的系统工具
  const tools = [
    new BashTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new GlobalFindFilesTool(),
    new GrepSearchTool(),
    new WebSearchTool(),
    new WebFetchTool()
  ];

  const toolsMap = new Map(tools.map(t => [t.name, t]));
  const toolDefinitions = tools.map(t => t.definition);

  // 动态生成系统初始提示词，指导 AI 环境认知
  const createSystemPrompt = () => systemPromptManager.generatePrompt({
    cwd: process.cwd(),
    os: os.platform() === 'win32' ? 'Windows (基于 Node.js 运行时环境)' : os.platform(),
    tools: tools.map(t => t.name),
    reasoningEffort
  });
  let systemPrompt = await createSystemPrompt();

  const sessionManager = new SessionManager();

  // 初始化会话历史记录
  let messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
  sessionManager.saveCurrentSession(messages);

  const ui = new TerminalUI({
    header: LOGO.trim(),
    compactHeader: colors.boldPurple('HAJI'),
    inputPrompt: '',
    continuationPrompt: '',
    renderBorder: width => colors.gray('─'.repeat(width))
  });
  const slashCommands = [
    { command: '/help', description: '显示帮助' },
    { command: '/resume', description: '历史对话查看与热切换' },
    { command: '/rewind', description: '历史节点撤销与代码回退' },
    { command: '/compact', description: '多层上下文压缩' },
    { command: '/permission', description: '切换权限档次与安全阈值' },
    { command: '/effort', description: '切换思考强度' },
    { command: '/model', description: '选择模型与思考强度' },
    { command: '/clear', description: '清空聊天与上下文' },
    { command: '/viewer', description: '打开 Trace 观测中心' },
    { command: '/exit', description: '退出 haji' }
  ];
  ui.start();
  ui.setPermissionMode(permissionMode);

  const updateStatusUI = () => {
    ui.setModelInfo(selectedModel, reasoningEffort);
    const tokens = estimateMessagesTokens(messages);
    ui.setContextUsage(tokens, 1000000);
  };
  updateStatusUI();

  // 绑定 Shift+Tab 快捷键动态循环切换权限档次
  const permissionCycleList: PermissionMode[] = ['default', 'accept-edit', 'auto', 'bypass-permissions'];
  ui.onShiftTab(() => {
    const currIdx = permissionCycleList.indexOf(permissionMode);
    const nextIdx = (currIdx + 1) % permissionCycleList.length;
    permissionMode = permissionCycleList[nextIdx];
    savePreference({ model: selectedModel, reasoningEffort, permissionMode, riskThreshold });
    ui.setPermissionMode(permissionMode);
  });

  // 待处理并发消息队列
  const pendingInputs: string[] = [];

  const startBackgroundInput = () => {
    if (ui.isInputActive()) return;
    ui.readInput({ slashCommands }).then(input => {
      const trimmed = input.trim();
      if (trimmed) {
        pendingInputs.push(trimmed);
        ui.setQueue(pendingInputs);
      }
      startBackgroundInput();
    }).catch(err => {
      if (err instanceof TerminalInputCancelledError) return;
    });
  };

  try {
    while (true) {
      let userInput: string;
      if (pendingInputs.length > 0) {
        userInput = pendingInputs.shift()!;
        ui.setQueue(pendingInputs);
      } else {
        if (ui.isInputActive()) {
          ui.cancelInput();
        }
        userInput = await ui.readInput({ slashCommands });
      }

      const trimmedInput = userInput.trim();
      if (!trimmedInput) {
        continue;
      }

      ui.writeLine();
      ui.writeLine(colors.userMsg(trimmedInput));
      ui.writeLine();

      // 解析斜杠内置命令
      if (trimmedInput.startsWith('/')) {
        const parts = trimmedInput.slice(1).split(/\s+/);
        const command = parts[0].toLowerCase();

        if (command === 'exit' || command === 'quit') {
          ui.writeLine(colors.gray('再见！'));
          break;
        }
        if (command === 'clear') {
          sessionManager.startNewSession();
          messages = [{ role: 'system', content: systemPrompt }];
          sessionManager.saveCurrentSession(messages);
          updateStatusUI();
          ui.clearChat();
          ui.writeLine(colors.green('🧹 已开启全新对话并重置上下文。'));
          continue;
        }
        if (command === 'resume') {
          const sessions = sessionManager.listSessions();
          if (sessions.length === 0) {
            ui.writeLine(colors.yellow('⚠️ 暂无存盘的历史对话记录。'));
            continue;
          }

          const items = sessions.map(s => {
            const timeStr = new Date(s.updatedAt).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit'
            });
            const msgCount = s.messages.filter(m => m.role === 'user').length;
            return {
              value: s.id,
              label: `[${timeStr}] ${s.title}`,
              description: `(${msgCount} 条消息)`
            };
          });

          try {
            const selection = await ui.readSelection({
              title: '选择要恢复的历史对话 (按最近时间排序)',
              items,
              selectedValue: sessionManager.getCurrentSession().id
            });

            const loaded = sessionManager.loadSession(selection.value);
            if (loaded && loaded.messages.length > 0) {
              messages = loaded.messages;
              updateStatusUI();
              const historyOutput: string[] = [];
              const appendHistoryLine = (value: string = '') => historyOutput.push(`${value}\n`);
              appendHistoryLine(colors.boldGreen(`✓ 已恢复会话：「${loaded.title}」 (${loaded.messages.length} 条上下文)`));
              // 完整回显历史会话中的全量消息轨迹 (User / Assistant / Tool)
              for (const m of messages) {
                if (m.role === 'system') continue;

                if (m.role === 'user' && typeof m.content === 'string') {
                  appendHistoryLine();
                  appendHistoryLine(colors.userMsg(m.content));
                  appendHistoryLine();
                } else if (m.role === 'assistant') {
                  if (m.reasoning_content) {
                    appendHistoryLine(colors.gray(`💭 深度思考 (${m.reasoning_content.length} 字)`));
                  }
                  if (m.content) {
                    const mdRenderer = new MarkdownStreamRenderer();
                    const rendered = mdRenderer.render(m.content, true);
                    appendHistoryLine(rendered);
                  }
                  if (m.tool_calls && m.tool_calls.length > 0) {
                    for (const tc of m.tool_calls) {
                      let argsObj = {};
                      try {
                        argsObj = JSON.parse(tc.function.arguments);
                      } catch {}
                      const argsSummary = formatToolArgs(argsObj);
                      const displayArgs = argsSummary ? `(${colors.cyan(argsSummary)})` : '';
                      appendHistoryLine(`  ${colors.purple(tc.function.name)}${displayArgs}`);
                    }
                  }
                  appendHistoryLine();
                } else if (m.role === 'tool') {
                  const isError = typeof m.content === 'string' && (m.content.startsWith('错误:') || m.content.startsWith('执行出错:'));
                  if (isError) {
                    appendHistoryLine(`  ${colors.boldRed('❌')} ${colors.red('工具执行出错')}`);
                  } else {
                    appendHistoryLine(`  ${colors.boldGreen('✓')} ${colors.gray('工具执行成功')}`);
                  }
                }
              }
              ui.replaceChat(historyOutput.join(''));
            } else {
              ui.writeLine(colors.yellow('⚠️ 选中的会话为空或加载失败。'));
            }
            continue;
          } catch (error) {
            if (error instanceof TerminalInputCancelledError) {
              ui.writeLine(colors.gray('已取消会话切换。'));
              continue;
            }
            throw error;
          }
        }
        if (command === 'rewind') {
          const userMessageNodes: Array<{ index: number; content: string }> = [];
          for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('/')) {
              userMessageNodes.push({ index: i, content: m.content });
            }
          }

          if (userMessageNodes.length === 0) {
            ui.writeLine(colors.yellow('⚠️ 当前会话中暂无合法的用户对话节点可供回退。'));
            continue;
          }

          const items = [...userMessageNodes].reverse().map(node => {
            const preview = node.content.length > 40 ? `${node.content.slice(0, 40)}...` : node.content;
            return {
              value: String(node.index),
              label: `#${node.index}: ${preview}`,
              description: node.content
            };
          });

          try {
            const selection = await ui.readSelection({
              title: '选择要退回的用户历史节点',
              items,
              selectedValue: items[0].value,
              secondary: {
                label: '确认退回并重置代码？',
                items: [
                  { value: 'yes', label: 'Yes (确认回退消息与代码)' },
                  { value: 'no', label: 'No (取消)' }
                ],
                selectedValue: 'no'
              }
            });

            if (selection.secondaryValue !== 'yes') {
              ui.writeLine(colors.gray('已取消 /rewind 退回操作。'));
              continue;
            }

            const targetMsgIndex = parseInt(selection.value, 10);
            const targetMsgNode = messages[targetMsgIndex];
            const targetContent = typeof targetMsgNode?.content === 'string' ? targetMsgNode.content : '';

            // 1. 截断消息历史（丢弃该节点之后的所有消息与回复）
            messages = messages.slice(0, targetMsgIndex);
            updateStatusUI();

            // 2. 联动回退代码文件变动
            const snapshotEngine = new SnapshotEngine(process.cwd());
            const headHash = snapshotEngine.getCurrentHeadHash();
            if (headHash) {
              snapshotEngine.rollback(headHash);
            }

            // 3. 清理聊天重置界面提示
            ui.clearChat();
            ui.writeLine(colors.boldGreen(`↺ 已成功退回历史至节点 #${targetMsgIndex}，并恢复了代码文件。`));
            ui.writeLine(colors.gray('已将选中消息文本回填至底栏输入框，请修改后发送：'));

            // 4. 将选中的用户消息文本回填回底栏输入框
            if (targetContent) {
              userInput = await ui.readInput({ slashCommands, initialValue: targetContent });
              const refilledTrimmed = userInput.trim();
              if (!refilledTrimmed) continue;
              // 自动跳出斜杠解析进入流程
              breakCommandProcessing: {
                if (refilledTrimmed.startsWith('/')) {
                  break breakCommandProcessing;
                }
              }
            } else {
              continue;
            }
          } catch (error) {
            if (error instanceof TerminalInputCancelledError) {
              ui.writeLine(colors.gray('已取消 /rewind 退回操作。'));
              continue;
            }
            throw error;
          }
        }
        if (command === 'compact') {
          ui.writeLine(colors.boldPurple('🧹 正在执行四层上下文压缩管线...'));
          const result = await runCompactionPipeline(messages, { forceL4: true });
          messages = result.messages;
          updateStatusUI();
          const layersStr = result.layersApplied.length > 0 ? result.layersApplied.join(' -> ') : '已处于精简状态';
          ui.writeLine(colors.boldGreen(`✓ 上下文压缩完成！(${layersStr})`));
          ui.writeLine(colors.cyan(`  字符占用: ${result.originalChars.toLocaleString()} ➔ ${result.compactedChars.toLocaleString()} (释放了 ${result.freedPercentage}% 空间)`));
          continue;
        }
        if (command === 'effort') {
          let requestedEffort = parts[1]?.toLowerCase();
          if (!requestedEffort) {
            try {
              const selection = await ui.readSelection({
                title: '选择思考强度',
                items: EFFORT_OPTIONS,
                selectedValue: reasoningEffort
              });
              requestedEffort = selection.value;
            } catch (error) {
              if (error instanceof TerminalInputCancelledError) {
                ui.writeLine(colors.gray('已取消切换思考强度。'));
                continue;
              }
              throw error;
            }
          }
          if (!isReasoningEffort(requestedEffort)) {
            ui.writeLine(colors.red(`无效思考强度：${requestedEffort}`));
            ui.writeLine(colors.gray('可选：low、medium、high、xhigh、max'));
            continue;
          }

          reasoningEffort = requestedEffort;
          systemPrompt = await createSystemPrompt();
          messages[0] = { role: 'system', content: systemPrompt };
          updateStatusUI();
          ui.writeLine(colors.green(`已切换到 ${reasoningEffort}，当前会话历史已保留。`));
          continue;
        }
        if (command === 'model') {
          try {
            const selection = await ui.readSelection({
              title: '选择模型',
              items: availableModels,
              selectedValue: selectedModel,
              secondary: {
                label: '思考强度',
                items: EFFORT_OPTIONS,
                selectedValue: reasoningEffort
              }
            });

            if (!isReasoningEffort(selection.secondaryValue)) {
              throw new Error('模型选择器返回了无效配置');
            }
            const newModel = selection.value;
            const newProviderName = detectProviderForModel(newModel);
            // 如果切换了模型，重建 Provider 实例
            if (newModel !== selectedModel || newProviderName !== currentProviderName) {
              provider = buildProvider(newModel);
              currentProviderName = newProviderName;
            }
            selectedModel = newModel;
            reasoningEffort = selection.secondaryValue;
            systemPrompt = await createSystemPrompt();
            messages[0] = { role: 'system', content: systemPrompt };
            // 持久化用户偏好到本地
            savePreference({ model: selectedModel, reasoningEffort });
            updateStatusUI();
            const providerLabel = currentProviderName === 'volcengine' ? '🌋 火山引擎' : '🔵 DeepSeek';
            ui.writeLine(colors.green(`模型：${selectedModel} · 思考强度：${reasoningEffort} · 提供商：${providerLabel}`));
          } catch (error) {
            if (error instanceof TerminalInputCancelledError) {
              ui.writeLine(colors.gray('已取消模型选择。'));
              continue;
            }
            throw error;
          }
          continue;
        }
        if (command === 'permission' || command === 'perm') {
          let reqMode = parts[1]?.toLowerCase();
          if (!reqMode) {
            try {
              const selection = await ui.readSelection({
                title: '选择权限档次',
                items: PERMISSION_MODES,
                selectedValue: permissionMode,
                secondary: {
                  label: 'Auto 危险阈值',
                  items: [
                    { value: 'low', label: 'LOW', description: '严苛（允许无副作用命令）' },
                    { value: 'medium', label: 'MEDIUM', description: '标准（推荐，阻止高危操作）' },
                    { value: 'high', label: 'HIGH', description: '宽松（仅阻止极危险破坏命令）' }
                  ],
                  selectedValue: riskThreshold
                }
              });
              reqMode = selection.value;
              if (selection.secondaryValue && ['low', 'medium', 'high'].includes(selection.secondaryValue)) {
                riskThreshold = selection.secondaryValue as RiskLevel;
              }
            } catch (error) {
              if (error instanceof TerminalInputCancelledError) {
                ui.writeLine(colors.gray('已取消切换权限模式。'));
                continue;
              }
              throw error;
            }
          }

          if (!isPermissionMode(reqMode)) {
            ui.writeLine(colors.red(`无效权限模式：${reqMode}`));
            ui.writeLine(colors.gray('可选：default、accept-edit、auto、bypass-permissions'));
            continue;
          }

          permissionMode = reqMode;
          savePreference({ model: selectedModel, reasoningEffort, permissionMode, riskThreshold });
          ui.setPermissionMode(permissionMode);
          ui.writeLine(colors.green(`🛡️  系统权限已设置为 [${permissionMode}] (Auto 危险阈值: ${riskThreshold})`));
          continue;
        }
        if (command === 'help') {
          const helpLines = [
            colors.bold('可用斜杠指令：'),
            `  ${colors.purple('/help')}        - 显示帮助手册`,
            `  ${colors.purple('/permission')}  - 切换权限档次与安全阈值（当前：${permissionMode}）`,
            `  ${colors.purple('/effort')}      - 切换思考强度（当前：${reasoningEffort}）`,
            `  ${colors.purple('/model')}       - 选择模型（当前：${selectedModel}）`,
            `  ${colors.purple('/clear')}       - 清空聊天区与上下文`,
            `  ${colors.purple('/viewer')}      - 打开 Trace 观测中心`,
            `  ${colors.purple('/exit')}        - 退出 haji 对话`,
            '',
            colors.bold('已注册的系统工具：'),
            ...tools.map(t => `  ⚙️  ${colors.blue(t.name.padEnd(20))} : ${t.definition.function.description}`),
            '',
            ''
          ];
          ui.writeChat(helpLines.join('\n'));
          continue;
        }
        if (command === 'viewer') {
          const url = `http://localhost:3000/viewer?session=${tracker.getSessionId()}`;
          ui.writeLine(`📊 Trace 观测中心：${colors.blue(url)}`);
          ui.writeLine(colors.gray('正在尝试在浏览器中打开链接...'));
          let openCmd = process.platform === 'win32' ? `start "" "${url}"` : (process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
          exec(openCmd, () => { });
          continue;
        }

ui.writeLine(colors.red(`未知命令: /${command}。输入 /help 查看帮助。`));
        continue;
      }

      // 记录用户消息到 Trace 与上下文
      tracker.recordUserInput(trimmedInput);
      messages.push({ role: 'user', content: trimmedInput });
      updateStatusUI();

      // 首条用户消息触发后台并行生成标题与存盘
      const isFirstUserMsg = messages.filter(m => m.role === 'user').length === 1;
      if (isFirstUserMsg) {
        sessionManager.saveCurrentSession(messages);
        sessionManager.generateTitleAsync(trimmedInput, async (prompt) => {
          let fullTitleText = '';
          const titleStream = provider.completeStream([{ role: 'user', content: prompt }], {
            model: selectedModel,
            reasoningEffort: 'low'
          });
          for await (const chunk of titleStream) {
            fullTitleText += chunk;
          }
          return fullTitleText;
        }).catch(() => {});
      } else {
        sessionManager.saveCurrentSession(messages);
      }

      let keepCalling = true;
      while (keepCalling) {
        startBackgroundInput();
        let currentToolCalls: ToolCall[] | null = null;
        let completionTokens: number | undefined;
        const thinkingStartedAt = Date.now();

        // 启动异步 Spinner 加载动画（TTFT 思考期）
        let isThinking = true;
        const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        let spinIdx = 0;

        ui.setStatus(`⠋ ${colors.gray('思考中...')}`);
        const spinnerInterval = setInterval(() => {
          if (isThinking) {
            const statusLabel = reasoningContent.length > 0
              ? `深度思考中... (${reasoningContent.length} 字)`
              : '思考中...';
            ui.setStatus(`${spinnerChars[spinIdx]} ${colors.gray(statusLabel)}`);
            spinIdx = (spinIdx + 1) % spinnerChars.length;
          }
        }, 80);

        let textContent = '';
        let reasoningContent = '';
        let isTurnAborted = false;
        let currentAbortController: AbortController | null = null;
        const mdStreamRenderer = new MarkdownStreamRenderer();
        const streamStartOffset = ui.getChatLength();
        ui.markStableChatPrefix(streamStartOffset);

        ui.onEsc(() => {
          isTurnAborted = true;
          if (currentAbortController) {
            try {
              currentAbortController.abort();
            } catch {}
          }
        });

        currentAbortController = new AbortController();
        const stream = provider.completeStream(messages, {
          model: selectedModel,
          reasoningEffort,
          thinking: true,
          tools: toolDefinitions,
          abortSignal: currentAbortController.signal,
          onToolCall: (tcs: ToolCall[]) => {
            currentToolCalls = tcs;
          },
          onReasoning: (content: string) => {
            reasoningContent += content;
            if (isThinking) {
              ui.setStatus(`${spinnerChars[spinIdx]} ${colors.gray(`深度思考中... (${reasoningContent.length} 字)`)}`);
            }
          },
          onUsage: usage => {
            completionTokens = usage.completion_tokens;
          }
        });

        try {
          for await (const chunk of stream) {
            if (isThinking) {
              isThinking = false;
              ui.setStatus();
            }

            textContent += chunk;
            // 使用流式 Markdown 引擎实时平滑渲染 ANSI
            const renderedMarkdown = mdStreamRenderer.render(textContent, false);
            ui.updateChatFrom(streamStartOffset, renderedMarkdown);
          }

          // 结束流式输出，做最终渲染
          if (textContent) {
            const finalRenderedMarkdown = mdStreamRenderer.render(textContent, true);
            ui.updateChatFrom(streamStartOffset, finalRenderedMarkdown);
          }
        } catch (streamError) {
          clearInterval(spinnerInterval);
          ui.setStatus();
          if (isTurnAborted) {
            // 用户按 ESC 主动中断，显示专门的对话已终止提示
            ui.writeLine();
            ui.writeLine(colors.boldYellow('🛑 对话已终止。'));
            ui.writeLine();
          } else {
            // 捕获 Provider 调用错误，展示友好提示而非崩溃
            const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
            ui.writeLine();
            ui.writeLine(colors.boldRed(`❌ 模型调用出错: ${errMsg}`));
            ui.writeLine(colors.gray('提示: 请检查模型名称、API Key 是否正确，或使用 /model 切换其他模型。'));
            ui.writeLine();
          }
          keepCalling = false;
          continue;
        } finally {
          clearInterval(spinnerInterval);
          ui.setStatus();
        }

        if (isThinking) {
          isThinking = false;
        }

        const toolCalls = currentToolCalls as ToolCall[] | null;
        if (toolCalls && toolCalls.length > 0) {
          const thinkingSeconds = Math.max(1, Math.round((Date.now() - thinkingStartedAt) / 1000));
          const tokenSummary = completionTokens === undefined
            ? 'token usage unavailable'
            : `${completionTokens.toLocaleString('en-US')} tokens consumed`;
          ui.writeLine(colors.gray(`Think ${thinkingSeconds} s, ${tokenSummary}.`));
        } else {
          ui.writeLine();
        }

        // 保存助理回复
        const assistantMessage: ChatMessage = { role: 'assistant', content: textContent };
        if (reasoningContent) {
          assistantMessage.reasoning_content = reasoningContent;
        }
        if (toolCalls && toolCalls.length > 0) {
          assistantMessage.tool_calls = toolCalls;
        }
        messages.push(assistantMessage);
        sessionManager.saveCurrentSession(messages);
        updateStatusUI();

        // 处理工具调用逻辑
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            // 用户按 ESC 中断后跳过后续工具执行
            if (isTurnAborted) {
              ui.writeLine(colors.boldYellow('🛑 对话已终止，跳过剩余工具调用。'));
              break;
            }
            const toolName = tc.function.name;
            const targetTool = toolsMap.get(toolName);

            if (!targetTool) {
              ui.writeLine(`❌ ${colors.red(`错误: 调用的工具 "${toolName}" 未注册。`)}`);
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: `错误: 工具 "${toolName}" 未注册。`
              });
              sessionManager.saveCurrentSession(messages);
              updateStatusUI();
              continue;
            }

            let args = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (e) { }

            // 获取用户最新意图（提取上下文中的最近一条 user 消息）
            const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

            // 触发 PreToolUse 钩子（包含权限引擎评估与用户授权弹窗）
            const preHookResult = await hookEngine.trigger('PreToolUse', {
              toolName,
              args,
              userIntent: lastUserMsg,
              permissionMode,
              riskThreshold
            });

            let toolOutput = '';
            const toolStartTime = Date.now();
            if (preHookResult) {
              // 被 Hook 拦截（安全拒绝或用户拒绝执行）
              toolOutput = preHookResult;
            } else {
              // Hook 放行，执行真实工具
              ui.setStatus(`${colors.blue('⚙')} ${colors.gray(`正在执行 ${toolName}...`)}`);
              try {
                toolOutput = await targetTool.execute(args);
              } catch (error) {
                toolOutput = `执行出错: ${error instanceof Error ? error.message : String(error)}`;
              } finally {
                ui.setStatus();
              }

              // 输出工具正常/异常执行单行结果
              const toolDuration = Date.now() - toolStartTime;
              const argsSummary = formatToolArgs(args);
              const displayArgs = argsSummary ? `(${colors.cyan(argsSummary)})` : '';
              if (toolOutput.startsWith('执行出错:')) {
                ui.writeLine(`  ${colors.boldRed('❌')} ${colors.purple(toolName)}${displayArgs} ${colors.red(`(${toolOutput})`)}`);
              } else {
                ui.writeLine(`  ${colors.boldGreen('✓')} ${colors.purple(toolName)}${displayArgs} ${colors.gray(`(${toolDuration}ms)`)}`);
              }
            }

            // 触发 PostToolUse 钩子（记录 Trace 轨迹日志与后续切面动作）
            await hookEngine.trigger('PostToolUse', {
              toolCallId: tc.id,
              toolName,
              args,
              toolOutput
            });

            // 保存工具输出至上下文
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolOutput
            });
            sessionManager.saveCurrentSession(messages);
            updateStatusUI();
          }
          keepCalling = true;
        } else {
          keepCalling = false;
        }
        sessionManager.saveCurrentSession(messages);
      }
    }
  } catch (error) {
    if (error instanceof TerminalInputCancelledError) {
      ui.writeLine(colors.gray('已取消输入。'));
    } else {
      throw error;
    }
  } finally {
    ui.close();
    try {
      const tracePath = await tracker.save();
      console.log(`\n💾 会话 Trace 数据已保存至: ${colors.blue(tracePath)}`);
    } catch (e) {
      console.error('无法保存 Trace 轨迹数据:', e);
    }
  }
}

main();
