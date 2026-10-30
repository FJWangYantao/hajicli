/**
 * `/patrol` 命令族：PR 巡检服务的查看、登记与控制。
 *
 * 常驻服务（start）会阻塞当前回合直到中止，适合在独立终端运行；
 * 交互会话里推荐 `run-once` 单轮驱动（可配合外部 cron / 定时器）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isTerminalPatrolStatus, PatrolStore, patrolJobId } from "@hajicli/core";
import { GitHubPatrolAdapter } from "@hajicli/patrol-github";
import { colors } from "../theme.js";
import { loadPatrolConfig, resolvePatrolRepo, savePatrolConfig } from "./config.js";
import { createHeadlessRunners } from "./runners.js";
import { PatrolService } from "./service.js";
import { createSmeeWakeSource } from "./wake.js";

const execFileAsync = promisify(execFile);

export interface PatrolCommandContext {
  cwd: string;
  writeLine(text: string): void;
  /** 巡检服务的令牌（默认 GH_TOKEN / GITHUB_TOKEN）。 */
  token?: string;
  /** start 的中止信号；缺省时用进程级 SIGINT/SIGTERM。 */
  signal?: AbortSignal;
  /**
   * 停止侧栏启动的常驻巡查（由 index.ts 注入）；返回是否真的停掉了一个在跑的循环。
   * 缺省（无头 / 非交互）时 `/patrol stop` 只提示没有常驻巡查。
   */
  stopLoop?: () => boolean;
}

export async function handlePatrolCommand(
  ctx: PatrolCommandContext,
  input: { parts: string[] } | string[],
): Promise<void> {
  try {
    await dispatchPatrolCommand(ctx, input);
  } catch (error) {
    // 配置损坏、GitHub 401/网络错误等都应落成一行可读错误，而不是把主循环带崩。
    ctx.writeLine(colors.failLine(`巡检命令失败：${(error as Error).message}`));
  }
}

async function dispatchPatrolCommand(
  ctx: PatrolCommandContext,
  input: { parts: string[] } | string[],
): Promise<void> {
  const parts = Array.isArray(input) ? input : input.parts;
  const sub = (parts[1] ?? "status").toLowerCase();
  const store = new PatrolStore(`${ctx.cwd}/.haji/patrol`);
  switch (sub) {
    case "status":
      return printStatus(ctx, store);
    case "inspect":
      return printInspect(ctx, store, parts[2]);
    case "register":
      return register(ctx, store, parts.slice(2));
    case "unregister":
      return unregister(ctx, store, parts[2]);
    case "pause":
      store.setPaused(true);
      ctx.writeLine(colors.okLine("巡检已暂停（resume 恢复）"));
      return;
    case "resume":
      store.setPaused(false);
      ctx.writeLine(colors.okLine("巡检已恢复"));
      return;
    case "retry":
      return retry(ctx, store, parts[2]);
    case "start":
      return start(ctx, parts.slice(2));
    case "run-once":
      return runOnce(ctx);
    case "stop":
      return stop(ctx);
    case "watch":
      return watch(ctx, parts[2]);
    case "unwatch":
      return unwatch(ctx);
    case "adopt-all":
      return adoptAll(ctx, parts[2]);
    default:
      usage(ctx);
      ctx.writeLine(colors.failLine(`未知子命令: ${sub}`));
  }
}

function usage(ctx: PatrolCommandContext): void {
  ctx.writeLine(colors.gray("用法："));
  ctx.writeLine(colors.gray("  /patrol                     查看巡检任务列表"));
  ctx.writeLine(
    colors.gray("  /patrol start [--interval <秒>]   一步启动常驻巡检（仓库与令牌自动推断）"),
  );
  ctx.writeLine(colors.gray("  /patrol stop                停止侧栏启动的常驻巡查"));
  ctx.writeLine(
    colors.gray(
      "  /patrol watch <url>         接入 webhook 唤醒通道（smee 形态 SSE），事件到达即复查",
    ),
  );
  ctx.writeLine(colors.gray("  /patrol unwatch             关闭唤醒通道，退回纯轮询"));
  ctx.writeLine(colors.gray("  /patrol run-once            单轮巡检（配合外部定时）"));
  ctx.writeLine(colors.gray("  /patrol inspect <PR>        查看单个任务详情"));
  ctx.writeLine(
    colors.gray(
      "  /patrol register <PR> --task <id> --brief <任务> [--accept <验收>]... [--scope <范围>]...",
    ),
  );
  ctx.writeLine(
    colors.gray(
      "                              登记非 agent 分支的 PR（haji/ 分支默认自动接管；autoAdoptAll 开启则全部接管）",
    ),
  );
  ctx.writeLine(colors.gray("  /patrol unregister <PR>     取消登记"));
  ctx.writeLine(
    colors.gray("  /patrol adopt-all [on|off]   接管全部 PR（默认关闭；他人提交只审查不合并）"),
  );
  ctx.writeLine(colors.gray("  /patrol pause / resume      暂停 / 恢复"));
  ctx.writeLine(colors.gray("  /patrol retry <PR>          重置卡住 / 已终止的任务"));
}

export const STATUS_LABELS: Record<string, string> = {
  discovered: "已登记",
  reviewing: "审查中",
  awaiting_changes: "退回修改",
  fixing: "修改中",
  adjudicating: "裁决中",
  enforcing: "裁决执行",
  ready_to_merge: "待合并",
  merging: "合并中",
  merged: "已合并",
  terminated: "已终止",
};

function printStatus(ctx: PatrolCommandContext, store: PatrolStore): void {
  const jobs = store.listJobs();
  ctx.writeLine(
    colors.cyan(
      `PR Patrol（${store.isPaused() ? "已暂停" : "运行可用"}，共 ${jobs.length} 个任务）`,
    ),
  );
  if (jobs.length === 0) {
    ctx.writeLine(colors.gray("  暂无任务；用 /patrol register <PR> 登记来源后自动接管。"));
    return;
  }
  for (const job of jobs) {
    const label = STATUS_LABELS[job.status] ?? job.status;
    const head = job.version.headSha.slice(0, 7);
    const rounds = `修改${job.fixRounds}/裁决${job.adjudicationRounds}`;
    const cost = `¥${job.usage.costCny.toFixed(2)}`;
    const flag = isTerminalPatrolStatus(job.status) ? colors.okLine(label) : colors.warnLine(label);
    ctx.writeLine(
      `  #${job.prNumber} ${flag} ${colors.gray(`${job.branch} → ${job.targetBranch}`)}`,
    );
    ctx.writeLine(colors.gray(`      head ${head} · ${rounds} · ${cost} · ${job.jobId}`));
    if (job.terminatedReason) {
      ctx.writeLine(colors.gray(`      终止原因：${job.terminatedReason}`));
    }
  }
}

function printInspect(ctx: PatrolCommandContext, store: PatrolStore, prArg?: string): void {
  const number = Number(prArg);
  if (!Number.isInteger(number) || number <= 0) {
    ctx.writeLine(colors.failLine("用法：/patrol inspect <PR 编号>"));
    return;
  }
  const job = store.listJobs().find((item) => item.prNumber === number);
  if (!job) {
    ctx.writeLine(colors.failLine(`没有 PR #${number} 的巡检任务`));
    return;
  }
  ctx.writeLine(
    colors.cyan(`#${job.prNumber} ${STATUS_LABELS[job.status] ?? job.status} · ${job.jobId}`),
  );
  ctx.writeLine(colors.gray(`  任务：${job.taskBrief}`));
  ctx.writeLine(
    colors.gray(
      `  版本：head ${job.version.headSha.slice(0, 10)} / base ${job.version.baseSha.slice(0, 10)} / 规则 ${job.version.ruleVersion}`,
    ),
  );
  ctx.writeLine(colors.gray(`  轮次：修改 ${job.fixRounds}，裁决 ${job.adjudicationRounds}`));
  ctx.writeLine(
    colors.gray(
      `  费用：¥${job.usage.costCny.toFixed(2)}（${job.usage.promptTokens + job.usage.completionTokens} tokens）`,
    ),
  );
  if (job.findings.length > 0) {
    ctx.writeLine(colors.gray("  问题："));
    for (const finding of job.findings) {
      const state =
        finding.state === "open"
          ? colors.warnLine("未解决")
          : finding.state === "resolved"
            ? colors.okLine("已解决")
            : colors.gray("已驳回");
      ctx.writeLine(`    ${finding.findingId} [${finding.severity}] ${state} ${finding.summary}`);
    }
  }
  const decisions = job.decisions.slice(-5);
  if (decisions.length > 0) {
    ctx.writeLine(colors.gray("  近期结论："));
    for (const decision of decisions) {
      ctx.writeLine(
        colors.gray(
          `    ${decision.decisionId} ${decision.kind}/${decision.verdict} @ ${decision.version.headSha.slice(0, 7)}`,
        ),
      );
    }
  }
  if (job.terminatedReason) ctx.writeLine(colors.gray(`  终止原因：${job.terminatedReason}`));
  if (job.mergedAt) ctx.writeLine(colors.gray(`  合并时间：${job.mergedAt}`));
}

function parseOptions(args: string[]): {
  positional: string[];
  values: Map<string, string[]>;
} {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) continue;
      const list = values.get(key) ?? [];
      list.push(value);
      values.set(key, list);
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, values };
}

async function register(
  ctx: PatrolCommandContext,
  store: PatrolStore,
  args: string[],
): Promise<void> {
  const { positional, values } = parseOptions(args);
  const number = Number(positional[0]);
  const taskId = values.get("task")?.[0];
  const brief = values.get("brief")?.[0];
  if (!Number.isInteger(number) || number <= 0 || !taskId || !brief) {
    ctx.writeLine(
      colors.failLine(
        "用法：/patrol register <PR> --task <任务ID> --brief <任务描述> [--accept <验收>]... [--scope <范围>]...",
      ),
    );
    return;
  }
  const configRepo = resolvePatrolRepo(ctx.cwd);
  if (!configRepo) {
    ctx.writeLine(
      colors.failLine(
        "无法确定巡检仓库：在 .haji/patrol/config.json 设置 repo（owner/name），或在该 git 仓库配置 origin 远端",
      ),
    );
    return;
  }
  const jobId = patrolJobId(configRepo, number);
  store.saveRegistration({
    jobId,
    repo: configRepo,
    prNumber: number,
    taskId,
    origin: "haji",
    registeredAt: new Date().toISOString(),
    taskBrief: brief,
    acceptance: values.get("accept") ?? [],
    scope: values.get("scope") ?? [],
    // 手动登记即显式授权：允许自动合并（自动登记才会因「作者非本人」被降级为仅审查）。
    mergeAuthorized: true,
  });
  ctx.writeLine(colors.okLine(`已登记 PR #${number}（任务 ${taskId}）。下一轮巡检将自动接管。`));
}

async function unregister(
  ctx: PatrolCommandContext,
  store: PatrolStore,
  prArg?: string,
): Promise<void> {
  const number = Number(prArg);
  const configRepo = resolvePatrolRepo(ctx.cwd);
  if (!Number.isInteger(number) || !configRepo) {
    ctx.writeLine(colors.failLine("用法：/patrol unregister <PR 编号>"));
    return;
  }
  const removed = store.removeRegistration(patrolJobId(configRepo, number));
  ctx.writeLine(
    removed
      ? colors.okLine(`已取消 PR #${number} 的登记`)
      : colors.gray(`PR #${number} 原本就没有登记`),
  );
}

async function retry(ctx: PatrolCommandContext, store: PatrolStore, prArg?: string): Promise<void> {
  const number = Number(prArg);
  if (!Number.isInteger(number)) {
    ctx.writeLine(colors.failLine("用法：/patrol retry <PR 编号>"));
    return;
  }
  const job = store.listJobs().find((item) => item.prNumber === number);
  if (!job) {
    ctx.writeLine(colors.failLine(`没有 PR #${number} 的巡检任务`));
    return;
  }
  if (job.status === "merged") {
    ctx.writeLine(colors.failLine("已合并的任务不能重试"));
    return;
  }
  job.status = "discovered";
  job.terminatedReason = undefined;
  job.lease = undefined;
  job.updatedAt = new Date().toISOString();
  store.saveJob(job);
  ctx.writeLine(colors.okLine(`PR #${number} 已重置为待审查`));
}

async function start(ctx: PatrolCommandContext, args: string[]): Promise<void> {
  const { values } = parseOptions(args);
  const intervalSeconds = Number(values.get("interval")?.[0]);
  const built = await buildService(
    ctx,
    Number.isFinite(intervalSeconds) ? intervalSeconds * 1000 : undefined,
  );
  if (!built) return;
  const { service, repo } = built;
  const controller = new AbortController();
  const signal = ctx.signal;
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  ctx.writeLine(
    colors.okLine(
      `PR Patrol 启动（${repo}）。有任务时连续推进，空闲时指数退避探测新 PR（上限 64 分钟）。Ctrl+C 停止。`,
    ),
  );
  const wakeUrl = loadPatrolConfig(ctx.cwd).wakeUrl;
  const wake = wakeUrl
    ? createSmeeWakeSource(wakeUrl, { logger: (line) => ctx.writeLine(colors.gray(line)) })
    : undefined;
  if (wake)
    ctx.writeLine(colors.gray(`已接入唤醒通道（${wakeUrl}）：事件到达即复查，轮询仍作兜底。`));
  try {
    await service.runLoop(controller.signal, { wake });
  } finally {
    wake?.close();
    ctx.writeLine(colors.gray("PR Patrol 已停止。"));
  }
}

function stop(ctx: PatrolCommandContext): void {
  const stopped = ctx.stopLoop?.() ?? false;
  ctx.writeLine(
    stopped
      ? colors.okLine("常驻巡查已停止（点侧栏入口可重新开始）")
      : colors.gray("当前没有侧栏启动的常驻巡查在运行"),
  );
}

/**
 * 接入唤醒通道：只写配置，不动正在跑的循环——热切换会让「谁在等」难以推理，
 * 重启一次（/patrol stop 后点侧栏）成本极低。
 */
async function watch(ctx: PatrolCommandContext, url?: string): Promise<void> {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    ctx.writeLine(colors.failLine("用法：/patrol watch <url>（如 https://smee.io/xxxx）"));
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    ctx.writeLine(colors.failLine(`唤醒通道地址不合法：${trimmed}`));
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    ctx.writeLine(colors.failLine(`唤醒通道只支持 http(s)：${trimmed}`));
    return;
  }
  const config = loadPatrolConfig(ctx.cwd);
  config.wakeUrl = trimmed;
  savePatrolConfig(ctx.cwd, config);
  ctx.writeLine(colors.okLine(`已接入唤醒通道：${trimmed}`));
  ctx.writeLine(
    colors.gray(
      "  GitHub 侧把仓库 webhook 指向该地址（pull_request / pull_request_review / check_suite / workflow_run / issue_comment）。",
    ),
  );
  ctx.writeLine(
    colors.gray("  轮询仍是兜底：事件丢了、乱序了，下一轮照样能对齐。重启巡检后生效。"),
  );
}

function unwatch(ctx: PatrolCommandContext): void {
  const config = loadPatrolConfig(ctx.cwd);
  if (!config.wakeUrl) {
    ctx.writeLine(colors.gray("当前没有配置唤醒通道"));
    return;
  }
  config.wakeUrl = "";
  savePatrolConfig(ctx.cwd, config);
  ctx.writeLine(colors.okLine("已关闭唤醒通道，巡检退回纯轮询（重启巡检后生效）"));
}

/**
 * 接管全部 PR 的开关：只写配置，与 `/patrol watch` 一样不动正在跑的循环。
 * 只放宽「谁来审」，合并授权仍按原分层——他人提交只审查，本人提交才允许自动合并。
 */
function adoptAll(ctx: PatrolCommandContext, arg?: string): void {
  const config = loadPatrolConfig(ctx.cwd);
  const value = (arg ?? "").trim().toLowerCase();
  if (!value) {
    ctx.writeLine(
      colors.gray(
        `当前接管全部 PR：${config.autoAdoptAll ? "已开启" : "已关闭"}（/patrol adopt-all on|off 切换）`,
      ),
    );
    return;
  }
  const enabled = value === "on" || value === "true" || value === "1";
  const disabled = value === "off" || value === "false" || value === "0";
  if (!enabled && !disabled) {
    ctx.writeLine(colors.failLine("用法：/patrol adopt-all on|off"));
    return;
  }
  if (config.autoAdoptAll === enabled) {
    ctx.writeLine(colors.gray(`接管全部 PR 已经是${enabled ? "开启" : "关闭"}状态`));
    return;
  }
  config.autoAdoptAll = enabled;
  savePatrolConfig(ctx.cwd, config);
  ctx.writeLine(
    colors.okLine(
      enabled
        ? "已开启：接管所有 PR 的审查（他人提交只审查、不自动合并；本人提交仍按原规则合并）。重启巡检后生效。"
        : "已关闭：只接管分支前缀 / 授权 label / 本人提交命中的 PR。重启巡检后生效。",
    ),
  );
}

async function runOnce(ctx: PatrolCommandContext): Promise<void> {
  const built = await buildService(ctx);
  if (!built) return;
  if (built.service.store.isPaused()) {
    ctx.writeLine(colors.warnLine("巡检处于暂停状态（/patrol resume 恢复）"));
    return;
  }
  const result = await built.service.drain();
  ctx.writeLine(colors.okLine(`本次巡检推进 ${result.processed} 步：`));
  for (const event of result.events) ctx.writeLine(colors.gray(`  · ${event}`));
  if (result.events.length === 0) ctx.writeLine(colors.gray("  （无事件）"));
  if (result.pendingExternal) {
    ctx.writeLine(colors.gray("  仍有任务在等外部状态（CI / 草稿转正 / head 变化）。"));
  }
}

/**
 * 令牌：显式传入 > GH_TOKEN > GITHUB_TOKEN > `gh auth token`。
 * 后者让「已经 gh auth login 过」的机器零配置启动巡检。
 */
export async function resolveToken(explicit?: string): Promise<string | undefined> {
  const fromEnv = explicit || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf8" });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function buildService(
  ctx: PatrolCommandContext,
  intervalMs?: number,
): Promise<{ service: PatrolService; repo: string } | null> {
  const repo = resolvePatrolRepo(ctx.cwd);
  if (!repo) {
    ctx.writeLine(
      colors.failLine(
        "无法确定巡检仓库：在 .haji/patrol/config.json 设置 repo（owner/name），或在该 git 仓库配置 origin 远端",
      ),
    );
    return null;
  }
  const token = await resolveToken(ctx.token);
  if (!token)
    ctx.writeLine(
      colors.warnLine(
        "未找到 GitHub 令牌（GH_TOKEN / gh auth login）：只能读公开仓库，评论与合并会失败。",
      ),
    );
  ctx.writeLine(colors.gray(`巡检仓库：${repo}${token ? "" : "（只读）"}`));
  const adapter = new GitHubPatrolAdapter({ repo, token });
  const runners = createHeadlessRunners({ repoDir: ctx.cwd });
  const service = new PatrolService({
    cwd: ctx.cwd,
    store: new PatrolStore(`${ctx.cwd}/.haji/patrol`),
    adapter,
    runners,
    config: intervalMs ? { pollIntervalMs: intervalMs } : undefined,
    logger: (line) => ctx.writeLine(colors.gray(`  · ${line}`)),
  });
  return { service, repo };
}
