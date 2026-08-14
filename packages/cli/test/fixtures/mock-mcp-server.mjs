/**
 * 测试用最小 MCP server：newline-delimited JSON-RPC over stdio。
 * 支持 initialize / tools/list / tools/call，供 mcp.test.mjs 验证客户端协议实现。
 */
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined || !message.method) continue;
    if (message.method === 'initialize') {
      send(message.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-server', version: '1.0.0' }
      });
    } else if (message.method === 'tools/list') {
      send(message.id, {
        tools: [
          {
            name: 'echo',
            description: 'Echo the input text',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
          },
          {
            name: 'fail-tool',
            description: 'Always returns an error result',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      });
    } else if (message.method === 'tools/call') {
      if (message.params?.name === 'fail-tool') {
        send(message.id, { content: [{ type: 'text', text: 'boom' }], isError: true });
      } else {
        send(message.id, { content: [{ type: 'text', text: `echo: ${message.params?.arguments?.text ?? ''}` }] });
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
