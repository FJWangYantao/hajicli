#!/usr/bin/env node
import os from 'node:os';
import { exec } from 'node:child_process';
import { SystemPromptManager, SessionTracker, ObservableModelProvider, startTraceServer, ChatMessage, ToolCall } from '@hajicli/core';
import {
  DeepSeekProvider,
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

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error(colors.boldRed('错误: 请在运行前将 DEEPSEEK_API_KEY 导出至环境变量。'));
    process.exit(1);
  }

  // 启动时清空终端屏幕，实现“置顶并开辟新页面”效果
  console.clear();

  console.log(LOGO);
  console.log(colors.gray('正在初始化大模型提供商、系统工具和 Trace 观测服务器...'));

  const tracker = new SessionTracker();
  const rawProvider = new DeepSeekProvider({ apiKey });
  const provider = new ObservableModelProvider(rawProvider, tracker);
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
  const systemPrompt = await systemPromptManager.generatePrompt({
    cwd: process.cwd(),
    os: os.platform() === 'win32' ? 'Windows (基于 Node.js 运行时环境)' : os.platform(),
    tools: tools.map(t => t.name)
  });

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
    { command: '/clear', description: '清空聊天与上下文' },
    { command: '/viewer', description: '打开 Trace 观测中心' },
    { command: '/exit', description: '退出 haji' }
  ];
  ui.start();

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
        const parts = trimmedInput.slice(1).split(' ');
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
        if (command === 'help') {
          const helpLines = [
            colors.bold('可用斜杠指令：'),
            `  ${colors.purple('/help')}    - 显示帮助手册`,
            `  ${colors.purple('/clear')}   - 清空聊天区与上下文`,
            `  ${colors.purple('/viewer')}  - 打开 Trace 观测中心`,
            `  ${colors.purple('/exit')}    - 退出 haji 对话`,
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
            ui.setStatus(`${spinnerChars[spinIdx]} ${colors.gray('思考中...')}`);
            spinIdx = (spinIdx + 1) % spinnerChars.length;
          }
        }, 80);

        const stream = provider.completeStream(messages, {
          tools: toolDefinitions,
          onToolCall: (tcs: ToolCall[]) => {
            currentToolCalls = tcs;
          }
        });

        let textContent = '';
        let inCodeBlock = false;

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

            // 修改型工具申请安全确认，只读型工具自动授权
            const isMutating = ['bash', 'write', 'edit'].includes(toolName);
            let approved = false;

            if (isMutating) {
              ui.writeLine(colors.boldYellow('┌────────────────────────────────────────────────────────┐'));
              ui.writeLine(`${colors.boldYellow('│')} ⚠️  ${colors.bold('AI 申请执行修改型工具：')} ${colors.purple(toolName)}`);
              ui.writeLine(`${colors.boldYellow('│')} ${colors.gray('执行入参：')}`);
              const argsLines = JSON.stringify(args, null, 2).split('\n');
              for (const line of argsLines) {
                ui.writeLine(`${colors.boldYellow('│')}   ${colors.cyan(line)}`);
              }
              ui.writeLine(colors.boldYellow('└────────────────────────────────────────────────────────┘'));

              const answer = await ui.readInput({
                prompt: colors.boldYellow('授权执行？输入 y 允许 › '),
                continuationPrompt: '                       '
              });
              approved = answer.trim().toLowerCase() === 'y';
            } else {
              ui.writeLine(`🔍 ${colors.gray('[自动授权]')} 正在执行只读工具 ${colors.blue(toolName)}...`);
              if (Object.keys(args).length > 0) {
                ui.writeLine(`   ${colors.gray('参数：')} ${colors.cyan(JSON.stringify(args))}`);
              }
              approved = true;
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
              toolOutput = '错误: 用户拒绝了此命令的执行请求。';
              ui.writeLine(`   ${colors.gray('[已拒绝执行]')}`);
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

            if (approved && toolOutput) {
              ui.writeLine(`   ${colors.green('✓ 执行成功')} ${colors.gray(`(${toolDuration}ms)`)}`);
              // 限制输出打印长度，使终端更加清爽
              const displayOutput = toolOutput.length > 500
                ? (toolOutput.slice(0, 500) + colors.gray('\n...[输出过长已截断，完整日志已自动录入后台 Trace 观测中心]'))
                : toolOutput;
              ui.writeLine(`   ${colors.gray('输出内容：')}\n${colors.gray(displayOutput.replace(/^/gm, '     '))}`);
              ui.writeLine();
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
