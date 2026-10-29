/**
 * 自定义斜杠命令：`.haji/commands/<名称>.md` 是一段提示词模板，输入 `/<名称> 参数` 时展开成
 * 本轮用户消息发给模型。
 *
 * 与 Skill 的分工：命令是**一次性的提示词模板**（「按这个清单 review」「写这种格式的提交说明」），
 * 展开后就是一条普通用户消息；Skill 是常驻能力包（说明 + 资源文件，按需加载进上下文）。
 *
 * - 两级目录：用户级 `~/.haji/commands/`、项目级 `<cwd>/.haji/commands/`，同名时项目级覆盖用户级；
 * - 文件名即命令名（小写字母、数字、`-`、`_`），与内置指令或别名重名的跳过并报告；
 * - 可选 frontmatter：`description`、`argument-hint`（简单 `key: value`，不支持嵌套）；
 * - 模板里的 `$ARGUMENTS` 换成整段参数，`$1`…`$9` 换成按空白切分的位置参数；
 *   模板没写占位符而用户给了参数时，参数接在模板后面，不会被静默丢掉。
 *
 * 项目级命令只产生提示词、不执行任何东西，所以不需要像 hooks 那样先信任。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CustomCommandScope = "user" | "project";

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  template: string;
  scope: CustomCommandScope;
  path: string;
}

export interface CustomCommandScan {
  commands: CustomCommand[];
  /** 跳过的文件与原因（重名、命名不合法、读不了）。 */
  warnings: string[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_TEMPLATE_CHARS = 32_000;

export function userCommandsDir(): string {
  return path.join(os.homedir(), ".haji", "commands");
}

export function projectCommandsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".haji", "commands");
}

/** 只认最外层 `---` 包住的 `key: value` 行；值两侧的引号去掉。 */
export function parseCommandFile(raw: string): {
  description?: string;
  argumentHint?: string;
  body: string;
} {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return { body: raw.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!pair) continue;
    fields[pair[1].toLowerCase()] = pair[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return {
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields["argument-hint"] ? { argumentHint: fields["argument-hint"] } : {}),
    body: raw.slice(match[0].length).trim(),
  };
}

function scanDir(
  dir: string,
  scope: CustomCommandScope,
  reserved: ReadonlySet<string>,
  warnings: string[],
): CustomCommand[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const commands: CustomCommand[] = [];
  for (const file of names.sort()) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const name = file.slice(0, -3);
    const filePath = path.join(dir, file);
    const label = `${scope === "project" ? ".haji" : "~/.haji"}/commands/${file}`;
    if (!NAME_PATTERN.test(name)) {
      warnings.push(`${label}：命令名只能用小写字母、数字、- 和 _，已跳过。`);
      continue;
    }
    if (reserved.has(name)) {
      warnings.push(`${label}：与内置指令 /${name} 重名，已跳过（内置优先）。`);
      continue;
    }
    let raw: string;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      warnings.push(`${label}：读取失败，已跳过。`);
      continue;
    }
    const parsed = parseCommandFile(raw);
    if (!parsed.body) {
      warnings.push(`${label}：模板为空，已跳过。`);
      continue;
    }
    const firstLine = parsed.body.split(/\r?\n/).find((line) => line.trim()) ?? "";
    commands.push({
      name,
      description: parsed.description ?? firstLine.replace(/^#+\s*/, "").slice(0, 80),
      ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
      template: parsed.body.slice(0, MAX_TEMPLATE_CHARS),
      scope,
      path: filePath,
    });
  }
  return commands;
}

/** 扫描两级目录；项目级同名覆盖用户级。reserved 是内置指令与别名的头词（小写、不含斜杠）。 */
export function loadCustomCommands(
  reserved: ReadonlySet<string>,
  cwd: string = process.cwd(),
): CustomCommandScan {
  const warnings: string[] = [];
  const byName = new Map<string, CustomCommand>();
  for (const command of scanDir(userCommandsDir(), "user", reserved, warnings)) {
    byName.set(command.name, command);
  }
  const projectDir = projectCommandsDir(cwd);
  // 项目目录就是 home 时两级是同一个目录，不重复扫描。
  if (path.resolve(projectDir) !== path.resolve(userCommandsDir())) {
    for (const command of scanDir(projectDir, "project", reserved, warnings)) {
      byName.set(command.name, command);
    }
  }
  return {
    commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

/** 展开模板：$ARGUMENTS → 整段参数，$1…$9 → 位置参数；没有占位符时参数追加在末尾。 */
export function expandCustomCommand(command: CustomCommand, args: string): string {
  const trimmedArgs = args.trim();
  const positional = trimmedArgs ? trimmedArgs.split(/\s+/) : [];
  let usedPlaceholder = false;
  const expanded = command.template.replace(/\$(ARGUMENTS|[1-9])\b/g, (_match, key: string) => {
    usedPlaceholder = true;
    return key === "ARGUMENTS" ? trimmedArgs : (positional[Number(key) - 1] ?? "");
  });
  if (!usedPlaceholder && trimmedArgs) return `${expanded}\n\n${trimmedArgs}`;
  return expanded;
}

/**
 * 输入是否是一条自定义命令；是则返回展开后的提示词。内置指令不经过这里——调用方只在
 * 内置分支都没命中后再查（-p / mcp-serve 没有内置分支，命中的只可能是自定义命令）。
 */
export function matchCustomCommand(
  input: string,
  commands: readonly CustomCommand[],
): { command: CustomCommand; prompt: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const match = trimmed.slice(1).match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const command = commands.find((entry) => entry.name === match[1].toLowerCase());
  if (!command) return undefined;
  return { command, prompt: expandCustomCommand(command, match[2] ?? "") };
}
