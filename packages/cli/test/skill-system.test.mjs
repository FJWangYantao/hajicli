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
import { LoadSkillTool } from '@hajicli/plugins';

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

test('Skill catalog is lightweight and loadskill stays read-only in Plan Mode', async () => {
  const manager = new SystemPromptManager();
  const prompt = await manager.generatePrompt({
    cwd: 'C:/repo',
    os: 'Windows',
    tools: ['read', 'loadskill'],
    permissionMode: 'plan',
    skills: [{ name: 'review', description: 'Review code', whenToUse: 'Review a diff', source: 'project', userInvocable: true }]
  });
  assert.match(prompt, /Available Skills/);
  assert.match(prompt, /review \[project\]/);
  assert.match(prompt, /先调用 loadskill/);
  assert.doesNotMatch(prompt, /Always inspect the diff/);

  const engine = new PermissionEngine();
  assert.equal((await engine.evaluate({ mode: 'plan', toolName: 'loadskill', args: {} })).action, 'allow');
  assert.equal(engine.isReadOnlyTool('loadskill'), true);
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
  assert.match(source, /if \(!entry\) \{\s*ui\.writeLine\(colors\.red\(`未找到 Skill/);
  assert.match(source, /manual-skill-\$\{randomUUID\(\)\}/);
  assert.match(source, /role: 'assistant', content: '', tool_calls: \[manualSkillExchange\.toolCall\]/);
  assert.match(source, /role: 'tool', content: manualSkillExchange\.output, tool_call_id: manualSkillExchange\.toolCall\.id/);
});
