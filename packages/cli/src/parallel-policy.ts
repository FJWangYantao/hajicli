/**
 * 并行批的可并行判定（纯函数，便于 A/B 与单测）。
 *
 * 静态白名单永远可并行；实验开启 dynamic 后，额外接受：
 * - 只读 bash（调用方注入 `isReadOnlyCommand`，与权限引擎同一套判定）；
 * - 只读 MCP / 只读内置工具（调用方注入 `isReadOnlyTool`）。
 * `loadskill` 虽然被权限引擎视为只读，但有加载副作用，必须继续当屏障。
 */

import { PARALLEL_READ_ONLY_TOOLS } from "./tool-batch.js";

export interface ParallelClassifierCall {
  function: { name: string; arguments?: string };
}

export interface ParallelClassifierOptions {
  /** A/B：只读 bash / MCP 是否加入并行白名单。 */
  dynamic: boolean;
  /** 权限引擎的只读工具判定（含 readOnly MCP）。 */
  isReadOnlyTool: (name: string) => boolean;
  /** 只读 shell 命令判定（与权限引擎同一口径）。 */
  isReadOnlyCommand: (command: string) => boolean;
}

export function createParallelClassifier(
  options: ParallelClassifierOptions,
): (call: ParallelClassifierCall) => boolean {
  return (call) => {
    const name = call.function.name.toLowerCase();
    if (PARALLEL_READ_ONLY_TOOLS.has(name)) return true;
    if (!options.dynamic) return false;
    // 有加载副作用：读类白名单之外的唯一例外。
    if (name === "loadskill") return false;
    if (name === "bash") {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        return false;
      }
      const command = typeof args.command === "string" ? args.command : "";
      return Boolean(command) && options.isReadOnlyCommand(command);
    }
    return options.isReadOnlyTool(name);
  };
}
