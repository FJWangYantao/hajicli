import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { normalizeAbortError } from '@hajicli/core';

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
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
  const error = new Error(`网络连接在 ${timeoutMs}ms 内未建立`);
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
    const response = await undiciFetch(input, {
      ...init,
      signal: controller.signal,
      ...(proxy ? { dispatcher: proxy } : {})
    });
    return response as unknown as globalThis.Response;
  } catch (error) {
    clearRequestTimeout();
    throw error;
  }
}
