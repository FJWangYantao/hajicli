import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadProviderConfig,
  loadProviderConfigScope,
  saveProviderConfig,
  unsetProviderConfig,
  resolveProviderSetting,
  parseModelList,
  validateProviderName,
  normalizeBaseUrl,
  testProviderConnection,
  providerConfigPath,
  userProviderConfigPath,
  projectProviderConfigPath
} from '../dist/provider-config.js';

/**
 * provider-config 的路径基于 os.homedir() 与 process.cwd()。
 * 测试前切换到临时目录并覆盖 HOME/USERPROFILE，结束后恢复。
 */
function withIsolatedPaths(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-provider-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });

  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  process.chdir(proj);
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    run({ root, home, proj });
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('provider config starts empty', () => {
  withIsolatedPaths(() => {
    const config = loadProviderConfig();
    assert.deepEqual(config.providers.deepseek, {});
    assert.deepEqual(config.providers.volcengine, {});
  });
});

test('save defaults to user config and merges fields', () => {
  withIsolatedPaths(() => {
    assert.equal(saveProviderConfig('deepseek', { apiKey: 'sk-a', baseUrl: 'https://gw.example.com/v1' }), true);
    assert.equal(fs.existsSync(userProviderConfigPath()), true);
    assert.equal(fs.existsSync(projectProviderConfigPath()), false, '默认保存不创建项目级配置');
    assert.equal(providerConfigPath('user'), userProviderConfigPath());
    assert.equal(providerConfigPath('project'), projectProviderConfigPath());

    assert.equal(saveProviderConfig('deepseek', { model: 'deepseek-v4-pro' }), true);
    const config = loadProviderConfig();
    assert.equal(config.providers.deepseek.apiKey, 'sk-a');
    assert.equal(config.providers.deepseek.baseUrl, 'https://gw.example.com/v1');
    assert.equal(config.providers.deepseek.model, 'deepseek-v4-pro');
  });
});

test('explicit project config overrides user config field by field', () => {
  withIsolatedPaths(({ home }) => {
    const userFile = path.join(home, '.haji', 'config.json');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, JSON.stringify({
      providers: {
        deepseek: { apiKey: 'sk-user', model: 'deepseek-v4-pro' },
        volcengine: { apiKey: 'ark-user' }
      }
    }));

    assert.equal(saveProviderConfig('deepseek', { apiKey: 'sk-project', baseUrl: 'https://inner.example.com/v1' }, 'project'), true);
    const config = loadProviderConfig();
    assert.equal(config.providers.deepseek.apiKey, 'sk-project', '项目级覆盖用户级 apiKey');
    assert.equal(config.providers.deepseek.model, 'deepseek-v4-pro', '用户级 model 保留');
    assert.equal(config.providers.deepseek.baseUrl, 'https://inner.example.com/v1');
    assert.equal(config.providers.volcengine.apiKey, 'ark-user', '未写项目级的 provider 取用户级');
  });
});

test('resolve precedence is env > config > fallback', () => {
  withIsolatedPaths(() => {
    assert.equal(saveProviderConfig('deepseek', { apiKey: 'sk-config', baseUrl: 'https://config.example.com' }), true);

    // env 优先
    assert.equal(resolveProviderSetting('deepseek', 'apiKey', 'sk-env', undefined), 'sk-env');
    // env 缺失时取配置
    assert.equal(resolveProviderSetting('deepseek', 'apiKey', undefined, undefined), 'sk-config');
    assert.equal(resolveProviderSetting('deepseek', 'baseUrl', undefined, 'https://fallback.example.com'), 'https://config.example.com');
    // 配置缺失时取 fallback
    assert.equal(resolveProviderSetting('volcengine', 'model', undefined, 'glm-5.2'), 'glm-5.2');
    assert.equal(resolveProviderSetting('volcengine', 'apiKey', undefined, undefined), undefined);
    // 传入预加载 config 的结果一致
    const config = loadProviderConfig();
    assert.equal(resolveProviderSetting('deepseek', 'apiKey', undefined, undefined, config), 'sk-config');
  });
});

test('empty string fields are cleared and fall back to user config', () => {
  withIsolatedPaths(({ home }) => {
    const userFile = path.join(home, '.haji', 'config.json');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, JSON.stringify({ providers: { deepseek: { apiKey: 'sk-user' } } }));

    assert.equal(saveProviderConfig('deepseek', { apiKey: 'sk-project', baseUrl: 'https://inner.example.com/v1' }, 'project'), true);
    assert.equal(saveProviderConfig('deepseek', { apiKey: '' }, 'project'), true);
    const config = loadProviderConfig();
    assert.equal(config.providers.deepseek.apiKey, 'sk-user', '项目级 apiKey 清空后回落用户级');
    assert.equal(config.providers.deepseek.baseUrl, 'https://inner.example.com/v1', '未清除的字段保留');
  });
});

test('unset defaults to user config and can explicitly remove project config', () => {
  withIsolatedPaths(({ home }) => {
    const userFile = path.join(home, '.haji', 'config.json');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, JSON.stringify({ providers: { deepseek: { apiKey: 'sk-user' } } }));
    assert.equal(saveProviderConfig('deepseek', { apiKey: 'sk-project' }, 'project'), true);

    assert.equal(unsetProviderConfig('deepseek', 'project'), true);
    const config = loadProviderConfig();
    assert.equal(config.providers.deepseek.apiKey, 'sk-user', 'unset 后只剩用户级');
    assert.equal(unsetProviderConfig('deepseek'), true);
    assert.deepEqual(loadProviderConfigScope('user').providers, {}, '默认 unset 清除用户全局配置');
  });
});

test('corrupt config files are treated as empty', () => {
  withIsolatedPaths(({ home }) => {
    fs.mkdirSync(path.join(home, '.haji'), { recursive: true });
    fs.writeFileSync(path.join(home, '.haji', 'config.json'), '{ broken json', 'utf8');
    fs.mkdirSync(path.join(process.cwd(), '.haji'), { recursive: true });
    fs.writeFileSync(projectProviderConfigPath(), 'not json at all', 'utf8');

    const config = loadProviderConfig();
    assert.deepEqual(config.providers.deepseek, {});
    assert.deepEqual(config.providers.volcengine, {});
  });
});

test('save reports failure when target config path cannot be written', () => {
  withIsolatedPaths(({ home }) => {
    // 把两级 .haji 目录位置占位成普通文件，mkdirSync 将失败
    fs.writeFileSync(path.join(home, '.haji'), 'not a directory', 'utf8');
    fs.writeFileSync(path.join(process.cwd(), '.haji'), 'not a directory', 'utf8');
    assert.equal(saveProviderConfig('deepseek', { apiKey: 'sk-a' }), false);
    assert.equal(unsetProviderConfig('deepseek'), false);
    assert.equal(saveProviderConfig('deepseek', { apiKey: 'sk-a' }, 'project'), false);
    assert.equal(unsetProviderConfig('deepseek', 'project'), false);
  });
});

test('parseModelList splits by semicolon/comma and dedupes', () => {
  assert.deepEqual(parseModelList('gpt-4o;gpt-4o-mini'), ['gpt-4o', 'gpt-4o-mini']);
  assert.deepEqual(parseModelList('a；b,c；d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(parseModelList('  a ;  a ; b '), ['a', 'b']);
  assert.deepEqual(parseModelList(''), []);
  assert.deepEqual(parseModelList(';;;'), []);
});

test('validateProviderName rejects empty, whitespace and path characters', () => {
  assert.equal(validateProviderName('openai'), null);
  assert.equal(validateProviderName(' my-provider '), null, '首尾空白会被 trim，本身合法');
  assert.ok(validateProviderName(''), '空名称非法');
  assert.ok(validateProviderName('  '), '纯空白非法');
  assert.ok(validateProviderName('a b'), '含空格非法');
  assert.ok(validateProviderName('a/b'), '含斜杠非法');
  assert.ok(validateProviderName('a\\b'), '含反斜杠非法');
  assert.ok(validateProviderName('x'.repeat(33)), '超长非法');
});

test('custom provider names are saved, loaded and unset', () => {
  withIsolatedPaths(() => {
    assert.equal(saveProviderConfig('openai', {
      apiKey: 'sk-custom',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini']
    }), true);

    const config = loadProviderConfig();
    assert.equal(config.providers.openai.apiKey, 'sk-custom');
    assert.equal(config.providers.openai.baseUrl, 'https://api.openai.com/v1');
    assert.equal(config.providers.openai.model, 'gpt-4o');
    assert.deepEqual(config.providers.openai.models, ['gpt-4o', 'gpt-4o-mini']);

    // 部分更新保留 models
    assert.equal(saveProviderConfig('openai', { model: 'gpt-4o-mini' }), true);
    const updated = loadProviderConfig();
    assert.equal(updated.providers.openai.model, 'gpt-4o-mini');
    assert.deepEqual(updated.providers.openai.models, ['gpt-4o', 'gpt-4o-mini'], 'models 在部分更新时保留');

    // 清空 models：传入空数组应移除该字段
    assert.equal(saveProviderConfig('openai', { models: [] }), true);
    const afterClear = loadProviderConfig();
    assert.equal(afterClear.providers.openai.models, undefined, '空 models 被移除');

    assert.equal(unsetProviderConfig('openai'), true);
    const afterUnset = loadProviderConfig();
    assert.equal(afterUnset.providers.openai, undefined, 'unset 后自定义 provider 消失');
  });
});

test('custom provider merges user and project config levels', () => {
  withIsolatedPaths(({ home }) => {
    const userFile = path.join(home, '.haji', 'config.json');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, JSON.stringify({
      providers: {
        moonshot: { apiKey: 'sk-user', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k'] }
      }
    }));

    assert.equal(saveProviderConfig('moonshot', { models: ['moonshot-v1-32k'] }, 'project'), true);
    const config = loadProviderConfig();
    assert.equal(config.providers.moonshot.apiKey, 'sk-user', '用户级 apiKey 保留');
    assert.deepEqual(config.providers.moonshot.models, ['moonshot-v1-32k'], '项目级 models 覆盖用户级');
  });
});

test('normalizeBaseUrl strips trailing slashes and endpoint suffixes', () => {
  // 尾部斜杠
  assert.deepEqual(normalizeBaseUrl('https://api.openai.com/v1/'), { url: 'https://api.openai.com/v1' });
  // 完整端点
  const full = normalizeBaseUrl('https://api.openai.com/v1/chat/completions');
  assert.equal(full.url, 'https://api.openai.com/v1');
  assert.ok(full.note && full.note.includes('chat/completions'));
  // 重复端点（用户可能粘贴两次）
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/chat/completions/chat/completions').url, 'https://api.openai.com/v1');
  // 大小写不敏感
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/Chat/Completions').url, 'https://api.openai.com/v1');
  // Anthropic 风格端点转 OpenAI 兼容
  const anthropic = normalizeBaseUrl('https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1');
  assert.ok(anthropic.note && anthropic.note.includes('messages'));
  // query/hash 剥离
  assert.equal(normalizeBaseUrl('https://api.example.com/v1?key=abc').url, 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1#section').url, 'https://api.example.com/v1');
  // 普通输入不产生提示
  assert.equal(normalizeBaseUrl('https://api.example.com/v1').note, undefined);
});

test('testProviderConnection tolerates full endpoint URLs', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      assert.equal(req.url, '/v1/chat/completions');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // 用户误填完整端点 URL，也应正确请求 /v1/chat/completions
    const result = await testProviderConnection(`http://127.0.0.1:${port}/v1/chat/completions`, 'sk-test', 'gpt-4o', 5000);
    assert.equal(result.ok, true);
    assert.equal(result.usedUrl, `http://127.0.0.1:${port}/v1/chat/completions`);
    assert.ok(result.normalizedNote && result.normalizedNote.includes('chat/completions'), '应提示已剥掉端点后缀');
  } finally {
    server.close();
  }
});

test('testProviderConnection rejects invalid base URLs without network call', async () => {
  const result = await testProviderConnection('not-a-url', 'sk-test', 'gpt-4o', 5000);
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.includes('无效'));
  assert.equal(result.usedUrl, undefined, '非法 URL 不应发起请求');
});

test('testProviderConnection succeeds against a working endpoint', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      assert.equal(req.url, '/v1/chat/completions');
      const payload = JSON.parse(body);
      assert.equal(payload.model, 'gpt-4o');
      assert.equal(payload.max_tokens, 1);
      assert.equal(req.headers.authorization, 'Bearer sk-test');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await testProviderConnection(`http://127.0.0.1:${port}/v1/`, 'sk-test', 'gpt-4o', 5000);
    assert.equal(result.ok, true);
    assert.ok(result.ms !== undefined);
  } finally {
    server.close();
  }
});

test('testProviderConnection reports HTTP error body message', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await testProviderConnection(`http://127.0.0.1:${port}/v1`, 'sk-bad', 'gpt-4o', 5000);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('invalid api key'), `error 应包含服务端消息，实际: ${result.error}`);
    assert.ok(result.ms !== undefined);
  } finally {
    server.close();
  }
});

test('testProviderConnection reports network errors', async () => {
  // 端口 9 无服务监听，连接立即被拒绝
  const result = await testProviderConnection('http://127.0.0.1:9/v1', 'sk-test', 'gpt-4o', 5000);
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
});
