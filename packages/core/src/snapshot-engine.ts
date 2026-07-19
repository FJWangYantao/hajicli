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
  version: 2;
  id: string;
  headHash: string;
  timestamp: number;
  description: string;
  files: SnapshotFile[];
}

interface SnapshotMetadata {
  id: string;
  headHash: string;
  timestamp: number;
}

interface MutationRecord {
  version: 1 | 2;
  id: string;
  anchorSnapshotId: string;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  timestamp: number;
  paths: string[];
  headChanged?: boolean;
  beforeHeadHash?: string;
  afterHeadHash?: string;
}

export interface MutationCompletionResult {
  recordId: string;
  headChanged: boolean;
  warning?: string;
}

export interface MutationCheckpoint {
  anchorSnapshotId: string;
  beforeSnapshotId: string;
  paths?: string[];
}

export interface SnapshotRollbackResult {
  ok: boolean;
  revertedPaths: string[];
  preservedPaths: string[];
  reason?: string;
}

/**
 * 内容寻址的工作区快照与会话级修改日志。
 *
 * 快照只用来比较状态；/rewind 仅逆向撤销当前 Haji 会话实际执行工具造成的变更。
 * 如果文件在工具执行后又被用户或其他进程修改，回退会保留该文件并报告冲突。
 */
export class SnapshotEngine {
  private readonly cwd: string;
  private readonly snapshotRoot: string;
  private readonly manifestsDir: string;
  private readonly blobsDir: string;
  private readonly journalsDir: string;
  private scope = 'default';

  constructor(cwd: string = process.cwd(), snapshotRoot = path.join(cwd, '.haji', 'snapshots')) {
    this.cwd = path.resolve(cwd);
    this.snapshotRoot = path.resolve(snapshotRoot);
    this.manifestsDir = path.join(this.snapshotRoot, 'manifests');
    this.blobsDir = path.join(this.snapshotRoot, 'blobs');
    this.journalsDir = path.join(this.snapshotRoot, 'journals');
  }

  setScope(scope: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(scope)) throw new Error('无效的快照作用域');
    this.scope = scope;
  }

  isGitRepo(): boolean {
    try {
      return this.git(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
    } catch {
      return false;
    }
  }

  getCurrentHeadHash(): string | null {
    try {
      return this.git(['rev-parse', '--verify', 'HEAD']).trim();
    } catch {
      return null;
    }
  }

  /** 保存工作区状态供归属比较，不会执行 git add、commit、stash 或 reset。 */
  createSnapshot(description: string, includedPaths?: readonly string[]): string | null {
    const headHash = this.getCurrentHeadHash();
    return this.createSnapshotAtHead(description, includedPaths, headHash);
  }

  private createSnapshotAtHead(
    description: string,
    includedPaths: readonly string[] | undefined,
    headHash: string | null
  ): string | null {
    if (!headHash) return null;

    try {
      fs.mkdirSync(this.manifestsDir, { recursive: true });
      fs.mkdirSync(this.blobsDir, { recursive: true });

      const snapshotPaths = includedPaths === undefined
        ? this.listManagedPaths()
        : [...new Set(includedPaths.map(file => this.normalizeRelativePath(file)))];
      const files: SnapshotFile[] = [];
      for (const relativePath of snapshotPaths) {
        if (this.isHajiRuntimePath(relativePath)) continue;
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

      const id = crypto.randomUUID();
      const manifest: SnapshotManifest = {
        version: 2,
        id,
        headHash,
        timestamp: Date.now(),
        description,
        files
      };
      fs.writeFileSync(this.getManifestPath(id), JSON.stringify(manifest, null, 2), 'utf8');
      return id;
    } catch {
      return null;
    }
  }

  /** Anchor snapshots only need HEAD and time; owned tool mutations carry the file contents. */
  createAnchor(description: string): string | null {
    return this.createSnapshot(description, []);
  }

  beginMutation(anchorSnapshotId: string, paths?: readonly string[]): MutationCheckpoint | null {
    if (!this.readSnapshotMetadata(anchorSnapshotId)) return null;
    const normalizedPaths = paths?.map(file => this.normalizeRelativePath(file));
    const beforeSnapshotId = this.createSnapshot('before Haji tool mutation', normalizedPaths);
    return beforeSnapshotId ? { anchorSnapshotId, beforeSnapshotId, paths: normalizedPaths } : null;
  }

  /** 记录一次工具调用前后的差异，作为当前会话拥有的修改。 */
  completeMutation(checkpoint: MutationCheckpoint): MutationCompletionResult | null {
    const before = this.readManifest(checkpoint.beforeSnapshotId);
    const currentHeadHash = this.getCurrentHeadHash();
    if (!before || !currentHeadHash) return null;
    const headChanged = before.headHash !== currentHeadHash;
    const afterSnapshotId = this.createSnapshotAtHead('after Haji tool mutation', checkpoint.paths, currentHeadHash);
    if (!afterSnapshotId) return null;
    const after = this.readManifest(afterSnapshotId);
    if (!after || after.headHash !== currentHeadHash) return null;

    const paths = this.changedPaths(before, after);
    if (paths.length === 0 && !headChanged) return null;

    const record: MutationRecord = {
      version: 2,
      id: crypto.randomUUID(),
      anchorSnapshotId: checkpoint.anchorSnapshotId,
      beforeSnapshotId: checkpoint.beforeSnapshotId,
      afterSnapshotId,
      timestamp: Date.now(),
      paths,
      headChanged,
      beforeHeadHash: before.headHash,
      afterHeadHash: currentHeadHash
    };
    const records = this.readJournal();
    records.push(record);
    this.writeJournal(records);
    return {
      recordId: record.id,
      headChanged,
      warning: headChanged
        ? '[快照警告] 工具执行期间 Git HEAD 发生变化；本次 mutation 已记录并标记为不可自动回退。'
        : undefined
    };
  }

  /**
   * 仅撤销目标消息开始后、由当前会话工具产生且之后未被外部修改的文件。
   * 旧版全量快照没有修改归属信息，因此只回退消息，不触碰工作区。
   */
  rollbackOwnedChanges(snapshotId: string): SnapshotRollbackResult {
    const target = this.readSnapshotMetadata(snapshotId);
    if (!target) {
      return { ok: false, revertedPaths: [], preservedPaths: [], reason: '快照缺失或版本过旧' };
    }
    if (this.getCurrentHeadHash() !== target.headHash) {
      return { ok: false, revertedPaths: [], preservedPaths: [], reason: 'Git HEAD 已发生变化' };
    }

    const records = this.readJournal();
    const candidates = records.filter(record => record.timestamp >= target.timestamp);
    const revertedPaths = new Set<string>();
    const preservedPaths = new Set<string>();

    for (const record of [...candidates].reverse()) {
      const before = this.readManifest(record.beforeSnapshotId);
      const after = this.readManifest(record.afterSnapshotId);
      if (!before || !after || before.headHash !== target.headHash || after.headHash !== target.headHash) {
        for (const relativePath of record.paths) preservedPaths.add(relativePath);
        continue;
      }
      const beforeFiles = this.fileMap(before);
      const afterFiles = this.fileMap(after);

      for (const relativePath of record.paths) {
        if (preservedPaths.has(relativePath)) continue;
        const expectedAfter = afterFiles.get(relativePath);
        if (!this.currentMatches(relativePath, expectedAfter)) {
          preservedPaths.add(relativePath);
          revertedPaths.delete(relativePath);
          continue;
        }
        this.restoreFile(relativePath, beforeFiles.get(relativePath));
        revertedPaths.add(relativePath);
      }
    }

    if (candidates.length > 0) {
      this.writeJournal(records.filter(record => record.timestamp < target.timestamp));
    }
    return {
      ok: true,
      revertedPaths: [...revertedPaths].sort(),
      preservedPaths: [...preservedPaths].sort()
    };
  }

  /** 兼容旧调用；语义已改为安全的会话归属回退。 */
  rollback(snapshotId: string): boolean {
    return this.rollbackOwnedChanges(snapshotId).ok;
  }

  private changedPaths(before: SnapshotManifest, after: SnapshotManifest): string[] {
    const beforeFiles = this.fileMap(before);
    const afterFiles = this.fileMap(after);
    const paths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
    return [...paths].filter(relativePath => !this.sameFile(beforeFiles.get(relativePath), afterFiles.get(relativePath))).sort();
  }

  private fileMap(manifest: SnapshotManifest): Map<string, SnapshotFile> {
    return new Map(manifest.files.map(file => [file.path, file]));
  }

  private sameFile(left: SnapshotFile | undefined, right: SnapshotFile | undefined): boolean {
    if (!left || !right) return left === right;
    return left.blob === right.blob && left.kind === right.kind && left.mode === right.mode;
  }

  private currentMatches(relativePath: string, expected: SnapshotFile | undefined): boolean {
    const absolutePath = this.resolveWorkspacePath(relativePath);
    if (!expected) return !fs.existsSync(absolutePath);
    if (!fs.existsSync(absolutePath)) return false;
    const stat = fs.lstatSync(absolutePath);
    if (expected.kind === 'symlink' ? !stat.isSymbolicLink() : !stat.isFile()) return false;
    const content = expected.kind === 'symlink'
      ? Buffer.from(fs.readlinkSync(absolutePath), 'utf8')
      : fs.readFileSync(absolutePath);
    const hash = crypto.createHash('sha256').update(expected.kind).update('\0').update(content).digest('hex');
    return hash === expected.blob;
  }

  private restoreFile(relativePath: string, target: SnapshotFile | undefined): void {
    const absolutePath = this.resolveWorkspacePath(relativePath);
    if (!target) {
      if (fs.existsSync(absolutePath)) {
        fs.rmSync(absolutePath, { force: true, recursive: true });
        this.removeEmptyParents(path.dirname(absolutePath));
      }
      return;
    }

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (fs.existsSync(absolutePath)) {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        fs.rmSync(absolutePath, { force: true, recursive: true });
      }
    }
    const content = fs.readFileSync(this.getBlobPath(target.blob));
    if (target.kind === 'symlink') {
      fs.symlinkSync(content.toString('utf8'), absolutePath);
    } else {
      fs.writeFileSync(absolutePath, content, { mode: target.mode });
      try { fs.chmodSync(absolutePath, target.mode); } catch {}
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
    return output.split('\0').filter(Boolean).map(file => this.normalizeRelativePath(file));
  }

  private isHajiRuntimePath(relativePath: string): boolean {
    return relativePath === '.haji' || relativePath.startsWith('.haji/');
  }

  private normalizeRelativePath(value: string): string {
    const normalized = value.replace(/\\/g, '/');
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').some(part => part === '..')) {
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
    if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, content, { flag: 'wx' });
    return hash;
  }

  private getBlobPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid snapshot blob hash');
    return path.join(this.blobsDir, hash);
  }

  private getManifestPath(id: string): string {
    return path.join(this.manifestsDir, `${id}.json`);
  }

  private readManifest(id: string): SnapshotManifest | null {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const manifestPath = this.getManifestPath(id);
    if (!fs.existsSync(manifestPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
      if (parsed.version !== 2 || parsed.id !== id || !Array.isArray(parsed.files)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private readSnapshotMetadata(id: string): SnapshotMetadata | null {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const manifestPath = this.getManifestPath(id);
    if (!fs.existsSync(manifestPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        version?: number;
        id?: string;
        headHash?: string;
        timestamp?: number;
      };
      if ((parsed.version !== 1 && parsed.version !== 2) || parsed.id !== id) return null;
      if (typeof parsed.headHash !== 'string' || typeof parsed.timestamp !== 'number') return null;
      return { id, headHash: parsed.headHash, timestamp: parsed.timestamp };
    } catch {
      return null;
    }
  }

  private getJournalPath(): string {
    return path.join(this.journalsDir, `${this.scope}.json`);
  }

  private readJournal(): MutationRecord[] {
    try {
      const filePath = this.getJournalPath();
      if (!fs.existsSync(filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MutationRecord[];
      return Array.isArray(parsed) ? parsed.filter(record => record?.version === 1 || record?.version === 2) : [];
    } catch {
      return [];
    }
  }

  private writeJournal(records: MutationRecord[]): void {
    fs.mkdirSync(this.journalsDir, { recursive: true });
    fs.writeFileSync(this.getJournalPath(), JSON.stringify(records, null, 2), 'utf8');
  }

  private removeEmptyParents(startPath: string): void {
    let current = path.resolve(startPath);
    while (current !== this.cwd && current.startsWith(`${this.cwd}${path.sep}`)) {
      try { fs.rmdirSync(current); } catch { break; }
      current = path.dirname(current);
    }
  }
}
