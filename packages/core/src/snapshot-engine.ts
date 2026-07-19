import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface SnapshotFile {
  path: string;
  blob: string;
  kind: 'file' | 'symlink';
  mode: number;
}

interface SnapshotManifest {
  version: 1;
  id: string;
  headHash: string;
  timestamp: number;
  description: string;
  files: SnapshotFile[];
  indexBlob?: string;
}

/** 不修改 Git 历史的工作区快照引擎。 */
export class SnapshotEngine {
  private readonly cwd: string;
  private readonly snapshotRoot: string;
  private readonly manifestsDir: string;
  private readonly blobsDir: string;

  constructor(cwd: string = process.cwd(), snapshotRoot = path.join(cwd, '.haji', 'snapshots')) {
    this.cwd = path.resolve(cwd);
    this.snapshotRoot = path.resolve(snapshotRoot);
    this.manifestsDir = path.join(this.snapshotRoot, 'manifests');
    this.blobsDir = path.join(this.snapshotRoot, 'blobs');
  }

  isGitRepo(): boolean {
    try {
      return this.git(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
    } catch {
      return false;
    }
  }

  getCurrentHeadHash(): string | null {
    if (!this.isGitRepo()) return null;
    try {
      return this.git(['rev-parse', 'HEAD']).trim();
    } catch {
      return null;
    }
  }

  /**
   * 保存当前 HEAD、索引以及全部 tracked/untracked 非忽略文件。
   * 文件内容按哈希去重存放，不会执行 git add、commit 或 stash。
   */
  createSnapshot(description: string): string | null {
    const headHash = this.getCurrentHeadHash();
    if (!headHash) return null;

    try {
      fs.mkdirSync(this.manifestsDir, { recursive: true });
      fs.mkdirSync(this.blobsDir, { recursive: true });

      const files: SnapshotFile[] = [];
      for (const relativePath of this.listManagedPaths()) {
        const absolutePath = this.resolveWorkspacePath(relativePath);
        if (!fs.existsSync(absolutePath)) continue;

        const stat = fs.lstatSync(absolutePath);
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;

        const kind = stat.isSymbolicLink() ? 'symlink' : 'file';
        const content = kind === 'symlink'
          ? Buffer.from(fs.readlinkSync(absolutePath), 'utf8')
          : fs.readFileSync(absolutePath);
        files.push({
          path: relativePath,
          blob: this.storeBlob(content, kind),
          kind,
          mode: stat.mode & 0o777
        });
      }

      const indexPath = this.getIndexPath();
      const indexBlob = fs.existsSync(indexPath)
        ? this.storeBlob(fs.readFileSync(indexPath), 'index')
        : undefined;
      const id = crypto.randomUUID();
      const manifest: SnapshotManifest = {
        version: 1,
        id,
        headHash,
        timestamp: Date.now(),
        description,
        files,
        indexBlob
      };
      fs.writeFileSync(this.getManifestPath(id), JSON.stringify(manifest, null, 2), 'utf8');
      return id;
    } catch {
      return null;
    }
  }

  /** 精确恢复指定快照；HEAD 已变化时拒绝操作，避免重写用户提交历史。 */
  rollback(snapshotId: string): boolean {
    if (!this.isValidSnapshotId(snapshotId)) return false;

    try {
      const manifest = this.readManifest(snapshotId);
      if (!manifest || this.getCurrentHeadHash() !== manifest.headHash) return false;

      // 在修改工作区前先验证所有快照数据完整可读。
      for (const file of manifest.files) {
        this.resolveWorkspacePath(file.path);
        if (!fs.existsSync(this.getBlobPath(file.blob))) return false;
      }
      if (manifest.indexBlob && !fs.existsSync(this.getBlobPath(manifest.indexBlob))) return false;

      const targetPaths = new Set(manifest.files.map(file => file.path));
      for (const currentPath of this.listManagedPaths()) {
        if (targetPaths.has(currentPath)) continue;
        const absolutePath = this.resolveWorkspacePath(currentPath);
        if (fs.existsSync(absolutePath)) {
          fs.rmSync(absolutePath, { force: true, recursive: true });
          this.removeEmptyParents(path.dirname(absolutePath));
        }
      }

      for (const file of manifest.files) {
        const absolutePath = this.resolveWorkspacePath(file.path);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        if (fs.existsSync(absolutePath)) {
          const stat = fs.lstatSync(absolutePath);
          if (stat.isDirectory() || stat.isSymbolicLink()) {
            fs.rmSync(absolutePath, { force: true, recursive: true });
          }
        }

        const content = fs.readFileSync(this.getBlobPath(file.blob));
        if (file.kind === 'symlink') {
          fs.symlinkSync(content.toString('utf8'), absolutePath);
        } else {
          fs.writeFileSync(absolutePath, content, { mode: file.mode });
          try {
            fs.chmodSync(absolutePath, file.mode);
          } catch {}
        }
      }

      if (manifest.indexBlob) {
        const indexPath = this.getIndexPath();
        fs.mkdirSync(path.dirname(indexPath), { recursive: true });
        fs.copyFileSync(this.getBlobPath(manifest.indexBlob), indexPath);
      }
      return true;
    } catch {
      return false;
    }
  }

  private git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
  }

  private listManagedPaths(): string[] {
    const output = this.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return output
      .split('\0')
      .filter(Boolean)
      .map(file => this.normalizeRelativePath(file));
  }

  private getIndexPath(): string {
    const gitPath = this.git(['rev-parse', '--git-path', 'index']).trim();
    return path.isAbsolute(gitPath) ? gitPath : path.resolve(this.cwd, gitPath);
  }

  private normalizeRelativePath(value: string): string {
    const normalized = value.replace(/\\/g, '/');
    if (
      !normalized ||
      path.posix.isAbsolute(normalized) ||
      normalized.split('/').some(part => part === '..')
    ) {
      throw new Error(`Invalid snapshot path: ${value}`);
    }
    return normalized;
  }

  private resolveWorkspacePath(relativePath: string): string {
    const normalized = this.normalizeRelativePath(relativePath);
    const resolved = path.resolve(this.cwd, ...normalized.split('/'));
    if (resolved !== this.cwd && !resolved.startsWith(`${this.cwd}${path.sep}`)) {
      throw new Error(`Snapshot path escaped workspace: ${relativePath}`);
    }
    return resolved;
  }

  private storeBlob(content: Buffer, kind: string): string {
    const hash = crypto.createHash('sha256').update(kind).update('\0').update(content).digest('hex');
    const blobPath = this.getBlobPath(hash);
    if (!fs.existsSync(blobPath)) {
      fs.writeFileSync(blobPath, content, { flag: 'wx' });
    }
    return hash;
  }

  private getBlobPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid snapshot blob hash');
    return path.join(this.blobsDir, hash);
  }

  private getManifestPath(id: string): string {
    return path.join(this.manifestsDir, `${id}.json`);
  }

  private isValidSnapshotId(id: string): boolean {
    return /^[a-f0-9-]{36}$/.test(id);
  }

  private readManifest(id: string): SnapshotManifest | null {
    const manifestPath = this.getManifestPath(id);
    if (!fs.existsSync(manifestPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
    if (parsed.version !== 1 || parsed.id !== id || !Array.isArray(parsed.files)) return null;
    return parsed;
  }

  private removeEmptyParents(startPath: string): void {
    let current = path.resolve(startPath);
    while (current !== this.cwd && current.startsWith(`${this.cwd}${path.sep}`)) {
      try {
        fs.rmdirSync(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
}
