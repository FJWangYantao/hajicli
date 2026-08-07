import fs from 'node:fs';
import path from 'node:path';
import {
  isReasoningEffort,
  MAX_SUBAGENT_INSTRUCTIONS_LENGTH,
  MAX_SUBAGENT_MAX_TOKENS,
  MAX_SUBAGENT_MAX_TOOL_CALLS,
  MIN_SUBAGENT_MAX_TOKENS,
  MIN_SUBAGENT_MAX_TOOL_CALLS,
  type ReasoningEffort,
  type SubagentRole
} from '@hajicli/core';
import type { ParsedSubagentCommand } from './agent-commands.js';

/**
 * Subagent 预设存储模块。
 *
 * 用户可以通过 /preset 命令或 /subagent 交互式流程保存一套
 * subagent 运行参数（模型、Provider、思考强度、token 预算、指令等），
 * 之后用 /subagent preset:<name> 或 /subagent --preset <name> 一键复用。
 *
 * 存储位置：<cwd>/.haji/subagent-presets.json（项目级，.gitignore 已忽略 .haji）。
 *
 * 安全设计：
 *   - 保存采用“临时文件 + rename”原子写入，避免写入中断留下损坏文件；
 *   - 加载时若发现文件损坏/结构非法，先重命名为 .bak 备份再按空列表处理，
 *     防止后续保存用空列表覆盖导致预设永久丢失；
 *   - 加载时逐字段清洗（枚举/类型/范围），脏值直接丢弃，不进入运行时。
 */

export interface SubagentPreset {
  /** 预设名称（唯一，大小写不敏感）。 */
  name: string;
  role?: SubagentRole;
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  instructions?: string;
  timeoutMs?: number;
  maxTokens?: number;
  maxToolCalls?: number;
}

const SUBAGENT_ROLES: readonly SubagentRole[] = ['research', 'review', 'implement'];

export function defaultSubagentPresetsPath(): string {
  return path.join(process.cwd(), '.haji', 'subagent-presets.json');
}

/** 清洗单个预设：name 非法返回 undefined；其余字段按类型/枚举/范围校验，非法字段丢弃。 */
function sanitizePreset(raw: Record<string, unknown>): SubagentPreset | undefined {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return undefined;
  const preset: SubagentPreset = { name };
  if (typeof raw.role === 'string' && SUBAGENT_ROLES.includes(raw.role as SubagentRole)) {
    preset.role = raw.role as SubagentRole;
  }
  if (typeof raw.model === 'string' && raw.model.trim()) preset.model = raw.model.trim();
  if (typeof raw.provider === 'string' && raw.provider.trim()) preset.provider = raw.provider.trim();
  if (typeof raw.reasoningEffort === 'string' && isReasoningEffort(raw.reasoningEffort)) {
    preset.reasoningEffort = raw.reasoningEffort;
  }
  if (typeof raw.instructions === 'string' && raw.instructions.trim()) {
    const instructions = raw.instructions.trim();
    if (instructions.length <= MAX_SUBAGENT_INSTRUCTIONS_LENGTH) preset.instructions = instructions;
  }
  if (typeof raw.timeoutMs === 'number' && Number.isInteger(raw.timeoutMs) && raw.timeoutMs >= 100 && raw.timeoutMs <= 3_600_000) {
    preset.timeoutMs = raw.timeoutMs;
  }
  if (typeof raw.maxTokens === 'number' && Number.isInteger(raw.maxTokens) && raw.maxTokens >= MIN_SUBAGENT_MAX_TOKENS && raw.maxTokens <= MAX_SUBAGENT_MAX_TOKENS) {
    preset.maxTokens = raw.maxTokens;
  }
  if (typeof raw.maxToolCalls === 'number' && Number.isInteger(raw.maxToolCalls) && raw.maxToolCalls >= MIN_SUBAGENT_MAX_TOOL_CALLS && raw.maxToolCalls <= MAX_SUBAGENT_MAX_TOOL_CALLS) {
    preset.maxToolCalls = raw.maxToolCalls;
  }
  return preset;
}

/** 损坏文件备份：重命名为 .bak，避免后续保存覆盖丢失数据。失败静默。 */
function backupCorruptedPresetFile(presetPath: string): void {
  try {
    fs.renameSync(presetPath, `${presetPath}.bak`);
  } catch {
    // 备份失败时保持现状（例如只读目录），调用方仍按空列表处理
  }
}

export function loadSubagentPresets(presetPath = defaultSubagentPresetsPath()): SubagentPreset[] {
  let raw: string;
  try {
    raw = fs.readFileSync(presetPath, 'utf8');
  } catch {
    // 文件不存在：正常空列表，无需备份
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { presets?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.presets)) {
      backupCorruptedPresetFile(presetPath);
      return [];
    }
    return parsed.presets
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map(item => sanitizePreset(item))
      .filter((item): item is SubagentPreset => Boolean(item));
  } catch {
    // JSON 解析失败：先备份损坏文件，再按空列表处理
    backupCorruptedPresetFile(presetPath);
    return [];
  }
}

export function saveSubagentPresets(presets: SubagentPreset[], presetPath = defaultSubagentPresetsPath()): boolean {
  const tempPath = `${presetPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(presetPath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify({ presets }, null, 2), 'utf8');
    fs.renameSync(tempPath, presetPath);
    return true;
  } catch {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // 忽略清理失败
    }
    return false;
  }
}

/** 按名称查找预设（大小写不敏感，name 防御性转换）。 */
export function findSubagentPreset(presets: SubagentPreset[], name: string): SubagentPreset | undefined {
  const lower = String(name ?? '').trim().toLowerCase();
  return presets.find(preset => String(preset.name ?? '').toLowerCase() === lower);
}

/**
 * 合并更新指定名称的预设：patch 中提供的字段（非 undefined）覆盖原值，
 * 未提供的字段（包括 name）保持不变。名称不存在时返回原列表。
 * patch 中的 undefined 值会被忽略，与 applySubagentPreset 的 ?? 语义保持一致。
 */
export function updateSubagentPreset(
  presets: SubagentPreset[],
  name: string,
  patch: Partial<Omit<SubagentPreset, 'name'>>
): SubagentPreset[] {
  const lower = String(name ?? '').trim().toLowerCase();
  const cleanPatch: Partial<Omit<SubagentPreset, 'name'>> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (cleanPatch as Record<string, unknown>)[key] = value;
    }
  }
  return presets.map(preset =>
    String(preset.name ?? '').toLowerCase() === lower
      ? { ...preset, ...cleanPatch, name: preset.name }
      : preset
  );
}

/**
 * 将预设合并进解析后的 subagent 命令。
 * 合并优先级：命令行显式参数 > 预设值；未显式指定且预设未提供时保持 undefined
 * （由调用方回退到主会话默认值）。
 */
export function applySubagentPreset(parsed: ParsedSubagentCommand, preset: SubagentPreset): ParsedSubagentCommand {
  return {
    ...parsed,
    role: parsed.role ?? preset.role,
    model: parsed.model ?? preset.model,
    provider: parsed.provider ?? preset.provider,
    reasoningEffort: parsed.reasoningEffort ?? preset.reasoningEffort,
    instructions: parsed.instructions ?? preset.instructions,
    timeoutMs: parsed.timeoutMs ?? preset.timeoutMs,
    maxTokens: parsed.maxTokens ?? preset.maxTokens,
    maxToolCalls: parsed.maxToolCalls ?? preset.maxToolCalls
  };
}
