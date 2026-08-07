import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { normalizeAbortError } from '@hajicli/core';

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
/** 模型请求默认总超时：reasoning 模型长生成时 60s 容易被掐断，放宽到 5 分钟。 */
const DEFAULT_MODEL_TIMEOUT_MS = 300_000;
/** 连接建立阶段超时：代理不在线 / 上游不可达时快速失败，避免干等总超时。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const MIN_HTTP_TIMEOUT_MS = 1_000;
const MAX_HTTP_TIMEOUT_MS = 600_000;

export interface ProxyConfiguration {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export interface NetworkPolicyOptions {
  timeoutMs?: number;
  useProxy?: boolean;
}

let cachedProxySignature = '';
let cachedProxyAgent: EnvHttpProxyAgent | undefined;

export function getHttpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.HAJI_HTTP_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= MIN_HTTP_TIMEOUT_MS && configured <= MAX_HTTP_TIMEOUT_MS
    ? configured
    : DEFAULT_HTTP_TIMEOUT_MS;
}

/**
 * 模型请求（chat/completions）的总超时：默认 300s，可通过 HAJI_MODEL_TIMEOUT_MS
 * 覆盖。reasoning 模型首块输出可能远超 60s，因此与通用网页请求分开设置。
 */
export function getModelTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.HAJI_MODEL_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= MIN_HTTP_TIMEOUT_MS && configured <= MAX_HTTP_TIMEOUT_MS
    ? configured
    : DEFAULT_MODEL_TIMEOUT_MS;
}

/** 连接建立阶段超时：默认 20s，可通过 HAJI_CONNECT_TIMEOUT_MS 覆盖。 */
export function getConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.HAJI_CONNECT_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= MIN_HTTP_TIMEOUT_MS && configured <= MAX_HTTP_TIMEOUT_MS
    ? configured
    : DEFAULT_CONNECT_TIMEOUT_MS;
}

export function getProxyConfiguration(env: NodeJS.ProcessEnv = process.env): ProxyConfiguration {
  const sharedProxy = env.HAJI_PROXY;
  const httpProxy = env.HAJI_HTTP_PROXY || sharedProxy || env.http_proxy || env.HTTP_PROXY;
  const httpsProxy = env.HAJI_HTTPS_PROXY || sharedProxy || env.https_proxy || env.HTTPS_PROXY;
  const noProxy = env.HAJI_NO_PROXY || env.no_proxy || env.NO_PROXY;
  return {
    enabled: Boolean(httpProxy || httpsProxy),
    httpProxy,
    httpsProxy,
    noProxy
  };
}

function getProxyAgent(config: ProxyConfiguration): EnvHttpProxyAgent | undefined {
  if (!config.enabled) return undefined;
  const signature = JSON.stringify(config);
  if (!cachedProxyAgent || cachedProxySignature !== signature) {
    cachedProxySignature = signature;
    cachedProxyAgent = new EnvHttpProxyAgent({
      httpProxy: config.httpProxy,
      httpsProxy: config.httpsProxy,
      noProxy: config.noProxy
    });
  }
  return cachedProxyAgent;
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`请求在 ${timeoutMs}ms 内未完成（连接建立或响应头超时）`);
  error.name = 'TimeoutError';
  return error;
}

/** Uses one abort controller so ESC remains effective after response headers arrive. */
function createRequestController(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  controller: AbortController;
  clearRequestTimeout: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => {
    const reason = parentSignal?.reason;
    controller.abort(reason instanceof Error && reason.name === 'TimeoutError'
      ? reason
      : normalizeAbortError(reason));
  };
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  const timeoutHandle = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
  timeoutHandle.unref?.();
  return {
    controller,
    clearRequestTimeout: () => clearTimeout(timeoutHandle)
  };
}

/**
 * Shared HTTP entrypoint with environment-proxy support and a configurable total request timeout.
 * The same signal remains active while a streaming response body is being consumed, so ESC stays immediate.
 */
export async function fetchWithNetworkPolicy(
  input: Parameters<typeof undiciFetch>[0],
  init: NonNullable<Parameters<typeof undiciFetch>[1]> = {},
  options: NetworkPolicyOptions = {}
): Promise<globalThis.Response> {
  const timeoutMs = options.timeoutMs ?? getHttpTimeoutMs();
  const { controller, clearRequestTimeout } = createRequestController(init.signal || undefined, timeoutMs);
  const proxy = options.useProxy === false ? undefined : getProxyAgent(getProxyConfiguration());

  try {
    // undici fetch 支持 connect 选项（连接阶段超时），但类型未暴露，用断言透传。
    const response = await undiciFetch(input, {
      ...init,
      signal: controller.signal,
      connect: { timeout: getConnectTimeoutMs() },
      ...(proxy ? { dispatcher: proxy } : {})
    } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as globalThis.Response;
  } catch (error) {
    clearRequestTimeout();
    if (!controller.signal.aborted) {
      throw decorateConnectionError(error);
    }
    throw error;
  }
}

/**
 * 连接阶段失败（TCP 拒绝 / DNS 失败 / 代理未运行等）时给出可操作的错误信息，
 * 而不是笼统的超时提示。仅当错误不是我们自己的总超时 abort 时应用。
 */
function decorateConnectionError(error: unknown): unknown {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  const code = cause && 'code' in cause
    ? String((cause as { code?: unknown }).code ?? '')
    : error instanceof Error && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (code.startsWith('ECONN')) {
    const wrapped = new Error(`无法连接目标服务（${code}）：请检查网络、代理（HAJI_PROXY）与目标地址是否可达`);
    wrapped.name = 'ConnectionError';
    return wrapped;
  }
  if (code.startsWith('ENOT')) {
    const wrapped = new Error(`无法解析目标域名（${code}）：请检查 DNS 与代理配置（HAJI_PROXY）`);
    wrapped.name = 'ConnectionError';
    return wrapped;
  }
  return error;
}
