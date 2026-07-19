import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SnapshotEngine } from '@hajicli/core';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'haji-snapshot-'));
  git(cwd, 'init');
  git(cwd, 'config', 'user.name', 'Haji Test');
  git(cwd, 'config', 'user.email', 'haji@example.test');
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.haji/\n');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'committed\n');
  fs.writeFileSync(path.join(cwd, 'external.txt'), 'committed external\n');
  git(cwd, 'add', '.gitignore', 'tracked.txt', 'external.txt');
  git(cwd, 'commit', '-m', 'initial');
  return cwd;
}

test('rewind only reverts Haji-owned tool changes and preserves later external edits', () => {
  const cwd = createRepository();
  try {
    const engine = new SnapshotEngine(cwd);
    engine.setScope('session-a');
    fs.writeFileSync(path.join(cwd, 'external.txt'), 'user dirty before turn\n');
    const anchor = engine.createSnapshot('before user message');
    assert.ok(anchor);
    const checkpoint = engine.beginMutation(anchor);
    assert.ok(checkpoint);

    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'changed by Haji tool\n');
    fs.writeFileSync(path.join(cwd, 'created-by-haji.txt'), 'tool output\n');
    assert.ok(engine.completeMutation(checkpoint));

    // 外部 Codex/用户在工具结束后继续编辑同一文件，回退不得覆盖。
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'changed later by external editor\n');
    const result = engine.rollbackOwnedChanges(anchor);

    assert.equal(result.ok, true);
    assert.deepEqual(result.revertedPaths, ['created-by-haji.txt']);
    assert.deepEqual(result.preservedPaths, ['tracked.txt']);
    assert.equal(fs.existsSync(path.join(cwd, 'created-by-haji.txt')), false);
    assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'changed later by external editor\n');
    assert.equal(fs.readFileSync(path.join(cwd, 'external.txt'), 'utf8'), 'user dirty before turn\n');
    assert.equal(git(cwd, 'rev-list', '--count', 'HEAD'), '1');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a snapshot without an owned mutation journal never rewrites the worktree', () => {
  const cwd = createRepository();
  try {
    const engine = new SnapshotEngine(cwd);
    engine.setScope('session-a');
    const anchor = engine.createSnapshot('before user message');
    assert.ok(anchor);
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'external change\n');
    const result = engine.rollbackOwnedChanges(anchor);
    assert.equal(result.ok, true);
    assert.deepEqual(result.revertedPaths, []);
    assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'external change\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('rewind refuses to touch files when HEAD changed', () => {
  const cwd = createRepository();
  try {
    const engine = new SnapshotEngine(cwd);
    engine.setScope('session-a');
    const anchor = engine.createSnapshot('before user message');
    assert.ok(anchor);
    const checkpoint = engine.beginMutation(anchor);
    assert.ok(checkpoint);
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'tool change\n');
    assert.ok(engine.completeMutation(checkpoint));

    git(cwd, 'add', 'tracked.txt');
    git(cwd, 'commit', '-m', 'user commit');
    const headAfterCommit = git(cwd, 'rev-parse', 'HEAD');
    const result = engine.rollbackOwnedChanges(anchor);
    assert.equal(result.ok, false);
    assert.match(result.reason, /HEAD/);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), headAfterCommit);
    assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'tool change\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('HEAD changes during a tool mutation are journaled and surfaced as unsafe to auto-rewind', () => {
  const cwd = createRepository();
  try {
    const engine = new SnapshotEngine(cwd);
    engine.setScope('session-head-change');
    const anchor = engine.createAnchor('before user message');
    assert.ok(anchor);
    const checkpoint = engine.beginMutation(anchor, ['tracked.txt']);
    assert.ok(checkpoint);

    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'tool changed and committed\n');
    git(cwd, 'add', 'tracked.txt');
    git(cwd, 'commit', '-m', 'HEAD changed during tool');
    const completion = engine.completeMutation(checkpoint);

    assert.ok(completion);
    assert.equal(completion.headChanged, true);
    assert.match(completion.warning, /HEAD.*mutation.*不可自动回退/);
    const journalPath = path.join(cwd, '.haji', 'snapshots', 'journals', 'session-head-change.json');
    const records = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(records.length, 1);
    assert.equal(records[0].version, 2);
    assert.equal(records[0].headChanged, true);
    assert.notEqual(records[0].beforeHeadHash, records[0].afterHeadHash);
    assert.deepEqual(records[0].paths, ['tracked.txt']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('lightweight anchors and scoped edit checkpoints only track the target file', () => {
  const cwd = createRepository();
  try {
    const engine = new SnapshotEngine(cwd);
    engine.setScope('session-a');
    const anchor = engine.createAnchor('before user message');
    assert.ok(anchor);
    const checkpoint = engine.beginMutation(anchor, ['tracked.txt']);
    assert.ok(checkpoint);

    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'edited by Haji\n');
    fs.writeFileSync(path.join(cwd, 'external.txt'), 'changed externally during tool\n');
    assert.ok(engine.completeMutation(checkpoint));

    const result = engine.rollbackOwnedChanges(anchor);
    assert.equal(result.ok, true);
    assert.deepEqual(result.revertedPaths, ['tracked.txt']);
    assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'committed\n');
    assert.equal(fs.readFileSync(path.join(cwd, 'external.txt'), 'utf8'), 'changed externally during tool\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
