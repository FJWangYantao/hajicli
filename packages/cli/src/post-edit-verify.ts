import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 诊断输出截断上限（保尾部——错误通常在末尾）。 */
const MAX_OUTPUT_CHARS = 1_800;

interface TsconfigShape {
  /** tsconfig 有 references 数组（project references 结构）。 */
  projectReferences: boolean;
}

function readTsconfig(cwd: string): TsconfigShape | undefined {
  const file = path.join(cwd, "tsconfig.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { references?: unknown };
    return { projectReferences: Array.isArray(parsed.references) && parsed.references.length > 0 };
  } catch {
    // tsconfig 允许注释和尾逗号，JSON.parse 会失败：退化成文本粗判，至少别把
    // references 结构当成普通 tsconfig 去跑 `--noEmit`（那种跑法会「假通过」）。
    return { projectReferences: /"references"\s*:/.test(raw) };
  }
}

/**
 * 探测项目的编辑后验证命令（LSP 的轻量替代）：
 * HAJI_POST_EDIT_VERIFY 环境变量显式指定（"0" 关闭）> package.json 的 typecheck 脚本 >
 * tsconfig.json（references 结构用 `tsc -b`，普通结构用 `tsc --noEmit`）。
 * 探测不到返回 undefined（项目不支持，静默跳过）。
 *
 * 刻意不认 `check` 这类组合脚本：本仓库的 check 是 `lint && test`，每次编辑都跑整套
 * 测试只会把超时耗满、永远拿不到诊断。复合脚本要用户用环境变量显式指定。
 */
export function detectProjectCheckCommand(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env.HAJI_POST_EDIT_VERIFY;
  if (override === "0") return undefined;
  const trimmedOverride = override?.trim();
  if (trimmedOverride) return trimmedOverride;
  const scripts = readPackageScripts(cwd);
  const typecheck = scripts?.typecheck;
  if (typeof typecheck === "string" && typecheck.trim()) return "npm run typecheck --silent";
  const tsconfig = readTsconfig(cwd);
  if (!tsconfig) return undefined;
  // references 结构（根 tsconfig 只有 files: [] + references）不能用 `tsc --noEmit`：
  // 它一个文件都不检查却 exit 0，会伪装成「验证通过」。必须用 `tsc -b` 走增量构建。
  return tsconfig.projectReferences ? "npx tsc -b" : "npx tsc --noEmit";
}

function readPackageScripts(cwd: string): Record<string, string> | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg?.scripts ?? {};
  } catch {
    return undefined;
  }
}

/**
 * 当前目录是不是「正在运行的 haji 自身仓库」。
 *
 * 这种仓库不能跑 `tsc -b`：构建会覆盖进程正在使用的 `dist/`，已经加载的模块不受影响，
 * 但之后懒加载的模块可能和已加载版本对不上。调用方据此跳过验证（显式设置
 * HAJI_POST_EDIT_VERIFY 时不跳过，由用户自己承担）。
 */
export function isSelfProject(cwd: string, moduleUrl: string = import.meta.url): boolean {
  try {
    // dist/post-edit-verify.js → packages/cli/dist → 仓库根
    const repoRoot = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../..");
    return fs.realpathSync(cwd) === fs.realpathSync(repoRoot);
  } catch {
    return false;
  }
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

/**
 * 格式化为注入给模型的系统消息；**只在发现问题时**才返回内容。
 *
 * 验证通过不注入：基准实测（design/ab/2026-10-27-write-edit-forced.md）显示，
 * 「验证通过」这条消息既没有让模型少跑自己的 `tsc`（两臂都自跑 1 次），又让
 * 每个验证窗口多一条上下文消息——4/4 轮更慢、请求 +15%、费用 +4.5%，正确性无差别。
 * 超时同样返回 undefined：模型拿不到诊断，写进上下文只会让它误以为项目有问题。
 */
export function formatVerificationNotice(
  result: ProjectCheckResult,
  command: string,
  editedPath?: string,
): string | undefined {
  if (result.timedOut || result.ok) return undefined;
  if (editedPath && !diagnosticsMentionFile(result.output, editedPath)) {
    return `[编辑后验证] ${command} 报告的问题没有提到本次编辑的文件（${editedPath}），属于项目既有问题，本次改动不需要处理；不要为此修改其他文件。`;
  }
  const detail = result.output || "（无输出）";
  const truncated =
    detail.length > MAX_OUTPUT_CHARS ? `…${detail.slice(-MAX_OUTPUT_CHARS)}` : detail;
  return `[编辑后验证] ${command} 发现以下问题，请在继续任务前优先修复：\n${truncated}`;
}

/** 超时的界面提示（只出现一次，不进模型上下文）。 */
export function formatVerificationTimeoutHint(command: string): string {
  return `编辑后验证：${command} 超过时限已中止，本次跳过（不影响继续编辑）。`;
}

/** 自身仓库跳过验证的界面提示（只出现一次，不进模型上下文）。 */
export function formatSelfProjectSkipHint(): string {
  return "编辑后验证：当前仓库就是正在运行的 haji 本身，已跳过（避免构建覆盖运行中的 dist）。";
}
