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
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.haji/\nignored.txt\n');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'committed\n');
  git(cwd, 'add', '.gitignore', 'tracked.txt');
  git(cwd, 'commit', '-m', 'initial');
  return cwd;
}

test('snapshot restores the exact dirty worktree without creating commits', () => {
  const cwd = createRepository();
  try {
    const engine = new SnapshotEngine(cwd);
    const headBefore = git(cwd, 'rev-parse', 'HEAD');
    const commitsBefore = git(cwd, 'rev-list', '--count', 'HEAD');

    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'staged before prompt\n');
    git(cwd, 'add', 'tracked.txt');
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'dirty before prompt\n');
    fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'untracked before prompt\n');
    fs.writeFileSync(path.join(cwd, 'ignored.txt'), 'keep ignored\n');
    const statusBefore = git(cwd, 'status', '--porcelain=v1');
    const snapshotId = engine.createSnapshot('before prompt');
    assert.ok(snapshotId);

    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'changed by later tool\n');
    fs.rmSync(path.join(cwd, 'untracked.txt'));
    fs.writeFileSync(path.join(cwd, 'later.txt'), 'created later\n');
    fs.writeFileSync(path.join(cwd, 'ignored.txt'), 'ignored changed later\n');

    assert.equal(engine.rollback(snapshotId), true);
    assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'dirty before prompt\n');
    assert.equal(fs.readFileSync(path.join(cwd, 'untracked.txt'), 'utf8'), 'untracked before prompt\n');
    assert.equal(fs.existsSync(path.join(cwd, 'later.txt')), false);
    assert.equal(fs.readFileSync(path.join(cwd, 'ignored.txt'), 'utf8'), 'ignored changed later\n');
    assert.equal(git(cwd, 'show', ':tracked.txt'), 'staged before prompt');
    assert.equal(git(cwd, 'status', '--porcelain=v1'), statusBefore);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(cwd, 'rev-list', '--count', 'HEAD'), commitsBefore);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('snapshot refuses to rewrite history when HEAD changed', () => {
  const cwd = createRepository();
  try {
    const engine = new SnapshotEngine(cwd);
    const snapshotId = engine.createSnapshot('before prompt');
    assert.ok(snapshotId);

    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'new commit\n');
    git(cwd, 'add', 'tracked.txt');
    git(cwd, 'commit', '-m', 'user commit');
    const headAfterCommit = git(cwd, 'rev-parse', 'HEAD');

    assert.equal(engine.rollback(snapshotId), false);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), headAfterCommit);
    assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'new commit\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
