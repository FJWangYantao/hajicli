/**
 * /doctor 一次性自检：Key 连通性、原生渲染引擎、ripgrep、编辑后验证命令、
 * MCP server、全局 haji 版本与当前进程一致性。只读检查，不修改任何配置。
 */
import { execFile } from "node:child_process";
import { getCliVersion } from "./cli-runtime.js";
import { getNativeTerminalEngineStatus } from "./native-terminal-engine.js";
import { detectProjectCheckCommand } from "./post-edit-verify.js";
import { testProviderConnection } from "./provider-config.js";
import { colors } from "./theme.js";

function execFileText(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error) resolve(undefined);
        else resolve(String(stdout).trim());
      },
    );
  });
}

export interface DoctorCheckRow {
  /** 检查项名称。 */
  name: string;
  ok: boolean;
  /** 通过/失败之外的中间态（如“未配置”“不可用”）。 */
  skipped?: boolean;
  detail: string;
}

export interface DoctorContext {
  /** 当前 provider 展示名与请求参数（连通性测试用；无 Key 时传 undefined）。 */
  connection?:
    | {
        providerLabel: string;
        baseUrl: string;
        apiKey: string;
        model: string;
      }
    | undefined;
  /** MCP server 状态（mcpManager.getServerStatuses() 的展示子集）。 */
  mcpStatuses: ReadonlyArray<{ name: string; state: string; toolCount: number; error?: string }>;
}

/** 逐项执行自检（异步项：连通性、ripgrep、全局 haji 版本）。 */
export async function collectDoctorChecks(ctx: DoctorContext): Promise<DoctorCheckRow[]> {
  const rows: DoctorCheckRow[] = [];

  if (ctx.connection) {
    const result = await testProviderConnection(
      ctx.connection.baseUrl,
      ctx.connection.apiKey,
      ctx.connection.model,
    );
    rows.push({
      name: `Key 连通（${ctx.connection.providerLabel} · ${ctx.connection.model}）`,
      ok: result.ok,
      detail: result.ok
        ? `通过，${result.ms}ms`
        : `${result.error ?? "未知错误"}${result.ms !== undefined ? `（${result.ms}ms）` : ""} · 可用 /provider set 重新配置`,
    });
  } else {
    rows.push({
      name: "Key 连通",
      ok: false,
      skipped: true,
      detail: "当前 provider 没有可测试的 API Key",
    });
  }

  const native = getNativeTerminalEngineStatus();
  rows.push({
    name: "原生终端引擎",
    ok: native.available,
    skipped: !native.available,
    detail: native.available
      ? `Rust native（${native.mode}）`
      : `TypeScript fallback（${native.mode}）`,
  });

  const rgVersion = await execFileText("rg", ["--version"]);
  rows.push({
    name: "ripgrep（rg）",
    ok: Boolean(rgVersion),
    skipped: !rgVersion,
    detail: rgVersion ? rgVersion.split(/\r?\n/)[0] : "未安装；搜索工具会退化为 JS 实现（较慢）",
  });

  const checkCommand = detectProjectCheckCommand(process.cwd());
  rows.push({
    name: "编辑后验证命令",
    ok: Boolean(checkCommand),
    skipped: !checkCommand,
    detail: checkCommand ?? "当前项目未探测到 typecheck 命令（编辑后验证静默跳过）",
  });

  if (ctx.mcpStatuses.length === 0) {
    rows.push({
      name: "MCP server",
      ok: true,
      skipped: true,
      detail: "未配置 MCP server（如需接入见 /mcp 说明）",
    });
  } else {
    for (const status of ctx.mcpStatuses) {
      const ok = status.state === "running";
      rows.push({
        name: `MCP server ${status.name}`,
        ok,
        skipped: status.state === "disabled",
        detail: ok
          ? `running · ${status.toolCount} 个工具`
          : `${status.state}${status.error ? `：${status.error.replace(/\s+/g, " ").slice(0, 120)}` : ""}`,
      });
    }
  }

  const globalVersion = await execFileText("haji", ["--version"]);
  const localVersion = getCliVersion();
  if (globalVersion === undefined) {
    rows.push({
      name: "全局 haji 命令",
      ok: false,
      skipped: true,
      detail: "PATH 中找不到 haji 命令",
    });
  } else {
    const globalMatch = globalVersion.match(/v?(\d+\.\d+\.\d+)/)?.[1];
    const ok = globalMatch === localVersion;
    rows.push({
      name: "全局 haji 版本一致性",
      ok,
      detail: ok
        ? `一致（v${localVersion}）`
        : `全局 ${globalMatch ?? globalVersion} ≠ 当前 v${localVersion}；若是 junction 安装请重新构建（pnpm run build），否则重装全局包`,
    });
  }

  return rows;
}

/** 把自检结果渲染成带 ✓/!/✕ 状态的文本行（由调用方写入对话区）。 */
export function renderDoctorReport(rows: readonly DoctorCheckRow[]): string {
  const lines = [colors.bold(`haji 自检（${rows.length} 项）`)];
  for (const row of rows) {
    const mark = row.ok
      ? colors.boldGreen("✓")
      : row.skipped
        ? colors.boldYellow("!")
        : colors.boldRed("✕");
    lines.push(`  ${mark} ${row.name}：${row.skipped ? colors.gray(row.detail) : row.detail}`);
  }
  lines.push(colors.gray("  连通测试会向当前 provider 发送一次最小请求；金额可忽略。"));
  return lines.join("\n");
}
