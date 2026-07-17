import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SessionTracker } from './trace-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 启动本地 Trace 可视化静态与数据服务器（零第三方依赖）。
 * @param port - 服务监听端口。
 * @param openBrowser - 是否自动在浏览器中打开可视化控制台。
 * @param keepAlive - 是否让该服务阻止 Node.js 进程自然退出。
 */
export async function startTraceServer(
  port: number = 3000,
  openBrowser: boolean = true,
  keepAlive: boolean = true
): Promise<void> {
  const tracesDir = path.join(process.cwd(), '.haji', 'traces');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    // 跨域设置
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      // 路由：访问控制台主页
      if (pathname === '/' || pathname === '/viewer') {
        let htmlPath = path.join(__dirname, 'trace-viewer.html');
        try {
          await fs.access(htmlPath);
        } catch {
          // 兜底尝试从源码目录加载
          htmlPath = path.join(__dirname, '..', 'src', 'trace-viewer.html');
        }

        const html = await fs.readFile(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // 路由：API 获取会话列表
      if (pathname === '/api/sessions') {
        const sessions = await SessionTracker.listSessions(tracesDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessions));
        return;
      }

      // 路由：API 获取单会话事件流详情
      if (pathname.startsWith('/api/session/')) {
        const sessionId = pathname.slice('/api/session/'.length);
        // 路径防越权过滤
        if (!/^[a-f0-9\-]+$/.test(sessionId)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid Session ID');
          return;
        }

        const filePath = path.join(tracesDir, `session_${sessionId}.json`);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(content);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Session not found');
        }
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Internal Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return new Promise<void>((resolve, reject) => {
    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, () => {
      if (!keepAlive) {
        server.unref();
      }

      const addr = `http://localhost:${port}`;
      console.log(`\n📊 hajicli 可观测性 Trace 服务器已在本地运行: ${addr}`);
      console.log(`   Trace 记录目录: ${tracesDir}\n`);

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
