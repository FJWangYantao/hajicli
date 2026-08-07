import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fetchWithNetworkPolicy,
  getHttpTimeoutMs,
  getProxyConfiguration,
  DeepSeekProvider,
  GrepSearchTool,
  ReadFileTool,
  VolcengineProvider,
  WriteFileTool
} from '../../plugins/dist/index.js';

async function consumeStream(stream) {
  let content = '';
  for await (const chunk of stream) content += chunk;
  return content;
}

test('providers reject malformed historical tool arguments before any network request', async () => {
  const messages = [{
    role: 'assistant',
    content: 'writing',
    tool_calls: [{
      id: 'broken-write',
      type: 'function',
      function: { name: 'write', arguments: '{"content":"truncated' }
    }]
  }];
  const providers = [
    new VolcengineProvider({ apiKey: 'test', baseUrl: 'http://127.0.0.1:1', defaultModel: 'test' }),
    new DeepSeekProvider({ apiKey: 'test', baseUrl: 'http://127.0.0.1:1', defaultModel: 'test' })
  ];

  for (const provider of providers) {
    let requestStarts = 0;
    await assert.rejects(
      consumeStream(provider.completeStream(messages, { onRequestStart: () => { requestStarts += 1; } })),
      /本地拒绝发送损坏的历史工具调用/
    );
    assert.equal(requestStarts, 0, '本地校验失败时请求尚未发出');
  }
});

test('thinking providers preserve reasoning_content for synthetic and resumed tool calls', async () => {
  const payloads = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const proxyKeys = [
    'HAJI_PROXY',
    'HAJI_HTTP_PROXY',
    'HAJI_HTTPS_PROXY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy'
  ];
  const previousProxyValues = new Map(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];

  const syntheticHistory = [
    { role: 'user', content: 'load review skill' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'manual-skill-test',
        type: 'function',
        function: { name: 'loadskill', arguments: '{"name":"review"}' }
      }]
    },
    { role: 'tool', tool_call_id: 'manual-skill-test', content: 'loaded' }
  ];

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const providers = [
      new DeepSeekProvider({ apiKey: 'test', baseUrl, defaultModel: 'test' }),
      new VolcengineProvider({ apiKey: 'test', baseUrl, defaultModel: 'test' })
    ];
    for (const provider of providers) {
      assert.equal(await provider.complete(syntheticHistory, { thinking: true }), 'ok');
    }

    assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      assert.equal(payload.thinking.type, 'enabled');
      assert.equal(payload.messages[1].reasoning_content, '');
      assert.equal(
        Object.prototype.hasOwnProperty.call(payload.messages[1], 'reasoning_content'),
        true
      );
    }
  } finally {
    for (const [key, value] of previousProxyValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

test('OpenAI-compatible providers share split SSE parsing for text, reasoning, tools and usage', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const payload = [
      'data: {"choices":[{"delta":{"reasoning_content":"think","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{\\\"path\\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"content":"par","tool_calls":[{"index":0,"function":{"arguments":"\\\"a.txt\\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{"content":"tial"},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n');
    response.write(payload.slice(0, 17));
    response.write(payload.slice(17, 83));
    response.end(payload.slice(83));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previousProxy = process.env.HAJI_PROXY;
  const previousHttpProxy = process.env.HAJI_HTTP_PROXY;
  const previousHttpsProxy = process.env.HAJI_HTTPS_PROXY;
  delete process.env.HAJI_PROXY;
  delete process.env.HAJI_HTTP_PROXY;
  delete process.env.HAJI_HTTPS_PROXY;

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const providers = [
      new DeepSeekProvider({ apiKey: 'test', baseUrl, defaultModel: 'test' }),
      new VolcengineProvider({ apiKey: 'test', baseUrl, defaultModel: 'test' })
    ];
    for (const provider of providers) {
      let requestStarts = 0;
      let finishReason;
      let reasoning = '';
      let toolCalls;
      let usage;
      const content = await consumeStream(provider.completeStream(
        [{ role: 'user', content: 'test' }],
        {
          onRequestStart: () => { requestStarts += 1; },
          onFinish: finish => { finishReason = finish.reason; },
          onReasoning: delta => { reasoning += delta; },
          onToolCall: calls => { toolCalls = calls; },
          onUsage: value => { usage = value; }
        }
      ));
      assert.equal(requestStarts, 1, '每次真实网络调用只触发一次请求边界');
      assert.equal(content, 'partial');
      assert.equal(reasoning, 'think');
      assert.equal(finishReason, 'length');
      assert.deepEqual(toolCalls, [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"a.txt"}' }
      }]);
      assert.deepEqual(usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    }
  } finally {
    if (previousProxy === undefined) delete process.env.HAJI_PROXY;
    else process.env.HAJI_PROXY = previousProxy;
    if (previousHttpProxy === undefined) delete process.env.HAJI_HTTP_PROXY;
    else process.env.HAJI_HTTP_PROXY = previousHttpProxy;
    if (previousHttpsProxy === undefined) delete process.env.HAJI_HTTPS_PROXY;
    else process.env.HAJI_HTTPS_PROXY = previousHttpsProxy;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

test('file tools reject paths outside the current workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'haji-boundary-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside.txt');
  await fs.mkdir(workspace);
  await fs.writeFile(outside, 'secret\n');
  const originalCwd = process.cwd();

  try {
    process.chdir(workspace);
    const read = await new ReadFileTool().execute({ path: outside });
    const write = await new WriteFileTool().execute({ path: outside, content: 'changed\n' });
    const grep = await new GrepSearchTool().execute({ query: 'secret', path: root });
    assert.match(read, /路径越出当前工作区/);
    assert.match(write, /路径越出当前工作区/);
    assert.match(grep, /路径越出当前工作区/);
    assert.equal(await fs.readFile(outside, 'utf8'), 'secret\n');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('file tools do not expose resolved host paths in filesystem errors', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haji-path-redaction-'));
  const originalCwd = process.cwd();

  try {
    process.chdir(workspace);
    const results = [
      await new ReadFileTool().execute({ path: 'missing.txt' }),
      await new GrepSearchTool().execute({ query: 'needle', path: 'missing-dir' })
    ];
    for (const result of results) {
      assert.match(result, /missing/);
      assert.equal(result.includes(workspace), false);
    }
  } finally {
    process.chdir(originalCwd);
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('selector transitions cancel background input and preserve its draft', async () => {
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const readSelectionSafely = async/);
  assert.match(source, /const draft = ui\.cancelInput\(\)/);
  assert.match(source, /pendingInputs\.push\(draft\)/);
  assert.doesNotMatch(source, /await ui\.readSelection\(/);
  assert.match(source, /shouldRestartBackgroundInput\(trimmed\)/);
  assert.match(source, /ui\.readInput\(\{ slashCommands, initialValue: draft \}\)/);
});

test('network policy reads dedicated and standard proxy variables deterministically', () => {
  assert.deepEqual(getProxyConfiguration({
    HAJI_PROXY: 'http://127.0.0.1:7890',
    HAJI_NO_PROXY: 'localhost'
  }), {
    enabled: true,
    httpProxy: 'http://127.0.0.1:7890',
    httpsProxy: 'http://127.0.0.1:7890',
    noProxy: 'localhost'
  });
  assert.equal(getHttpTimeoutMs({ HAJI_HTTP_TIMEOUT_MS: '1500' }), 1500);
  assert.equal(getHttpTimeoutMs({ HAJI_HTTP_TIMEOUT_MS: 'invalid' }), 60_000);
});

test('network policy sends HTTP requests through HAJI_PROXY', async () => {
  let proxyObserved = false;
  const sockets = new Set();
  const target = http.createServer((_request, response) => response.end('target reached'));
  target.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === 'object');

  const proxy = http.createServer((request, response) => {
    proxyObserved = true;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('proxied');
  });
  proxy.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('connect', (request, clientSocket, head) => {
    proxyObserved = true;
    const [host, portText] = (request.url || '').split(':');
    const upstream = net.connect(Number(portText), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === 'object');
  const previous = process.env.HAJI_PROXY;
  const previousNoProxy = process.env.HAJI_NO_PROXY;
  process.env.HAJI_PROXY = `http://127.0.0.1:${address.port}`;
  process.env.HAJI_NO_PROXY = 'not-a-match.invalid';

  try {
    const response = await fetchWithNetworkPolicy(`http://127.0.0.1:${targetAddress.port}/probe`, {}, { timeoutMs: 2000 });
    assert.ok(['proxied', 'target reached'].includes(await response.text()));
    assert.equal(proxyObserved, true);
  } finally {
    if (previous === undefined) delete process.env.HAJI_PROXY;
    else process.env.HAJI_PROXY = previous;
    if (previousNoProxy === undefined) delete process.env.HAJI_NO_PROXY;
    else process.env.HAJI_NO_PROXY = previousNoProxy;
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections?.();
    await new Promise(resolve => proxy.close(resolve));
    target.closeAllConnections?.();
    await new Promise(resolve => target.close(resolve));
  }
});

test('network policy aborts a connection that does not return headers', async () => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    await assert.rejects(
      fetchWithNetworkPolicy(`http://127.0.0.1:${address.port}`, {}, { timeoutMs: 50, useProxy: false }),
      error => error instanceof Error && error.name === 'TimeoutError'
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

test('network policy timeout remains active while reading a stalled body', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.flushHeaders();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const response = await fetchWithNetworkPolicy(
      `http://127.0.0.1:${address.port}`,
      {},
      { timeoutMs: 50, useProxy: false }
    );
    await assert.rejects(
      response.text(),
      error => error instanceof Error && error.name === 'TimeoutError'
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
