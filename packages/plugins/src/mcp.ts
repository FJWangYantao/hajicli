/**
 * MCP（Model Context Protocol）客户端：把外部 MCP server 的工具接入 haji。
 *
 * 传输实现 MVP 范围：stdio（newline-delimited JSON-RPC 2.0），这也是绝大多数
 * 本地 MCP server（npx/uvx 启动）使用的传输方式；HTTP/SSE 传输后续按需扩展。
 *
 * 安全模型：
 *   - server 配置只来自本地 .haji/config.json（用户显式写入），等价于用户手动信任
 *   - 未标记 readOnly 的 server，其工具按「修改型」参与权限审批（default/accept-edit 需人工确认）
 *   - 工具名统一加 mcp_<server>_ 前缀，避免与内置工具或其他 server 撞名
 *   - 工具失败输出以「错误:」开头，与 isFailedToolOutput 的判定保持一致，
 *     使经验系统能把 MCP 失败样本纳入观测与提炼
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { BaseTool, ToolDefinition, ToolExecutionContext, ToolMutationScope } from '@hajicli/core';

/** 单个 MCP server 的启动配置（.haji/config.json 的 mcpServers.<name>）。 */
export interface McpServerConfig {
  /** 启动命令，如 npx / uvx / node。 */
  command: string;
  /** 命令参数。 */
  args?: string[];
  /** 附加环境变量（合并在 process.env 之上）。 */
  env?: Record<string, string>;
  /** 默认 true；false 时不启动该 server。 */
  enabled?: boolean;
  /**
   * 标记该 server 的全部工具为只读（如 filesystem server 的纯读工具集）。
   * 只读工具在任何权限模式下自动放行；未标记的走人工审批。
   */
  readOnly?: boolean;
  /** 单次工具调用超时（毫秒），默认 120s。 */
  callTimeoutMs?: number;
}

/** server 运行状态，供 /mcp 命令展示。 */
export interface McpServerStatus {
  name: string;
  state: 'running' | 'failed' | 'disabled';
  /** running 时的工具数。 */
  toolCount: number;
  /** 工具名列表（含 mcp_ 前缀）。 */
  tools: string[];
  /** failed 时的错误描述。 */
  error?: string;
}

/** tools/list 返回的原始工具描述。 */
interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}
interface JsonRpcError {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

/** MCP initialize 握手时声明的协议版本。 */
const MCP_PROTOCOL_VERSION = '2025-06-18';
/** initialize 握手超时：npx/uvx 首次运行需要下载依赖，给足时间。 */
const INIT_TIMEOUT_MS = 20_000;
/** tools/list 超时。 */
const LIST_TIMEOUT_MS = 15_000;
/** tools/call 默认超时。 */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** stderr 只保留尾部用于诊断，避免长驻 server 的日志无限增长。 */
const STDERR_TAIL_LIMIT = 2000;

/** 工具名合法化：LLM function name 只允许 [a-zA-Z0-9_-]。 */
function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * 单个 MCP server 的 stdio JSON-RPC 连接。
 *
 * 每个请求带自增 id 与超时；server 崩溃时拒绝所有 pending 请求。
 * 生命周期由 McpManager 管理，失败即关闭，不做自动重连（重启 CLI 即可）。
 */
export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stdoutBuffer = '';
  private stderrTail = '';
  private closed = false;

  constructor(
    public readonly serverName: string,
    private readonly config: McpServerConfig
  ) {}

  /** spawn 子进程并完成 initialize 握手。失败时清理子进程并抛错。 */
  async connect(): Promise<void> {
    const proc = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      // Windows 下 npx/uvx 实为 .cmd，必须经 shell 解析；含空格参数手动加引号
      ...(process.platform === 'win32' ? { shell: true } : {})
    });
    this.proc = proc;

    proc.on('error', error => this.failAll(new Error(`无法启动 ${this.config.command}: ${error.message}`)));
    proc.on('exit', (code, signal) => {
      const detail = this.stderrTail ? `\nstderr 尾部:\n${this.stderrTail}` : '';
      this.failAll(new Error(`server 进程已退出（code=${code} signal=${signal}）${detail}`));
    });
    proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
    });

    try {
      const result = await this.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'hajicli', version: '1.0.0' }
        },
        INIT_TIMEOUT_MS
      ) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
      this.serverInfo = result?.serverInfo;
      // 握手完成通知（规范要求，无需响应）
      this.notify('notifications/initialized');
    } catch (error) {
      this.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** server 在 initialize 响应中报告的自身标识，诊断用。 */
  public serverInfo?: { name?: string; version?: string };

  /** 列出该 server 的全部工具（跟随 nextCursor 分页）。 */
  async listTools(): Promise<McpToolSpec[]> {
    const tools: McpToolSpec[] = [];
    let cursor: string | undefined;
    // 分页保护上限，异常 server 不至于死循环
    for (let page = 0; page < 32; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, LIST_TIMEOUT_MS) as {
        tools?: McpToolSpec[];
        nextCursor?: string;
      };
      for (const t of result?.tools || []) {
        if (t && typeof t.name === 'string' && t.name) tools.push(t);
      }
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  /** 调用一个工具，返回文本内容与 isError 标记。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = await this.request(
      'tools/call',
      { name, arguments: args },
      this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    ) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const texts: string[] = [];
    for (const item of result?.content || []) {
      if (item?.type === 'text' && typeof item.text === 'string') texts.push(item.text);
    }
    return {
      text: texts.length > 0 ? texts.join('\n') : '(server 未返回文本内容)',
      isError: Boolean(result?.isError)
    };
  }

  /** 关闭连接：杀掉子进程并拒绝所有 pending 请求。幂等。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('连接已关闭'));
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.killed) {
      try { proc.kill(); } catch { /* 尽力而为 */ }
    }
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message: JsonRpcSuccess | JsonRpcError;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行忽略（server 可能把日志打到 stdout）
      }
      const entry = this.pending.get(message.id);
      if (!entry) continue; // 通知或未知响应，忽略
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if ('error' in message) {
        entry.reject(new Error(message.error.message || `JSON-RPC 错误码 ${message.error.code}`));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed || !this.proc?.stdin) {
        reject(new Error('连接不可用'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.proc.stdin.write(payload, error => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`写入失败: ${error.message}`));
        }
      });
    });
  }

  private notify(method: string): void {
    if (this.closed || !this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * 把单个 MCP 工具包装为 haji 内部工具契约。
 * 工具名加 mcp_<server>_ 前缀；readOnly server 声明为无副作用，
 * 其余按 workspace 级修改对待，走权限审批。
 */
export class McpTool implements BaseTool {
  public readonly name: string;
  public readonly definition: ToolDefinition;

  constructor(
    private readonly client: McpClient,
    private readonly spec: McpToolSpec,
    private readonly readOnly: boolean
  ) {
    this.name = sanitizeToolName(`mcp_${client.serverName}_${spec.name}`);
    const desc = (spec.description || `MCP server "${client.serverName}" 提供的工具 ${spec.name}。`).replace(/\s+/g, ' ').slice(0, 1024);
    this.definition = {
      type: 'function',
      function: {
        name: this.name,
        description: `[mcp:${client.serverName}] ${desc}`,
        // MCP inputSchema 即 JSON Schema；server 缺省时兜底空对象 schema
        parameters: spec.inputSchema && typeof spec.inputSchema === 'object'
          ? spec.inputSchema
          : { type: 'object', properties: {} }
      }
    };
  }

  public getMutationScope(): ToolMutationScope {
    return this.readOnly ? 'none' : 'workspace';
  }

  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    if (context?.abortSignal?.aborted) return `[MCP 调用已中止] ${this.name}`;
    try {
      const { text, isError } = await this.client.callTool(this.spec.name, args);
      if (context?.abortSignal?.aborted) return `[MCP 调用已中止] ${this.name}`;
      return isError ? `错误: [${this.name}] ${text}` : text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `错误: [${this.name}] MCP 调用失败: ${message}`;
    }
  }
}

/**
 * 多 server 生命周期管理：并行启动、失败降级（一个 server 失败不影响其余）、
 * 聚合全部工具、统一退出清理。
 */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private statuses = new Map<string, McpServerStatus>();
  /** 各 server 的工具 spec，collectTools 据此构造 BaseTool 列表。 */
  private toolSpecs = new Map<string, Array<{ spec: McpToolSpec; readOnly: boolean; client: McpClient }>>();

  /** 并行连接全部启用的 server，返回成功挂载的工具列表（失败项记入状态）。 */
  async startAll(configs: Record<string, McpServerConfig>): Promise<BaseTool[]> {
    await Promise.all(Object.entries(configs).map(async ([name, config]) => {
      if (config.enabled === false) {
        this.statuses.set(name, { name, state: 'disabled', toolCount: 0, tools: [] });
        return;
      }
      const client = new McpClient(name, config);
      try {
        await client.connect();
        const specs = await client.listTools();
        this.clients.set(name, client);
        this.toolSpecs.set(name, specs.map(spec => ({ spec, readOnly: Boolean(config.readOnly), client })));
        this.statuses.set(name, {
          name,
          state: 'running',
          toolCount: specs.length,
          tools: specs.map(s => sanitizeToolName(`mcp_${name}_${s.name}`))
        });
      } catch (error) {
        client.close();
        this.statuses.set(name, {
          name,
          state: 'failed',
          toolCount: 0,
          tools: [],
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }));
    return this.collectTools();
  }

  /** 当前全部状态（含失败原因），供 /mcp 展示。 */
  public getServerStatuses(): McpServerStatus[] {
    return Array.from(this.statuses.values());
  }

  /** 构造全部 running server 的工具，跨 server 撞名时保留先注册者。 */
  private collectTools(): BaseTool[] {
    const tools: BaseTool[] = [];
    const seen = new Set<string>();
    for (const [, entries] of this.toolSpecs) {
      for (const { spec, readOnly, client } of entries) {
        const tool = new McpTool(client, spec, readOnly);
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  }

  /** 关闭全部连接。进程退出时调用。 */
  stopAll(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

/**
 * 从 .haji/config.json（用户级与项目级）读取 mcpServers 字段并合并，
 * 项目级覆盖用户级同名 server。文件不存在/损坏按空处理。
 */
export function readMcpServerConfigs(configPaths: string[]): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  for (const filePath of configPaths) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
      if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
        for (const [name, config] of Object.entries(parsed.mcpServers)) {
          if (config && typeof config === 'object' && typeof config.command === 'string' && config.command.trim()) {
            merged[name] = config;
          }
        }
      }
    } catch {
      // 文件不存在或非法 JSON：跳过该层
    }
  }
  return merged;
}
