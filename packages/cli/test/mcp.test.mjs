import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { McpManager, readMcpServerConfigs } from '@hajicli/plugins';
import { PermissionEngine } from '@hajicli/core';

const MOCK_SERVER = path.join(import.meta.dirname, 'fixtures', 'mock-mcp-server.mjs');

function mockServerConfig(overrides = {}) {
  return { command: process.execPath, args: [MOCK_SERVER], ...overrides };
}

test('McpManager mounts tools from a stdio server and executes calls', async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.startAll({ mock: mockServerConfig() });
    assert.equal(tools.length, 2);
    // 工具名加 mcp_<server>_ 前缀（连字符为合法字符，原样保留）
    assert.deepEqual(tools.map(t => t.name).sort(), ['mcp_mock_echo', 'mcp_mock_fail-tool']);

    const echo = tools.find(t => t.name === 'mcp_mock_echo');
    assert.ok(echo.definition.function.description.includes('[mcp:mock]'));
    assert.deepEqual(echo.definition.function.parameters.required, ['text']);
    assert.equal(await echo.execute({ text: 'hi' }), 'echo: hi');

    // server 标记 isError 的结果以「错误:」开头，与 isFailedToolOutput 判定一致
    const fail = tools.find(t => t.name === 'mcp_mock_fail-tool');
    assert.ok((await fail.execute({})).startsWith('错误:'));
  } finally {
    manager.stopAll();
  }
});

test('McpTool mutation scope follows server readOnly flag', async () => {
  const roManager = new McpManager();
  const rwManager = new McpManager();
  try {
    const roTools = await roManager.startAll({ ro: mockServerConfig({ readOnly: true }) });
    const rwTools = await rwManager.startAll({ rw: mockServerConfig() });
    assert.equal(roTools[0].getMutationScope?.({}), 'none');
    assert.equal(rwTools[0].getMutationScope?.({}), 'workspace');
  } finally {
    roManager.stopAll();
    rwManager.stopAll();
  }
});

test('McpManager degrades when a server fails to start', async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.startAll({
      broken: { command: 'definitely-not-a-command-xyz' },
      ok: mockServerConfig(),
      off: mockServerConfig({ enabled: false })
    });
    // 失败与禁用的 server 不产出工具，正常的照常挂载
    assert.deepEqual(tools.map(t => t.name).sort(), ['mcp_ok_echo', 'mcp_ok_fail-tool']);
    const statuses = manager.getServerStatuses();
    const broken = statuses.find(s => s.name === 'broken');
    assert.equal(broken.state, 'failed');
    assert.ok(broken.error);
    assert.equal(statuses.find(s => s.name === 'off').state, 'disabled');
    assert.equal(statuses.find(s => s.name === 'ok').state, 'running');
  } finally {
    manager.stopAll();
  }
});

test('readMcpServerConfigs merges user and project config layers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-mcpcfg-'));
  try {
    const userPath = path.join(tmp, 'user-config.json');
    const projectPath = path.join(tmp, 'project-config.json');
    fs.writeFileSync(userPath, JSON.stringify({
      providers: { deepseek: { apiKey: 'sk-x' } },
      mcpServers: {
        shared: { command: 'node', args: ['old.js'] },
        userOnly: { command: 'uvx', args: ['some-server'] }
      }
    }), 'utf8');
    fs.writeFileSync(projectPath, JSON.stringify({
      mcpServers: { shared: { command: 'node', args: ['new.js'], readOnly: true } }
    }), 'utf8');
    const merged = readMcpServerConfigs([userPath, projectPath]);
    // 项目级覆盖用户级同名 server，用户级独有项保留
    assert.deepEqual(merged.shared, { command: 'node', args: ['new.js'], readOnly: true });
    assert.equal(merged.userOnly.command, 'uvx');
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('readMcpServerConfigs ignores broken files and invalid entries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-mcpbad-'));
  try {
    const brokenPath = path.join(tmp, 'broken.json');
    fs.writeFileSync(brokenPath, '{ not json', 'utf8');
    const missingCommandPath = path.join(tmp, 'missing-command.json');
    fs.writeFileSync(missingCommandPath, JSON.stringify({ mcpServers: { bad: { args: ['x'] }, ok: { command: 'node' } } }), 'utf8');
    const missingPath = path.join(tmp, 'does-not-exist.json');
    const merged = readMcpServerConfigs([brokenPath, missingCommandPath, missingPath]);
    assert.deepEqual(Object.keys(merged), ['ok']);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('PermissionEngine honors registered read-only MCP tools', async () => {
  const engine = new PermissionEngine();
  engine.registerReadOnlyTool('mcp_ro_echo');
  assert.ok(engine.isReadOnlyTool('mcp_ro_echo'));
  assert.ok(!engine.isReadOnlyTool('mcp_rw_edit'));
  // Plan 模式下注册过的只读 MCP 工具放行
  const planResult = await engine.evaluate({ mode: 'plan', toolName: 'mcp_ro_echo', args: {} });
  assert.equal(planResult.action, 'allow');
  // 未注册的 MCP 工具在 default 模式下需人工审批
  const defaultResult = await engine.evaluate({ mode: 'default', toolName: 'mcp_rw_edit', args: {} });
  assert.equal(defaultResult.action, 'prompt');
});
