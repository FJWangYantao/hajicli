import os from "node:os";
import path from "node:path";
import { matchPathRule, readToolPathArgs } from "./path-scope.js";

/**
 * 受保护目标：无论用户选了什么权限档（含 auto / bypass-permissions），
 * 只要碰到这些路径或命令就必须由用户逐次确认。
 *
 * 这里是**确定性**判定，不经过任何模型分类器——一旦交给模型判断，
 * 一次提示注入就能把「改 permissions.json」解释成合理需求。
 *
 * 两级：
 * - hard：改掉它之后「用户授权 / 回退 / 审计」本身就不再可信，因此
 *   不接受永久授权，也不能被历史遗留的持久放行规则命中；
 * - sensitive：凭据与高影响范围，需要确认，但允许用户按会话或全局记住。
 *
 * 名单刻意保持很小，并且只存在于代码里（不给配置项）：新增一条应当
 * 经过代码评审并补测试，就像改安全边界一样。
 */

/**
 * 保护级别：
 * - forbidden：灾难性操作（如删除工作区或更外层），任何档位都直接拒绝，连“本次允许”都不给；
 * - hard：任何档位都必须逐次确认，且不接受永久授权；
 * - sensitive：需要确认，但允许用户按会话或全局记住。
 */
export type ProtectedLevel = "forbidden" | "hard" | "sensitive";

export type ProtectedAccess = "read" | "write" | "exec";

export interface ProtectedHit {
  level: ProtectedLevel;
  kind: "path" | "command";
  /** 命中的规则原文（路径模式或命令标签），用于卡片与测试断言。 */
  rule: string;
  /** 具体目标（绝对路径或命令片段），用于展示。 */
  target: string;
  access: ProtectedAccess;
  /** 为什么需要确认（一句话，面向用户）。 */
  reason: string;
}

interface PathRule {
  level: ProtectedLevel;
  access: "read" | "write";
  pattern: string;
  reason: string;
}

interface CommandRule {
  level: ProtectedLevel;
  pattern: RegExp;
  label: string;
  reason: string;
}

/** 关闭整层保护（CI / 无人值守场景）：显式设置才生效，且会在启动时提示。 */
export function protectedTargetsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HAJI_ALLOW_PROTECTED === "1";
}

function pathRules(cwd: string): PathRule[] {
  const homeHaji = path.join(os.homedir(), ".haji");
  const projectHaji = path.join(cwd, ".haji");
  const rules: PathRule[] = [];

  // 授权与运行配置：改它等于改「谁能做什么」，一律 hard。
  for (const dir of [projectHaji, homeHaji]) {
    for (const file of [
      "permissions.json",
      "config.json",
      "workspaces.json",
      "preferences.json",
      // hooks 里的命令不经授权直接执行；信任表决定项目级 hooks 是否生效。
      "hooks.json",
      "hooks-trust.json",
    ]) {
      rules.push({
        level: "hard",
        access: "write",
        pattern: path.join(dir, file),
        reason: "这是授权/运行配置，修改会影响后续所有调用的权限判定",
      });
    }
    // 配置文件里有明文 API Key，读取同样需要确认。
    rules.push({
      level: "hard",
      access: "read",
      pattern: path.join(dir, "config.json"),
      reason: "该文件含明文 API Key",
    });
  }

  // Agent 的自我定义：技能、记忆、本能规则。
  for (const dir of [projectHaji, homeHaji]) {
    for (const sub of ["skills", "memory", "instincts", "agents", "commands"]) {
      rules.push({
        level: "hard",
        access: "write",
        pattern: path.join(dir, sub, "**"),
        reason: "该目录决定 Agent 之后的行为，属于自我修改",
      });
    }
  }

  // 回退与审计依据：删改即销毁后路。
  for (const sub of ["snapshots", "transcripts", "traces", "sessions"]) {
    rules.push({
      level: "hard",
      access: "write",
      pattern: path.join(projectHaji, sub, "**"),
      reason: "该目录保存回退快照或审计记录，改写会破坏可追溯性",
    });
  }

  // 凭据类文件：工作区内读取默认也会自动放行，因此单独列一层。
  const sensitiveWrite: Array<[string, string]> = [
    ["**/.env", "环境变量文件，通常含密钥"],
    ["**/.env.*", "环境变量文件，通常含密钥"],
    ["**/*.pem", "证书或私钥文件"],
    ["**/*.key", "私钥文件"],
    ["**/*.p12", "证书容器"],
    ["**/*.pfx", "证书容器"],
    ["**/id_rsa*", "SSH 私钥"],
    ["**/id_ed25519*", "SSH 私钥"],
    ["**/id_ecdsa*", "SSH 私钥"],
    ["**/.npmrc", "包管理器凭据"],
    ["**/.yarnrc", "包管理器凭据"],
    ["**/.pypirc", "包管理器凭据"],
    ["**/.netrc", "凭据文件"],
    ["**/.git-credentials", "Git 凭据"],
    ["**/.aws/**", "云凭据目录"],
    ["**/.ssh/**", "SSH 凭据目录"],
    ["**/.gnupg/**", "GPG 凭据目录"],
  ];
  for (const [pattern, reason] of sensitiveWrite) {
    rules.push({ level: "sensitive", access: "read", pattern, reason });
    rules.push({ level: "sensitive", access: "write", pattern, reason });
  }

  // 仓库协作手册：改它等于改 Agent 的工作约定，但属于正常仓库文件。
  rules.push({
    level: "sensitive",
    access: "write",
    pattern: path.join(cwd, "AGENTS.md"),
    reason: "该文件是 Agent 的仓库工作约定",
  });

  return rules;
}

const COMMAND_RULES: CommandRule[] = [
  {
    level: "hard",
    pattern: /\bgit\s+reset\b[^\n;&|]*--hard\b/,
    label: "git reset --hard",
    reason: "会丢弃所有未提交的改动",
  },
  {
    level: "hard",
    pattern: /\bgit\s+clean\b[^\n;&|]*\s-[a-zA-Z]*f[a-zA-Z]*\b/,
    label: "git clean -f",
    reason: "会删除未跟踪的文件，无法恢复",
  },
  {
    level: "hard",
    pattern: /\bgit\s+push\b[^\n;&|]*(?:--force(?:-with-lease)?\b|\s-f\b)/,
    label: "git push --force",
    reason: "会改写远端历史",
  },
  {
    level: "hard",
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/,
    label: "包发布",
    reason: "会向包仓库发布制品，通常不可撤回",
  },
  {
    level: "hard",
    pattern: /\bcargo\s+publish\b/,
    label: "cargo publish",
    reason: "会向 crates.io 发布制品",
  },
  {
    level: "hard",
    pattern: /\btwine\s+upload\b/,
    label: "twine upload",
    reason: "会向 PyPI 发布制品",
  },
];

/** 是否指向工作区本身、它的祖先、家目录或文件系统根（删掉就伤及项目或更外层）。 */
function isCriticalDeleteTarget(rawTarget: string, cwd: string): boolean {
  const target = rawTarget.replace(/^["']|["']$/g, "").trim();
  if (!target) return false;
  if (target === ".." || target === "../" || target === "~" || target === "$HOME") return true;
  const resolved = path.resolve(cwd, target);
  const home = path.resolve(os.homedir());
  const root = path.parse(resolved).root;
  if (resolved === root || resolved === home || resolved === path.resolve(cwd)) return true;
  // 工作区的祖先目录（例如在 D:\work\repo 里删 D:\work）。
  const relative = path.relative(resolved, path.resolve(cwd));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** 去掉参数里的引号与 PowerShell 的 `-Foo:bar` 形式，便于取目标路径。 */
function splitCommandSegments(command: string): string[] {
  return command
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

interface DeleteInvocation {
  tokens: string[];
  recursive: boolean;
  force: boolean;
}

function parseDeleteInvocation(segment: string): DeleteInvocation | undefined {
  const tokens: string[] = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (tokens.length === 0) return undefined;
  const head = (tokens[0] ?? "").toLowerCase();
  const hasFlag = (letters: string): boolean =>
    tokens.some(
      (token) =>
        /^-[a-zA-Z]+$/.test(token) && [...letters].every((letter) => token.includes(letter)),
    );

  if (head === "rm") {
    // rm 只有同时带 -r 与 -f 才认定为不可恢复删除。
    return { tokens: tokens.slice(1), recursive: hasFlag("r"), force: hasFlag("f") };
  }
  if (head === "remove-item" || head === "ri" || head === "del" || head === "erase") {
    const recursive =
      tokens.some((token) => /^-(?:recurse|r)$/i.test(token)) || tokens.includes("/s");
    const force = tokens.some((token) => /^-(?:force|fo?)$/i.test(token)) || tokens.includes("/q");
    return { tokens: tokens.slice(1), recursive, force };
  }
  if (head === "rd" || head === "rmdir") {
    const recursive = tokens.includes("/s") || hasFlag("r");
    const force = tokens.includes("/q") || hasFlag("f");
    return { tokens: tokens.slice(1), recursive, force };
  }
  return undefined;
}

function inspectProtectedCommand(command: string, cwd: string): ProtectedHit | undefined {
  for (const rule of COMMAND_RULES) {
    const match = command.match(rule.pattern);
    if (match) {
      return {
        level: rule.level,
        kind: "command",
        rule: rule.label,
        target: match[0].trim(),
        access: "exec",
        reason: rule.reason,
      };
    }
  }

  for (const segment of splitCommandSegments(command)) {
    const invocation = parseDeleteInvocation(segment);
    if (!invocation?.recursive || !invocation.force) continue;
    // 参数里可能有 -Recurse / /s 之类的开关，取第一个真正的目标判断范围。
    const critical = invocation.tokens.find(
      (token) =>
        !token.startsWith("-") &&
        !/^\/[a-zA-Z?]+$/.test(token) &&
        isCriticalDeleteTarget(token, cwd),
    );
    if (!critical) continue;
    return {
      level: "forbidden",
      kind: "command",
      rule: "递归强制删除",
      target: segment,
      access: "exec",
      reason: `会递归删除 ${critical}，超出正常清理范围`,
    };
  }
  return undefined;
}

/**
 * 判定一次工具调用是否命中受保护目标。
 * `depth` 之类的运行时状态不参与判定，保证完全可复现。
 */
export function inspectProtectedTarget(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): ProtectedHit | undefined {
  const name = toolName.toLowerCase();
  if (name === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) return undefined;
    return inspectProtectedCommand(command, path.resolve(cwd));
  }

  const extracted = readToolPathArgs(toolName, args);
  if (!extracted || extracted.paths.length === 0) return undefined;
  const rules = pathRules(path.resolve(cwd)).filter((rule) => rule.access === extracted.access);
  for (const raw of extracted.paths) {
    const target = path.resolve(cwd, raw);
    for (const rule of rules) {
      if (matchPathRule(rule.pattern, target)) {
        return {
          level: rule.level,
          kind: "path",
          rule: rule.pattern,
          target,
          access: extracted.access,
          reason: rule.reason,
        };
      }
    }
  }
  return undefined;
}

/** 是否属于「任何档位都不能跳过、也不能永久记住」的一级（含直接拒绝的灾难性操作）。 */
export function isHardProtectedTarget(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): boolean {
  const level = inspectProtectedTarget(toolName, args, cwd)?.level;
  return level === "hard" || level === "forbidden";
}

/** 给用户和模型看的一句话说明。 */
export function formatProtectedReason(hit: ProtectedHit): string {
  const advice =
    hit.level === "forbidden"
      ? "该操作会删除工作区或更外层目录，任何权限档下都不会执行。"
      : hit.level === "hard"
        ? "该操作会改变授权、自我定义或审计依据本身，即使在 bypass 档也必须由你逐次确认。"
        : "该操作涉及凭据或高影响范围，需要你确认。";
  return `命中受保护目标：${hit.target}（${hit.reason}）。${advice}`;
}
