import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = path.join(workspaceRoot, 'packages', 'cli', 'native', 'terminal-engine');
const targetDir = path.join(crateDir, 'target');
const manifestPath = path.join(crateDir, 'Cargo.toml');
const outputDir = path.join(workspaceRoot, 'packages', 'cli', 'dist');

const build = spawnSync('cargo', [
  'build',
  '--release',
  '--manifest-path',
  manifestPath,
  '--target-dir',
  targetDir
], {
  cwd: workspaceRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const sourceName = process.platform === 'win32'
  ? 'haji_terminal_engine.dll'
  : process.platform === 'darwin'
    ? 'libhaji_terminal_engine.dylib'
    : 'libhaji_terminal_engine.so';
const sourcePath = path.join(targetDir, 'release', sourceName);
const outputName = `haji_terminal_engine.${process.platform}-${process.arch}.node`;
const outputPath = path.join(outputDir, outputName);

fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(sourcePath, outputPath);
console.log(`✓ Native terminal engine: ${outputPath}`);
