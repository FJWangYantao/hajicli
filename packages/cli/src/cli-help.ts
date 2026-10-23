import { getCliVersion } from "./cli-runtime.js";
import { splitGraphemes, terminalWidth } from "./terminal-text.js";
import { colors } from "./theme.js";

// 像素画风格的大写 HAJI 启动 Logo
export const LOGO = `
${colors.boldPurple("██╗  ██╗  ██████╗      █████╗ ████████╗")}
${colors.boldPurple("██║  ██║ ██╔═══██╗     ╚══██║ ╚══██╔══╝")}
${colors.boldPurple("███████║ ████████║        ██║    ██║   ")}
${colors.boldPurple("██╔══██║ ██╔═══██║   ██   ██║    ██║   ")}
${colors.boldPurple("██║  ██║ ██║   ██║   ╚█████╔╝ ████████╗")}
${colors.boldPurple("╚═╝  ╚═╝ ╚═╝   ╚═╝    ╚════╝  ╚═══════╝")}
`;

/**
 * 指令面条目：顶层指令，或枢纽条目下的成员子指令。
 * 该常量是底栏补全、会话内 /help 与 CLI --help 三处展示的唯一事实源。
 */
export interface CommandSurfaceEntry {
  command: string;
  description: string;
  /** 存在 members 时该条目为枢纽：入口菜单与帮助按分组展开，成员仍可直连调用。 */
  members?: readonly CommandSurfaceEntry[];
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

/**
 * 顶层指令面：5 个枢纽收纳低频配置/管理类指令，高频动作保留在顶层。
 * 按 `/` 的补全只展示这里的一层条目；成员子指令不再出现在补全中，但保留直连能力。
 */
export const COMMAND_SURFACE: readonly CommandSurfaceEntry[] = [
  { command: "/help", description: "显示帮助手册" },
  {
    command: "/config",
    description: "模型与配置",
    members: [
      { command: "/model", description: "选择模型与思考强度" },
      { command: "/effort", description: "切换思考强度（low/medium/high/xhigh/max）" },
      { command: "/permission", description: "切换权限档次与危险阈值" },
      { command: "/provider", description: "查看 / 切换 / 添加 / 配置提供商" },
    ],
  },
  {
    command: "/agent",
    description: "子代理管理",
    members: [
      { command: "/subagent", description: "启动子代理（无参数进入交互向导）" },
      { command: "/preset", description: "查看 / 管理 subagent 预设" },
      { command: "/agents", description: "查看、管理与中止 Agent" },
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
  },
  {
    command: "/diag",
    description: "诊断与观测",
    members: [
      { command: "/perf", description: "查看性能指标（reset 清空采样）" },
      { command: "/viewer", description: "打开 Trace 观测中心" },
      { command: "/mcp", description: "查看 MCP server 与外部工具状态" },
    ],
  },
  { command: "/compact", description: "多层上下文压缩" },
  { command: "/clear", description: "清空聊天与上下文" },
  { command: "/resume", description: "历史对话查看与热切换" },
  { command: "/rewind", description: "历史节点撤销与代码回退" },
  { command: "/exit", description: "退出 haji" },
];

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
    const items: HubMenuItem[] = entry.members.map((member) => ({
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
    ...COMMAND_SURFACE.flatMap((entry) => entry.members ?? []).map((member) =>
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
    for (const member of entry.members ?? []) {
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
    for (const member of entry.members ?? []) {
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
