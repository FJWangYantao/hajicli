/**
 * /memory 与 /instinct 斜杠命令的实现。
 *
 * 这两个命令让用户能查看、确认、手工添加、删除经验系统积累的规则与记忆，
 * 而不必等会话结束的自动提炼。命令分发仍在 index.ts，本模块只负责业务逻辑。
 */
import { ExperienceStore, DistillEngine, Instinct, Memory } from '@hajicli/core';

export interface ExperienceCommandContext {
  store: ExperienceStore;
  /** 构造 DistillEngine 所需的 provider/model 闭包。 */
  provider: () => { complete: unknown } | null;
  model: () => string;
  /** 当前会话的待提炼观测（用于 /instinct distill）。 */
  pendingObservations: () => ReturnType<ExperienceStore['getPendingObservations']>;
  /** 提炼后的消息写入通道。 */
  writeLine: (line: string) => void;
  writeChat: (content: string) => void;
}

/** ANSI 颜色辅助（与 index.ts 的 colors 一致，由调用方注入）。 */
export interface ExperienceColors {
  purple: (s: string) => string;
  gray: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  bold: (s: string) => string;
}

/**
 * 处理 /memory 命令。返回 true 表示已处理（调用方应 continue）。
 *
 * 用法：
 *   /memory                  列出 active + staging
 *   /memory confirm <id>     确认 staging → active
 *   /memory add <type> <内容> 手工添加（type: user|project|feedback）
 *   /memory forget <id>      删除
 *   /memory reload           重读磁盘
 */
export async function handleMemoryCommand(
  args: string[],
  ctx: ExperienceCommandContext,
  colors: ExperienceColors
): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (sub === 'confirm') {
    const id = args[1];
    if (!id) { ctx.writeLine(colors.red('用法: /memory confirm <id>')); return; }
    const ok = await ctx.store.confirmMemory(id);
    ctx.writeLine(ok
      ? colors.green(`✓ 记忆 "${id}" 已确认并进入 active。`)
      : colors.red(`未找到 staging 中 id 为 "${id}" 的记忆。`));
    return;
  }

  if (sub === 'add') {
    const type = args[1]?.toLowerCase();
    const content = args.slice(2).join(' ').trim();
    if (!type || !content) {
      ctx.writeLine(colors.red('用法: /memory add <user|project|feedback> <内容>'));
      return;
    }
    if (!['user', 'project', 'feedback'].includes(type)) {
      ctx.writeLine(colors.red('类型必须是 user / project / feedback 之一。'));
      return;
    }
    const now = new Date().toISOString();
    const id = `manual-${Date.now()}`;
    const memory: Memory = {
      id,
      name: content.slice(0, 40),
      type: type as Memory['type'],
      content,
      status: 'active',
      confidence: 0.8,
      createdAt: now,
      updatedAt: now,
      keywords: Array.from(content.toLowerCase().match(/[a-z0-9]{2,}/g) || [])
    };
    await ctx.store.upsertMemory(memory);
    ctx.writeLine(colors.green(`✓ 已添加 ${type} 记忆 "${id}"。`));
    return;
  }

  if (sub === 'forget') {
    const id = args[1];
    if (!id) { ctx.writeLine(colors.red('用法: /memory forget <id>')); return; }
    const ok = await ctx.store.forgetMemory(id);
    ctx.writeLine(ok
      ? colors.green(`✓ 已删除记忆 "${id}"。`)
      : colors.red(`未找到 id 为 "${id}" 的记忆。`));
    return;
  }

  // 默认：列出所有
  const active = ctx.store.loadMemories('active');
  const staging = ctx.store.loadMemories('all').filter(m => m.status === 'staging');
  if (active.length === 0 && staging.length === 0) {
    ctx.writeLine(colors.gray('暂无记忆。可用：/memory add <type> <内容>，或等待自动提炼产生候选。'));
    return;
  }
  const lines: string[] = [colors.bold(`记忆（active ${active.length} · staging ${staging.length}）`)];
  if (active.length > 0) {
    lines.push(colors.gray('— active —'));
    for (const m of active) {
      lines.push(`  ${colors.purple(m.id.padEnd(28))} ${colors.gray(`[${m.type}]`)} ${m.content.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }
  if (staging.length > 0) {
    lines.push(colors.yellow(`— staging（待确认，/memory confirm <id>）—`));
    for (const m of staging) {
      lines.push(`  ${colors.yellow(m.id.padEnd(28))} ${colors.gray(`[${m.type}]`)} ${m.content.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }
  ctx.writeChat(lines.join('\n'));
}

/**
 * 处理 /instinct 命令。
 *
 * 用法：
 *   /instinct                列出所有规则（按 confidence 排序）
 *   /instinct distill        手动触发提炼（用当前 pending 观测）
 *   /instinct forget <id>    删除某条
 *   /instinct stats          统计
 */
export async function handleInstinctCommand(
  args: string[],
  ctx: ExperienceCommandContext,
  colors: ExperienceColors
): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (sub === 'distill') {
    const provider = ctx.provider();
    if (!provider) {
      ctx.writeLine(colors.red('当前无可用 provider，无法运行 LLM 提炼（统计路径仍可运行）。'));
    }
    const engine = new DistillEngine({
      store: ctx.store,
      provider: () => provider as never,
      model: ctx.model
    });
    const obs = ctx.pendingObservations();
    if (obs.length === 0) {
      ctx.writeLine(colors.gray('本会话暂无待提炼的观测样本。'));
      return;
    }
    ctx.writeLine(colors.gray(`正在提炼 ${obs.length} 条观测...`));
    const summary = await engine.runDistill(obs, {
      messages: [],
      cwd: process.cwd(),
      sessionId: 'manual'
    });
    const parts = [`统计 ${summary.statisticalInstincts}`, `LLM ${summary.llmInstincts}`, `强化 ${summary.reinforced}`];
    if (summary.memoryCandidates > 0) parts.push(`记忆候选 ${summary.memoryCandidates}`);
    ctx.writeLine(colors.green(`✓ 提炼完成：${parts.join(' / ')}${summary.llmTriggered ? '' : '（LLM 未触发）'}`));
    return;
  }

  if (sub === 'forget') {
    const id = args[1];
    if (!id) { ctx.writeLine(colors.red('用法: /instinct forget <id>')); return; }
    const ok = await ctx.store.forgetInstinct(id);
    ctx.writeLine(ok
      ? colors.green(`✓ 已删除规则 "${id}"。`)
      : colors.red(`未找到 id 为 "${id}" 的规则。`));
    return;
  }

  if (sub === 'stats') {
    const instincts = ctx.store.loadInstincts(true);
    const active = instincts.filter(i => !i.deprecated);
    const deprecated = instincts.filter(i => i.deprecated);
    const byDomain = new Map<string, number>();
    for (const i of active) byDomain.set(i.domain, (byDomain.get(i.domain) || 0) + 1);
    const lines: string[] = [
      colors.bold('经验系统统计'),
      `  规则总数：${active.length} active · ${deprecated.length} deprecated`,
      `  记忆数量：${ctx.store.loadMemories('active').length} active`,
      `  待提炼观测：${ctx.pendingObservations().length} 条`
    ];
    if (byDomain.size > 0) {
      lines.push(colors.gray('  — active 按领域 —'));
      for (const [domain, count] of Array.from(byDomain.entries()).sort((a, b) => b[1] - a[1])) {
        lines.push(`    ${domain.padEnd(20)} ${count}`);
      }
    }
    ctx.writeChat(lines.join('\n'));
    return;
  }

  // 默认：列出所有规则
  const instincts = ctx.store.loadInstincts(true)
    .sort((a, b) => b.confidence - a.confidence);
  if (instincts.length === 0) {
    ctx.writeLine(colors.gray('暂无规则。系统会在会话结束时自动提炼，或用 /instinct distill 手动触发。'));
    return;
  }
  const lines: string[] = [colors.bold(`规则（${instincts.length} 条，按置信度排序）`)];
  for (const i of instincts.slice(0, 30)) {
    const depTag = i.deprecated ? colors.yellow(' [deprecated]') : '';
    const conf = colors.gray(i.confidence.toFixed(2));
    lines.push(`  ${colors.purple(i.id.padEnd(28))} ${conf} ${colors.gray(`[${i.domain}/${i.source}]`)}${depTag}`);
    lines.push(colors.gray(`    ${i.action.replace(/\s+/g, ' ').slice(0, 90)}`));
  }
  if (instincts.length > 30) {
    lines.push(colors.gray(`  ...另有 ${instincts.length - 30} 条，使用 /instinct stats 查看统计。`));
  }
  ctx.writeChat(lines.join('\n'));
}
