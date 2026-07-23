import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PermissionEngine,
  SKILL_ALREADY_LOADED_MARKER,
  SKILL_CONTEXT_START,
  SKILL_LOAD_MARKER,
  SkillRegistry,
  SubagentRunner,
  SystemPromptManager,
  runCompactionPipeline
} from '@hajicli/core';
import {
  ListSkillResourcesTool,
  LoadSkillTool,
  ReadSkillResourceTool
} from '@hajicli/plugins';

function writeSkill(root, directory, frontmatter, body = '# Skill instructions') {
  const target = path.join(root, directory);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
}

test('SkillRegistry scans user and project skills with project precedence', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-skills-'));
  const projectDir = path.join(cwd, 'project');
  const userDir = path.join(cwd, 'user');
  try {
    writeSkill(userDir, 'review', 'name: review\ndescription: User review rules');
    writeSkill(projectDir, 'review', 'name: review\ndescription: Project review rules\nwhen_to_use: Review a diff');
    writeSkill(projectDir, 'invalid', 'name: INVALID NAME\ndescription: invalid');
    const registry = new SkillRegistry({ cwd, projectSkillsDir: projectDir, userSkillsDir: userDir });
    const result = await registry.scan();

    assert.equal(result.skills.length, 1);
    assert.equal(registry.get('review').source, 'project');
    assert.equal(registry.get('review').description, 'Project review rules');
    assert.ok(result.warnings.some(warning => /覆盖/.test(warning)));
    assert.ok(result.warnings.some(warning => /INVALID NAME|invalid/.test(warning)));
    assert.ok(result.issues.some(issue => issue.severity === 'warning' && /覆盖/.test(issue.message)));
    assert.ok(result.issues.some(issue => issue.severity === 'error' && /INVALID NAME|invalid/.test(issue.message)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadskill injects content once per context and supports independent child scopes', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-skill-load-'));
  const projectDir = path.join(cwd, 'skills');
  try {
    writeSkill(projectDir, 'review', 'name: review\ndescription: Review code', 'Always inspect the diff.');
    const registry = new SkillRegistry({ cwd, projectSkillsDir: projectDir, userSkillsDir: path.join(cwd, 'none') });
    await registry.scan();
    const tool = new LoadSkillTool(registry);

    const first = await tool.execute({ name: 'review', args: 'current diff' });
    const duplicate = await tool.execute({ name: 'review' });
    const child = await tool.execute({ name: 'review' }, { agentId: 'sub-1' });
    assert.ok(first.startsWith(`${SKILL_LOAD_MARKER} `));
    assert.match(first, /Always inspect the diff/);
    assert.ok(duplicate.startsWith(`${SKILL_ALREADY_LOADED_MARKER} `));
    assert.ok(child.startsWith(`${SKILL_LOAD_MARKER} `));
    assert.match(await tool.execute({ name: '../review' }), /^错误:/);

    const controller = new AbortController();
    controller.abort();
    assert.equal(await tool.execute({ name: 'review' }, { abortSignal: controller.signal }), '[Skill 加载已中止]');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Skill resource tools require activation and safely resolve text resources', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-skill-resources-'));
  const projectDir = path.join(cwd, 'skills');
  try {
    writeSkill(
      projectDir,
      'review',
      'name: review\ndescription: Review code',
      'Read references/rules.md before reviewing.'
    );
    const skillDir = path.join(projectDir, 'review');
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(skillDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'references', 'rules.md'), 'one\ntwo\nthree\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'scripts', 'check.js'), 'console.log("check");\n', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'assets', 'binary.dat'), Buffer.from([0xff, 0xfe, 0xfd]));
    let linkedResourceCreated = false;
    const outsideDir = path.join(cwd, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret', 'utf8');
    try {
      fs.symlinkSync(
        outsideDir,
        path.join(skillDir, 'references', 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      linkedResourceCreated = true;
    } catch {
      // 某些 Windows 环境禁止创建链接；路径穿越测试仍覆盖核心边界。
    }

    const registry = new SkillRegistry({
      cwd,
      projectSkillsDir: projectDir,
      userSkillsDir: path.join(cwd, 'none')
    });
    await registry.scan();
    const load = new LoadSkillTool(registry);
    const list = new ListSkillResourcesTool(registry);
    const read = new ReadSkillResourceTool(registry);

    assert.match(await list.execute({ name: 'review' }), /尚未加载/);
    await load.execute({ name: 'review' });

    const listed = await list.execute({ name: 'review' });
    assert.match(listed, /references\/rules\.md \[reference/);
    assert.match(listed, /scripts\/check\.js \[script/);
    assert.match(listed, /assets\/binary\.dat \[asset/);
    if (linkedResourceCreated) assert.match(listed, /已拒绝符号链接资源/);

    const excerpt = await read.execute({
      name: 'review',
      path: 'references/rules.md',
      startLine: 2,
      endLine: 2
    });
    assert.match(excerpt, /two/);
    assert.doesNotMatch(excerpt, /\none\n/);
    assert.match(await read.execute({ name: 'review', path: '../SKILL.md' }), /不能包含/);
    assert.match(await read.execute({ name: 'review', path: 'SKILL.md' }), /请使用 loadskill/);
    assert.match(await read.execute({ name: 'review', path: 'references/rules.md:stream' }), /不安全/);
    assert.match(await read.execute({ name: 'review', path: 'references/NUL.txt' }), /Windows 保留设备名/);
    assert.match(await read.execute({ name: 'review', path: 'COM1.log' }), /Windows 保留设备名/);
    assert.match(await read.execute({ name: 'review', path: 'assets/binary.dat' }), /不是有效 UTF-8/);
    const missing = await read.execute({ name: 'review', path: 'references/missing.md' });
    assert.match(missing, /资源不存在: references\/missing\.md/);
    assert.equal(missing.includes(skillDir), false);

    const childList = await list.execute({ name: 'review' }, { agentId: 'child-1' });
    assert.match(childList, /尚未加载/);
    await load.execute({ name: 'review' }, { agentId: 'child-1' });
    assert.match(await list.execute({ name: 'review' }, { agentId: 'child-1' }), /rules\.md/);

    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await read.execute({ name: 'review', path: 'references/rules.md' }, { abortSignal: controller.signal }),
      '[Skill 资源读取已中止]'
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Skill validation is side-effect free until the caller explicitly rescans', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-skill-pure-validation-'));
  const projectDir = path.join(cwd, 'skills');
  try {
    writeSkill(projectDir, 'review', 'name: review\ndescription: Review code', 'Version one.');
    const registry = new SkillRegistry({
      cwd,
      projectSkillsDir: projectDir,
      userSkillsDir: path.join(cwd, 'none')
    });
    await registry.scan();
    registry.load('review');
    const originalHash = registry.get('review').contentHash;
    writeSkill(projectDir, 'review', 'name: review\ndescription: Review code', 'Version two.');

    const validation = await registry.validate();
    assert.equal(validation.valid, true);
    assert.equal(registry.get('review').contentHash, originalHash);
    assert.equal(registry.isLoaded('review'), true);

    await registry.scan();
    assert.notEqual(registry.get('review').contentHash, originalHash);
    assert.equal(registry.isLoaded('review'), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Skill validation reports invalid manifests and oversized resources', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-skill-validation-'));
  const projectDir = path.join(cwd, 'skills');
  try {
    writeSkill(projectDir, 'valid', 'name: valid\ndescription: Valid skill');
    writeSkill(projectDir, 'invalid', 'name: INVALID NAME\ndescription: Invalid skill');
    fs.mkdirSync(path.join(projectDir, 'valid', 'references'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'valid', 'references', 'large.txt'), 'x'.repeat(33), 'utf8');
    const registry = new SkillRegistry({
      cwd,
      projectSkillsDir: projectDir,
      userSkillsDir: path.join(cwd, 'none'),
      maxResourceBytes: 32
    });

    await registry.scan();
    const result = await registry.validate();
    assert.equal(result.valid, false);
    assert.equal(result.checkedSkills, 1);
    assert.equal(result.checkedResources, 1);
    assert.ok(result.issues.some(issue => /INVALID NAME|invalid/.test(issue.message)));
    assert.ok(result.issues.some(issue => /超过 32 字节限制/.test(issue.message)));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Skill catalog is lightweight and loadskill stays read-only in Plan Mode', async () => {
  const manager = new SystemPromptManager();
  const prompt = await manager.generatePrompt({
    cwd: 'C:/repo',
    os: 'Windows',
    tools: ['read', 'loadskill', 'listskillresources', 'readskillresource'],
    permissionMode: 'plan',
    skills: [{ name: 'review', description: 'Review code', whenToUse: 'Review a diff', source: 'project', userInvocable: true }]
  });
  assert.match(prompt, /Available Skills/);
  assert.match(prompt, /review \[project\]/);
  assert.match(prompt, /先调用 loadskill/);
  assert.match(prompt, /listskillresources/);
  assert.match(prompt, /readskillresource/);
  assert.doesNotMatch(prompt, /Always inspect the diff/);

  const engine = new PermissionEngine();
  assert.equal((await engine.evaluate({ mode: 'plan', toolName: 'loadskill', args: {} })).action, 'allow');
  assert.equal(engine.isReadOnlyTool('loadskill'), true);
  assert.equal(engine.isReadOnlyTool('listskillresources'), true);
  assert.equal(engine.isReadOnlyTool('readskillresource'), true);
});

test('subagent receives the Skill catalog when loadskill is available', async () => {
  let systemPrompt = '';
  const provider = {
    async *completeStream(messages) {
      systemPrompt = messages[0].content;
      yield JSON.stringify({ summary: 'done', filesChanged: [], verification: [], unresolved: [] });
    }
  };
  const runner = new SubagentRunner({
    cwd: 'C:/repo',
    getProvider: () => provider,
    getModel: () => 'test-model',
    getReasoningEffort: () => 'low',
    getTools: () => [{
      name: 'loadskill',
      definition: {
        type: 'function',
        function: { name: 'loadskill', description: 'load', parameters: { type: 'object', properties: {} } }
      },
      async execute() { return ''; }
    }],
    getSkills: () => [{
      name: 'review',
      description: 'Review code',
      whenToUse: 'Review a diff',
      source: 'project',
      userInvocable: true
    }],
    executeTool: async () => ''
  });

  await runner.runResult({ description: 'review current diff' });
  assert.match(systemPrompt, /# Available Skills/);
  assert.match(systemPrompt, /review \[project\]/);
  assert.match(systemPrompt, /先调用 loadskill/);
});

test('L4 keeps Skill activation metadata but allows content to be reloaded', async () => {
  const previousCwd = process.cwd();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-skill-compact-'));
  const projectDir = path.join(cwd, 'skills');
  process.chdir(cwd);
  try {
    writeSkill(projectDir, 'review', 'name: review\ndescription: Review code', 'Detailed private instructions.');
    const registry = new SkillRegistry({ cwd, projectSkillsDir: projectDir, userSkillsDir: path.join(cwd, 'none') });
    await registry.scan();
    const output = registry.load('review');
    const history = [
      { role: 'system', content: 'system rules' },
      { role: 'user', content: 'load review' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'skill-1', type: 'function', function: { name: 'loadskill', arguments: '{"name":"review"}' } }] },
      { role: 'tool', tool_call_id: 'skill-1', content: output },
      { role: 'user', content: 'turn two' },
      { role: 'assistant', content: 'done two' },
      { role: 'user', content: 'turn three' },
      { role: 'assistant', content: 'done three' },
      { role: 'user', content: 'turn four' }
    ];
    const compacted = await runCompactionPipeline(history, {
      forceL4: true,
      summaryProvider: async () => 'summary'
    });
    assert.match(compacted.messages[0].content, new RegExp(SKILL_CONTEXT_START.replace(/[\[\]]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(compacted.messages), /Detailed private instructions/);

    registry.restoreScopeFromMessages('main', compacted.messages);
    assert.equal(registry.getLoaded('main')[0].resident, false);
    assert.ok(registry.load('review').startsWith(`${SKILL_LOAD_MARKER} `));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI exposes deterministic Skill commands and preserves tool-call pairing', () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /command: '\/skills'/);
  assert.match(source, /command: '\/skill'/);
  assert.match(source, /parts\[1\]\?\.toLowerCase\(\) === 'validate'/);
  assert.match(source, /new ListSkillResourcesTool\(skillRegistry\)/);
  assert.match(source, /new ReadSkillResourceTool\(skillRegistry\)/);
  assert.match(source, /if \(!entry\) \{\s*ui\.writeLine\(colors\.red\(`未找到 Skill/);
  assert.match(source, /manual-skill-\$\{randomUUID\(\)\}/);
  assert.match(source, /role: 'assistant', content: '', tool_calls: \[manualSkillExchange\.toolCall\]/);
  assert.match(source, /role: 'tool', content: manualSkillExchange\.output, tool_call_id: manualSkillExchange\.toolCall\.id/);
});
