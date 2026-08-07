import {
  MAX_SUBAGENT_MAX_TOKENS,
  MAX_SUBAGENT_MAX_TOOL_CALLS,
  MAX_SUBAGENT_INSTRUCTIONS_LENGTH,
  MIN_SUBAGENT_MAX_TOKENS,
  MIN_SUBAGENT_MAX_TOOL_CALLS,
  isReasoningEffort,
  ReasoningEffort,
  SubagentRole
} from '@hajicli/core';

export interface ParsedSubagentCommand {
  background: boolean;
  role?: SubagentRole;
  taskId?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  instructions?: string;
  timeoutMs?: number;
  maxTokens?: number;
  maxToolCalls?: number;
  /** 预设名称：--preset <name> 或 preset:<name> 前缀。 */
  preset?: string;
  description: string;
}

/** /preset add 子命令解析结果（name + 可选运行参数，全部可持久化）。 */
export interface ParsedPresetCommand {
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

function extractOption(source: string, name: string): { source: string; value?: string; error?: string } {
  const marker = `--${name}`;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index <= source.length - marker.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (source.slice(index, index + marker.length).toLowerCase() !== marker.toLowerCase()) continue;
    if (index > 0 && !/\s/.test(source[index - 1])) continue;
    const separator = source[index + marker.length];
    if (separator !== '=' && !/\s/.test(separator || '')) continue;

    let valueStart = index + marker.length + 1;
    if (separator !== '=') {
      while (/\s/.test(source[valueStart] || '')) valueStart += 1;
    }
    const valueQuote = source[valueStart] === '"' || source[valueStart] === "'"
      ? source[valueStart] as '"' | "'"
      : undefined;
    if (valueQuote) valueStart += 1;
    let valueEnd = valueStart;
    if (valueQuote) {
      while (valueEnd < source.length && source[valueEnd] !== valueQuote) valueEnd += 1;
      if (valueEnd >= source.length) {
        // 引号未闭合：整个选项作废并报错，避免静默吞掉剩余描述
        return { source, error: `--${name} 的引号未闭合` };
      }
    } else {
      while (valueEnd < source.length && !/\s/.test(source[valueEnd])) valueEnd += 1;
    }
    const value = source.slice(valueStart, valueEnd);
    const removalEnd = valueQuote && source[valueEnd] === valueQuote ? valueEnd + 1 : valueEnd;
    return {
      source: `${source.slice(0, index)} ${source.slice(removalEnd)}`.trim(),
      value
    };
  }
  return { source };
}

/** 提取选项并立即校验错误（引号未闭合等），失败抛出。 */
function extractOptionOrThrow(source: string, name: string): { source: string; value?: string } {
  const result = extractOption(source, name);
  if (result.error) throw new Error(result.error);
  return result;
}

/**
 * 引号感知地查找独立 `--` 终止符：其后的全部内容一律视为描述文本，
 * 不再解析任何选项（与 POSIX 约定一致）。找不到时 tail 为空。
 */
function splitAtDoubleDash(source: string): { head: string; tail: string } {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '-' && source[index + 1] === '-') {
      const before = index === 0 ? ' ' : source[index - 1];
      const after = index + 2 >= source.length ? ' ' : source[index + 2];
      if (/\s/.test(before) && /\s/.test(after)) {
        return { head: source.slice(0, index).trim(), tail: source.slice(index + 2).trim() };
      }
    }
  }
  return { head: source, tail: '' };
}

const DECIMAL_INTEGER = /^[+-]?\d+$/;

/** Parses the deterministic /subagent command and its optional resource limits. */
export function parseSubagentCommand(raw: string): ParsedSubagentCommand {
  // `--` 终止符：其后的全部内容视为描述文本，不再解析选项
  const { head, tail: descriptionSuffix } = splitAtDoubleDash(raw.trim());
  const source = head;
  const length = source.length;

  let background = false;
  let role: SubagentRole | undefined;
  let taskId: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let reasoningEffort: ReasoningEffort | undefined;
  let instructions: string | undefined;
  let timeoutMs: number | undefined;
  let maxTokens: number | undefined;
  let maxToolCalls: number | undefined;
  let preset: string | undefined;

  let cursor = 0;
  const skipSpaces = (): void => {
    while (cursor < length && /\s/.test(source[cursor])) cursor += 1;
  };
  /** 读取下一个 token（调用前应已跳过空白；调用后 cursor 位于 token 结尾或行尾）。 */
  const readToken = (): string => {
    const start = cursor;
    while (cursor < length && !/\s/.test(source[cursor])) cursor += 1;
    return source.slice(start, cursor);
  };
  /** 读取选项值：--opt value 或引号包裹值；行尾无值返回 undefined。 */
  const readOptionValue = (): string | undefined => {
    skipSpaces();
    if (cursor >= length) return undefined;
    const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor] : undefined;
    if (quote) {
      cursor += 1;
      const start = cursor;
      while (cursor < length && source[cursor] !== quote) cursor += 1;
      if (cursor >= length) throw new Error('选项值引号未闭合');
      const value = source.slice(start, cursor);
      cursor += 1;
      return value;
    }
    return readToken();
  };
  const ensureNonEmpty = (value: string | undefined, option: string): string => {
    const trimmed = (value ?? '').trim();
    if (!trimmed) throw new Error(`--${option} 不能为空`);
    return trimmed;
  };

  // 行首 preset: 前缀（语法：preset:<名称>，名称可引号包裹）
  if (/^preset:/i.test(source)) {
    const presetPrefix = source.match(/^preset:(?:"([^"]*)"|'([^']*)'|([^\s]+))/i);
    if (!presetPrefix) {
      throw new Error('preset: 名称不能为空（语法：preset:<名称>，如 preset:调研）');
    }
    preset = (presetPrefix[1] || presetPrefix[2] || presetPrefix[3] || '').trim();
    if (!preset) throw new Error('preset: 名称不能为空（语法：preset:<名称>，如 preset:调研）');
    cursor = presetPrefix[0].length;
  }

  // 顺序解析：选项/前缀只能出现在描述之前；遇到第一个非选项 token 即进入描述，
  // 其后内容（包括 --xxx 文本）原样保留，不会被误解析。
  let description: string | undefined;
  while (description === undefined) {
    skipSpaces();
    if (cursor >= length) break;
    const tokenStart = cursor;
    const token = readToken();
    const lower = token.toLowerCase();
    if (lower === 'bg' && !background) {
      background = true;
      continue;
    }
    if ((lower === 'research' || lower === 'review' || lower === 'implement') && !role) {
      role = lower;
      continue;
    }
    if (token.startsWith('--')) {
      const eqIndex = token.indexOf('=');
      const name = (eqIndex >= 0 ? token.slice(2, eqIndex) : token.slice(2)).toLowerCase();
      const value = eqIndex >= 0 ? token.slice(eqIndex + 1) : readOptionValue();
      if (value === undefined) {
        throw new Error(`--${name} 缺少值`);
      }
      switch (name) {
        case 'task': {
          taskId = ensureNonEmpty(value, 'task');
          break;
        }
        case 'preset': {
          const presetValue = ensureNonEmpty(value, 'preset');
          if (preset) throw new Error('不能同时使用 preset: 前缀与 --preset 选项');
          preset = presetValue;
          break;
        }
        case 'model': {
          model = ensureNonEmpty(value, 'model');
          break;
        }
        case 'provider': {
          provider = ensureNonEmpty(value, 'provider');
          break;
        }
        case 'effort': {
          const effortValue = ensureNonEmpty(value, 'effort').toLowerCase();
          if (!isReasoningEffort(effortValue)) {
            throw new Error('--effort 必须是 low、medium、high、xhigh 或 max');
          }
          reasoningEffort = effortValue;
          break;
        }
        case 'instructions': {
          const instructionsValue = ensureNonEmpty(value, 'instructions');
          if (instructionsValue.length > MAX_SUBAGENT_INSTRUCTIONS_LENGTH) {
            throw new Error(`--instructions 长度必须是 1 到 ${MAX_SUBAGENT_INSTRUCTIONS_LENGTH} 个字符`);
          }
          instructions = instructionsValue;
          break;
        }
        case 'timeout-ms': {
          timeoutMs = parseOptionalRange(value, 'timeout-ms', 100, 3_600_000);
          break;
        }
        case 'max-tokens': {
          maxTokens = parseOptionalRange(value, 'max-tokens', MIN_SUBAGENT_MAX_TOKENS, MAX_SUBAGENT_MAX_TOKENS);
          break;
        }
        case 'max-tool-calls': {
          maxToolCalls = parseOptionalRange(value, 'max-tool-calls', MIN_SUBAGENT_MAX_TOOL_CALLS, MAX_SUBAGENT_MAX_TOOL_CALLS);
          break;
        }
        default: {
          // 未知选项：视为描述开始，原样保留
          description = source.slice(tokenStart).trim();
          break;
        }
      }
      continue;
    }
    // 其他 token（bg/role 重复、普通文本、-foo 等）：视为描述开始
    description = source.slice(tokenStart).trim();
  }
  description = description ?? '';
  const fullDescription = [description, descriptionSuffix].filter(Boolean).join(' ');

  return {
    background,
    taskId,
    timeoutMs,
    maxTokens,
    maxToolCalls,
    description: fullDescription,
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(instructions ? { instructions } : {}),
    ...(preset ? { preset } : {})
  };
}

function parseOptionalRange(raw: string, name: string, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!DECIMAL_INTEGER.test(raw.trim())) {
    throw new Error(`--${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

/**
 * Parses `/preset add <name> [--role ...] [--model ...] [--provider ...] [--effort ...]
 * [--instructions "..."] [--timeout-ms N] [--max-tokens N] [--max-tool-calls N]`.
 * 预设名称是第一个 token（可带引号），其余选项均复用 subagent 的参数语法。
 */
export function parsePresetCommand(raw: string): ParsedPresetCommand {
  const trimmed = raw.trim();
  const nameMatch = trimmed.match(/^(?:"([^"]*)"|'([^']*)'|([^\s]+))/);
  if (!nameMatch || (!nameMatch[1] && !nameMatch[2] && !nameMatch[3])) {
    throw new Error('预设名称不能为空');
  }
  const name = (nameMatch[1] || nameMatch[2] || nameMatch[3] || '').trim();
  if (!name) throw new Error('预设名称不能为空');
  if (nameMatch[3] && nameMatch[3].startsWith('-')) {
    throw new Error('预设名称不能以 - 开头');
  }

  let remaining = trimmed.slice(nameMatch[0].length).trim();
  let role: SubagentRole | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let reasoningEffort: ReasoningEffort | undefined;
  let instructions: string | undefined;
  let timeoutMs: number | undefined;
  let maxTokens: number | undefined;
  let maxToolCalls: number | undefined;

  const roleOption = extractOptionOrThrow(remaining, 'role');
  remaining = roleOption.source;
  if (roleOption.value !== undefined) {
    const value = roleOption.value.trim().toLowerCase();
    if (!['research', 'review', 'implement'].includes(value)) {
      throw new Error('--role 必须是 research、review 或 implement');
    }
    role = value as SubagentRole;
  }

  const modelOption = extractOptionOrThrow(remaining, 'model');
  remaining = modelOption.source;
  if (modelOption.value !== undefined) {
    model = modelOption.value.trim();
    if (!model) throw new Error('--model 不能为空');
  }

  const providerOption = extractOptionOrThrow(remaining, 'provider');
  remaining = providerOption.source;
  if (providerOption.value !== undefined) {
    provider = providerOption.value.trim();
    if (!provider) throw new Error('--provider 不能为空');
  }

  const effortOption = extractOptionOrThrow(remaining, 'effort');
  remaining = effortOption.source;
  if (effortOption.value !== undefined) {
    const value = effortOption.value.trim().toLowerCase();
    if (!isReasoningEffort(value)) {
      throw new Error('--effort 必须是 low、medium、high、xhigh 或 max');
    }
    reasoningEffort = value;
  }

  const instructionsOption = extractOptionOrThrow(remaining, 'instructions');
  remaining = instructionsOption.source;
  if (instructionsOption.value !== undefined) {
    instructions = instructionsOption.value.trim();
    if (!instructions || instructions.length > MAX_SUBAGENT_INSTRUCTIONS_LENGTH) {
      throw new Error(`--instructions 长度必须是 1 到 ${MAX_SUBAGENT_INSTRUCTIONS_LENGTH} 个字符`);
    }
  }

  const timeoutOption = extractOptionOrThrow(remaining, 'timeout-ms');
  remaining = timeoutOption.source;
  timeoutMs = timeoutOption.value !== undefined ? parseOptionalRange(timeoutOption.value, 'timeout-ms', 100, 3_600_000) : undefined;

  const maxTokensOption = extractOptionOrThrow(remaining, 'max-tokens');
  remaining = maxTokensOption.source;
  maxTokens = maxTokensOption.value !== undefined
    ? parseOptionalRange(maxTokensOption.value, 'max-tokens', MIN_SUBAGENT_MAX_TOKENS, MAX_SUBAGENT_MAX_TOKENS)
    : undefined;

  const maxToolCallsOption = extractOptionOrThrow(remaining, 'max-tool-calls');
  remaining = maxToolCallsOption.source;
  maxToolCalls = maxToolCallsOption.value !== undefined
    ? parseOptionalRange(maxToolCallsOption.value, 'max-tool-calls', MIN_SUBAGENT_MAX_TOOL_CALLS, MAX_SUBAGENT_MAX_TOOL_CALLS)
    : undefined;

  if (remaining) {
    throw new Error(`无法识别的参数: ${remaining}`);
  }

  return {
    name,
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(instructions ? { instructions } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {})
  };
}

export function formatAgentTokens(totalTokens: number): string {
  if (totalTokens < 1000) return `${totalTokens}`;
  return `${(totalTokens / 1000).toFixed(totalTokens < 10000 ? 1 : 0)}k`;
}
