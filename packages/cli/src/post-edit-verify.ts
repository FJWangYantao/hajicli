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

/** 会触发编辑后验证的源码扩展名：日志、产物这类重定向不该跑一遍 typecheck。 */
const SOURCE_FILE_PATTERN =
  /\.(?:[cm]?[jt]sx?|json|vue|svelte|astro|py|go|rs|java|kt|kts|c|cc|cpp|h|hpp|cs|swift|rb|php)$/i;

/**
 * 粗切 shell 命令：按引号保留整词，`;` `&&` `||` `|` 换行切成多段，重定向符单独成词。
 * 只服务于「这条命令写了哪些源码文件」的判断，不追求完整的 shell 语法。
 */
function tokenizeShell(command: string): string[][] {
  const segments: string[][] = [[]];
  let word = "";
  let quoted = false;
  let quote: string | undefined;
  const pushWord = (): void => {
    if (word || quoted) segments[segments.length - 1].push(word);
    word = "";
    quoted = false;
  };
  const split = (): void => {
    pushWord();
    if (segments[segments.length - 1].length > 0) segments.push([]);
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < command.length)
        word += command[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (char === "\\" && index + 1 < command.length) {
      word += command[++index];
    } else if (char === " " || char === "\t") {
      pushWord();
    } else if (char === "\n" || char === ";" || char === "|" || char === "&") {
      // `2>&1`、`&>` 里的 & 属于重定向，不是分隔符。
      if (char === "&" && (word.endsWith(">") || command[index + 1] === ">")) {
        word += char;
        continue;
      }
      split();
      if ((char === "|" || char === "&") && command[index + 1] === char) index += 1;
    } else if (char === ">" || char === "<") {
      // 重定向符（含 `2>`、`>>`、`&>`）单独成词，目标路径是下一个词。
      const fd = /^(?:\d|&)$/.test(word) ? word : "";
      if (!fd) pushWord();
      let op = `${fd}${char}`;
      while (command[index + 1] === char) op += command[++index];
      if (command[index + 1] === "&") op += command[++index];
      word = "";
      segments[segments.length - 1].push(op);
    } else {
      word += char;
    }
  }
  pushWord();
  return segments.filter((segment) => segment.length > 0);
}

/** 去掉重定向及其目标，只留命令的位置参数。 */
function stripRedirects(words: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < words.length; index++) {
    if (/^(?:\d|&)?[<>]/.test(words[index])) {
      index += 1;
      continue;
    }
    result.push(words[index]);
  }
  return result;
}

/** 选项后面跟取值的 xargs 选项（`-n 1`、`-I {}`…），跳过它们才找得到子命令。 */
const XARGS_VALUE_OPTIONS = new Set(["-n", "-I", "-L", "-P", "-d", "-s", "-E", "-a"]);

interface ShellWriteScan {
  files: string[];
  /** 原地改写但目标来自管道/find（`xargs sed -i`、`find -exec sed -i {}`），无从得知具体文件。 */
  opaque: boolean;
}

/** 分析一段命令（已去掉环境变量前缀之前的整段词）里的原地改写。 */
function scanInPlaceEdit(words: readonly string[], scan: ShellWriteScan): void {
  const programIndex = words.findIndex((word) => !/^\w+=/.test(word));
  if (programIndex < 0) return;
  const name = path.basename(words[programIndex]);
  const args = stripRedirects(words.slice(programIndex + 1));
  if (name === "xargs") {
    let index = 0;
    while (index < args.length && args[index].startsWith("-")) {
      index += XARGS_VALUE_OPTIONS.has(args[index]) ? 2 : 1;
    }
    const inner: ShellWriteScan = { files: [], opaque: false };
    scanInPlaceEdit(args.slice(index), inner);
    // xargs 把管道里的路径追加到末尾：子命令自己写明的文件之外，一定还有看不见的目标。
    if (inner.files.length > 0 || inner.opaque) scan.opaque = true;
    scan.files.push(...inner.files);
    return;
  }
  if (name === "find") {
    const execIndex = args.findIndex((arg) => arg === "-exec" || arg === "-execdir");
    if (execIndex < 0) return;
    const tail = args.slice(execIndex + 1);
    const stop = tail.findIndex((arg) => arg === ";" || arg === "+" || arg === "\\;");
    const inner: ShellWriteScan = { files: [], opaque: false };
    scanInPlaceEdit(stop < 0 ? tail : tail.slice(0, stop), inner);
    if (inner.files.length > 0 || inner.opaque) scan.opaque = true;
    scan.files.push(...inner.files.filter((file) => file !== "{}"));
    return;
  }
  if (name === "sed" || name === "gsed") {
    if (!args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) return;
    // 脚本是 -e/-f 的参数，否则是第一个非选项词；其余非选项词是文件。
    let scriptGiven = false;
    let files = 0;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "-e" || arg === "-f" || arg === "--expression" || arg === "--file") {
        scriptGiven = true;
        index += 1;
      } else if (arg.startsWith("-") && arg !== "-") {
        // `-i ''`（BSD）：空后缀参数紧随 -i。
        if (arg === "-i" && args[index + 1] === "") index += 1;
      } else if (!scriptGiven) {
        scriptGiven = true;
      } else {
        scan.files.push(arg);
        files += 1;
      }
    }
    if (files === 0) scan.opaque = true;
  } else if (name === "perl") {
    if (!args.some((arg) => /^-[a-zA-Z]*i/.test(arg))) return;
    let files = 0;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "-e" || arg === "-E") index += 1;
      else if (!arg.startsWith("-")) {
        scan.files.push(arg);
        files += 1;
      }
    }
    if (files === 0) scan.opaque = true;
  } else if (name === "tee") {
    for (const arg of args) if (!arg.startsWith("-")) scan.files.push(arg);
  }
}

/**
 * 一条 bash 命令改写了哪些源码文件（`sed -i`、`perl -i`、`>`/`>>` 重定向、`tee`，
 * 以及经 `xargs` / `find -exec` 套一层的原地改写）。
 *
 * write/edit 之外，模型常用一条 `sed -i` 完成批量重命名，此时编辑后验证的钩子从不触发
 * （见 design/ab/2026-10-27-write-baseline.md）。`files` 只含源码扩展名的目标——日志、产物
 * 重定向不该跑 typecheck；`opaque` 表示确实原地改了文件、但目标来自管道无从得知。
 * 识别不了的写法两者皆空，宁可漏验也不对只读命令跑 typecheck。
 */
export function detectShellFileWrites(command: string): ShellWriteScan {
  const scan: ShellWriteScan = { files: [], opaque: false };
  for (const words of tokenizeShell(command)) {
    for (let index = 0; index < words.length - 1; index++) {
      // 输出重定向：`>`、`>>`、`1>`、`&>`；`2>`（stderr）与 `>&2` 这类 fd 复制不算写文件。
      if (/^(?:1|&)?>>?$/.test(words[index])) {
        const target = words[index + 1];
        if (target && !target.startsWith("&") && target !== "/dev/null") scan.files.push(target);
      }
    }
    scanInPlaceEdit(words, scan);
  }
  return {
    files: [...new Set(scan.files)].filter((target) => SOURCE_FILE_PATTERN.test(target)),
    opaque: scan.opaque,
  };
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
