import readline from "node:readline";
import { handleMessage } from "./mcp.js";
import type { DriverServer } from "./server.js";

/**
 * 在 stdio 上跑 MCP：stdin 每行一条 JSON-RPC 消息，stdout 只写协议回包。
 *
 * 不串行化「处理」——长回合（haji_send）在等结果时，haji_cancel / haji_status
 * 仍要能被处理；只串行化 stdout 写入，保证每条回包是完整的一行。
 */
export function startMcpStdio(server: DriverServer): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let writeChain: Promise<void> = Promise.resolve();
  const send = (payload: unknown): Promise<void> => {
    const line = `${JSON.stringify(payload)}\n`;
    writeChain = writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          process.stdout.write(line, () => resolve());
        }),
    );
    return writeChain;
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      await send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const response = await handleMessage(server, message);
    if (response) await send(response);
  };

  rl.on("line", (line) => {
    void handleLine(line).catch((error: unknown) => {
      // 协议层不因单条消息失败而退出：回一条 error，继续读下一行。
      void send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });

  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      rl.close();
      void server.close().finally(() => resolve());
    };
    rl.on("close", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
