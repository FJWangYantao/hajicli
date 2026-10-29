# 外部 Agent 调用 haji（`haji mcp-serve`）

`haji mcp-serve` 让外部 Agent 把 haji 当成一个可派活的编程助手：对方的模型通过 MCP 工具
`haji_send` / `haji_wait` / `haji_approve` 等派任务、跟进进度、回复授权。工具面与参数见
[README 的「驱动进程」一节](../README.md#驱动进程haji-mcp-serve)，这里只讲接入与调用顺序。

## 接入配置

任何支持 stdio MCP 服务的客户端都能接，本质只有一条启动命令：

```bash
haji mcp-serve --cwd /path/to/repo --approval ask
```

**Hermes**（`~/.hermes/config.yaml` 的 MCP 段；字段名以你所用 Hermes 版本的文档为准）：

```yaml
mcp_servers:
  haji:
    command: haji
    args: ["mcp-serve", "--cwd", "/path/to/repo", "--approval", "ask"]
    timeout: 120
```

**`mcpServers` JSON 风格的客户端**（Claude Desktop、Cursor 等）：

```json
{
  "mcpServers": {
    "haji": {
      "command": "haji",
      "args": ["mcp-serve", "--cwd", "/path/to/repo", "--approval", "ask"]
    }
  }
}
```

注意事项：

- API Key 走 haji 自己的配置（`~/.haji/config.json` 或 `DEEPSEEK_API_KEY` 等环境变量），客户端不用传。
  如果客户端会清空子进程环境，把需要的环境变量写进它的 `env` 字段。
- 客户端单次工具调用一般有超时（常见 60–120 秒）。`haji_send` 的 `waitMs`、`haji_wait` 的
  `timeoutMs` 要小于它，没跑完就返回 `running`，下次接着等，不会丢进度。
- `--approval auto` 适合无人值守：普通授权只放行本次，受保护目标、加工作区目录、临时提权一律拒绝。
  需要外部 Agent 自己判断时用默认的 `ask`。

## 调用顺序

```text
haji_status                      # 可选：看模型、权限档、是否有回合在跑
haji_adjust {permissionMode}     # 可选：切权限档 / 模型 / Plan
haji_send {text, waitMs}         # 派活；跑完直接返回结果，否则返回 running + taskId + lastSeq
loop:
  haji_wait {sinceSeq: cursor}   # 有工具结束 / 授权卡 / 回合结束就返回
  cursor = 返回的 lastSeq
  selection_request → haji_approve {requestId, value, reason?}
  turn_end（taskId 对上）→ 结束，text 是最终正文，ok 表示成功与否
```

要点：

- **游标从 `haji_send` 返回的 `lastSeq` 开始**。回合仍在跑时它停在本回合开始之前，
  早于回包就发出的授权卡也能等到；之后每次用 `haji_wait` 返回的 `lastSeq` 续上。
- **授权卡必须回**。`ask` 模式下 5 分钟没回复按拒绝处理（事件里的 `default` 就是兜底值）。
  `value` 必须是卡片 `items` 里的某个值，传错会返回 `accepted:false`，卡片继续挂着。
- **拒绝要给理由**：选 `deny-reason` 并带 `reason`，理由会原样回传给模型，它会换个做法；
  Plan 审批选 `no` 并带 `reason`，模型会在同一回合里按意见改计划，再次请求审批。
- `turn_end.ok` 为 `false` 表示模型请求失败或回合被中止，不代表任务没做完——结论看正文。
- 无人值守建议加硬上限：`haji mcp-serve --max-cost 5 --max-turns 40`。命中时 `turn_end` /
  回合结果带 `stopReason`（`max_cost` / `max_turns`）；费用上限按整个进程累计，超出后
  `haji_send` 直接拒绝，需要继续就重启服务。

## 最小客户端示例

[`mcp-serve-client.mjs`](mcp-serve-client.mjs) 用不到 150 行实现上面的循环，零依赖：

```bash
node examples/mcp-serve-client.mjs --mode default "给 utils.ts 的 parseDate 补单测"
```

```bash
node examples/mcp-serve-client.mjs --mode default --yes "跑一遍 pnpm test 并修掉失败用例"
```

```bash
node examples/mcp-serve-client.mjs --plan "把登录逻辑拆成独立模块"
```

- 默认对授权卡回「拒绝并说明」，加 `--yes` 改为「仅本次允许」；
- `--plan` 先进 Plan 档，计划出来后选「批准，逐步审批」；
- 进度打到 stderr，最终正文打到 stdout，退出码跟随 `turn_end.ok`。

授权策略在 `decide(card)` 里，接入自己的 Agent 时从这里改起。这个示例由
`packages/cli/test/mcp-serve-approval.test.mjs` 用假模型端到端跑过。
