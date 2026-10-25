import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BaseTool, ToolDefinition, ToolExecutionContext } from "@hajicli/core";
import {
  contentHash,
  FileConflictError,
  fileVersions,
  writeUtf8Atomically,
} from "./file-content.js";
import { formatWorkspaceError, resolveWorkspacePath } from "./workspace-path.js";

function parseExpectedHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/i.test(value)) {
    throw new Error("expectedHash 必须是 read 返回的16位十六进制 hash。");
  }
  return value.toLowerCase();
}

/**
 * hash 冲突的报错：首行保持「文件已变化：期望/当前 hash」稳定格式（重复失败按首行归并），
 * 后面明确告诉模型变化来自哪里、下一步该做什么，避免带着同一个旧 hash 原样重发整份内容。
 */
function formatConflict(error: FileConflictError): string {
  return [
    `写入失败: ${error.message}。`,
    "该文件在你最近一次 read/edit/write 之后被外部修改（编辑器、bash 命令如格式化/biome --write、子代理或其他进程），覆写会丢掉这些修改。",
    "不要用同一个 expectedHash 原样重发：先 read 获取当前内容与 hash 并确认这些修改；局部改动改用 edit，确需整体覆写再带新的 expectedHash 调用 write。",
  ].join("\n");
}

async function readCurrentHash(filePath: string): Promise<string | undefined> {
  try {
    return contentHash(await fs.readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class WriteFileTool implements BaseTool {
  public readonly name = "write";

  public readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "write",
      description:
        "原子创建或完整覆写文件。覆写已读取文件时应传入 expectedHash，文件已变化则拒绝覆盖。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要创建或覆写的文件路径。" },
          content: { type: "string", description: "完整文件内容。" },
          expectedHash: { type: "string", description: "可选，read 返回的16位内容 hash。" },
        },
        required: ["path", "content"],
      },
    },
  };

  public async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    if (typeof args.path !== "string" || !args.path) return "错误: 缺少 path 参数。";
    if (typeof args.content !== "string") return "错误: content 必须是字符串。";
    let expectedHash: string | undefined;
    try {
      expectedHash = parseExpectedHash(args.expectedHash);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (context?.abortSignal?.aborted) return "[文件写入已中止]";

    const filePath = args.path;
    try {
      const resolvedPath = await resolveWorkspacePath(filePath, { mustExist: false });
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      if (context?.abortSignal?.aborted) return "[文件写入已中止]";
      const agentId = context?.agentId;
      // expectedHash 过期但磁盘仍是本代理自己 edit/write 出来的链尾版本：期间没有外部修改，
      // 以当前 hash 作为 CAS 基准放行；写入时 writeUtf8Atomically 仍会拒绝并发改动。
      let casHash = expectedHash;
      let ownChainNote = "";
      if (expectedHash !== undefined) {
        const currentHash = await readCurrentHash(resolvedPath);
        if (currentHash !== expectedHash) {
          if (
            currentHash === undefined ||
            !fileVersions.isOwnChain(agentId, resolvedPath, expectedHash, currentHash)
          ) {
            throw new FileConflictError(expectedHash, currentHash);
          }
          casHash = currentHash;
          ownChainNote = `\n说明: expectedHash 已过期，但期间只有你本轮自己的 edit/write（当前 hash=${currentHash}），已按本次完整内容覆写。`;
        }
      }
      await writeUtf8Atomically(resolvedPath, args.content, context?.abortSignal, casHash);
      const hash = contentHash(args.content);
      fileVersions.advance(agentId, resolvedPath, casHash, hash);
      const stats = await fs.stat(resolvedPath);
      return `[文件写入成功]\n路径: ${filePath}\n大小: ${stats.size} 字节\nhash=${hash}${ownChainNote}`;
    } catch (error) {
      if (
        context?.abortSignal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return "[文件写入已中止]";
      }
      if (error instanceof FileConflictError) {
        return formatConflict(error);
      }
      return `写入文件失败: ${formatWorkspaceError(error, filePath)}`;
    }
  }
}
