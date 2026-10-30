import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirs = ["packages/core", "packages/patrol-github", "packages/plugins", "packages/cli"];
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const tar = process.platform === "win32" ? "tar.exe" : "tar";
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hajicli-pack-"));

// 第一步：monorepo 根与各子包的 version 必须一致（AGENTS.md 约定的版本同步），
// 防止只改了部分 package.json 就打标签发版。
const manifestPaths = ["package.json", ...packageDirs.map((dir) => path.join(dir, "package.json"))];
const versionByPath = new Map();
for (const relPath of manifestPaths) {
  const manifest = JSON.parse(await fs.readFile(path.join(workspaceRoot, relPath), "utf8"));
  versionByPath.set(relPath, manifest.version);
}
const uniqueVersions = new Set(versionByPath.values());
if (uniqueVersions.size !== 1) {
  const detail = [...versionByPath.entries()].map(([f, v]) => `${f}: ${v}`).join("\n  ");
  throw new Error(`版本号不一致，发版前必须同步各包 version：\n  ${detail}`);
}
const releaseVersion = [...uniqueVersions][0];
console.log(`✓ 各包 package.json 版本一致: ${releaseVersion}`);

// 标签触发时（release workflow），tag 名必须与包版本一致，防止打错标签发布。
if (process.env.GITHUB_REF_TYPE === "tag") {
  const expectedTag = `v${releaseVersion}`;
  if (process.env.GITHUB_REF_NAME !== expectedTag) {
    throw new Error(`发布标签 ${process.env.GITHUB_REF_NAME} 与包版本 ${expectedTag} 不一致`);
  }
}

try {
  for (const relativeDir of packageDirs) {
    const packageDir = path.join(workspaceRoot, relativeDir);
    const before = new Set(await fs.readdir(tempDir));
    await execFileAsync(pnpm, ["pack", "--pack-destination", tempDir], {
      cwd: packageDir,
      shell: process.platform === "win32",
    });
    const tarballs = (await fs.readdir(tempDir)).filter(
      (file) => file.endsWith(".tgz") && !before.has(file),
    );
    if (tarballs.length !== 1) throw new Error(`${relativeDir} 未生成唯一发布包`);

    const tarballName = tarballs[0];
    // Windows 的 bsdtar 会把绝对路径里的 "C:" 解析成远程主机，改用临时目录内的相对路径
    const { stdout: listOutput } = await execFileAsync(tar, ["-tf", tarballName], {
      encoding: "utf8",
      cwd: tempDir,
    });
    const entries = listOutput.split(/\r?\n/).filter(Boolean);
    const forbidden = entries.filter(
      (entry) =>
        entry.includes("/.haji/") ||
        entry.includes("/src/") ||
        entry.includes("/test/") ||
        entry.endsWith(".tsbuildinfo"),
    );
    if (forbidden.length > 0) {
      throw new Error(`${relativeDir} 发布包包含禁止文件: ${forbidden.join(", ")}`);
    }
    if (
      relativeDir === "packages/cli" &&
      !entries.some((entry) => /\/dist\/haji_terminal_engine\.[^/]+\.node$/.test(entry))
    ) {
      throw new Error("packages/cli 发布包缺少当前平台的原生终端渲染模块");
    }

    const { stdout: manifestText } = await execFileAsync(
      tar,
      ["-xOf", tarballName, "package/package.json"],
      { encoding: "utf8", cwd: tempDir },
    );
    const manifest = JSON.parse(manifestText);
    for (const [name, version] of Object.entries(manifest.dependencies || {})) {
      if (String(version).startsWith("workspace:")) {
        throw new Error(`${relativeDir} 的发布依赖 ${name} 未转换为正式版本`);
      }
    }
    console.log(`✓ ${manifest.name}: ${entries.length} files, dependency manifest ready`);
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
