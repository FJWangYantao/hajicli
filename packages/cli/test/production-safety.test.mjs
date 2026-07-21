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
  GrepSearchTool,
  ReadFileTool,
  WriteFileTool
} from '../../plugins/dist/index.js';

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
