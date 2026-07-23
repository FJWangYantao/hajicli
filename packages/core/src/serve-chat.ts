import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { ModelProvider, BaseTool, ChatMessage, ToolCall } from './types.js';
import { SessionTracker } from './trace-logger.js';
import { ObservableModelProvider } from './observable-provider.js';
import { validateToolCall } from './tool-call-validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 启动独立的交互式对话 Web Chat 服务器（零第三方依赖）。
 * @param provider - 基础大模型提供商（建议使用 ObservableModelProvider 包装以自动同步轨迹）。
 * @param tools - AI 支持的本地工具集。
 * @param systemPrompt - 系统提示词模板。
 * @param port - 对话服务端口（默认 3001）。
 * @param openBrowser - 是否自动在浏览器中打开对话页面。
 */
export async function startChatServer(
  provider: ModelProvider,
  tools: BaseTool[],
  systemPrompt: string,
  port: number = 3001,
  openBrowser: boolean = true
): Promise<void> {
  const toolsMap = new Map(tools.map(t => [t.name, t]));
  const toolDefinitions = tools.map(t => t.definition);

  // 内存中缓存的活跃会话历史与轨迹追踪器
  interface ActiveSession {
    id: string;
    messages: ChatMessage[];
    tracker: SessionTracker;
  }
  const activeSessions = new Map<string, ActiveSession>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    // 设置跨域头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      // 路由：访问对话主页
      if (pathname === '/' || pathname === '/chat') {
        let htmlPath = path.join(__dirname, 'chat.html');
        try {
          await fs.access(htmlPath);
        } catch {
          // 兜底尝试从源码目录加载
          htmlPath = path.join(__dirname, '..', 'src', 'chat.html');
        }

        const html = await fs.readFile(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // 路由：API 流式对话接口
      if (pathname === '/api/chat' && req.method === 'POST') {
        // 读取 Body 数据
        let bodyRaw = '';
        for await (const chunk of req) {
          bodyRaw += chunk;
        }

        let payload: { message: string; sessionId?: string };
        try {
          payload = JSON.parse(bodyRaw);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('请求 Body 解析 JSON 失败');
          return;
        }

        const userInput = (payload.message || '').trim();
        if (!userInput) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('输入消息不能为空');
          return;
        }

        // 确定/初始化会话
        let session: ActiveSession;
        if (payload.sessionId && activeSessions.has(payload.sessionId)) {
          session = activeSessions.get(payload.sessionId)!;
        } else {
          const tracker = new SessionTracker();
          session = {
            id: tracker.getSessionId(),
            messages: [{ role: 'system', content: systemPrompt }],
            tracker
          };
          activeSessions.set(session.id, session);
        }

        // 用该会话专用的 tracker 包装 ModelProvider，实现独立的轨迹记录
        const sessionProvider = new ObservableModelProvider(provider, session.tracker);

        // 记录用户消息到内存及 Trace
        session.messages.push({ role: 'user', content: userInput });
        session.tracker.recordUserInput(userInput);

        // 设置流式响应头
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Transfer-Encoding': 'chunked'
        });

        // 启动 AI 代理循环（自动调用工具）
        let keepCalling = true;
        while (keepCalling) {
          let currentToolCalls: ToolCall[] | null = null;
          let textContent = '';
          let finishReason: string | undefined;

          // 流式生成回复
          const stream = sessionProvider.completeStream(session.messages, {
            tools: toolDefinitions,
            onToolCall: (tcs) => {
              currentToolCalls = tcs;
            },
            onFinish: finish => {
              finishReason = finish.reason;
            }
          });

          for await (const chunk of stream) {
            textContent += chunk;
            // 实时写回文本 Chunk
            res.write(JSON.stringify({ type: 'text', content: chunk }) + '\n');
          }

          // 保存 AI 文本回复
          const assistantMessage: ChatMessage = { role: 'assistant', content: textContent };
          const toolCalls = currentToolCalls as ToolCall[] | null;
          const invalidToolCall = toolCalls?.map(toolCall => ({
            toolCall,
            validation: validateToolCall(toolCall)
          })).find(item => !item.validation.valid);
          if (toolCalls && toolCalls.length > 0 && !invalidToolCall) {
            assistantMessage.tool_calls = toolCalls;
          }
          session.messages.push(assistantMessage);

          if (invalidToolCall) {
            res.write(JSON.stringify({
              type: 'error',
              content: `已拦截未执行的不完整工具调用：${invalidToolCall.validation.error}${finishReason === 'length' ? '（输出达到长度上限）' : ''}`
            }) + '\n');
            keepCalling = false;
            continue;
          }

          // 处理工具调用
          if (toolCalls && toolCalls.length > 0) {
            for (const tc of toolCalls) {
              const toolName = tc.function.name;
              const targetTool = toolsMap.get(toolName);

              const args = validateToolCall(tc).arguments || {};

              // 实时通知前端：工具执行开始
              res.write(JSON.stringify({ type: 'tool_start', name: toolName, arguments: args }) + '\n');

              let toolOutput = '';
              const toolStartTime = Date.now();

              if (!targetTool) {
                toolOutput = `错误: 未找到注册的工具 "${toolName}"。`;
              } else {
                try {
                  // 网页交互中默认自动授权执行本地工具，提高操作流畅性
                  toolOutput = await targetTool.execute(args);
                } catch (error) {
                  toolOutput = `执行出错: ${error instanceof Error ? error.message : String(error)}`;
                }
              }

              const toolDuration = Date.now() - toolStartTime;

              // 记录工具执行到 Trace 追踪器
              session.tracker.recordToolExecution(
                tc.id,
                toolName,
                args,
                true, // 自动授权
                toolOutput,
                toolDuration
              );

              // 实时通知前端：工具执行结束与输出
              res.write(JSON.stringify({
                type: 'tool_end',
                name: toolName,
                output: toolOutput,
                duration: toolDuration
              }) + '\n');

              // 保存工具输出到会话上下文
              session.messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: toolOutput
              });
            }
            keepCalling = true;
          } else {
            keepCalling = false;
          }
        }

        // 保存本次交互最新的轨迹到本地文件
        await session.tracker.save();

        // 结束本次 HTTP 对话流
        res.write(JSON.stringify({ type: 'done', sessionId: session.id }) + '\n');
        res.end();
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      } else {
        res.write(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }) + '\n');
      }
      res.end(`Internal Server Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return new Promise<void>((resolve, reject) => {
    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, () => {
      const addr = `http://localhost:${port}`;
      console.log(`\n💬 haji 极简网页对话服务器已在本地运行: ${addr}`);
      console.log(`   访问该地址即可开始交互式 AI 编程对话`);

      if (openBrowser) {
        let cmd = '';
        if (process.platform === 'win32') {
          cmd = `start "" "${addr}"`;
        } else if (process.platform === 'darwin') {
          cmd = `open "${addr}"`;
        } else {
          cmd = `xdg-open "${addr}"`;
        }
        exec(cmd, (err) => {
          if (err) {
            console.log(`   [提示] 自动打开浏览器失败，请手动访问: ${addr}`);
          }
        });
      }
      resolve();
    });
  });
}
