import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BaseTool, ToolDefinition, ToolExecutionContext } from '@hajicli/core';
import { takeWholeRecords, truncateSingleLine } from './bounded-output.js';
import { contentHash } from './file-content.js';
import { runRipgrepLines } from './ripgrep.js';
import { DEFAULT_EXCLUDED_DIRS } from './search-filter.js';

type ProjectInfoDepth = 'summary' | 'detailed';

interface ProjectInfoOptions {
  depth: ProjectInfoDepth;
  includeGit: boolean;
  refresh: boolean;
}

interface PackageSummary {
  path: string;
  name?: string;
  scripts: string[];
  workspaces: string[];
}

interface CachedProjectInfo {
  fingerprint: string;
  fileCount: number;
  fileScanTruncated: boolean;
  languageCounts: Array<[string, number]>;
  topDirectories: string[];
  configFiles: string[];
  entrypoints: string[];
  packages: PackageSummary[];
  packageManagers: string[];
}

interface GitSummary {
  branch?: string;
  changedCount: number;
  changedSample: string[];
  unavailable?: string;
}

const MAX_SCANNED_FILES = 20_000;
const MAX_OUTPUT_LENGTH = 8_000;
/** 缓存按 cwd 记录的项目摘要数量上限；超限时淘汰最久未写入的条目，防止长期运行会话内存无界增长。 */
const MAX_CACHED_PROJECTS = 8;
const projectInfoCache = new Map<string, CachedProjectInfo>();
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.pyi': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java',
  '.kt': 'Kotlin', '.kts': 'Kotlin', '.cs': 'C#', '.c': 'C/C++', '.cc': 'C/C++',
  '.cpp': 'C/C++', '.h': 'C/C++', '.hpp': 'C/C++', '.rb': 'Ruby', '.php': 'PHP',
  '.swift': 'Swift', '.vue': 'Vue', '.svelte': 'Svelte', '.sql': 'SQL',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS', '.md': 'Markdown', '.mdx': 'Markdown'
};
const CONFIG_NAMES = new Set([
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb',
  'pyproject.toml', 'requirements.txt', 'poetry.lock', 'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'agents.md', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'makefile',
  'eslint.config.js', 'eslint.config.mjs', '.eslintrc', '.prettierrc', 'vitest.config.ts',
  'vite.config.ts', 'jest.config.js', 'jest.config.ts'
]);

function parseOptions(args: Record<string, unknown>): ProjectInfoOptions {
  const depth = args.depth === undefined ? 'summary' : args.depth;
  if (depth !== 'summary' && depth !== 'detailed') throw new Error('depth 只能是 summary 或 detailed。');
  if (args.includeGit !== undefined && typeof args.includeGit !== 'boolean') throw new Error('includeGit 必须是布尔值。');
  if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new Error('refresh 必须是布尔值。');
  return { depth, includeGit: args.includeGit !== false, refresh: args.refresh === true };
}

function throwIfAborted(context?: ToolExecutionContext): void {
  if (!context?.abortSignal?.aborted) return;
  const error = new Error('项目摘要已中止');
  error.name = 'AbortError';
  throw error;
}

async function listWorkspaceFiles(cwd: string, context?: ToolExecutionContext): Promise<{ files: string[]; truncated: boolean }> {
  const args = ['--files', '--hidden', '--sort', 'path'];
  for (const directory of DEFAULT_EXCLUDED_DIRS) args.push('--glob', `!${directory}/**`);
  const fastResult = await runRipgrepLines(args, cwd, MAX_SCANNED_FILES, context?.abortSignal);
  if (fastResult) {
    return {
      files: fastResult.lines.map(file => file.replace(/\\/g, '/')).sort((left, right) => left.localeCompare(right)),
      truncated: fastResult.truncated
    };
  }

  const files: string[] = [];
  let truncated = false;
  const walk = async (directory: string) => {
    throwIfAborted(context);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRS.includes(entry.name)) await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push(path.relative(cwd, absolutePath).replace(/\\/g, '/'));
        if (files.length >= MAX_SCANNED_FILES) truncated = true;
      }
    }
  };
  await walk(cwd);
  return { files, truncated };
}

function isConfigFile(file: string): boolean {
  const basename = path.posix.basename(file).toLowerCase();
  return CONFIG_NAMES.has(basename)
    || /^tsconfig(?:\.[^.]+)?\.json$/.test(basename)
    || /^requirements[^/]*\.txt$/.test(basename);
}

function isEntrypoint(file: string): boolean {
  const normalized = file.toLowerCase();
  return /(?:^|\/)(?:src\/)?(?:index|main|app|server|cli)\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java)$/.test(normalized)
    || /(?:^|\/)cmd\/[^/]+\/main\.go$/.test(normalized);
}

async function readPackageSummary(cwd: string, file: string): Promise<PackageSummary | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(cwd, file), 'utf8')) as Record<string, unknown>;
    const scriptsValue = parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
      ? Object.keys(parsed.scripts as Record<string, unknown>).sort()
      : [];
    const workspaceValue = parsed.workspaces;
    const workspaces = Array.isArray(workspaceValue)
      ? workspaceValue.filter((item): item is string => typeof item === 'string')
      : workspaceValue && typeof workspaceValue === 'object' && Array.isArray((workspaceValue as Record<string, unknown>).packages)
        ? ((workspaceValue as Record<string, unknown>).packages as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
    return {
      path: path.posix.dirname(file) === '.' ? '.' : path.posix.dirname(file),
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      scripts: scriptsValue,
      workspaces
    };
  } catch {
    return null;
  }
}

async function buildProjectInfo(
  cwd: string,
  files: string[],
  fileScanTruncated: boolean,
  fingerprint: string,
  context?: ToolExecutionContext
): Promise<CachedProjectInfo> {
  const languageMap = new Map<string, number>();
  const topDirectories = new Set<string>();
  for (const file of files) {
    const extension = path.posix.extname(file).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (language) languageMap.set(language, (languageMap.get(language) || 0) + 1);
    const firstSegment = file.split('/')[0];
    if (file.includes('/')) topDirectories.add(firstSegment);
  }
  const configFiles = files.filter(isConfigFile);
  const packageFiles = configFiles.filter(file => path.posix.basename(file).toLowerCase() === 'package.json').slice(0, 30);
  const packages = (await Promise.all(packageFiles.map(file => readPackageSummary(cwd, file))))
    .filter((item): item is PackageSummary => Boolean(item));
  throwIfAborted(context);

  const fileSet = new Set(files.map(file => file.toLowerCase()));
  const packageManagers = [
    fileSet.has('pnpm-lock.yaml') || fileSet.has('pnpm-workspace.yaml') ? 'pnpm' : '',
    fileSet.has('yarn.lock') ? 'yarn' : '',
    fileSet.has('package-lock.json') ? 'npm' : '',
    fileSet.has('bun.lockb') ? 'bun' : '',
    fileSet.has('pyproject.toml') || fileSet.has('requirements.txt') ? 'python' : '',
    fileSet.has('cargo.toml') ? 'cargo' : '',
    fileSet.has('go.mod') ? 'go modules' : '',
    fileSet.has('pom.xml') ? 'maven' : '',
    fileSet.has('build.gradle') || fileSet.has('build.gradle.kts') ? 'gradle' : ''
  ].filter(Boolean);

  return {
    fingerprint,
    fileCount: files.length,
    fileScanTruncated,
    languageCounts: [...languageMap.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    topDirectories: [...topDirectories].sort(),
    configFiles,
    entrypoints: files.filter(isEntrypoint),
    packages,
    packageManagers
  };
}

async function computeFingerprint(cwd: string, files: string[], context?: ToolExecutionContext): Promise<string> {
  const configFiles = files.filter(isConfigFile);
  const stats = await Promise.all(configFiles.map(async file => {
    throwIfAborted(context);
    try {
      const stat = await fs.stat(path.join(cwd, file));
      return `${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    } catch {
      return `${file}:missing`;
    }
  }));
  return contentHash(`${files.join('\n')}\n--config--\n${stats.join('\n')}`);
}

async function readGitSummary(cwd: string, context?: ToolExecutionContext): Promise<GitSummary> {
  throwIfAborted(context);
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks', 'status', '--short', '--branch'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      signal: context?.abortSignal
    }, (error, stdout) => {
      if (context?.abortSignal?.aborted) {
        resolve({ changedCount: 0, changedSample: [], unavailable: '已中止' });
        return;
      }
      if (error && !stdout) {
        resolve({ changedCount: 0, changedSample: [], unavailable: '不是 Git 仓库或 Git 不可用' });
        return;
      }
      const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
      const branchLine = lines[0]?.startsWith('## ') ? lines.shift() : undefined;
      resolve({
        branch: branchLine?.slice(3),
        changedCount: lines.length,
        changedSample: lines.slice(0, 20).map(line => truncateSingleLine(line, 240))
      });
    });
  });
}

function renderProjectInfo(
  cwd: string,
  info: CachedProjectInfo,
  cacheHit: boolean,
  depth: ProjectInfoDepth,
  git?: GitSummary
): string {
  const detailLimit = depth === 'detailed' ? 30 : 10;
  const records: string[] = [
    `项目=${path.basename(cwd)}；文件数=${info.fileCount}${info.fileScanTruncated ? '+' : ''}；缓存=${cacheHit ? 'hit' : 'miss'}`,
    `主要语言=${info.languageCounts.slice(0, detailLimit).map(([name, count]) => `${name}:${count}`).join(', ') || '未识别'}`,
    `包管理=${info.packageManagers.join(', ') || '未识别'}`,
    `顶层目录=${info.topDirectories.slice(0, detailLimit).join(', ') || '(无)'}`
  ];

  for (const pkg of info.packages.slice(0, depth === 'detailed' ? 20 : 5)) {
    records.push(`包 ${pkg.path}: ${pkg.name || '(未命名)'}；scripts=${pkg.scripts.slice(0, detailLimit).join(', ') || '(无)'}${pkg.workspaces.length > 0 ? `；workspaces=${pkg.workspaces.join(', ')}` : ''}`);
  }
  if (info.entrypoints.length > 0) records.push(`入口候选=${info.entrypoints.slice(0, detailLimit).join(', ')}`);
  if (info.configFiles.length > 0) records.push(`配置文件=${info.configFiles.slice(0, depth === 'detailed' ? 60 : 20).join(', ')}`);
  if (git) {
    if (git.unavailable) records.push(`Git=${git.unavailable}`);
    else {
      records.push(`Git分支=${git.branch || '(未知)'}；变更数=${git.changedCount}`);
      if (depth === 'detailed' && git.changedSample.length > 0) records.push(`Git变更样本=${git.changedSample.join(', ')}`);
    }
  }
  if (info.fileScanTruncated) records.push(`提示：文件数超过扫描上限 ${MAX_SCANNED_FILES}，语言与目录统计为前缀样本。`);

  const bounded = takeWholeRecords(records, MAX_OUTPUT_LENGTH - 50);
  return `[项目结构摘要]\n${bounded.text}${bounded.truncated ? '\n提示：摘要已按输出预算截断。' : ''}`;
}

export class ProjectInfoTool implements BaseTool {
  public readonly name = 'projectinfo';

  public readonly definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'projectinfo',
      description: '快速汇总当前项目的语言、目录、包管理、脚本、配置、入口和 Git 状态，减少进入陌生项目时的重复搜索。',
      parameters: {
        type: 'object',
        properties: {
          depth: { type: 'string', enum: ['summary', 'detailed'], description: '摘要深度，默认 summary。' },
          includeGit: { type: 'boolean', description: '是否包含只读 Git 状态，默认 true。' },
          refresh: { type: 'boolean', description: '忽略缓存强制刷新，默认 false。' }
        }
      }
    }
  };

  public async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    let options: ProjectInfoOptions;
    try {
      options = parseOptions(args);
    } catch (error) {
      return `错误: ${error instanceof Error ? error.message : String(error)}`;
    }

    const cwd = process.cwd();
    try {
      throwIfAborted(context);
      const listed = await listWorkspaceFiles(cwd, context);
      const fingerprint = await computeFingerprint(cwd, listed.files, context);
      const cached = projectInfoCache.get(cwd);
      const cacheHit = !options.refresh && cached?.fingerprint === fingerprint;
      const info = cacheHit
        ? cached
        : await buildProjectInfo(cwd, listed.files, listed.truncated, fingerprint, context);
      if (!cacheHit) {
        // 命中刷新时先删除再写回，保持 Map 插入序即最近使用序。
        projectInfoCache.delete(cwd);
        projectInfoCache.set(cwd, info);
        while (projectInfoCache.size > MAX_CACHED_PROJECTS) {
          const oldest = projectInfoCache.keys().next().value;
          if (oldest === undefined) break;
          projectInfoCache.delete(oldest);
        }
      }
      const git = options.includeGit ? await readGitSummary(cwd, context) : undefined;
      if (context?.abortSignal?.aborted) return '[项目摘要已中止]';
      return renderProjectInfo(cwd, info, cacheHit, options.depth, git);
    } catch (error) {
      if (context?.abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return '[项目摘要已中止]';
      }
      return `项目摘要失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
