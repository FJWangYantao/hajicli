import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 文件工具的路径作用域判定。
 *
 * 边界从「工具内部硬拒绝」上移到权限层：这里只回答「这次调用的目标路径
 * 在不在已声明的工作区根之内」，由 PermissionEngine 决定放行、询问还是拒绝。
 * 组件职责：
 * - 词法越界（`../`、绝对路径）与符号链接逃逸都由 realpath 比较兜底；
 * - 工作区根 = 启动时的 cwd + `--add-dir` / `/workspace add` 追加的目录；
 * - 用户级 `permissions.json` 的 `paths.allow/deny` 提供路径级放行与禁止。
 */

/** 文件内容工具的参数键；`read` 额外支持 `paths[].path` 批量读取。 */
const PATH_TOOL_KEYS: Record<string, string> = {
  read: "path",
  grep: "path",
  global: "path",
  write: "path",
  edit: "path",
};

/** 写类工具（授权键按写入语义归类，读类其余）。 */
const WRITE_TOOLS = new Set(["write", "edit"]);

export type PathAccessKind = "read" | "write";

/** 用户级路径规则：与 permissions.json 的 `paths` 段同构。 */
export interface PathScopeRules {
  allow?: readonly string[];
  deny?: readonly string[];
}

export interface PathScopeConfig {
  /** 工作区基准目录（启动时的 cwd）。 */
  cwd: string;
  /** 追加的工作区根（`--add-dir` / `/workspace add`），绝对路径。 */
  roots?: readonly string[];
  rules?: PathScopeRules;
}

/** 工作区外一次操作的授权范围：key 用于持久化/会话授权，scope 用于卡片文案。 */
export interface PathScopeGrant {
  key: string;
  scope: string;
}

export interface PathScopeResult {
  /** 该工具是否以文件路径为作用对象；false 时其余字段无意义。 */
  applies: boolean;
  /**
   * - inside: 在某个工作区根内（按权限模式正常处理）
   * - outside: 在工作区外（需要授权，或由全局开关放行）
   * - allowed: 在工作区外但命中用户级放行规则（等同于工作区内）
   * - deny: 命中用户级禁止规则
   */
  status: "inside" | "outside" | "allowed" | "deny";
  /** 解析后的目标绝对路径（展示用，未 realpath）。 */
  targets: string[];
  access?: PathAccessKind;
  /** 命中的路径规则原文（status=allowed/deny）。 */
  rule?: string;
  /** status=outside 时的授权范围。 */
  grant?: PathScopeGrant;
}

export type ToolPathScope = PathScopeResult & { applies: true };

/** 归一化比较口径：Windows 大小写不敏感，去掉末尾分隔符。 */
function normalizeForCompare(value: string): string {
  let resolved = path.resolve(value);
  if (resolved.length > 1 && !/^[a-zA-Z]:[\\/]$/.test(resolved)) {
    resolved = resolved.replace(/[\\/]+$/, "");
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsidePath(root: string, target: string): boolean {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedTarget = normalizeForCompare(target);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

/**
 * 目标的 realpath：目标不存在时取最近的已存在上级目录再拼回剩余段，
 * 这样「新建文件」与「经由符号链接目录写入」都能按真实位置判断。
 */
function realpathLoose(target: string): string {
  const resolved = path.resolve(target);
  const tail: string[] = [];
  let current = resolved;
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return resolved;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** 最近的已存在目录（授权前缀用它，避免一次授权就放开整个盘）。 */
function nearestExistingDirectory(target: string): string {
  const resolved = path.resolve(target);
  try {
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    // 目标不存在或不可访问：继续向上找
  }
  let current = resolved;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    try {
      if (fs.statSync(parent).isDirectory()) return parent;
    } catch {
      // 继续向上
    }
    current = parent;
  }
}

/** 授权键里的路径口径：Windows 统一小写 + 正斜杠，避免同一目录出现两个键。 */
export function normalizePathKey(target: string): string {
  const resolved = path.resolve(target).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function expandHome(pattern: string): string {
  if (pattern === "~") return os.homedir();
  if (pattern.startsWith("~/") || pattern.startsWith("~\\")) {
    return path.join(os.homedir(), pattern.slice(2));
  }
  return pattern;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 路径 glob 匹配：支持 `**`（跨目录）、`*`（单个路径段内）、`?`，以及 `~` 展开。
 * 不含通配符的模式按目录前缀理解（`~/scratch` 也匹配 `~/scratch/a.ts`）。
 * Windows 下大小写不敏感。
 */
export function matchPathRule(pattern: string, absolutePath: string): boolean {
  const source = expandHome(pattern.trim());
  if (!source) return false;
  const caseInsensitive = process.platform === "win32";
  const normalize = (value: string): string => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const rule = normalize(source);
  const target = normalize(absolutePath);

  if (!/[*?]/.test(rule)) {
    return target === rule || target.startsWith(`${rule}/`);
  }

  let regex = "";
  for (let index = 0; index < rule.length; index += 1) {
    const char = rule[index];
    if (char === "*" && rule[index + 1] === "*") {
      index += 1;
      if (rule[index + 1] === "/") {
        index += 1;
        regex += "(?:.*/)?";
      } else {
        regex += ".*";
      }
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegExp(char);
  }
  try {
    return new RegExp(`^${regex}$`, caseInsensitive ? "i" : "").test(target);
  } catch {
    return false;
  }
}

/** 从工具入参提取目标路径（未解析、保持模型给的形态）。 */
export function readToolPathArgs(
  toolName: string,
  args: Record<string, unknown>,
): { paths: string[]; access: PathAccessKind } | undefined {
  const name = toolName.toLowerCase();
  const key = PATH_TOOL_KEYS[name];
  if (!key) return undefined;
  const access: PathAccessKind = WRITE_TOOLS.has(name) ? "write" : "read";
  const paths: string[] = [];
  const single = args[key];
  if (typeof single === "string" && single.trim()) paths.push(single.trim());
  if (name === "read" && Array.isArray(args.paths)) {
    for (const item of args.paths) {
      if (!item || typeof item !== "object") continue;
      const candidate = (item as Record<string, unknown>).path;
      if (typeof candidate === "string" && candidate.trim()) paths.push(candidate.trim());
    }
  }
  return { paths, access };
}

/**
 * 判定一次工具调用的路径作用域。同步实现（权限层在 PreToolUse 里同步决策），
 * 只做一次 stat/realpath，目标不存在时按最近存在祖先判断。
 */
export function inspectPathScope(
  toolName: string,
  args: Record<string, unknown>,
  config: PathScopeConfig,
): PathScopeResult {
  const extracted = readToolPathArgs(toolName, args);
  if (!extracted) return { applies: false, status: "inside", targets: [] };
  const { paths, access } = extracted;
  const cwd = path.resolve(config.cwd);
  if (paths.length === 0) {
    return { applies: true, status: "inside", targets: [], access };
  }

  const lexicalTargets = paths.map((item) => path.resolve(cwd, item));
  const realTargets = lexicalTargets.map((item) => realpathLoose(item));
  const rules = config.rules ?? {};

  for (const pattern of rules.deny ?? []) {
    const matched = lexicalTargets.some(
      (lexical, index) =>
        matchPathRule(pattern, lexical) || matchPathRule(pattern, realTargets[index] ?? lexical),
    );
    if (matched) {
      return { applies: true, status: "deny", targets: lexicalTargets, access, rule: pattern };
    }
  }

  const roots = [cwd, ...(config.roots ?? [])]
    .map((root) => path.resolve(root))
    .filter((root, index, all) => all.indexOf(root) === index)
    .map((root) => realpathLoose(root));

  const insideAll = (targets: readonly string[]): boolean =>
    targets.every((target) => roots.some((root) => isInsidePath(root, target)));

  if (insideAll(realTargets)) {
    return { applies: true, status: "inside", targets: lexicalTargets, access };
  }

  const allow = rules.allow ?? [];
  if (allow.length > 0) {
    const allowedAll = lexicalTargets.every((lexical, index) => {
      const real = realTargets[index] ?? lexical;
      return allow.some(
        (pattern) => matchPathRule(pattern, lexical) || matchPathRule(pattern, real),
      );
    });
    if (allowedAll) {
      return { applies: true, status: "allowed", targets: lexicalTargets, access };
    }
  }

  // 授权前缀取第一个越界目标的最近已存在目录，避免一次授权放开整个盘。
  const outsideIndex = realTargets.findIndex(
    (target) => !roots.some((root) => isInsidePath(root, target)),
  );
  const outsideTarget = lexicalTargets[outsideIndex === -1 ? 0 : outsideIndex] ?? cwd;
  const prefix = nearestExistingDirectory(outsideTarget);
  const key = `${access}:${normalizePathKey(prefix)}`;
  const verb = access === "write" ? "写入" : "读取";
  return {
    applies: true,
    status: "outside",
    targets: lexicalTargets,
    access,
    grant: { key, scope: `${verb} ${prefix} 下的文件` },
  };
}

/** 给模型/卡片看的越界说明：一次性讲清边界与可行做法，避免反复换写法重试。 */
export function formatPathScopeReason(result: PathScopeResult): string {
  const target = result.targets[0] ?? "";
  const verb = result.access === "write" ? "写入" : "读取";
  return (
    `目标在工作区外：${target}（${verb}需授权）。` +
    "工作区根 = 启动目录 + /workspace add 或 --add-dir 追加的目录；" +
    "也可以用 /workspace add <目录> 加入该目录，或设置 HAJI_ALLOW_OUTSIDE_WORKSPACE=1 放行全部路径。"
  );
}
