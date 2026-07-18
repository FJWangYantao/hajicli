#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { SystemPromptManager, SessionTracker, ObservableModelProvider, startTraceServer, ChatMessage, ToolCall, ReasoningEffort, REASONING_EFFORTS, isReasoningEffort, PermissionEngine, PermissionMode, PERMISSION_MODES, isPermissionMode, RiskLevel } from '@hajicli/core';
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

async function main() {
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

  // 初始化会话历史记录
  let messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  const ui = new TerminalUI({
    header: LOGO.trim(),
    compactHeader: colors.boldPurple('HAJI'),
    inputPrompt: '',
    continuationPrompt: '',
    renderBorder: width => colors.gray('─'.repeat(width))
  });
  const slashCommands = [
    { command: '/help', description: '显示帮助' },
    { command: '/permission', description: '切换权限档次与安全阈值' },
    { command: '/effort', description: '切换思考强度' },
    { command: '/model', description: '选择模型与思考强度' },
    { command: '/clear', description: '清空聊天与上下文' },
    { command: '/viewer', description: '打开 Trace 观测中心' },
    { command: '/exit', description: '退出 haji' }
  ];
  ui.start();
  ui.setPermissionMode(permissionMode);

  // 绑定 Shift+Tab 快捷键动态循环切换权限档次
  const permissionCycleList: PermissionMode[] = ['default', 'accept-edit', 'auto', 'bypass-permissions'];
  ui.onShiftTab(() => {
    const currIdx = permissionCycleList.indexOf(permissionMode);
    const nextIdx = (currIdx + 1) % permissionCycleList.length;
    permissionMode = permissionCycleList[nextIdx];
    savePreference({ model: selectedModel, reasoningEffort, permissionMode, riskThreshold });
    ui.setPermissionMode(permissionMode);
  });

  try {
    while (true) {
      const userInput = await ui.readInput({ slashCommands });

      const trimmedInput = userInput.trim();
      if (!trimmedInput) {
        continue;
      }

      ui.writeLine(userInput);
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
          messages = [{ role: 'system', content: systemPrompt }];
          ui.clearChat();
          ui.writeLine(colors.green('🧹 已清空聊天区并重置会话上下文。'));
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

      let keepCalling = true;
      while (keepCalling) {
        let currentToolCalls: ToolCall[] | null = null;

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
        let inCodeBlock = false;

        const stream = provider.completeStream(messages, {
          model: selectedModel,
          reasoningEffort,
          thinking: true,
          tools: toolDefinitions,
          onToolCall: (tcs: ToolCall[]) => {
            currentToolCalls = tcs;
          },
          onReasoning: (content: string) => {
            reasoningContent += content;
            if (isThinking) {
              ui.setStatus(`${spinnerChars[spinIdx]} ${colors.gray(`深度思考中... (${reasoningContent.length} 字)`)}`);
            }
          }
        });

        try {
          for await (const chunk of stream) {
            if (isThinking) {
              isThinking = false;
              ui.setStatus();
            }

            // 代码块在终端的流式变色渲染
            let formattedChunk = chunk;
            if (chunk.includes('```')) {
              inCodeBlock = !inCodeBlock;
              formattedChunk = chunk.replace(/```/g, colors.gray('```'));
            }

            if (inCodeBlock && !chunk.includes('```')) {
              ui.writeChat(colors.cyan(formattedChunk));
            } else {
              ui.writeChat(formattedChunk);
            }

            textContent += chunk;
          }
        } catch (streamError) {
          // 捕获 Provider 调用错误，展示友好提示而非崩溃
          clearInterval(spinnerInterval);
          ui.setStatus();
          const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
          ui.writeLine();
          ui.writeLine(colors.boldRed(`❌ 模型调用出错: ${errMsg}`));
          ui.writeLine(colors.gray('提示: 请检查模型名称、API Key 是否正确，或使用 /model 切换其他模型。'));
          ui.writeLine();
          keepCalling = false;
          continue;
        } finally {
          clearInterval(spinnerInterval);
          ui.setStatus();
        }

        if (isThinking) {
          isThinking = false;
        }

        ui.writeLine();
        ui.writeLine();

        // 保存助理回复
        const assistantMessage: ChatMessage = { role: 'assistant', content: textContent };
        if (reasoningContent) {
          assistantMessage.reasoning_content = reasoningContent;
        }
        const toolCalls = currentToolCalls as ToolCall[] | null;
        if (toolCalls && toolCalls.length > 0) {
          assistantMessage.tool_calls = toolCalls;
        }
        messages.push(assistantMessage);

        // 处理工具调用逻辑
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const toolName = tc.function.name;
            const targetTool = toolsMap.get(toolName);

            if (!targetTool) {
              ui.writeLine(`❌ ${colors.red(`错误: 调用的工具 "${toolName}" 未注册。`)}`);
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: `错误: 工具 "${toolName}" 未注册。`
              });
              continue;
            }

            let args = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (e) { }

            // 获取用户最新意图（提取上下文中的最近一条 user 消息）
            const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

            // 使用 PermissionEngine 评估工具调用安全性
            const checkResult = await permissionEngine.evaluate({
              mode: permissionMode,
              toolName,
              args,
              userIntent: lastUserMsg,
              riskThreshold
            });

            const argsSummary = formatToolArgs(args);
            const displayArgs = argsSummary ? `(${colors.cyan(argsSummary)})` : '';
            let approved = false;
            let autoDeniedReason: string | undefined = undefined;

            if (checkResult.action === 'allow') {
              approved = true;
            } else if (checkResult.action === 'prompt') {
              const answer = await ui.readInput({
                prompt: `  ${colors.boldYellow('⚠️  AI 申请执行修改型工具：')}${colors.purple(toolName)}${displayArgs} ${colors.boldYellow('授权？(y/N)')} › `
              });
              approved = answer.trim().toLowerCase() === 'y';
            } else if (checkResult.action === 'deny') {
              approved = false;
              autoDeniedReason = checkResult.reason || 'Auto 分类器安全拦截';
            }

            let toolOutput = '';
            const toolStartTime = Date.now();
            if (approved) {
              ui.setStatus(`${colors.blue('⚙')} ${colors.gray(`正在执行 ${toolName}...`)}`);
              try {
                toolOutput = await targetTool.execute(args);
              } catch (error) {
                toolOutput = `执行出错: ${error instanceof Error ? error.message : String(error)}`;
              } finally {
                ui.setStatus();
              }
            } else {
              if (autoDeniedReason) {
                toolOutput = `[安全引擎拒绝拦截] 命令 "${toolName}" 被 Auto 分类器检测为超出允许的危险阈值 (${checkResult.riskLevel})。拒绝原因: ${autoDeniedReason}。请重新分析用户意图，改用更安全的替代指令或步骤。`;
              } else {
                toolOutput = '错误: 用户拒绝了此命令的执行请求。';
              }
            }
            const toolDuration = Date.now() - toolStartTime;

            // 记录事件到 Trace 追踪器
            tracker.recordToolExecution(
              tc.id,
              toolName,
              args,
              approved,
              toolOutput,
              approved ? toolDuration : undefined
            );

            // 保存工具输出至上下文
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolOutput
            });

            // 统一单行输出工具执行结果
            if (!approved) {
              if (autoDeniedReason) {
                ui.writeLine(`  ${colors.boldRed('🛡️ [Auto安全拦截]')} ${colors.purple(toolName)}${displayArgs} ${colors.red(`(评级: ${checkResult.riskLevel} - ${autoDeniedReason})`)}`);
              } else {
                ui.writeLine(`  ${colors.boldRed('✕')} ${colors.purple(toolName)}${displayArgs} ${colors.gray('(已拒绝执行)')}`);
              }
            } else if (toolOutput.startsWith('执行出错:')) {
              ui.writeLine(`  ${colors.boldRed('❌')} ${colors.purple(toolName)}${displayArgs} ${colors.red(`(${toolOutput})`)}`);
            } else {
              ui.writeLine(`  ${colors.boldGreen('✓')} ${colors.purple(toolName)}${displayArgs} ${colors.gray(`(${toolDuration}ms)`)}`);
            }
          }
          keepCalling = true;
        } else {
          keepCalling = false;
        }
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
