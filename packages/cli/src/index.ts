#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
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
${colors.purple('█   █   ██   █████  █████')}
${colors.purple('█   █  █  █      █    █  ')}
${colors.purple('█████  ████      █    █  ')}
${colors.purple('█   █  █  █  █   █    █  ')}
${colors.purple('█   █  █  █  █████  █████')}
`;

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error(colors.boldRed('错误: 请在运行前将 DEEPSEEK_API_KEY 导出至环境变量。'));
    process.exit(1);
  }

  console.log(LOGO);
  console.log(colors.gray('正在初始化大模型提供商、系统工具和 Trace 观测服务器...'));

  const tracker = new SessionTracker();
  const rawProvider = new DeepSeekProvider({ apiKey });
  const provider = new ObservableModelProvider(rawProvider, tracker);
  const systemPromptManager = new SystemPromptManager();
  const rl = readline.createInterface({ input, output });

  // 在后台异步拉起 Trace 观测服务器，不自动打开浏览器
  startTraceServer(3000, false).catch(() => {});

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

  console.log('==================================================');
  console.log(`🤖 ${colors.bold('haji 极简终端对话中心')} 启动成功！`);
  console.log(`   输入 ${colors.purple('/help')} 查看帮助指令，输入 ${colors.purple('/exit')} 退出会话。`);
  console.log('==================================================\n');

  // 初始化会话历史记录
  let messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  try {
    while (true) {
      // 优雅的用户提示符
      const userInput = await rl.question(`\n${colors.boldPurple('👤 你 › ')}`);
      const trimmedInput = userInput.trim();
      if (!trimmedInput) continue;

      // 解析斜杠内置命令
      if (trimmedInput.startsWith('/')) {
        const parts = trimmedInput.slice(1).split(' ');
        const command = parts[0].toLowerCase();

        if (command === 'exit' || command === 'quit') {
          console.log(colors.gray('再见！'));
          break;
        }
        if (command === 'clear') {
          messages = [{ role: 'system', content: systemPrompt }];
          console.log(colors.green('🧹 已成功重置会话上下文！'));
          continue;
        }
        if (command === 'help') {
          console.log('\n' + colors.bold('可用斜杠指令列表:'));
          console.log(`  ${colors.purple('/help')}    - 显示帮助手册`);
          console.log(`  ${colors.purple('/clear')}   - 清空上下文，开始全新会话`);
          console.log(`  ${colors.purple('/viewer')}  - 打印或自动在浏览器打开 Trace 观测中心`);
          console.log(`  ${colors.purple('/exit')}    - 退出 haji 对话`);
          console.log('\n' + colors.bold('已注册的系统工具列表:'));
          tools.forEach(t => {
            console.log(`  ⚙️  ${colors.blue(t.name.padEnd(20))} : ${t.definition.function.description}`);
          });
          console.log('');
          continue;
        }
        if (command === 'viewer') {
          const url = `http://localhost:3000/viewer?session=${tracker.getSessionId()}`;
          console.log(`📊 Trace 观测中心当前会话链接: ${colors.blue(url)}`);
          console.log(colors.gray('正在尝试在浏览器中打开链接...'));
          let openCmd = process.platform === 'win32' ? `start "" "${url}"` : (process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
          exec(openCmd, () => {});
          continue;
        }

        console.log(colors.red(`未知命令: /${command}。输入 /help 查看帮助。`));
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

        process.stdout.write(`\r${colors.boldGreen('🤖 haji › ')}⠋ ${colors.gray('思考中...')}`);
        const spinnerInterval = setInterval(() => {
          if (isThinking) {
            process.stdout.write(`\r${colors.boldGreen('🤖 haji › ')}${spinnerChars[spinIdx]} ${colors.gray('思考中...')}`);
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

        for await (const chunk of stream) {
          if (isThinking) {
            isThinking = false;
            clearInterval(spinnerInterval);
            // 清除思考中...字样，准备打印文本
            process.stdout.write(`\r${colors.boldGreen('🤖 haji › ')}`);
          }

          // 代码块在终端的流式变色渲染
          let formattedChunk = chunk;
          if (chunk.includes('```')) {
            inCodeBlock = !inCodeBlock;
            formattedChunk = chunk.replace(/```/g, colors.gray('```'));
          }

          if (inCodeBlock && !chunk.includes('```')) {
            process.stdout.write(colors.cyan(formattedChunk));
          } else {
            process.stdout.write(formattedChunk);
          }

          textContent += chunk;
        }

        if (isThinking) {
          isThinking = false;
          clearInterval(spinnerInterval);
          process.stdout.write(`\r${colors.boldGreen('🤖 haji › ')}`);
        }

        process.stdout.write('\n');

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
              console.log(`\n❌ ${colors.red(`错误: 调用的工具 "${toolName}" 未注册。`)}`);
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
            } catch (e) {}

            // 修改型工具申请安全确认，只读型工具自动授权
            const isMutating = ['bash', 'write', 'edit'].includes(toolName);
            let approved = false;

            if (isMutating) {
              console.log(`\n${colors.boldYellow('┌────────────────────────────────────────────────────────┐')}`);
              console.log(`${colors.boldYellow('│')} ⚠️  ${colors.bold('AI 申请在本地执行修改型工具:')} ${colors.purple(toolName)}`);
              console.log(`${colors.boldYellow('│')} ${colors.gray('执行入参:')}`);
              const argsLines = JSON.stringify(args, null, 2).split('\n');
              for (const line of argsLines) {
                console.log(`${colors.boldYellow('│')}   ${colors.cyan(line)}`);
              }
              console.log(`${colors.boldYellow('└────────────────────────────────────────────────────────┘')}`);

              const answer = await rl.question(`   ${colors.bold('是否授权执行该本地工具？(输入 "y" 允许，其他任意键拒绝): ')}`);
              approved = answer.trim().toLowerCase() === 'y';
            } else {
              console.log(`\n🔍 ${colors.gray('[自动授权]')} AI 正在执行只读工具 ${colors.blue(toolName)}...`);
              if (Object.keys(args).length > 0) {
                console.log(`   ${colors.gray('参数:')} ${colors.cyan(JSON.stringify(args))}`);
              }
              approved = true;
            }

            let toolOutput = '';
            const toolStartTime = Date.now();
            if (approved) {
              try {
                toolOutput = await targetTool.execute(args);
              } catch (error) {
                toolOutput = `执行出错: ${error instanceof Error ? error.message : String(error)}`;
              }
            } else {
              toolOutput = '错误: 用户拒绝了此命令的执行请求。';
              console.log(`   ${colors.gray('[已拒绝执行]')}`);
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
              console.log(`   ${colors.green('✓ 执行成功')} ${colors.gray(`(${toolDuration}ms)`)}`);
              // 限制输出打印长度，使终端更加清爽
              const displayOutput = toolOutput.length > 500
                ? (toolOutput.slice(0, 500) + colors.gray('\n...[输出过长已截断，完整日志已自动录入后台 Trace 观测中心]'))
                : toolOutput;
              console.log(`   ${colors.gray('输出内容:')}\n${colors.gray(displayOutput.replace(/^/gm, '     '))}`);
            }
          }
          keepCalling = true;
        } else {
          keepCalling = false;
        }
      }
    }
  } finally {
    rl.close();
    try {
      const tracePath = await tracker.save();
      console.log(`\n💾 会话 Trace 数据已保存至: ${colors.blue(tracePath)}`);
    } catch (e) {
      console.error('无法保存 Trace 轨迹数据:', e);
    }
  }
}

main();
