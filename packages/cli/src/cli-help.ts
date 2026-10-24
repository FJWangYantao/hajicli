import { getCliVersion } from "./cli-runtime.js";
import type { SlashCommand } from "./terminal-input.js";
import { splitGraphemes, terminalWidth } from "./terminal-text.js";
import { colors, getTheme, gradientFg, themeReset } from "./theme.js";

/** 像素画风格的大写 HAJI 字形（不含颜色）。 */
const LOGO_GLYPHS: readonly string[] = [
  "██╗  ██╗  ██████╗      █████╗ ████████╗",
  "██║  ██║ ██╔═══██╗     ╚══██║ ╚══██╔══╝",
  "███████║ ████████║        ██║    ██║   ",
  "██╔══██║ ██╔═══██║   ██   ██║    ██║   ",
  "██║  ██║ ██║   ██║   ╚█████╔╝ ████████╗",
  "╚═╝  ╚═╝ ╚═╝   ╚═╝    ╚════╝  ╚═══════╝",
];

/**
 * 构建启动 Logo：逐行取 Oklab 感知均匀渐变（accent → cyan）。
 * 必须延迟到渲染时调用：终端明/暗外观在启动阶段才探测到，
 * 模块级常量会把深色调色板固化下来。
 */
export function buildLogo(): string {
  const theme = getTheme();
  const colors = gradientFg(theme.accent, theme.cyan, LOGO_GLYPHS.length);
  const body = LOGO_GLYPHS.map((line, index) => `${colors[index]}${line}${themeReset()}`);
  return `\n${body.join("\n")}\n`;
}

/**
 * 指令面条目：顶层指令，或枢纽条目下的成员子指令。
 * 该常量是底栏补全、会话内 /help 与 CLI --help 三处展示的唯一事实源。
 */
export interface CommandSurfaceEntry {
  command: string;
  description: string;
  /** 存在 members 时该条目为枢纽：入口菜单与帮助按分组展开，成员仍可直连调用。 */
  members?: readonly CommandSurfaceEntry[];
  /** 子命令：输入指令并敲空格后作为补全候选，command 为完整指令文本（如 `/memory confirm`）。 */
  subcommands?: readonly CommandSurfaceEntry[];
  /** 参数格式提示（如 `<id>`），显示在补全标签之后。 */
  argHint?: string;
  /** 参数为必填：补全时只填入指令并等待输入参数，不直接执行。 */
  argRequired?: boolean;
  /** 为 false 时不出现在枢纽菜单与帮助树中，但仍可补全与直连调用（兼容旧指令）。 */
  menu?: boolean;
}

/** 枢纽菜单项：value 是选中后转发给主循环的完整指令文本。 */
export interface HubMenuItem {
  value: string;
  label: string;
  description: string;
}

export interface HubMenu {
  title: string;
  items: readonly HubMenuItem[];
}

/** Skill 枢纽的动态数据源：只依赖展示与可调用性字段，便于测试注入。 */
export interface HubSkillEntry {
  name: string;
  description: string;
  userInvocable: boolean;
}

const EFFORT_SUBCOMMANDS: readonly CommandSurfaceEntry[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
].map((effort) => ({ command: `/effort ${effort}`, description: `思考强度切换为 ${effort}` }));

const PERMISSION_SUBCOMMANDS: readonly CommandSurfaceEntry[] = [
  { command: "/permission plan", description: "计划模式：只读调研，批准后才实施" },
  { command: "/permission default", description: "默认：只读自动通过，修改需审批" },
  { command: "/permission accept-edit", description: "自动编辑：文件编辑自动通过，命令需审批" },
  { command: "/permission auto", description: "自动：分类器判定风险，不安全的拒绝" },
  { command: "/permission bypass-permissions", description: "全放行：不做任何审批（谨慎）" },
];

/**
 * 顶层指令面：5 个枢纽收纳低频配置/管理类指令，高频动作保留在顶层。
 * 只输入 `/` 时补全只展示这里的一层条目；继续输入字母后会模糊搜索全部指令、子命令与 Skill。
 */
export const COMMAND_SURFACE: readonly CommandSurfaceEntry[] = [
  { command: "/help", description: "显示帮助手册" },
  { command: "/model", description: "选择模型与思考强度" },
  {
    command: "/config",
    description: "模型与配置",
    members: [
      {
        command: "/permission",
        description: "切换权限档次与危险阈值",
        argHint: "[模式]",
        subcommands: PERMISSION_SUBCOMMANDS,
      },
      {
        command: "/provider",
        description: "查看 / 切换 / 添加 / 配置提供商",
        argHint: "[名称|add|set|unset]",
        subcommands: [
          { command: "/provider add", description: "引导添加自定义提供商", argHint: "[--project]" },
          {
            command: "/provider set",
            description: "配置提供商的 API Key、Base URL 与模型",
            argHint: "<名称> [--project]",
            argRequired: true,
          },
          {
            command: "/provider unset",
            description: "清除提供商配置",
            argHint: "<名称> [--project]",
            argRequired: true,
          },
        ],
      },
      {
        command: "/effort",
        description: "单独切换思考强度（/model 中也可用 ←→ 调整）",
        argHint: "[low|medium|high|xhigh|max]",
        subcommands: EFFORT_SUBCOMMANDS,
        menu: false,
      },
      {
        command: "/permissions",
        description: "查看 / 删除永久放行的授权规则（跨会话生效）",
      },
      {
        command: "/theme",
        description: "切换配色主题（无参列出，/theme kero 应用并记住）",
        argHint: "[preset]",
      },
    ],
  },
  {
    command: "/agent",
    description: "子代理管理",
    members: [
      {
        command: "/subagent",
        description: "启动子代理（无参数进入交互向导）",
        argHint: "[选项] [任务描述]",
      },
      {
        command: "/preset",
        description: "查看 / 管理 subagent 预设",
        argHint: "[list|show|add|edit|remove]",
        subcommands: [
          { command: "/preset list", description: "列出全部预设" },
          {
            command: "/preset show",
            description: "查看预设详情",
            argHint: "<名称>",
            argRequired: true,
          },
          {
            command: "/preset add",
            description: "添加预设",
            argHint: "<名称> [选项]",
            argRequired: true,
          },
          {
            command: "/preset edit",
            description: "修改预设",
            argHint: "<名称> [选项]",
            argRequired: true,
          },
          {
            command: "/preset remove",
            description: "删除预设",
            argHint: "<名称>",
            argRequired: true,
          },
        ],
      },
      {
        command: "/agents",
        description: "查看、管理与中止 Agent",
        argHint: "[stop|clear]",
        subcommands: [
          {
            command: "/agents stop",
            description: "中止 Agent",
            argHint: "<agentId|all>",
            argRequired: true,
          },
          { command: "/agents clear", description: "清理已结束的 Agent 记录" },
        ],
      },
    ],
  },
  {
    command: "/skill",
    description: "Skill 管理",
    members: [
      { command: "/skills", description: "查看全部 Skill" },
      { command: "/skills reload", description: "重新扫描两个 Skill 目录" },
      { command: "/skills validate", description: "校验 Skill 清单与附属资源" },
    ],
  },
  {
    command: "/memory",
    description: "经验系统",
    members: [
      { command: "/memory list", description: "列出 active 与 staging 记忆" },
      { command: "/instinct", description: "列出行为规则（按 confidence 排序）" },
      { command: "/instinct distill", description: "用本会话观测手动触发提炼" },
      { command: "/instinct stats", description: "规则/记忆数量与观测健康" },
    ],
    subcommands: [
      {
        command: "/memory confirm",
        description: "把 staging 记忆确认为 active",
        argHint: "<id>",
        argRequired: true,
      },
      {
        command: "/memory add",
        description: "手工添加记忆",
        argHint: "<user|project|feedback> <内容>",
        argRequired: true,
      },
      { command: "/memory forget", description: "删除记忆", argHint: "<id>", argRequired: true },
      {
        command: "/memory promote",
        description: "把项目级记忆提升到用户级",
        argHint: "<id>",
        argRequired: true,
      },
      { command: "/instinct forget", description: "删除规则", argHint: "<id>", argRequired: true },
      {
        command: "/instinct promote",
        description: "把项目级规则提升到用户级",
        argHint: "<id>",
        argRequired: true,
      },
      {
        command: "/instinct skill",
        description: "查看可蒸馏规则 / 生成 Skill 草稿",
        argHint: "[id]",
      },
    ],
  },
  {
    command: "/diag",
    description: "诊断与观测",
    members: [
      {
        command: "/perf",
        description: "查看性能指标（reset 清空采样）",
        subcommands: [{ command: "/perf reset", description: "读取后清空性能采样" }],
      },
      { command: "/cost", description: "本会话费用估算（按模型单价与 token 用量）" },
      { command: "/viewer", description: "打开 Trace 观测中心" },
      { command: "/mcp", description: "查看 MCP server 与外部工具状态" },
    ],
  },
  { command: "/compact", description: "多层上下文压缩" },
  {
    command: "/image",
    description: "附加本地图片并提问（需视觉模型）",
    argHint: "<图片路径> [提示词]",
    argRequired: true,
  },
  { command: "/clear", description: "清空聊天与上下文" },
  { command: "/resume", description: "历史对话查看与热切换", argHint: "[标题关键词]" },
  { command: "/rewind", description: "历史节点撤销与代码回退" },
  { command: "/exit", description: "退出 haji" },
];

/** 帮助与枢纽菜单展示的成员（menu: false 的兼容指令不展示）。 */
function menuMembers(entry: CommandSurfaceEntry): readonly CommandSurfaceEntry[] {
  return (entry.members ?? []).filter((member) => member.menu !== false);
}

/** 供底栏补全使用：只返回一层条目（枢纽 + 高频动作）。 */
export function getTopLevelSlashCommands(): ReadonlyArray<{
  command: string;
  description: string;
}> {
  return COMMAND_SURFACE.map((entry) => ({
    command: entry.command,
    description: entry.description,
  }));
}

/**
 * 补全目录：把顶层指令、枢纽成员、子命令与可手动调用的 Skill 展平成一张表。
 * 顶层条目标记 topLevel；其余条目带上所属分组名，补全时作为来源标签显示。
 */
export function buildSlashCommandCatalog(skills: readonly HubSkillEntry[] = []): SlashCommand[] {
  const catalog: SlashCommand[] = [];
  const seen = new Set<string>();
  const add = (entry: CommandSurfaceEntry, group: string | undefined, topLevel: boolean): void => {
    if (seen.has(entry.command)) return;
    seen.add(entry.command);
    catalog.push({
      command: entry.command,
      description: entry.description,
      group,
      argHint: entry.argHint,
      argRequired: entry.argRequired,
      topLevel,
    });
  };
  for (const entry of COMMAND_SURFACE) add(entry, undefined, true);
  for (const entry of COMMAND_SURFACE) {
    for (const member of entry.members ?? []) add(member, entry.description, false);
    for (const sub of entry.subcommands ?? []) add(sub, entry.description, false);
    for (const member of entry.members ?? []) {
      for (const sub of member.subcommands ?? []) add(sub, entry.description, false);
    }
  }
  for (const skill of skills) {
    if (!skill.userInvocable) continue;
    add(
      { command: `/skill ${skill.name}`, description: skill.description, argHint: "[任务]" },
      "Skill",
      false,
    );
  }
  return catalog;
}

/** 子序列匹配：needle 的字符按顺序出现在 haystack 中（首字符必须相同，避免过度宽松）。 */
function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  if (needle[0] !== haystack[0]) return false;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

/**
 * 斜杠补全的匹配与排序：
 * - 只输入 `/`：列出顶层指令；
 * - 无空格：先按前缀匹配全部单词指令（顶层优先），再按子序列模糊匹配（如 /mdl → /model），
 *   最后按子命令/Skill 名的前缀匹配多词条目（如 /reload → /skills reload）；
 * - 含空格：只补全已输入指令的子命令，最后一个词支持前缀与子序列匹配。
 * 候选必须比输入更长，已输入参数的完整指令不会再被补全覆盖。
 */
export function matchSlashCommands(
  input: string,
  catalog: readonly SlashCommand[],
): SlashCommand[] {
  if (!input.startsWith("/") || input.includes("\n")) return [];
  const typed = input.toLowerCase().replace(/\s+/g, " ");
  if (typed === "/") {
    // 未标注顶层条目的简单列表（如测试或外部调用方）整体视为顶层。
    const topLevel = catalog.filter((entry) => entry.topLevel);
    return topLevel.length > 0 ? topLevel : [...catalog];
  }

  const scored: Array<{ entry: SlashCommand; score: number; order: number }> = [];
  const lastSpace = typed.lastIndexOf(" ");
  catalog.forEach((entry, order) => {
    const command = entry.command.toLowerCase();
    let score: number | undefined;
    if (lastSpace >= 0) {
      const head = typed.slice(0, lastSpace + 1);
      const tail = typed.slice(lastSpace + 1);
      if (!command.startsWith(head)) return;
      const rest = command.slice(head.length);
      if (!rest || rest.includes(" ")) return;
      if (rest.startsWith(tail)) score = 0;
      else if (isSubsequence(tail, rest)) score = 1;
    } else if (!command.includes(" ")) {
      if (command.startsWith(typed)) score = entry.topLevel ? 0 : 1;
      else if (isSubsequence(typed.slice(1), command.slice(1))) score = 2;
    } else if (typed.length >= 3) {
      const words = command.slice(1).split(" ").slice(1);
      if (words.some((word) => word.startsWith(typed.slice(1)))) score = 3;
    }
    if (lastSpace < 0 && command === typed) {
      // 输入已是完整指令时仍保留它自身并排在首位，便于确认将要执行的内容。
      scored.push({ entry, score: -1, order });
      return;
    }
    if (score !== undefined) scored.push({ entry, score, order });
  });
  return scored
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map((item) => item.entry);
}

/**
 * 已输入参数时的格式提示：返回输入所对应的最长指令（需带 argHint），
 * 例如输入 `/memory confirm ab` 时提示 `/memory confirm <id>`。
 */
export function findSlashArgHint(
  input: string,
  catalog: readonly SlashCommand[],
): SlashCommand | undefined {
  if (!input.startsWith("/") || input.includes("\n")) return undefined;
  const typed = input.toLowerCase().replace(/\s+/g, " ");
  let best: SlashCommand | undefined;
  for (const entry of catalog) {
    if (!entry.argHint) continue;
    const command = entry.command.toLowerCase();
    if (!typed.startsWith(`${command} `)) continue;
    if (!best || command.length > best.command.length) best = entry;
  }
  return best;
}

/** 编辑距离（插入/删除/替换/相邻交换各计 1），用于未知指令的纠错建议。 */
function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => (row === 0 ? col : col === 0 ? row : 0)),
  );
  for (let row = 1; row < rows; row++) {
    for (let col = 1; col < cols; col++) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      table[row][col] = Math.min(
        table[row - 1][col] + 1,
        table[row][col - 1] + 1,
        table[row - 1][col - 1] + cost,
      );
      if (
        row > 1 &&
        col > 1 &&
        left[row - 1] === right[col - 2] &&
        left[row - 2] === right[col - 1]
      ) {
        table[row][col] = Math.min(table[row][col], table[row - 2][col - 2] + 1);
      }
    }
  }
  return table[left.length][right.length];
}

/**
 * 未知指令的纠错建议：在全部单词指令中找编辑距离最近的一个（短名最多差 1，长名最多差 2），
 * 找不到时退回唯一的前缀匹配。返回带斜杠的指令，或 undefined。
 */
export function suggestSimilarCommand(
  name: string,
  catalog: readonly SlashCommand[],
): string | undefined {
  const target = name.toLowerCase().replace(/^\//, "");
  if (!target) return undefined;
  const commands = catalog
    .map((entry) => entry.command.toLowerCase().slice(1))
    .filter((command) => !command.includes(" "));
  let best: { command: string; distance: number } | undefined;
  for (const command of commands) {
    const distance = editDistance(target, command);
    const limit = Math.max(target.length, command.length) <= 4 ? 1 : 2;
    if (distance <= limit && (!best || distance < best.distance)) best = { command, distance };
  }
  if (best) return `/${best.command}`;
  const prefixed = commands.filter((command) => command.startsWith(target));
  return prefixed.length === 1 ? `/${prefixed[0]}` : undefined;
}

/**
 * 构建全部枢纽菜单。Skill 枢纽把可手动调用的 Skill 动态注入为“选中即加载”的菜单项；
 * 其余枢纽直接映射成员子指令。返回值的键为枢纽名（不含斜杠）。
 */
export function buildHubMenus(skills: readonly HubSkillEntry[] = []): Record<string, HubMenu> {
  const loadableSkills: HubMenuItem[] = skills
    .filter((skill) => skill.userInvocable)
    .map((skill) => ({
      value: `/skill ${skill.name}`,
      label: `/skill ${skill.name}`,
      description: skill.description,
    }));

  const menus: Record<string, HubMenu> = {};
  for (const entry of COMMAND_SURFACE) {
    if (!entry.members) continue;
    const items: HubMenuItem[] = menuMembers(entry).map((member) => ({
      value: member.command,
      label: member.command,
      description: member.description,
    }));
    if (entry.command === "/skill") items.unshift(...loadableSkills);
    menus[entry.command.slice(1)] = { title: entry.description, items };
  }
  return menus;
}

/** 会话内快捷键：与 terminal-input 的按键处理保持一致。 */
export const SESSION_SHORTCUTS: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: "Enter", description: "发送消息" },
  { keys: "Shift+Enter / Ctrl+J", description: "输入框内换行" },
  { keys: "Esc", description: "中止当前回合（未发出的 prompt 会收回输入框）" },
  { keys: "Shift+Tab", description: "循环切换权限模式" },
  { keys: "↑ / ↓", description: "浏览输入历史" },
  { keys: "PgUp / PgDn", description: "翻阅对话；Shift+↑↓ 逐行滚动，Ctrl+End 回到底部" },
  { keys: "Ctrl+T", description: "展开 / 收起任务面板" },
  { keys: "Ctrl+O", description: "展开最后一批工具调用的完整输出" },
  { keys: "Tab", description: "补全斜杠指令（不执行）" },
  { keys: "鼠标拖选 + Ctrl+C", description: "复制选中文本；无选中时 Ctrl+C 退出" },
];

/** 按显示宽度折行：英文尽量在空格处断开，中文逐字断开。 */
function wrapPlainText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const rows: string[] = [];
  let row = "";
  for (const grapheme of splitGraphemes(text)) {
    if (terminalWidth(row + grapheme) <= safeWidth) {
      row += grapheme;
      continue;
    }
    const breakAt = row.lastIndexOf(" ");
    if (grapheme !== " " && /^[\x21-\x7e]$/.test(grapheme) && breakAt > 0) {
      rows.push(row.slice(0, breakAt));
      row = `${row.slice(breakAt + 1)}${grapheme}`;
    } else {
      rows.push(row);
      row = grapheme === " " ? "" : grapheme;
    }
  }
  if (row) rows.push(row);
  return rows.length > 0 ? rows : [""];
}

/** 两列对齐：标签列定宽，说明列超宽时悬挂缩进折行，窄屏下说明另起一行。 */
function formatHelpRow(
  indent: string,
  label: string,
  description: string,
  labelWidth: number,
  width: number,
  styleLabel: (text: string) => string,
): string[] {
  const indentWidth = terminalWidth(indent);
  const descriptionWidth = width - indentWidth - labelWidth - 2;
  if (descriptionWidth < 12) {
    return [
      `${indent}${styleLabel(label)}`,
      ...wrapPlainText(description, width - indentWidth - 2).map((row) => `${indent}  ${row}`),
    ];
  }
  const padding = " ".repeat(Math.max(0, labelWidth - terminalWidth(label)) + 2);
  const continuation = " ".repeat(indentWidth + labelWidth + 2);
  return wrapPlainText(description, descriptionWidth).map((row, index) =>
    index === 0 ? `${indent}${styleLabel(label)}${padding}${row}` : `${continuation}${row}`,
  );
}

export interface SessionHelpOptions {
  width: number;
  permissionMode: string;
  reasoningEffort: string;
  model: string;
  toolNames: readonly string[];
}

/**
 * 会话内 /help：指令表 + 快捷键 + 当前状态 + 工具名清单。工具说明是写给模型的，
 * 篇幅长且对用户无用，这里只列名称。
 */
export function buildSessionHelpLines(options: SessionHelpOptions): string[] {
  const width = Math.max(20, options.width);
  const commandWidth = Math.max(...COMMAND_SURFACE.map((entry) => terminalWidth(entry.command)));
  const memberWidth = Math.max(
    ...COMMAND_SURFACE.flatMap((entry) => menuMembers(entry)).map((member) =>
      terminalWidth(member.command),
    ),
  );
  const lines = [colors.bold("指令")];
  for (const entry of COMMAND_SURFACE) {
    lines.push(
      ...formatHelpRow(
        "  ",
        entry.command,
        entry.description,
        commandWidth,
        width,
        entry.members ? colors.boldPurple : colors.purple,
      ),
    );
    for (const member of menuMembers(entry)) {
      lines.push(
        ...formatHelpRow(
          "    ",
          member.command,
          member.description,
          memberWidth,
          width,
          colors.gray,
        ),
      );
    }
  }
  lines.push(
    ...wrapPlainText("枢纽指令进入后可选择细分项，细分指令也可以直接输入。", width - 2).map(
      (row) => `  ${colors.gray(row)}`,
    ),
    "",
  );

  const shortcutWidth = Math.max(...SESSION_SHORTCUTS.map((item) => terminalWidth(item.keys)));
  lines.push(colors.bold("快捷键"));
  for (const shortcut of SESSION_SHORTCUTS) {
    lines.push(
      ...formatHelpRow(
        "  ",
        shortcut.keys,
        shortcut.description,
        shortcutWidth,
        width,
        colors.cyan,
      ),
    );
  }
  lines.push("", colors.bold("当前"));
  lines.push(
    ...wrapPlainText(
      `权限 ${options.permissionMode} · 强度 ${options.reasoningEffort} · 模型 ${options.model}`,
      width - 2,
    ).map((row) => `  ${row}`),
  );
  lines.push("", colors.bold(`可用工具（${options.toolNames.length}）`));
  lines.push(
    ...wrapPlainText(options.toolNames.join("  "), width - 2).map((row) => `  ${colors.gray(row)}`),
  );
  return lines;
}

/** 把指令面渲染为 CLI --help 使用的对齐文本（不含颜色）。 */
function renderCommandSurfaceLines(): string[] {
  const lines: string[] = [];
  for (const entry of COMMAND_SURFACE) {
    lines.push(`  ${entry.command.padEnd(12)}${entry.description}`);
    for (const member of menuMembers(entry)) {
      lines.push(`    ${member.command.padEnd(20)}${member.description}`);
    }
  }
  return lines;
}

/**
 * 处理 `--version/-v` 与 `--help/-h` 启动参数。
 * 命中时打印信息后直接退出进程；未命中返回 false，继续正常启动流程。
 */
export function handleEarlyCliArgs(cliArgs: string[]): boolean {
  if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
    console.log(`haji v${getCliVersion()}`);
    process.exit(0);
  }
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    console.log(`
${colors.boldPurple("HAJI CLI")} - 轻量级终端 AI 辅助编程工具 (v${getCliVersion()})

${colors.bold("用法:")}
  haji [选项]

${colors.bold("选项:")}
  -v, --version       显示版本号
  -h, --help          显示帮助手册
  -p, --print <prompt>  无头单次执行：跑完一个回合输出结果并退出（stdout 只含正文；prompt 传 "-" 从 stdin 管道读取）
  --permission-mode <mode>  无头模式的权限档位：plan|default|accept-edit|auto|bypass-permissions
  --output-format <format>  无头输出格式：text（默认）或 json（stdout 只输出一个结构化 JSON）

${colors.bold("快捷命令 (对话内，枢纽进入后选择细分项):")}
${renderCommandSurfaceLines().join("\n")}
  （被收纳的子指令仍可直接输入完整指令调用）

${colors.bold("环境变量配置:")}
  DEEPSEEK_API_KEY    DeepSeek 平台 API Key
  VOLC_API_KEY        火山引擎 API Key (或 ARK_API_KEY)
  HAJI_PROXY          HTTP/HTTPS 统一代理（也支持 HTTP_PROXY / HTTPS_PROXY）
  HAJI_HTTP_TIMEOUT_MS  网络连接超时，默认 60000ms
  HAJI_ALLOW_OUTSIDE_WORKSPACE  设为 1 时允许文件工具访问工作区外（谨慎）
  HAJI_CONTEXT_WINDOW_TOKENS  可选：覆盖当前模型的上下文 Token 上限
`);
    process.exit(0);
  }
  return false;
}
