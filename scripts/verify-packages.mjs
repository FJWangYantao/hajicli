import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirs = ['packages/core', 'packages/plugins', 'packages/cli'];
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hajicli-pack-'));

try {
  for (const relativeDir of packageDirs) {
    const packageDir = path.join(workspaceRoot, relativeDir);
    const before = new Set(await fs.readdir(tempDir));
    await execFileAsync(pnpm, ['pack', '--pack-destination', tempDir], {
      cwd: packageDir,
      shell: process.platform === 'win32'
    });
    const tarballs = (await fs.readdir(tempDir)).filter(file => file.endsWith('.tgz') && !before.has(file));
    if (tarballs.length !== 1) throw new Error(`${relativeDir} 未生成唯一发布包`);

    const tarball = path.join(tempDir, tarballs[0]);
    const { stdout: listOutput } = await execFileAsync(tar, ['-tf', tarball], { encoding: 'utf8' });
    const entries = listOutput.split(/\r?\n/).filter(Boolean);
    const forbidden = entries.filter(entry =>
      entry.includes('/.haji/') || entry.includes('/src/') || entry.includes('/test/') || entry.endsWith('.tsbuildinfo')
    );
    if (forbidden.length > 0) {
      throw new Error(`${relativeDir} 发布包包含禁止文件: ${forbidden.join(', ')}`);
    }

    const { stdout: manifestText } = await execFileAsync(tar, ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' });
    const manifest = JSON.parse(manifestText);
    for (const [name, version] of Object.entries(manifest.dependencies || {})) {
      if (String(version).startsWith('workspace:')) {
        throw new Error(`${relativeDir} 的发布依赖 ${name} 未转换为正式版本`);
      }
    }
    console.log(`✓ ${manifest.name}: ${entries.length} files, dependency manifest ready`);
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
