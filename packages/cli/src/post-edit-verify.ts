import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 诊断输出截断上限（保尾部——错误通常在末尾）。 */
const MAX_OUTPUT_CHARS = 1_800;

/**
 * 探测项目的编辑后验证命令（LSP 的轻量替代）：
 * HAJI_POST_EDIT_VERIFY 环境变量显式指定（"0" 关闭）> package.json 的
 * typecheck / check 脚本 > tsconfig.json 存在时 npx tsc --noEmit。
 * 探测不到返回 undefined（项目不支持，静默跳过）。
 */
export function detectProjectCheckCommand(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env.HAJI_POST_EDIT_VERIFY;
  if (override === "0") return undefined;
  const trimmedOverride = override?.trim();
  if (trimmedOverride) return trimmedOverride;
  let pkg: { scripts?: Record<string, string> } | undefined;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  const scripts = pkg?.scripts ?? {};
  if (typeof scripts.typecheck === "string" && scripts.typecheck.trim()) {
    return "npm run typecheck --silent";
  }
  if (typeof scripts.check === "string" && scripts.check.trim()) {
    return "npm run check --silent";
  }
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) return "npx tsc --noEmit";
  return undefined;
}

export interface ProjectCheckResult {
  ok: boolean;
  timedOut: boolean;
  output: string;
}

/** 运行验证命令并截取尾部输出；超时不视为项目错误（ok 仍按退出码）。 */
export function runProjectCheck(
  command: string,
  cwd: string,
  timeoutMs = 15_000,
): Promise<ProjectCheckResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const combined = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        const truncated =
          combined.length > MAX_OUTPUT_CHARS ? `…${combined.slice(-MAX_OUTPUT_CHARS)}` : combined;
        resolve({
          ok: error === null || (error as { code?: number | string })?.code === 0,
          timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
          output: truncated,
        });
      },
    );
  });
}

/** 格式化为注入给模型的系统消息；通过时也明确告知，避免模型重复自查。 */
export function formatVerificationNotice(result: ProjectCheckResult, command: string): string {
  if (result.timedOut) {
    return `[编辑后验证] ${command} 超过时限被中止，本次未获得诊断结果。`;
  }
  if (result.ok) {
    return `[编辑后验证] ${command} 通过（未发现错误）。`;
  }
  const detail = result.output || "（无输出）";
  return `[编辑后验证] ${command} 发现以下问题，请在继续任务前优先修复：\n${detail}`;
}
