import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchWithNetworkPolicy } from '@hajicli/plugins';

/**
 * Provider 快速配置模块。
 *
 * 用户可以在 haji 会话内通过 /provider 指令读写本地配置文件，
 * 无需依赖环境变量。配置分两级：
 *   - 用户级：~/.haji/config.json       （API Key 跨项目共用）
 *   - 项目级：<cwd>/.haji/config.json   （baseUrl/模型等团队或项目设置）
 * 读取时两级合并，项目级覆盖用户级同名字段；写入默认落盘用户级，
 * 调用方可显式指定项目级。
 *
 * provider 名称支持内置（deepseek/volcengine）与用户自定义名称
 * （通过 /provider add 引导添加）。自定义 provider 同样存储在上述文件中。
 *
 * 注意：API Key 为明文存储。.gitignore 已忽略任意目录下的 .haji，
 * 因此该文件不会被提交到版本库；调用方应在保存成功后向用户提示这一安全事实。
 */

export type ProviderName = string;
export type ProviderConfigScope = 'user' | 'project';

export interface ProviderEntry {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 自定义 provider 的模型列表；内置 provider 也可通过 /provider set 补充。 */
  models?: string[];
}

export interface ProviderConfig {
  providers: Record<ProviderName, ProviderEntry>;
}

/** 内置 provider 名称，保持既有环境变量/模型注册表兼容。 */
export const PROVIDER_NAMES: readonly ProviderName[] = ['deepseek', 'volcengine'];

export function isBuiltinProvider(name: string): boolean {
  return PROVIDER_NAMES.includes(name);
}

/** 校验用户输入的 provider 名称；合法返回 null，否则返回错误描述。 */
export function validateProviderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'provider 名称不能为空';
  if (/\s/.test(trimmed)) return 'provider 名称不能包含空白字符';
  if (/[\\/:*?"<>|]/.test(trimmed)) return 'provider 名称不能包含路径/保留字符';
  if (trimmed.length > 32) return 'provider 名称过长（最多 32 个字符）';
  return null;
}

/**
 * 解析用户输入的模型列表：支持分号、逗号、中文分号分隔，自动去空白与去重。
 */
export function parseModelList(input: string): string[] {
  return [...new Set(input.split(/[;；,，]/).map(s => s.trim()).filter(Boolean))];
}

export function userProviderConfigPath(): string {
  return path.join(os.homedir(), '.haji', 'config.json');
}

export function projectProviderConfigPath(): string {
  return path.join(process.cwd(), '.haji', 'config.json');
}

export function providerConfigPath(scope: ProviderConfigScope): string {
  return scope === 'project' ? projectProviderConfigPath() : userProviderConfigPath();
}

function readConfigFile(filePath: string): ProviderConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ProviderConfig;
    if (!parsed || typeof parsed !== 'object' || !parsed.providers || typeof parsed.providers !== 'object') {
      return { providers: {} };
    }
    return { providers: parsed.providers };
  } catch {
    // 文件不存在、损坏或结构非法时一律按空配置处理
    return { providers: {} };
  }
}

/** 读取单一作用域的原始配置，不与另一层合并。 */
export function loadProviderConfigScope(scope: ProviderConfigScope): ProviderConfig {
  return readConfigFile(providerConfigPath(scope));
}

/**
 * 读取两级配置并合并：项目级覆盖用户级同 provider 同字段。
 * 始终包含内置 provider 条目；自定义名称按出现情况动态加入。
 */
export function loadProviderConfig(): ProviderConfig {
  const user = readConfigFile(userProviderConfigPath());
  const project = readConfigFile(projectProviderConfigPath());
  const names = new Set<string>([...PROVIDER_NAMES, ...Object.keys(user.providers), ...Object.keys(project.providers)]);
  const providers: Record<ProviderName, ProviderEntry> = {};
  for (const name of names) {
    providers[name] = { ...user.providers[name], ...project.providers[name] };
  }
  return { providers };
}

function writeConfig(config: ProviderConfig, scope: ProviderConfigScope): boolean {
  const filePath = providerConfigPath(scope);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
    // 尽量收紧文件权限；Windows 上可能无效，忽略失败
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // 忽略权限设置失败
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 合并更新指定 provider 的配置（保留未被本次传入的字段），
 * 默认写入用户级配置文件；空字符串字段会被清除，models 数组保留非空项。
 * 成功返回 true。
 */
export function saveProviderConfig(
  provider: ProviderName,
  entry: ProviderEntry,
  scope: ProviderConfigScope = 'user'
): boolean {
  const config = readConfigFile(providerConfigPath(scope));
  const merged: ProviderEntry = { ...config.providers[provider], ...entry };
  const cleaned: ProviderEntry = {};
  const out = cleaned as Record<string, unknown>;
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'models') {
      const items = (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
      if (items.length > 0) out.models = items;
    } else if (typeof value === 'string' && value.trim()) {
      out[key] = value;
    }
  }
  config.providers[provider] = cleaned;
  return writeConfig(config, scope);
}

/**
 * 删除指定 provider 在目标作用域中的全部条目。默认清除用户级配置。
 */
export function unsetProviderConfig(
  provider: ProviderName,
  scope: ProviderConfigScope = 'user'
): boolean {
  const config = readConfigFile(providerConfigPath(scope));
  delete config.providers[provider];
  return writeConfig(config, scope);
}

/**
 * 解析某个配置项的实际值，优先级：环境变量 > 配置文件 > fallback。
 * 调用方可传入预先加载的 config 以避免重复读盘。
 */
export function resolveProviderSetting(
  provider: ProviderName,
  key: 'apiKey' | 'baseUrl' | 'model',
  envValue: string | undefined,
  fallback: string | undefined,
  config: ProviderConfig = loadProviderConfig()
): string | undefined {
  return envValue || config.providers[provider]?.[key] || fallback;
}

export interface ProviderConnectionResult {
  ok: boolean;
  /** 请求耗时（毫秒）；失败时可能缺失。 */
  ms?: number;
  /** 失败时的错误描述。 */
  error?: string;
  /** 实际请求的完整 URL（用于诊断）。 */
  usedUrl?: string;
  /** Base URL 被自动修正时的人性化说明。 */
  normalizedNote?: string;
}

/**
 * 归一化用户输入的 Base URL，防止常见误填导致 404 或拼接错误：
 *   - 去掉首尾空白与 query/hash 片段；
 *   - 去掉重复的尾部斜杠；
 *   - 剥掉完整端点后缀 /chat/completions 或 /v1/chat/completions（含重复、大小写不敏感）；
 *   - 剥掉 Anthropic 风格后缀 /v1/messages，统一转成 OpenAI 兼容端点。
 * 返回归一化后的 URL 与是否需要提示用户的信息。
 */
export function normalizeBaseUrl(input: string): { url: string; note?: string } {
  const trimmed = input.trim();
  const notes: string[] = [];
  let url = trimmed;

  // 去掉 query / hash（用户可能从文档复制带参数的 URL）
  const qIndex = url.search(/[?#]/);
  if (qIndex >= 0) {
    const stripped = url.slice(0, qIndex);
    if (stripped !== url) notes.push('已去掉 URL 中的查询参数');
    url = stripped;
  }

  // 去掉全部尾部斜杠
  url = url.replace(/\/+$/, '');

  // 剥掉完整的 OpenAI 兼容端点后缀（含重复与大小写变体）
  const chatMatch = url.match(/(\/chat\/completions)+$/i);
  if (chatMatch) {
    url = url.slice(0, url.length - chatMatch[0].length);
    notes.push('已自动去掉末尾的 /chat/completions（Base URL 只需填服务根地址）');
  }

  // 剥掉 Anthropic 风格 /messages 后缀，转成 OpenAI 兼容请求
  const msgMatch = url.match(/(\/messages)+$/i);
  if (msgMatch) {
    url = url.slice(0, url.length - msgMatch[0].length);
    notes.push('已自动去掉末尾的 /messages（Anthropic 端点，按 OpenAI 兼容方式请求）');
  }

  // 剥掉后缀后可能残留斜杠
  url = url.replace(/\/+$/, '');

  return {
    url,
    ...(notes.length > 0 ? { note: notes.join('；') } : {})
  };
}

/**
 * 连通性测试：向 {baseUrl}/chat/completions 发送一个 max_tokens=1 的最小请求，
 * 验证 baseUrl + API Key + 模型三者是否有效。尊重 HAJI_PROXY 等网络策略。
 * Base URL 会自动归一化（见 normalizeBaseUrl），容错完整端点等误填。
 */
export async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs = 15_000
): Promise<ProviderConnectionResult> {
  const normalized = normalizeBaseUrl(baseUrl);
  const base = normalized.url;
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: `Base URL 无效：${baseUrl}`, ...(normalized.note ? { normalizedNote: normalized.note } : {}) };
  }
  const url = `${base}/chat/completions`;
  const startedAt = performance.now();
  try {
    const response = await fetchWithNetworkPolicy(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        })
      },
      { timeoutMs }
    );
    const ms = Math.round(performance.now() - startedAt);
    if (response.ok) {
      return { ok: true, ms, usedUrl: url, ...(normalized.note ? { normalizedNote: normalized.note } : {}) };
    }
    let errorMsg = `HTTP ${response.status}`;
    try {
      const data = (await response.json()) as { error?: { message?: string }; message?: string };
      errorMsg = data.error?.message || data.message || errorMsg;
    } catch {
      // 响应体非 JSON 时保留状态码描述
    }
    return { ok: false, ms, error: errorMsg, usedUrl: url, ...(normalized.note ? { normalizedNote: normalized.note } : {}) };
  } catch (error) {
    const ms = Math.round(performance.now() - startedAt);
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, ms, error: `请求超时（${timeoutMs}ms）`, ...(normalized.note ? { normalizedNote: normalized.note } : {}) };
    }
    return { ok: false, ms, error: error instanceof Error ? error.message : String(error), ...(normalized.note ? { normalizedNote: normalized.note } : {}) };
  }
}
