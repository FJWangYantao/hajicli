/**
 * /memory 与 /instinct 斜杠命令的实现。
 *
 * 这两个命令让用户能查看、确认、手工添加、删除经验系统积累的规则与记忆，
 * 而不必等会话结束的自动提炼。命令分发仍在 index.ts，本模块只负责业务逻辑。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DistillEngine, type ExperienceStore, type Memory } from "@hajicli/core";

export interface ExperienceCommandContext {
  store: ExperienceStore;
  /** 构造 DistillEngine 所需的 provider/model 闭包。 */
  provider: () => { complete: unknown } | null;
  model: () => string;
  /** 当前会话的待提炼观测（用于 /instinct distill）。 */
  pendingObservations: () => ReturnType<ExperienceStore["getPendingObservations"]>;
  /** 提炼后的消息写入通道。 */
  writeLine: (line: string) => void;
  writeChat: (content: string) => void;
  /**
   * 缺 id 时列出候选供选（由终端注入）。未注入时退回“用法”提示，
   * 便于测试与无头场景复用本模块而不依赖 TerminalUI。
   */
  pick?: (options: ExperiencePickOptions) => Promise<string | undefined>;
  /** 用户级 Skill 目录（/instinct skill 蒸馏目标），缺省 ~/.haji/skills；测试注入临时目录。 */
  userSkillsDir?: string;
}

/** 候选选择器的入参：与 TerminalUI.readSelection 的子集保持一致，避免直接耦合。 */
export interface ExperiencePickOptions {
  title: string;
  items: ReadonlyArray<{ value: string; label: string; description: string }>;
  selectedValue?: string;
}

/** 缺 id 时列出候选；未注入选择器或候选为空时返回 undefined，调用方回退用法提示。 */
async function pickCandidate(
  ctx: ExperienceCommandContext,
  title: string,
  items: Array<{ value: string; label: string; description: string }>,
): Promise<string | undefined> {
  if (!ctx.pick || items.length === 0) return undefined;
  return ctx.pick({ title, items, selectedValue: items[0]?.value });
}

/** 记忆候选：id + 类型作标签，内容作说明，便于直接辨认。 */
function memoryPickItems(memories: readonly Memory[]): Array<{
  value: string;
  label: string;
  description: string;
}> {
  return memories.map((memory) => ({
    value: memory.id,
    label: `${memory.id} [${memory.type}]`,
    description: memory.content.replace(/\s+/g, " ").slice(0, 80),
  }));
}

/** 规则候选：id + domain 作标签，触发条件与动作用来说明。 */
function instinctPickItems(
  instincts: ReturnType<ExperienceStore["loadInstincts"]>,
): Array<{ value: string; label: string; description: string }> {
  return instincts.map((instinct) => ({
    value: instinct.id,
    label: `${instinct.id} [${instinct.domain}]`,
    description: `${instinct.trigger} → ${instinct.action}`.replace(/\s+/g, " ").slice(0, 80),
  }));
}

/** ANSI 颜色辅助（与 index.ts 的 colors 一致，由调用方注入）。 */
export interface ExperienceColors {
  purple: (s: string) => string;
  gray: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  bold: (s: string) => string;
  /** 带状态图标的整行提示：只给图标着色（见 theme.ts 的 paint）。 */
  okLine: (s: string) => string;
  warnLine: (s: string) => string;
  failLine: (s: string) => string;
}

/** 作用域展示标签：用户级（跨项目）用强调色突出，项目级用灰色。 */
function scopeTag(scope: "user" | "project" | undefined, colors: ExperienceColors): string {
  return scope === "user" ? colors.purple("[用户级]") : colors.gray("[项目级]");
}

/**
 * 处理 /memory 命令。返回 true 表示已处理（调用方应 continue）。
 *
 * 用法：
 *   /memory                  列出 active + staging
 *   /memory confirm <id>     确认 staging -> active
 *   /memory add <type> <内容> 手工添加（type: user|project|feedback）
 *   /memory forget <id>      删除
 *   /memory promote <id>     提升到用户级（跨项目共用）
 *   /memory reload           重读磁盘
 */
export async function handleMemoryCommand(
  args: string[],
  ctx: ExperienceCommandContext,
  colors: ExperienceColors,
): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (sub === "confirm") {
    // 缺 id 时列出 staging 候选：待确认项通常不多，直接选比手抄 id 更快。
    const id =
      args[1] ??
      (await pickCandidate(
        ctx,
        "确认哪条记忆（staging → active）",
        memoryPickItems(ctx.store.loadMemories("all").filter((m) => m.status === "staging")),
      ));
    if (!id) {
      ctx.writeLine(colors.warnLine("用法: /memory confirm <id>"));
      return;
    }
    const result = await ctx.store.confirmMemory(id);
    if (result === "user") {
      ctx.writeLine(colors.okLine(`记忆 "${id}" 已确认并进入用户级 active（跨项目生效）。`));
    } else if (result === "project") {
      ctx.writeLine(colors.okLine(`记忆 "${id}" 已确认并进入 active。`));
    } else {
      ctx.writeLine(colors.failLine(`未找到 staging 中 id 为 "${id}" 的记忆。`));
    }
    return;
  }

  if (sub === "add") {
    const type = args[1]?.toLowerCase();
    const content = args.slice(2).join(" ").trim();
    if (!type || !content) {
      ctx.writeLine(colors.warnLine("用法: /memory add <user|project|feedback> <内容>"));
      return;
    }
    if (!["user", "project", "feedback"].includes(type)) {
      ctx.writeLine(colors.failLine("类型必须是 user / project / feedback 之一。"));
      return;
    }
    const now = new Date().toISOString();
    const id = `manual-${Date.now()}`;
    const memory: Memory = {
      id,
      name: content.slice(0, 40),
      type: type as Memory["type"],
      content,
      status: "active",
      confidence: 0.8,
      createdAt: now,
      updatedAt: now,
      keywords: Array.from(content.toLowerCase().match(/[a-z0-9]{2,}/g) || []),
    };
    await ctx.store.upsertMemory(memory);
    ctx.writeLine(
      colors.okLine(
        type === "user"
          ? `已添加 user 记忆 "${id}"（用户级，跨项目共用）。`
          : `已添加 ${type} 记忆 "${id}"（项目级）。`,
      ),
    );
    return;
  }

  if (sub === "forget") {
    const id =
      args[1] ??
      (await pickCandidate(ctx, "删除哪条记忆", memoryPickItems(ctx.store.loadMemories("all"))));
    if (!id) {
      ctx.writeLine(colors.warnLine("用法: /memory forget <id>"));
      return;
    }
    const ok = await ctx.store.forgetMemory(id);
    ctx.writeLine(
      ok ? colors.okLine(`已删除记忆 "${id}"。`) : colors.failLine(`未找到 id 为 "${id}" 的记忆。`),
    );
    return;
  }

  if (sub === "promote") {
    // 只有项目级能提升，候选里就先过滤掉用户级，避免选了才报错。
    const id =
      args[1] ??
      (await pickCandidate(
        ctx,
        "提升哪条记忆到用户级",
        memoryPickItems(ctx.store.loadMemories("all").filter((m) => m.scope !== "user")),
      ));
    if (!id) {
      ctx.writeLine(colors.warnLine("用法: /memory promote <id>"));
      return;
    }
    const result = await ctx.store.promoteMemory(id);
    if (result === "promoted") {
      ctx.writeLine(colors.okLine(`记忆 "${id}" 已提升到用户级（跨项目共用）。`));
    } else if (result === "already-user-level") {
      ctx.writeLine(colors.gray(`记忆 "${id}" 已在用户级，无需提升。`));
    } else {
      ctx.writeLine(colors.failLine(`未找到项目级 id 为 "${id}" 的记忆。`));
    }
    return;
  }

  // 默认：列出所有
  const active = ctx.store.loadMemories("active");
  const staging = ctx.store.loadMemories("all").filter((m) => m.status === "staging");
  if (active.length === 0 && staging.length === 0) {
    ctx.writeLine(
      colors.gray("暂无记忆。可用：/memory add <type> <内容>，或等待自动提炼产生候选。"),
    );
    return;
  }
  const lines: string[] = [
    colors.bold(`记忆（active ${active.length} · staging ${staging.length}）`),
  ];
  if (active.length > 0) {
    lines.push(colors.gray("— active —"));
    for (const m of active) {
      lines.push(
        `  ${colors.purple(m.id.padEnd(28))} ${colors.gray(`[${m.type}]`)} ${scopeTag(m.scope, colors)} ${m.content.replace(/\s+/g, " ").slice(0, 80)}`,
      );
    }
  }
  if (staging.length > 0) {
    lines.push(colors.gray(`— staging（待确认，/memory confirm <id>）—`));
    for (const m of staging) {
      lines.push(
        `  ${colors.purple(m.id.padEnd(28))} ${colors.gray(`[${m.type}]`)} ${scopeTag(m.scope, colors)} ${m.content.replace(/\s+/g, " ").slice(0, 80)}`,
      );
    }
  }
  ctx.writeChat(`${lines.join("\n")}\n`);
}

/**
 * 处理 /instinct 命令。
 *
 * 用法：
 *   /instinct                列出所有规则（按 confidence 排序）
 *   /instinct distill        手动触发提炼（用当前 pending 观测）
 *   /instinct forget <id>    删除某条
 *   /instinct promote <id>   提升到用户级（跨项目共用）
 *   /instinct skill [id]     查看可蒸馏规则 / 把规则生成为用户级 Skill 草稿
 *   /instinct stats          统计
 */
export async function handleInstinctCommand(
  args: string[],
  ctx: ExperienceCommandContext,
  colors: ExperienceColors,
): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (sub === "distill") {
    const provider = ctx.provider();
    if (!provider) {
      ctx.writeLine(
        colors.failLine("当前无可用 provider，无法运行 LLM 提炼（统计路径仍可运行）。"),
      );
    }
    const engine = new DistillEngine({
      store: ctx.store,
      provider: () => provider as never,
      model: ctx.model,
    });
    const obs = ctx.pendingObservations();
    if (obs.length === 0) {
      ctx.writeLine(colors.gray("本会话暂无待提炼的观测样本。"));
      return;
    }
    ctx.writeLine(colors.gray(`正在提炼 ${obs.length} 条观测...`));
    const summary = await engine.runDistill(obs, {
      messages: [],
      cwd: process.cwd(),
      sessionId: "manual",
    });
    const parts = [
      `统计 ${summary.statisticalInstincts}`,
      `LLM ${summary.llmInstincts}`,
      `强化 ${summary.reinforced}`,
    ];
    if (summary.memoryCandidates > 0) parts.push(`记忆候选 ${summary.memoryCandidates}`);
    ctx.writeLine(
      colors.okLine(
        `提炼完成：${parts.join(" / ")}${summary.llmTriggered ? "" : "（LLM 未触发）"}`,
      ),
    );
    return;
  }

  if (sub === "forget") {
    const id =
      args[1] ??
      (await pickCandidate(ctx, "删除哪条规则", instinctPickItems(ctx.store.loadInstincts(true))));
    if (!id) {
      ctx.writeLine(colors.warnLine("用法: /instinct forget <id>"));
      return;
    }
    const ok = await ctx.store.forgetInstinct(id);
    ctx.writeLine(
      ok ? colors.okLine(`已删除规则 "${id}"。`) : colors.failLine(`未找到 id 为 "${id}" 的规则。`),
    );
    return;
  }

  if (sub === "promote") {
    const id =
      args[1] ??
      (await pickCandidate(
        ctx,
        "提升哪条规则到用户级",
        // 只有项目级规则可提升，先按 scope 过滤候选。
        instinctPickItems(ctx.store.loadInstincts(true).filter((item) => item.scope !== "user")),
      ));
    if (!id) {
      ctx.writeLine(colors.warnLine("用法: /instinct promote <id>"));
      return;
    }
    const result = await ctx.store.promoteInstinct(id);
    if (result === "promoted") {
      ctx.writeLine(colors.okLine(`规则 "${id}" 已提升到用户级（跨项目共用）。`));
    } else if (result === "already-user-level") {
      ctx.writeLine(colors.gray(`规则 "${id}" 已在用户级，无需提升。`));
    } else {
      ctx.writeLine(colors.failLine(`未找到项目级 id 为 "${id}" 的规则。`));
    }
    return;
  }

  if (sub === "skill") {
    await handleInstinctSkillCommand(args.slice(1), ctx, colors);
    return;
  }

  if (sub === "stats") {
    const instincts = ctx.store.loadInstincts(true);
    const active = instincts.filter((i) => !i.deprecated);
    const deprecated = instincts.filter((i) => i.deprecated);
    const memories = ctx.store.loadMemories("active");
    const byDomain = new Map<string, number>();
    for (const i of active) byDomain.set(i.domain, (byDomain.get(i.domain) || 0) + 1);
    const countByScope = (items: Array<{ scope?: "user" | "project" }>) => ({
      user: items.filter((x) => x.scope === "user").length,
      project: items.filter((x) => x.scope !== "user").length,
    });
    const instScope = countByScope(active);
    const memScope = countByScope(memories);
    const obsStats = await ctx.store.getObservationStats();
    const lines: string[] = [
      colors.bold("经验系统统计"),
      `  规则总数：${active.length} active · ${deprecated.length} deprecated（用户级 ${instScope.user} / 项目级 ${instScope.project}）`,
      `  记忆数量：${memories.length} active（用户级 ${memScope.user} / 项目级 ${memScope.project}）`,
      `  待提炼观测：${ctx.pendingObservations().length} 条`,
    ];
    if (obsStats.total > 0) {
      const pct = (obsStats.failureRate * 100).toFixed(1);
      lines.push(
        `  观测健康（近 ${obsStats.windowDays} 天）：${obsStats.total} 次 · 失败 ${obsStats.failed} 次（${pct}%）`,
      );
      if (obsStats.byTool.length > 0) {
        const top = obsStats.byTool.map((t) => `${t.tool} ${t.failed}/${t.total}`).join(" · ");
        lines.push(`  失败集中：${top}`);
      }
      if (obsStats.weeklyTrend) {
        const r = (obsStats.weeklyTrend.recent * 100).toFixed(1);
        const p = (obsStats.weeklyTrend.previous * 100).toFixed(1);
        const dir =
          obsStats.weeklyTrend.recent < obsStats.weeklyTrend.previous
            ? "下降"
            : obsStats.weeklyTrend.recent > obsStats.weeklyTrend.previous
              ? "上升"
              : "持平";
        lines.push(`  失败率趋势：近 7 天 ${r}% vs 前 7 天 ${p}%（${dir}）`);
      }
    } else {
      lines.push(`  观测健康：暂无近 30 天观测数据`);
    }
    if (byDomain.size > 0) {
      lines.push(colors.gray("  — active 按领域 —"));
      for (const [domain, count] of Array.from(byDomain.entries()).sort((a, b) => b[1] - a[1])) {
        lines.push(`    ${domain.padEnd(20)} ${count}`);
      }
    }
    ctx.writeChat(`${lines.join("\n")}\n`);
    return;
  }

  // 默认：列出所有规则
  const instincts = ctx.store.loadInstincts(true).sort((a, b) => b.confidence - a.confidence);
  if (instincts.length === 0) {
    ctx.writeLine(
      colors.gray("暂无规则。系统会在会话结束时自动提炼，或用 /instinct distill 手动触发。"),
    );
    return;
  }
  const lines: string[] = [colors.bold(`规则（${instincts.length} 条，按置信度排序）`)];
  for (const i of instincts.slice(0, 30)) {
    const depTag = i.deprecated ? colors.yellow(" [deprecated]") : "";
    const conf = colors.gray(i.confidence.toFixed(2));
    lines.push(
      `  ${colors.purple(i.id.padEnd(28))} ${conf} ${colors.gray(`[${i.domain}/${i.source}]`)} ${scopeTag(i.scope, colors)}${depTag}`,
    );
    lines.push(colors.gray(`    ${i.action.replace(/\s+/g, " ").slice(0, 90)}`));
  }
  if (instincts.length > 30) {
    lines.push(
      colors.gray(`  ...另有 ${instincts.length - 30} 条，使用 /instinct stats 查看统计。`),
    );
  }
  ctx.writeChat(`${lines.join("\n")}\n`);
}

/** 可蒸馏为 Skill 的最低门槛：规则已被反复验证，才值得固化成可复用工作流。 */
const DISTILL_SKILL_MIN_CONFIDENCE = 0.8;
const DISTILL_SKILL_MIN_OCCURRENCES = 3;

/**
 * /instinct skill 子命令：无参数列出可蒸馏候选；带 id 把规则蒸馏为用户级 Skill 草稿。
 *
 * 蒸馏是模板化的确定性生成（trigger → when_to_use，action → 执行要点），
 * 不调 LLM；生成物落在用户级 skills 目录，经 /skills reload 生效。
 * 目标目录已存在同名 Skill 时拒绝覆盖。
 */
async function handleInstinctSkillCommand(
  args: string[],
  ctx: ExperienceCommandContext,
  colors: ExperienceColors,
): Promise<void> {
  const id = args[0];
  const userSkillsDir = ctx.userSkillsDir ?? path.join(os.homedir(), ".haji", "skills");

  if (!id) {
    const candidates = ctx.store
      .loadInstincts()
      .filter(
        (i) =>
          !i.deprecated &&
          i.confidence >= DISTILL_SKILL_MIN_CONFIDENCE &&
          i.occurrenceCount >= DISTILL_SKILL_MIN_OCCURRENCES,
      )
      .sort((a, b) => b.confidence - a.confidence || b.occurrenceCount - a.occurrenceCount);
    if (candidates.length === 0) {
      ctx.writeLine(
        colors.gray(
          `暂无可蒸馏规则（需 confidence ≥ ${DISTILL_SKILL_MIN_CONFIDENCE} 且观测 ≥ ${DISTILL_SKILL_MIN_OCCURRENCES} 次）。`,
        ),
      );
      return;
    }
    const lines: string[] = [colors.bold(`可蒸馏为 Skill 的规则（${candidates.length}）`)];
    for (const i of candidates) {
      const conf = colors.gray(`conf ${i.confidence.toFixed(2)} · ${i.occurrenceCount} 次`);
      lines.push(`  ${colors.purple(i.id.padEnd(28))} ${conf} ${scopeTag(i.scope, colors)}`);
      lines.push(colors.gray(`    ${i.action.replace(/\s+/g, " ").slice(0, 90)}`));
    }
    lines.push(colors.gray("使用 /instinct skill <id> 生成用户级 Skill 草稿。"));
    ctx.writeChat(`${lines.join("\n")}\n`);
    return;
  }

  const instinct = ctx.store.loadInstincts(true).find((i) => i.id === id);
  if (!instinct) {
    ctx.writeLine(colors.failLine(`未找到 id 为 "${id}" 的规则。`));
    return;
  }

  // Skill name 仅允许小写字母/数字/-/_（1-64），从规则 id 派生并合法化
  const skillName =
    instinct.id
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "-")
      .replace(/^[-_]+/, "")
      .slice(0, 64) || "distilled-skill";
  const skillDir = path.join(userSkillsDir, skillName);
  const manifestPath = path.join(skillDir, "SKILL.md");
  if (fs.existsSync(manifestPath)) {
    ctx.writeLine(
      colors.failLine(
        `用户级 Skill "${skillName}" 已存在，已拒绝覆盖。如需重新生成，请先删除 ${skillDir}。`,
      ),
    );
    return;
  }

  const trigger = instinct.trigger.replace(/\s+/g, " ").trim();
  const action = instinct.action.replace(/\s+/g, " ").trim();
  // frontmatter 值经 JSON.stringify 转义（JSON 字符串是合法 YAML flow scalar），防冒号/引号破坏解析
  const content = [
    "---",
    `name: ${skillName}`,
    `description: ${JSON.stringify(action.slice(0, 120))}`,
    `when_to_use: ${JSON.stringify(trigger.slice(0, 160))}`,
    "user_invocable: true",
    "---",
    "",
    `# ${action.slice(0, 60) || skillName}`,
    "",
    `> 由经验系统蒸馏生成（confidence ${instinct.confidence.toFixed(2)}，观测 ${instinct.occurrenceCount} 次）。请结合实际使用修订完善。`,
    "",
    "## 触发场景",
    "",
    trigger,
    "",
    "## 执行要点",
    "",
    action,
    "",
    "## 来源",
    "",
    `- 源规则：${instinct.id}（${instinct.domain}/${instinct.source}，confidence ${instinct.confidence.toFixed(2)}，观测 ${instinct.occurrenceCount} 次）`,
    `- 生成时间：${new Date().toISOString()}`,
    "",
  ].join("\n");

  await fsp.mkdir(skillDir, { recursive: true });
  await fsp.writeFile(manifestPath, content, "utf8");
  ctx.writeLine(colors.okLine(`已生成用户级 Skill 草稿 "${skillName}"：${manifestPath}`));
  ctx.writeLine(
    colors.gray(
      `执行 /skills reload 重新扫描后生效；原规则保留，如不再需要可用 /instinct forget ${instinct.id} 移除。`,
    ),
  );
}
