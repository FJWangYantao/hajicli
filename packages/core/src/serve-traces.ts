import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionTracker } from "./trace-logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 启动本地 Trace 可视化静态与数据服务器（零第三方依赖）。
 * @param port - 服务监听的首选端口。
 * @param openBrowser - 是否自动在浏览器中打开可视化控制台。
 * @param keepAlive - 是否让该服务阻止 Node.js 进程自然退出。
 * @param maxPortSearch - 首选端口被占用（如上一会话进程未退出）时向后尝试的额外端口数。
 * @returns 实际监听的端口。
 */
export async function startTraceServer(
  port: number = 3000,
  openBrowser: boolean = true,
  keepAlive: boolean = true,
  maxPortSearch: number = 10,
): Promise<number> {
  const tracesDir = path.join(process.cwd(), ".haji", "traces");

  const createHandler = (boundPort: number) =>
    async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
      const url = new URL(req.url || "/", `http://localhost:${boundPort}`);
      const pathname = url.pathname;

      // 跨域设置
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        // 路由：访问控制台主页
        if (pathname === "/" || pathname === "/viewer") {
          let htmlPath = path.join(__dirname, "trace-viewer.html");
          try {
            await fs.access(htmlPath);
          } catch {
            // 兜底尝试从源码目录加载
            htmlPath = path.join(__dirname, "..", "src", "trace-viewer.html");
          }

          const html = await fs.readFile(htmlPath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }

        // 路由：API 获取会话列表
        if (pathname === "/api/sessions") {
          const sessions = await SessionTracker.listSessions(tracesDir);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(sessions));
          return;
        }

        // 路由：API 获取单会话事件流详情
        if (pathname.startsWith("/api/session/")) {
          const sessionId = pathname.slice("/api/session/".length);
          // 路径防越权过滤
          if (!/^[a-f0-9-]+$/.test(sessionId)) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid Session ID");
            return;
          }

          try {
            const session = await SessionTracker.readSession(sessionId, tracesDir);
            if (!session) throw new Error("Session not found");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(session));
          } catch {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Session not found");
          }
          return;
        }

        // 404
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Internal Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

  const listenOnce = (attemptPort: number) =>
    new Promise<{ server: http.Server; boundPort: number }>((resolve, reject) => {
      const server = http.createServer(createHandler(attemptPort));
      server.on("error", (err) => {
        server.close();
        reject(err);
      });
      server.listen(attemptPort, () => resolve({ server, boundPort: attemptPort }));
    });

  let lastError: unknown;
  for (let offset = 0; offset <= maxPortSearch; offset += 1) {
    let bound: { server: http.Server; boundPort: number };
    try {
      bound = await listenOnce(port + offset);
    } catch (err) {
      lastError = err;
      // 端口被占（常见于上一会话进程未退出）时向后尝试；其他错误直接抛出。
      if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw err;
      continue;
    }

    const { server, boundPort } = bound;
    if (!keepAlive) {
      server.unref();
    }

    const addr = `http://localhost:${boundPort}`;
    console.log(`\n📊 hajicli 可观测性 Trace 服务器已在本地运行: ${addr}`);
    console.log(`   Trace 记录目录: ${tracesDir}\n`);

    if (openBrowser) {
      let cmd = "";
      if (process.platform === "win32") {
        cmd = `start "" "${addr}"`;
      } else if (process.platform === "darwin") {
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
    return boundPort;
  }
  throw lastError;
}
