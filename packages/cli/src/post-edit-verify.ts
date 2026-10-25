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
        // 保留完整输出：格式化时既要截断展示，也要先在全文里判断问题是否涉及本次编辑的文件。
        resolve({
          ok: error === null || (error as { code?: number | string })?.code === 0,
          timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
          output: combined,
        });
      },
    );
  });
}

/** 诊断输出是否提到了本次编辑的文件（兼容相对/绝对路径与反斜杠）。 */
export function diagnosticsMentionFile(output: string, editedPath: string): boolean {
  const normalized = output.replace(/\\/g, "/").toLowerCase();
  const target = editedPath.replace(/\\/g, "/").toLowerCase();
  if (!target) return true;
  if (normalized.includes(target)) return true;
  const base = target.split("/").pop() ?? "";
  return base.length > 3 && normalized.includes(base);
}

/**
 * 同一条验证结论在冷却窗口内只注入一次：编辑连发时，重复的
 * 「[编辑后验证] … 发现以下问题」会把上下文塞满，并反复催模型去修同一批既有问题。
 */
export function shouldPushVerificationNotice(
  previous: { text: string; at: number } | undefined,
  text: string,
  now: number,
  windowMs = 60_000,
): boolean {
  return !previous || previous.text !== text || now - previous.at >= windowMs;
}

/** 格式化为注入给模型的系统消息；通过时也明确告知，避免模型重复自查。 */
export function formatVerificationNotice(
  result: ProjectCheckResult,
  command: string,
  editedPath?: string,
): string {
  if (result.timedOut) {
    return `[编辑后验证] ${command} 超过时限被中止，本次未获得诊断结果。`;
  }
  if (result.ok) {
    return `[编辑后验证] ${command} 通过（未发现错误）。`;
  }
  if (editedPath && !diagnosticsMentionFile(result.output, editedPath)) {
    return `[编辑后验证] ${command} 报告的问题没有提到本次编辑的文件（${editedPath}），属于项目既有问题，本次改动不需要处理；不要为此修改其他文件。`;
  }
  const detail = result.output || "（无输出）";
  const truncated =
    detail.length > MAX_OUTPUT_CHARS ? `…${detail.slice(-MAX_OUTPUT_CHARS)}` : detail;
  return `[编辑后验证] ${command} 发现以下问题，请在继续任务前优先修复：\n${truncated}`;
}
