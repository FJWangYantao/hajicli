import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

/** Git 快照节点结构 */
export interface SnapshotNode {
  id: string;
  commitHash: string;
  timestamp: number;
  description: string;
}

/**
 * Git 状态与文件恢复快照引擎。
 * 为 /rewind 指令提供代码与工作区文件的精确回退还原能力。
 */
export class SnapshotEngine {
  private readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /**
   * 检查当前工作目录是否为一个 Git 仓库。
   */
  isGitRepo(): boolean {
    try {
      const output = execSync('git rev-parse --is-inside-work-tree', {
        cwd: this.cwd,
        stdio: 'pipe'
      }).toString().trim();
      return output === 'true';
    } catch {
      return false;
    }
  }

  /**
   * 获取当前 Git HEAD 的提交 Commit Hash。
   */
  getCurrentHeadHash(): string | null {
    if (!this.isGitRepo()) {
      return null;
    }
    try {
      return execSync('git rev-parse HEAD', {
        cwd: this.cwd,
        stdio: 'pipe'
      }).toString().trim();
    } catch {
      return null;
    }
  }

  /**
   * 创建一个自动轻量快照 Commit。
   * @param description 快照描述
   */
  createSnapshot(description: string): string | null {
    if (!this.isGitRepo()) {
      return null;
    }
    try {
      const status = execSync('git status --porcelain', {
        cwd: this.cwd,
        stdio: 'pipe'
      }).toString().trim();

      if (!status) {
        return this.getCurrentHeadHash();
      }

      const safeMsg = description.replace(/"/g, "'");
      execSync(`git add -A && git commit -m "haji-snapshot: ${safeMsg}" --no-verify`, {
        cwd: this.cwd,
        stdio: 'pipe'
      });

      return this.getCurrentHeadHash();
    } catch {
      return null;
    }
  }

  /**
   * 将代码工作区完全回退至指定的 Commit Hash / 快照节点。
   * @param commitHash 目标 Commit Hash
   */
  rollback(commitHash: string): boolean {
    if (!this.isGitRepo() || !commitHash) {
      return false;
    }
    try {
      // 重置代码仓到目标节点并清理未追踪文件
      execSync(`git reset --hard ${commitHash}`, {
        cwd: this.cwd,
        stdio: 'pipe'
      });
      execSync('git clean -fd', {
        cwd: this.cwd,
        stdio: 'pipe'
      });
      return true;
    } catch {
      return false;
    }
  }
}
